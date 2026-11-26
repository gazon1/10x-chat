import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
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
import { withQueueWait } from './contract.js';
import { nodeProcessRunner, type ProcessResult, type ProcessRunner } from './process-runner.js';

export type { ProcessResult, ProcessRunner };
export { nodeProcessRunner };

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

/**
 * The size of one argument of a process.
 *
 * The kernel of Linux limits one argument of a process to 128 KiB
 * (`MAX_ARG_STRLEN`): a prompt that is bigger is refused with `E2BIG`
 * before the CLI ever sees it. The command line of Windows is smaller still
 * (32 767 characters), and the limit of the process is the smaller one of
 * the two. A prompt that does not fit travels through the stdin of the CLI
 * instead — the bundle of a review of a big change is bigger than the limit.
 */
const MAX_ARGUMENT_BYTES = 30_000;

/** The prompt that carries a request that travels through the stdin. */
const CONTEXT_PROMPT =
  'The request is in the context of this message. Follow it exactly: answer in the format it asks for, and nothing else.';

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

/** The resolved ChatGPT Project destination. */
export interface ResolvedChatgptProject {
  /** The project name as the CLI accepts it. */
  name: string;
  /** The project id (`g-p-…`) — the real identity under the name. */
  id: string;
}

/** Verifies that a newly created conversation landed in the configured project. */
export type ProjectMembershipVerifier = (
  conversationId: string,
  project: ResolvedChatgptProject,
) => Promise<BackendFailure | undefined>;

