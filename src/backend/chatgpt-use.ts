import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import type {
  AiBackend,
  BackendCapabilities,
  BackendFailure,
  BackendFailureKind,
  BackendOutcome,
  BackendRequest,
  BackendResponse,
  BackendStatus,
  BackendSubmission,
} from './contract.js';

/**
 * The ChatGPT backend, driven by the `chatgpt-use` CLI.
 *
 * `chatgpt-use` owns the browser: it opens ChatGPT, sends the prompt and
 * reads the answer. This adapter only speaks the JSON envelope of the CLI and
 * maps it onto the backend contract — no DOM, no selector, no browser type.
 *
 * The rules that matter:
 *
 * - a request that may have reached ChatGPT is never sent again: the id of
 *   the request is the receipt of the CLI
 * - an unknown submission state is a failure of its own, never a retry
 * - the stdout of the CLI stays machine-readable, the diagnostics come from
 *   stderr
 */

/** The result of a process of the runner. */
export interface ProcessResult {
  /** The exit code of the process — `null` when it was killed. */
  code: number | null;
  /** Everything the process wrote to stdout. */
  stdout: string;
  /** Everything the process wrote to stderr. */
  stderr: string;
  /** The process was killed: it did not finish in time. */
  timedOut: boolean;
}

/** How the adapter starts a process — the seam the unit tests replace. */
export interface ProcessRunner {
  run(command: string, args: string[], options?: { timeoutMs?: number }): Promise<ProcessResult>;
}

/**
 * The runner of the real processes.
 *
 * The process is started without a shell, so a prompt or a path is never
 * interpolated into a command line.
 */
export const nodeProcessRunner: ProcessRunner = {
  run(command, args, options = {}) {
    return new Promise((resolve, reject) => {
      const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      let timedOut = false;
      let killTimer: NodeJS.Timeout | undefined;
      const timer = options.timeoutMs
        ? setTimeout(() => {
            timedOut = true;
            child.kill('SIGTERM');
            // A process that ignores SIGTERM must not keep the run pending
            // forever: it is killed after the grace period.
            killTimer = setTimeout(() => child.kill('SIGKILL'), KILL_GRACE_MS);
          }, options.timeoutMs)
        : undefined;
      child.stdout.on('data', (chunk) => {
        stdout += chunk;
      });
      child.stderr.on('data', (chunk) => {
        stderr += chunk;
      });
      child.on('error', (error) => {
        if (timer) clearTimeout(timer);
        if (killTimer) clearTimeout(killTimer);
        reject(error);
      });
      child.on('close', (code) => {
        if (timer) clearTimeout(timer);
        if (killTimer) clearTimeout(killTimer);
        resolve({ code, stdout, stderr, timedOut });
      });
    });
  },
};

/** The grace period between SIGTERM and SIGKILL. */
const KILL_GRACE_MS = 2_000;

/** What the ChatGPT backend of `chatgpt-use` supports. */
export const CHATGPT_USE_CAPABILITIES: BackendCapabilities = Object.freeze({
  attachments: true,
  // The CLI answers in one piece: it has no stream of the answer.
  streaming: false,
  cancellation: true,
  // The CLI has no "continue this conversation" for `ask`.
  conversationReuse: false,
  modelSelection: true,
  imageOutput: false,
});

/** The options of the backend. */
export interface ChatgptUseBackendOptions {
  /** The command of the CLI — the one on the PATH by default. */
  command?: string;
  /** The runner of the processes — the real one by default. */
  runner?: ProcessRunner;
}

/** The name of the backend in the registry. */
export const CHATGPT_USE_BACKEND_NAME = 'chatgpt-use';

/** The CLI is not installed or cannot be started. */
const UNAVAILABLE: BackendFailure = {
  kind: 'unavailable',
  message: 'chatgpt-use could not be started.',
  submission: 'not_submitted',
};

/**
 * The kinds of a failure of the CLI and the kind of the contract they are.
 *
 * A kind that is not listed here is an unusable answer (`invalid_output`) —
 * the CLI is another program: its failure is mapped, never trusted.
 */
const FAILURE_KIND_OF: Record<string, BackendFailureKind> = {
  busy: 'busy',
  unavailable: 'unavailable',
  login_required: 'unavailable',
  session_unavailable: 'unavailable',
  page_blocked: 'unavailable',
  rate_limited: 'unavailable',
  not_submitted: 'unavailable',
  cancelled: 'cancelled',
  incomplete: 'timeout',
  duplicate_request: 'invalid_output',
  submit_unknown: 'unknown_submission',
  failed: 'invalid_output',
  error: 'invalid_output',
};

/** The state a failure of a kind claims. */
const SUBMISSION_OF_KIND: Record<BackendFailureKind, BackendSubmission> = {
  busy: 'not_submitted',
  unavailable: 'not_submitted',
  timeout: 'submitted',
  invalid_output: 'unknown',
  cancelled: 'submitted',
  unknown_submission: 'unknown',
};

/** The image types the CLI can upload. */
const IMAGE_TYPES = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp']);

/** The levels of the composer of ChatGPT that the CLI knows. */
const MODEL_LEVELS = new Set(['instant', 'medium', 'high', 'extra high', 'pro', 'current']);

/**
 * The envelope of the CLI and the receipt of `status` — every field is
 * checked before it is used.
 */
interface Envelope {
  status?: unknown;
  request_id?: unknown;
  conversation_id?: unknown;
  result?: unknown;
  error?: unknown;
  /** The receipt of a request. */
  state?: unknown;
  outcome?: unknown;
  submitted?: unknown;
}

/**
 * Create the ChatGPT backend.
 *
 * The backend drives one ChatGPT session: the asks of one process run one
 * after the other. Another process that uses the same window is rejected by
 * the CLI itself (`--busy fail`) and becomes a `busy` failure.
 */