/** The options of the backend. */
export interface ChatgptUseBackendOptions {
  /** The command of the CLI — the one on the PATH by default. */
  command?: string;
  /** The runner of the processes — the real one by default. */
  runner?: ProcessRunner;
  /**
   * Verifies that a newly created conversation is in the configured project.
   *
   * The default reads the project page through a browser and checks the
   * project's Chats list — the primary membership signal from
   * `docs/chatgpt-projects.md`. Tests inject a fake.
   */
  verifyProjectMembership?: ProjectMembershipVerifier;
  /** The `projects.json` of `chatgpt-use` — the name → id map. */
  projectsPath?: string;
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
  rejected: 'not_submitted',
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
  const projectsPath = options.projectsPath ?? chatgptUseProjectsPath();
  const verifyMembership = options.verifyProjectMembership ?? verifyChatgptProjectMembership;

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
   * Run an ask or a resume through the queue, and report how long it waited.
   *
   * The wait is measured here and not by the caller: only the queue knows when
   * a request reached the front of it. The caller's wall clock minus this wait
   * is the time the provider really worked, and the pipeline reports both.
   */
  const queued = (
    task: () => Promise<BackendOutcome<BackendResponse>>,
  ): Promise<BackendOutcome<BackendResponse>> => {
    const queuedAt = Date.now();
    return serialize(async () => {
      const startedAt = Date.now();
      const outcome = await task();
      return withQueueWait(outcome, startedAt - queuedAt);
    });
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
    input?: string,
  ): Promise<{ stdout: string; stderr: string; timedOut: boolean; started: boolean }> => {
    try {
      const result = await runner.run(command, args, {
        // The CLI has its own timeout for the turn; this one is the backstop
        // for the parts around it (opening the browser).
        ...(timeoutMs ? { timeoutMs: timeoutMs + 60_000 } : {}),
        ...(input !== undefined ? { input } : {}),
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
    // A conversation the CLI cannot continue is refused: `ask` always opens a
    // new chat, so answering here would silently drop the conversation the
    // caller asked for.
    if (request.conversationId && !CHATGPT_USE_CAPABILITIES.conversationReuse) {
      return {
        ok: false,
        failure: {
          kind: 'rejected',
          message: `chatgpt-use cannot continue the conversation '${request.conversationId}' — every ask starts a new chat.`,
          submission: 'not_submitted',
        },
      };
    }
    let project: ResolvedChatgptProject | undefined;
    if (request.chatgptProject) {
      const resolved = await resolveChatgptProject(request.chatgptProject, projectsPath);
      if (!resolved.ok) return { ok: false, failure: resolved.failure };
      project = resolved.value;
    }
    const id = effectiveId(request.requestId);
    // A prompt that does not fit into one argument of a process travels
    // through the stdin of the CLI: the kernel refuses a bigger argument
    // with `E2BIG` before the CLI sees it.
    const throughStdin = Buffer.byteLength(request.prompt) > MAX_ARGUMENT_BYTES;
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
      // The prompt is an argument: the stdin is never read as a context. A
      // prompt that is too big for an argument is read from the stdin.
      ...(throughStdin ? ['--stdin'] : ['--no-stdin']),
      ...(request.model ? ['--model', modelArg(request.model)] : []),
      ...(project ? ['--project', project.name] : []),
      ...(request.timeoutMs ? ['--timeout', String(Math.ceil(request.timeoutMs / 1000))] : []),
      ...attachmentArgs(request.attachments ?? []),
      // The prompt is a positional argument: `--` keeps a prompt that starts
      // with a dash out of the options.
      '--',
      throughStdin ? CONTEXT_PROMPT : request.prompt,
    ];
    const result = await run(args, request.timeoutMs, throughStdin ? request.prompt : undefined);
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
    const outcome = outcomeOf(envelope, request, id);
    if (project) return verifyProjectMembership(outcome, project, verifyMembership);
    return outcome;
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

    ask: (request) => queued(() => ask(request)),

    resume: (request) => queued(() => resume(request)),

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

/** The `~/.chatgpt-use/projects.json` path — the name → id map the CLI uses. */
export function chatgptUseProjectsPath(): string {
  return path.join(os.homedir(), '.chatgpt-use', 'projects.json');
}

/** Read the name → id map of `chatgpt-use`. */
export async function readChatgptUseProjects(
  filePath = chatgptUseProjectsPath(),
): Promise<Record<string, string>> {
  let raw: string;
  try {
    raw = await readFile(filePath, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return {};
    throw new Error(
      `Cannot read ChatGPT Projects map ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `Cannot read ChatGPT Projects map ${filePath}: not valid JSON (${error instanceof Error ? error.message : String(error)})`,
    );
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Cannot read ChatGPT Projects map ${filePath}: expected an object`);
  }
  const out: Record<string, string> = Object.create(null);
  for (const [name, id] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof id === 'string' && id.trim()) out[name] = id;
  }
  return out;
}

/** Resolve a configured project name to its id through `projects.json`. */
export async function resolveChatgptProject(
  name: string,
  filePath = chatgptUseProjectsPath(),
): Promise<BackendOutcome<ResolvedChatgptProject>> {
  const trimmed = name.trim();
  if (!trimmed) {
    return {
      ok: false,
      failure: {
        kind: 'rejected',
        message: 'The ChatGPT Project name is empty.',
        submission: 'not_submitted',
      },
    };
  }
  let projects: Record<string, string>;
  try {
    projects = await readChatgptUseProjects(filePath);
  } catch (error) {
    return {
      ok: false,
      failure: {
        kind: 'unavailable',
        message: error instanceof Error ? error.message : String(error),
        submission: 'not_submitted',
      },
    };
  }
  const id = Object.hasOwn(projects, trimmed) ? projects[trimmed] : undefined;
  if (!id) {
    const known = Object.keys(projects)
      .filter((key) => /^g-p-/.test(projects[key] ?? ''))
      .slice(0, 8);
    const hint = known.length > 0 ? ` Known project names: ${known.join(', ')}.` : '';
    return {
      ok: false,
      failure: {
        kind: 'rejected',
        message:
          `ChatGPT Project "${trimmed}" is not in ${filePath}. ` +
          `The configured value must be the project name as it appears in that file; ` +
          `an unknown name would make chatgpt-use create a project instead of using the one you meant.` +
          hint,
        submission: 'not_submitted',
      },
    };
  }
  return { ok: true, value: { name: trimmed, id } };
}

/**
 * The primary membership signal: the conversation is in the project's own Chats
 * list after a reload. A bare `/c/<id>` redirect is corroboration only and is
 * not enough on its own (docs/chatgpt-projects.md).
 *
 * This verifier opens the project page in a 10x-chat browser session. The
 * chatgpt-use CLI that created the conversation runs in its own browser, so
 * both profiles must be logged into the same ChatGPT account for this check to
 * observe the project list.
 */
export async function verifyChatgptProjectMembership(
  conversationId: string,
  project: ResolvedChatgptProject,
): Promise<BackendFailure | undefined> {
  const { launchBrowser } = await import('../browser/index.js');
  const { getProvider } = await import('../providers/index.js');
  const projectUrl = `https://chatgpt.com/g/${project.id}/project`;
  let browser: Awaited<ReturnType<typeof launchBrowser>> | undefined;
  try {
    browser = await launchBrowser({
      provider: 'chatgpt',
      url: projectUrl,
      operation: 'chat',
    });
    await browser.page
      .goto(projectUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 })
      .catch(() => {});

    const provider = getProvider('chatgpt');
    let loggedIn = false;
    try {
      loggedIn = await provider.actions.isLoggedIn(browser.page);
    } catch (error) {
      return {
        kind: 'unavailable',
        message:
          `Could not verify ChatGPT Project "${project.name}" (${project.id}) membership for conversation ${conversationId}: ` +
          `${error instanceof Error ? error.message : String(error)}. ` +
          'Membership verification reads the project page through the 10x-chat browser profile; run `10x-chat login chatgpt` for that profile and ensure it uses the same ChatGPT account as chatgpt-use.',
        submission: 'submitted',
      };
    }
    if (!loggedIn) {
      return {
        kind: 'unavailable',
        message:
          `Cannot verify ChatGPT Project "${project.name}" (${project.id}) membership: the 10x-chat browser profile is not logged into ChatGPT. ` +
          'Run `10x-chat login chatgpt` and ensure it uses the same ChatGPT account as chatgpt-use, then retry.',
        submission: 'submitted',
      };
    }

    // The project page paints a generic shell before the Chats list settles.
    await browser.page.waitForTimeout(2_000);

    // One reload: the primary membership signal is the project Chats list after
    // reload (docs/chatgpt-projects.md). The initial check alone is not enough.
    await browser.page.reload({ waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => {});
    await browser.page.waitForTimeout(2_000);
    const inListAfterReload = await projectChatsListContains(browser.page, conversationId);
    if (inListAfterReload) return undefined;

    return {
      kind: 'invalid_output',
      message:
        `The conversation ${conversationId} was not found in the Chats list of ChatGPT Project "${project.name}" ` +
        `(${project.id}) after reload. The project destination could not be verified; the conversation may be outside the project. ` +
        'Membership verification reads the project page through the 10x-chat browser profile, so that profile must be logged into the same ChatGPT account as chatgpt-use.',
      submission: 'submitted',
    };
  } catch (error) {
    return {
      kind: 'unavailable',
      message:
        `Could not verify that conversation ${conversationId} landed in ChatGPT Project "${project.name}" (${project.id}): ` +
        `${error instanceof Error ? error.message : String(error)}. ` +
        'Membership verification reads the project page through the 10x-chat browser profile, so that profile must be logged into the same ChatGPT account as chatgpt-use.',
      submission: 'submitted',
    };
  } finally {
    await browser?.close().catch(() => {});
  }
}

/**
 * True when `href` is a conversation URL for `conversationId`.
 *
 * The project page carries `/c/<id>` anchors in its Chats list and in global
 * navigation. This helper is the shared href matcher used by the DOM predicate.
 */
export function conversationHrefMatches(
  href: string,
  conversationId: string,
  origin: string,
): boolean {
  const needle = `/c/${conversationId}`;
  const hasBoundary = (path: string, index: number): boolean => {
    const next = path[index + needle.length];
    return next === undefined || next === '/' || next === '?' || next === '#';
  };
  try {
    const url = new URL(href, origin);
    const index = url.pathname.indexOf(needle);
    return index >= 0 && hasBoundary(url.pathname, index);
  } catch {
    const index = href.indexOf(needle);
    return index >= 0 && hasBoundary(href, index);
  }
}

/**
 * DOM predicate for project Chats list membership.
 *
 * The project's own Chats list is the primary signal. Global navigation anchors
 * (sidebar/nav/aside) can also link to conversations and must be ignored
 * (docs/chatgpt-projects.md: 61 anchors in document, 50 in the project list).
 *
 * Kept as a pure function so it can be unit-tested without a browser. The real
 * verifier calls it inside `page.evaluate`.
 */
export function isProjectChatsListAnchor(
  anchor: { href: string; insideGlobalNav: boolean },
  conversationId: string,
  origin: string,
): boolean {
  if (anchor.insideGlobalNav) return false;
  return conversationHrefMatches(anchor.href, conversationId, origin);
}

/**
 * The in-browser predicate used by the default verifier.
 *
 * The project's own Chats list is the primary signal
 * (docs/chatgpt-projects.md). Global navigation/sidebar anchors are not evidence.
 * We scope to main content and exclude nav/sidebar/aside/header so a conversation
 * link elsewhere on the page cannot satisfy membership by accident.
 *
 * Self-contained: `page.evaluate` serializes this function, so it must not
 * reference module-scope helpers.
 */
export function projectChatsListDomPredicate(conversationId: string): boolean {
  const needle = `/c/${conversationId}`;
  const hrefMatches = (href: string): boolean => {
    const hasBoundary = (path: string, index: number): boolean => {
      const next = path[index + needle.length];
      return next === undefined || next === '/' || next === '?' || next === '#';
    };
    try {
      const url = new URL(href, window.location.origin);
      const index = url.pathname.indexOf(needle);
      return index >= 0 && hasBoundary(url.pathname, index);
    } catch {
      const index = href.indexOf(needle);
      return index >= 0 && hasBoundary(href, index);
    }
  };
  const roots = Array.from(document.querySelectorAll('main, [role="main"]')) as HTMLElement[];
  const anchors =
    roots.length > 0
      ? roots.flatMap(
          (root) => Array.from(root.querySelectorAll('a[href*="/c/"]')) as HTMLAnchorElement[],
        )
      : (Array.from(document.querySelectorAll('a[href*="/c/"]')) as HTMLAnchorElement[]);
  return anchors.some((a) => {
    if (a.closest('nav, [data-testid*="sidebar"], aside, header, [role="navigation"]'))
      return false;
    return hrefMatches(a.href);
  });
}

/**
 * Whether the project's Chats list contains the conversation.
 *
 * The project page's own list is the primary membership signal. Sidebar/global
 * `/c/<id>` links are not evidence (docs/chatgpt-projects.md), so anchors inside
 * nav/sidebar containers are ignored.
 */
async function projectChatsListContains(
  page: Awaited<ReturnType<typeof import('../browser/index.js').launchBrowser>>['page'],
  conversationId: string,
): Promise<boolean> {
  return page.evaluate(projectChatsListDomPredicate, conversationId);
}

async function verifyProjectMembership(
  outcome: BackendOutcome<BackendResponse>,
  project: ResolvedChatgptProject,
  verify: ProjectMembershipVerifier = verifyChatgptProjectMembership,
): Promise<BackendOutcome<BackendResponse>> {
  if (!outcome.ok) return outcome;
  const conversationId = outcome.value.conversationId;
  if (!conversationId) {
    return {
      ok: false,
      failure: {
        kind: 'invalid_output',
        message: `chatgpt-use answered without a conversation id, so membership in ChatGPT Project "${project.name}" (${project.id}) cannot be verified.`,
        submission: 'submitted',
      },
    };
  }
  const failure = await verify(conversationId, project);
  if (!failure) return outcome;
  return { ok: false, failure };
}

/**
 * The receipt id of a request for the CLI.
 *
 * The CLI accepts letters, digits, `.`, `_` and `-`. Every other byte is escaped
 * as `_` and its hex code, so two different request ids never share a
 * receipt: the escape is reversible, so `a/b` and `a_2Fb` stay apart.
 *
 * An id that is empty or too long for the CLI becomes a hash of it — the
 * receipt of a request is unique, not readable. The hash carries a trailing
 * `_`, which the escape above never produces: the two names cannot collide.
 */
function encodeId(requestId: string): string {
  let encoded = '';
  for (const byte of Buffer.from(requestId, 'utf8')) {
    const char = String.fromCharCode(byte);
    encoded += /[A-Za-z0-9.-]/.test(char) ? char : `_${byte.toString(16).padStart(2, '0')}`;
  }
  if (encoded !== '' && encoded.length <= MAX_ID_LENGTH) return encoded;
  // The escape never ends with `_` — the hash is in a namespace of its own.
  return `${createHash('sha256').update(requestId).digest('hex')}_`;
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