export function createChatgptUseBackend(options: ChatgptUseBackendOptions = {}): AiBackend {
  const command = options.command ?? CHATGPT_USE_BACKEND_NAME;
  const runner = options.runner ?? nodeProcessRunner;

  // The queue of the session: one ask at a time.
  let queue: Promise<unknown> = Promise.resolve();
  const serialize = <T>(task: () => Promise<T>): Promise<T> => {
    const result = queue.then(task, task);
    queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };

  /**
   * Run the CLI.
   *
   * `started` is false when the CLI could not be started at all — it is not
   * installed, or it cannot be executed.
   */
  const run = async (
    args: string[],
    timeoutMs?: number,
  ): Promise<{ stdout: string; stderr: string; timedOut: boolean; started: boolean }> => {
    try {
      const result = await runner.run(command, args, {
        // The CLI has its own timeout for the turn; this one is the backstop
        // for the parts around it (opening the browser).
        ...(timeoutMs ? { timeoutMs: timeoutMs + 60_000 } : {}),
      });
      return {
        stdout: result.stdout,
        stderr: result.stderr,
        timedOut: result.timedOut,
        started: true,
      };
    } catch (error) {
      return {
        stdout: '',
        stderr: error instanceof Error ? error.message : String(error),
        timedOut: false,
        started: false,
      };
    }
  };

  /** The state of a request the CLI reported. */
  const submissionOf = (value: unknown): BackendSubmission => {
    if (value === 'yes') return 'submitted';
    if (value === 'no') return 'not_submitted';
    return 'unknown';
  };

  /** The failure of an envelope of the CLI. */
  const failureOf = (envelope: Envelope, fallback: string): BackendFailure => {
    const error = isRecord(envelope.error) ? envelope.error : undefined;
    // An envelope without an error says nothing: the answer is unusable.
    if (!error) {
      return { kind: 'invalid_output', message: fallback, submission: 'unknown' };
    }
    const kind = typeof error.kind === 'string' ? error.kind : '';
    const mapped = FAILURE_KIND_OF[kind] ?? 'invalid_output';
    const reported = submissionOf(error.submitted);
    const message =
      typeof error.message === 'string' && error.message.trim() !== '' ? error.message : fallback;
    // An unknown state is a failure of its own: the request may have run, so
    // it must not be sent again.
    if (reported === 'unknown') {
      return {
        kind: 'unknown_submission',
        message: `The submission state of the request is unknown: ${message}`,
        submission: 'unknown',
      };
    }
    // The state of a failure follows its kind: a busy backend is the only one
    // that may still be busy with the request.
    const submission =
      mapped === 'unknown_submission'
        ? 'unknown'
        : mapped === 'busy' || mapped === 'invalid_output'
          ? reported
          : SUBMISSION_OF_KIND[mapped];
    return { kind: mapped, message, submission };
  };

  /** The answer of a completed envelope. */
  const responseOf = (
    envelope: Envelope,
    request: BackendRequest,
  ): BackendOutcome<BackendResponse> => {
    const result = isRecord(envelope.result) ? envelope.result : undefined;
    const text = result?.text;
    if (typeof text !== 'string' || text.trim() === '') {
      return {
        ok: false,
        failure: {
          kind: 'invalid_output',
          message: 'chatgpt-use answered without a text.',
          submission: 'submitted',
        },
      };
    }
    const conversationId =
      typeof envelope.conversation_id === 'string' && envelope.conversation_id !== ''
        ? envelope.conversation_id
        : undefined;
    return {
      ok: true,
      value: {
        requestId: request.requestId,
        ...(conversationId ? { conversationId } : {}),
        text,
        markdown: text,
        ...(request.model ? { model: request.model } : {}),
        truncated: false,
        submission: 'submitted',
      },
    };
  };

  /** The outcome of an envelope of the CLI. */
  const outcomeOf = (
    envelope: Envelope,
    request: BackendRequest,
    effectiveId: string,
  ): BackendOutcome<BackendResponse> => {
    // The answer of another request is not the answer of this one.
    if (typeof envelope.request_id === 'string' && envelope.request_id !== effectiveId) {
      return {
        ok: false,
        failure: {
          kind: 'invalid_output',
          message: `chatgpt-use answered the request '${envelope.request_id}' instead of '${effectiveId}'.`,
          submission: 'unknown',
        },
      };
    }
    if (envelope.status === 'completed') {
      // An answer without the id of the request is an answer whose origin is
      // unknown: it is not the answer of this request.
      if (envelope.request_id !== effectiveId) {
        return {
          ok: false,
          failure: {
            kind: 'invalid_output',
            message: `chatgpt-use answered without the id of the request '${effectiveId}'.`,
            submission: 'unknown',
          },
        };
      }
      return responseOf(envelope, request);
    }
    return { ok: false, failure: failureOf(envelope, 'chatgpt-use did not answer.') };
  };

  /** The receipt id of the CLI for a request — the charset is checked below. */
  const effectiveId = (requestId: string): string => encodeId(requestId);

  /** The model of the request as the level of the composer of ChatGPT. */
  const modelArg = (model: string): string => {
    const normalized = model.trim().toLowerCase().replace(/\s+/g, ' ');
    if (MODEL_LEVELS.has(normalized)) return normalized;
    // A raw menu label of the picker ("GPT-5.5") is accepted as it is.
    return model.trim();
  };

  /** The attachments of the request: the images are uploaded, the rest is context. */
  const attachmentArgs = (attachments: string[]): string[] => {
    const args: string[] = [];
    for (const file of attachments) {
      const extension = file.slice(file.lastIndexOf('.')).toLowerCase();
      args.push(IMAGE_TYPES.has(extension) ? '--image' : '--file', file);
    }
    return args;
  };

  const ask = async (request: BackendRequest): Promise<BackendOutcome<BackendResponse>> => {
    const id = effectiveId(request.requestId);
    const args = [
      'ask',
      '--json',
      // The id is the receipt of the request: it is looked up by `status`,
      // `resume` and `cancel` — and it is never sent twice.
      '--request-id',
      id,
      // Another run uses the ChatGPT window: it fails at once instead of
      // waiting for the window — the busy policy of this backend.
      '--busy',
      'fail',
      // The prompt is an argument: the stdin is never read as a context.
      '--no-stdin',
      ...(request.model ? ['--model', modelArg(request.model)] : []),
      ...(request.timeoutMs ? ['--timeout', String(Math.ceil(request.timeoutMs / 1000))] : []),
      ...attachmentArgs(request.attachments ?? []),
      // The prompt is a positional argument: `--` keeps a prompt that starts
      // with a dash out of the options.
      '--',
      request.prompt,
    ];
    const result = await run(args, request.timeoutMs);
    if (!result.started) {
      return { ok: false, failure: { ...UNAVAILABLE, message: result.stderr } };
    }
    if (result.timedOut) {
      return {
        ok: false,
        failure: {
          kind: 'unknown_submission',
          message: 'chatgpt-use did not finish in time — the request may have reached ChatGPT.',
          submission: 'unknown',
        },
      };
    }
    const envelope = parseJson(result.stdout);
    if (!envelope) {
      return {
        ok: false,
        failure: {
          kind: 'invalid_output',
          message: `chatgpt-use did not answer with an envelope: ${lastLine(result.stderr)}`,
          submission: 'unknown',
        },
      };
    }
    return outcomeOf(envelope, request, id);
  };

  const resume = async (request: BackendRequest): Promise<BackendOutcome<BackendResponse>> => {
    const id = effectiveId(request.requestId);
    // `resume` waits for the reply of the request on the server — the prompt
    // is not sent again.
    const result = await run(
      [
        'resume',
        id,
        // The busy policy of the backend: the window is not waited for.
        '--busy',
        'fail',
        ...(request.model ? ['--model', modelArg(request.model)] : []),
        ...(request.timeoutMs ? ['--timeout', String(Math.ceil(request.timeoutMs / 1000))] : []),
      ],
      request.timeoutMs,
    );
    if (!result.started) {
      return { ok: false, failure: { ...UNAVAILABLE, message: result.stderr } };
    }
    if (result.timedOut) {
      return {
        ok: false,
        failure: {
          kind: 'unknown_submission',
          message: 'chatgpt-use did not finish in time — the request may have reached ChatGPT.',
          submission: 'unknown',
        },
      };
    }
    const envelope = parseJson(result.stdout);
    if (!envelope) {
      // The CLI does not know the request: it was never submitted by it — the
      // same state `status` reports for a request without a receipt.
      if (/no receipt|unknown request/i.test(result.stderr)) {
        return {
          ok: false,
          failure: {
            kind: 'invalid_output',
            message: `chatgpt-use does not know the request '${request.requestId}' — it was never submitted.`,
            submission: 'not_submitted',
          },
        };
      }
      return {
        ok: false,
        failure: {
          kind: 'invalid_output',
          message: `chatgpt-use did not answer with an envelope: ${lastLine(result.stderr)}`,
          submission: 'unknown',
        },
      };
    }
    return outcomeOf(envelope, request, id);
  };

  return {
    name: CHATGPT_USE_BACKEND_NAME,
    capabilities: CHATGPT_USE_CAPABILITIES,

    ask: (request) => serialize(() => ask(request)),

    resume: (request) => serialize(() => resume(request)),

    status: async (requestId: string): Promise<BackendStatus> => {
      const id = effectiveId(requestId);
      const result = await run(['status', id]);
      if (!result.started) return { requestId, submission: 'unknown' };
      const receipt = parseJson(result.stdout);
      if (!receipt) {
        // No receipt: the request was never submitted by this backend.
        if (/no receipt/i.test(result.stderr)) return { requestId, submission: 'not_submitted' };
        return { requestId, submission: 'unknown' };
      }
      // The receipt of another request is not the receipt of this one.
      if (receipt.request_id !== id) {
        return { requestId, submission: 'unknown' };
      }
      const state = typeof receipt.state === 'string' ? receipt.state : '';
      const outcome = typeof receipt.outcome === 'string' ? receipt.outcome : '';
      const error = isRecord(receipt.error) ? receipt.error : undefined;
      const errorKind = typeof error?.kind === 'string' ? error.kind : '';
      const cancelled =
        state === 'cancelled' || outcome === 'cancelled' || errorKind === 'cancelled';
      const conversationId =
        typeof receipt.conversation_id === 'string' && receipt.conversation_id !== ''
          ? receipt.conversation_id
          : undefined;
      return {
        requestId,
        submission: submissionOf(receipt.submitted),
        ...(cancelled ? { cancelled: true } : {}),
        ...(conversationId ? { conversationId } : {}),
      };
    },

    cancel: async (requestId: string): Promise<BackendOutcome<{ cancelled: boolean }>> => {
      const id = effectiveId(requestId);
      const result = await run(['cancel', id]);
      if (!result.started) {
        return { ok: false, failure: { ...UNAVAILABLE, message: result.stderr } };
      }
      const envelope = parseJson(result.stdout);
      if (!envelope) {
        return {
          ok: false,
          failure: {
            kind: 'invalid_output',
            message: `chatgpt-use did not answer with an envelope: ${lastLine(result.stderr)}`,
            submission: 'unknown',
          },
        };
      }
      // The answer of another request is not the answer of this one.
      if (envelope.request_id !== id) {
        return {
          ok: false,
          failure: {
            kind: 'invalid_output',
            message: `chatgpt-use answered the request '${envelope.request_id}' instead of '${id}'.`,
            submission: 'unknown',
          },
        };
      }
      if (envelope.status === 'cancelled') return { ok: true, value: { cancelled: true } };
      if (envelope.status === 'already_finished') return { ok: true, value: { cancelled: false } };
      return { ok: false, failure: failureOf(envelope, 'chatgpt-use did not cancel the request.') };
    },
  };
}

/**
 * The receipt id of a request for the CLI.
 *
 * The CLI accepts letters, digits, `.` and `-`. Every other byte is escaped
 * as `_` and its hex code, so two different request ids never share a
 * receipt: the escape is reversible, so `a/b` and `a_2Fb` stay apart.
 *
 * An id that is empty or too long for the CLI becomes a hash of it — the
 * receipt of a request is unique, not readable.
 */
function encodeId(requestId: string): string {
  let encoded = '';
  for (const byte of Buffer.from(requestId, 'utf8')) {
    const char = String.fromCharCode(byte);
    encoded += /[A-Za-z0-9.-]/.test(char) ? char : `_${byte.toString(16).padStart(2, '0')}`;
  }
  if (encoded !== '' && encoded.length <= MAX_ID_LENGTH) return encoded;
  return createHash('sha256').update(requestId).digest('hex');
}

/** The longest id the CLI accepts. */
const MAX_ID_LENGTH = 128;

/** The JSON of the stdout of the CLI — undefined when it is not JSON. */
function parseJson(stdout: string): Envelope | undefined {
  try {
    const parsed: unknown = JSON.parse(stdout);
    return isRecord(parsed) ? (parsed as Envelope) : undefined;
  } catch {
    return undefined;
  }
}

/** Whether a value is an object with fields. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The last line of the stderr of the CLI — the diagnostic of a failure. */
function lastLine(stderr: string): string {
  const lines = stderr
    .trim()
    .split('\n')
    .filter((line) => line.trim() !== '');
  return lines.length > 0 ? (lines[lines.length - 1] as string).trim() : 'no output';
}
