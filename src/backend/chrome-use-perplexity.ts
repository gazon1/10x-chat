import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import type {
  AiBackend,
  BackendCapabilities,
  BackendFailure,
  BackendOutcome,
  BackendRequest,
  BackendResponse,
  BackendStatus,
  BackendSubmission,
} from './contract.js';

/**
 * Perplexity POC driven by the `chrome-use` CLI (user's real Chrome via the
 * extension relay). Narrow adapter: no Playwright/Page objects cross this
 * boundary. Site-specific selectors and flow live here only.
 *
 * POC limits (explicit, never silent): no attachments, model selection, image
 * output, streaming chunks, conversation reuse, or cancellation. One ask = one
 * chrome-use session; tabs are closed with `done` on every path.
 */

export interface ProcessResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface ProcessRunner {
  run(
    command: string,
    args: string[],
    options?: { timeoutMs?: number; input?: string },
  ): Promise<ProcessResult>;
}

const KILL_GRACE_MS = 2_000;

export const nodeProcessRunner: ProcessRunner = {
  run(command, args, options = {}) {
    return new Promise((resolve, reject) => {
      const child = spawn(command, args, {
        stdio: [options.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      let timedOut = false;
      let killTimer: NodeJS.Timeout | undefined;
      if (options.input !== undefined) {
        child.stdin?.on('error', () => {});
        child.stdin?.end(options.input);
      }
      const timer = options.timeoutMs
        ? setTimeout(() => {
            timedOut = true;
            child.kill('SIGTERM');
            killTimer = setTimeout(() => child.kill('SIGKILL'), KILL_GRACE_MS);
          }, options.timeoutMs)
        : undefined;
      child.stdout?.on('data', (chunk) => {
        stdout += String(chunk);
      });
      child.stderr?.on('data', (chunk) => {
        stderr += String(chunk);
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

export const CHROME_USE_PERPLEXITY_BACKEND_NAME = 'chrome-use-perplexity';

export const CHROME_USE_PERPLEXITY_CAPABILITIES: BackendCapabilities = Object.freeze({
  attachments: false,
  streaming: false,
  cancellation: false,
  conversationReuse: false,
  modelSelection: false,
  imageOutput: false,
});

const PERPLEXITY_URL = 'https://www.perplexity.ai';
const COMPOSER = 'div[role="textbox"][contenteditable="true"]';
const SUBMIT = 'button[aria-label="Submit"]';
const CMD_TIMEOUT_FLOOR_MS = 5_000;

interface ChromeJson {
  success?: boolean;
  data?: unknown;
  error?: unknown;
}

export interface ChromeUsePerplexityBackendOptions {
  command?: string;
  runner?: ProcessRunner;
  sessionPrefix?: string;
  /** Poll interval while waiting for a stable answer. */
  pollMs?: number;
  /** Consecutive unchanged polls required before considering the answer complete. */
  stablePolls?: number;
}

const nowMs = (): number => Date.now();

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

function parseJson(stdout: string): ChromeJson | undefined {
  const text = stdout.trim();
  if (!text) return undefined;
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) return undefined;
  try {
    const parsed = JSON.parse(text.slice(start, end + 1)) as unknown;
    return isRecord(parsed) ? (parsed as ChromeJson) : undefined;
  } catch {
    return undefined;
  }
}

function sessionName(prefix: string, requestId: string): string {
  const hash = createHash('sha256').update(requestId).digest('hex').slice(0, 12);
  const safe = requestId.replace(/[^A-Za-z0-9_-]+/g, '-').slice(0, 24) || 'req';
  return `${prefix}-${safe}-${hash}`;
}

function dataRecord(data: unknown): Record<string, unknown> | undefined {
  return isRecord(data) ? data : undefined;
}

type FailureOutcome = Extract<BackendOutcome<never>, { ok: false }>;

function failure(
  kind: BackendFailure['kind'],
  submission: BackendSubmission,
  message: string,
  partialText?: string,
): FailureOutcome {
  return { ok: false, failure: { kind, submission, message, ...(partialText ? { partialText } : {}) } };
}

function unavailable(message: string, submission: BackendSubmission = 'not_submitted'): FailureOutcome {
  return failure('unavailable', submission, message);
}

function disconnectLike(text: string): boolean {
  return /not connected|relay|extension|native host|no .*daemon|session .*unresponsive|profile not open|could not connect|ECONN|connect.*chrome/i.test(
    text,
  );
}

function classifyCommandError(
  detail: string,
  submitted: boolean,
  timedOut: boolean,
): FailureOutcome {
  if (timedOut) {
    return failure(
      submitted ? 'timeout' : 'unknown_submission',
      submitted ? 'submitted' : 'unknown',
      submitted
        ? `Timed out waiting for the Perplexity answer: ${detail}`
        : `Timed out before the prompt was confirmed sent (it may have reached Perplexity): ${detail}`,
    );
  }
  if (disconnectLike(detail)) {
    return failure(
      submitted ? 'unknown_submission' : 'unavailable',
      submitted ? 'unknown' : 'not_submitted',
      submitted
        ? `Lost connection to Chrome/chrome-use while waiting for the answer (prompt may have been submitted): ${detail}`
        : `chrome-use is unavailable or not connected to Chrome: ${detail}`,
    );
  }
  return failure(
    submitted ? 'invalid_output' : 'unavailable',
    submitted ? 'submitted' : 'not_submitted',
    detail,
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createChromeUsePerplexityBackend(
  options: ChromeUsePerplexityBackendOptions = {},
): AiBackend {
  const command = options.command ?? 'chrome-use';
  const runner = options.runner ?? nodeProcessRunner;
  const sessionPrefix = options.sessionPrefix ?? '10x-pplx';
  const pollMs = options.pollMs ?? 800;
  const stablePolls = options.stablePolls ?? 3;
  // Best-effort in-process record: this POC has no persistent receipt, but
  // status() must not lie about a request it already handled in this process.
  const known = new Map<
    string,
    { submission: BackendSubmission; text?: string; truncated?: boolean; cancelled?: boolean }
  >();

  let queue: Promise<unknown> = Promise.resolve();
  const serialize = <T>(task: () => Promise<T>): Promise<T> => {
    const result = queue.then(task, task);
    queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };

  const run = async (
    args: string[],
    timeoutMs?: number,
    input?: string,
  ): Promise<{ result?: ProcessResult; started: boolean; startError?: string }> => {
    try {
      const result = await runner.run(command, args, { timeoutMs, input });
      return { result, started: true };
    } catch (error) {
      return {
        started: false,
        startError: error instanceof Error ? error.message : String(error),
      };
    }
  };

  const cmd = async (
    session: string,
    sub: string[],
    timeoutMs: number | undefined,
    submitted: boolean,
    input?: string,
  ): Promise<
    | { ok: true; json?: ChromeJson; result: ProcessResult }
    | { ok: false; outcome: FailureOutcome }
  > => {
    // Respect the caller/request budget: never run a command longer than the
    // remaining deadline (a floor above it would violate timeoutMs).
    const budget = timeoutMs ?? CMD_TIMEOUT_FLOOR_MS;
    const runTimeout =
      timeoutMs === undefined ? Math.max(budget, CMD_TIMEOUT_FLOOR_MS) : Math.max(budget, 1);
    const { result, started, startError } = await run(['--session', session, ...sub], runTimeout, input);
    if (!started || !result) {
      const detail = startError ?? 'failed to start chrome-use';
      if (/ENOENT/i.test(detail)) {
        if (submitted) {
          return {
            ok: false,
            outcome: failure(
              'unknown_submission',
              'unknown',
              `chrome-use could not be started after submission (prompt may have been submitted): ${detail}`,
            ),
          };
        }
        return { ok: false, outcome: unavailable(`chrome-use could not be started: ${detail}`) };
      }
      return { ok: false, outcome: classifyCommandError(detail, submitted, false) };
    }
    if (result.timedOut) {
      return {
        ok: false,
        outcome: classifyCommandError(`command timed out (${sub[0] ?? 'chrome-use'})`, submitted, true),
      };
    }
    const json = parseJson(result.stdout);
    if (json && json.success === false) {
      const detail = typeof json.error === 'string' ? json.error : JSON.stringify(json.error ?? json);
      return { ok: false, outcome: classifyCommandError(detail, submitted, false) };
    }
    if (result.code !== 0) {
      const detail =
        (typeof json?.error === 'string' ? json.error : undefined) ||
        (result.stderr || result.stdout || `exit ${result.code}`).trim();
      return { ok: false, outcome: classifyCommandError(detail || 'chrome-use failed', submitted, false) };
    }
    if (!json || json.success !== true) {
      const detail = (result.stderr || result.stdout || 'invalid chrome-use JSON envelope').trim();
      return { ok: false, outcome: classifyCommandError(detail || 'invalid chrome-use JSON envelope', submitted, false) };
    }
    return { ok: true, json, result };
  };

  const ask = async (request: BackendRequest): Promise<BackendOutcome<BackendResponse>> => {
    if (request.attachments && request.attachments.length > 0) {
      return failure(
        'invalid_output',
        'not_submitted',
        'The chrome-use Perplexity backend does not support attachments.',
      );
    }
    if (request.model) {
      return failure(
        'invalid_output',
        'not_submitted',
        'The chrome-use Perplexity backend does not support model selection.',
      );
    }

    const session = sessionName(sessionPrefix, request.requestId);
    known.set(request.requestId, { submission: 'not_submitted' });
    const deadline = request.timeoutMs !== undefined ? nowMs() + request.timeoutMs : undefined;
    const remaining = (): number | undefined =>
      deadline === undefined ? undefined : Math.max(0, deadline - nowMs());
    const ensureTime = (submitted: boolean): FailureOutcome | undefined => {
      const left = remaining();
      if (left !== undefined && left <= 0) {
        if (submitted) {
          known.set(request.requestId, { submission: 'submitted' });
          return failure('timeout', 'submitted', 'Timed out waiting for the Perplexity answer.');
        }
        // Before submit nothing reached Perplexity; safe to retry.
        known.set(request.requestId, { submission: 'not_submitted' });
        return failure(
          'unavailable',
          'not_submitted',
          'Timed out before the prompt was sent to Perplexity.',
        );
      }
      return undefined;
    };

    let submitted = false;
    let partialText = '';

    const cleanup = async (): Promise<void> => {
      try {
        // Cleanup is lifecycle management: give it its own bounded budget so a
        // request timeout cannot starve tab/session teardown.
        await run(['--session', session, 'done', '--json'], 5_000);
      } catch {
        // best effort
      }
    };

    try {
      let t = ensureTime(false);
      if (t) return t;

      const opened = await cmd(session, ['open', PERPLEXITY_URL, '--json'], remaining(), false);
      if (!opened.ok) {
        known.set(request.requestId, { submission: opened.outcome.failure.submission });
        return opened.outcome;
      }

      await cmd(
        session,
        [
          'eval',
          `(() => { let n=0; for (const b of document.querySelectorAll('button[aria-label="Close"]')) { const r=b.getBoundingClientRect(); if (r.width>0&&r.height>0){b.click();n++;} } document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true})); return n; })()`,
          '--json',
        ],
        Math.min(remaining() ?? 8_000, 8_000),
        false,
      ).catch(() => undefined);

      t = ensureTime(false);
      if (t) return t;

      const waited = await cmd(
        session,
        ['wait', COMPOSER, '--json'],
        Math.min(remaining() ?? 20_000, 20_000),
        false,
      );
      if (!waited.ok) {
        const f = waited.outcome.failure;
        // Before submit nothing reached Perplexity; keep submission valid
        // (timeout kind requires submitted, so map pre-submit timeout to unavailable).
        const kind = f.kind === 'timeout' || f.kind === 'unknown_submission' ? 'unavailable' : f.kind;
        const out = failure(
          kind,
          'not_submitted',
          `Perplexity composer not available (log in to Perplexity in Chrome if required, or check the page): ${f.message}`,
        );
        known.set(request.requestId, { submission: 'not_submitted' });
        return out;
      }

      const base = await cmd(
        session,
        ['eval', `document.querySelectorAll('.prose').length`, '--json'],
        Math.min(remaining() ?? 8_000, 8_000),
        false,
      );
      if (!base.ok) {
        known.set(request.requestId, { submission: base.outcome.failure.submission });
        return base.outcome;
      }
      const baseCountRaw = dataRecord(base.json?.data)?.result;
      const baseline = typeof baseCountRaw === 'number' ? baseCountRaw : Number(baseCountRaw ?? 0);
      const baseIndex = Number.isFinite(baseline) ? baseline : 0;

      t = ensureTime(false);
      if (t) return t;

      // Prefer fill --stdin so the prompt travels via stdin (not argv); fall
      // back to eval with the script sent via stdin and validate the result.
      const fillRes = await cmd(
        session,
        ['fill', COMPOSER, '--stdin', '--json'],
        Math.min(remaining() ?? 30_000, 30_000),
        false,
        request.prompt,
      );
      if (!fillRes.ok) {
        const script = `(() => { const el = document.querySelector(${JSON.stringify(COMPOSER)}); if (!el) return false; el.focus(); const t = ${JSON.stringify(request.prompt)}; el.innerText = t; el.dispatchEvent(new Event('input',{bubbles:true})); el.dispatchEvent(new Event('change',{bubbles:true})); return (el.innerText||'').trim().length > 0; })()`;
        const evalFill = await cmd(
          session,
          ['eval', '--stdin', '--json'],
          Math.min(remaining() ?? 30_000, 30_000),
          false,
          script,
        );
        if (!evalFill.ok) {
          known.set(request.requestId, { submission: evalFill.outcome.failure.submission });
          return evalFill.outcome;
        }
        const fillValue = dataRecord(evalFill.json?.data)?.result;
        if (fillValue !== true) {
          return failure(
            'unavailable',
            'not_submitted',
            'The Perplexity composer did not accept the prompt (composer missing or prompt not entered).',
          );
        }
      }

      await cmd(session, ['press', 'Escape', '--json'], Math.min(remaining() ?? 3_000, 3_000), false).catch(
        () => undefined,
      );

      t = ensureTime(false);
      if (t) return t;

      const clicked = await cmd(
        session,
        ['click', SUBMIT, '--json'],
        Math.min(remaining() ?? 10_000, 10_000),
        false,
      );
      if (!clicked.ok) {
        const f = clicked.outcome.failure;
        const ambiguous = f.kind === 'timeout' || f.kind === 'unknown_submission' || disconnectLike(f.message);
        if (ambiguous) {
          // A failed/timed-out click may still have submitted; do not send
          // Enter (it could submit again). Report the ambiguous state.
          const sub: BackendSubmission = f.kind === 'timeout' ? 'submitted' : 'unknown';
          known.set(request.requestId, { submission: sub });
          return failure(
            f.kind === 'timeout' ? 'timeout' : 'unknown_submission',
            sub,
            `Submitting the prompt via click is ambiguous (it may have been sent): ${f.message}`,
          );
        }
        // Definite pre-submit click failure: try Enter as a fallback.
        const pressed = await cmd(
          session,
          ['press', 'Enter', '--json'],
          Math.min(remaining() ?? 5_000, 5_000),
          false,
        );
        if (!pressed.ok) {
          const pf = pressed.outcome.failure;
          known.set(request.requestId, { submission: pf.submission });
          return pressed.outcome;
        }
      }
      submitted = true;
      known.set(request.requestId, { submission: 'submitted' });

      let lastText = '';
      let stableCount = 0;
      let lastHtml = '';
      for (;;) {
        t = ensureTime(true);
        if (t) {
          if (partialText) t.failure.partialText = partialText;
          known.set(request.requestId, { submission: t.failure.submission, text: partialText || undefined, truncated: true });
          return t;
        }
        const snap = await cmd(
          session,
          [
            'eval',
            `(() => { const nodes = document.querySelectorAll('.prose'); const n = nodes.length; const el = nodes[${baseIndex}]; return { count:n, text: el ? (el.innerText||'').trim() : '', html: el ? (el.innerHTML||'') : '' }; })()`,
            '--json',
          ],
          Math.min(remaining() ?? 10_000, 10_000),
          true,
        );
        if (!snap.ok) {
          if (partialText) snap.outcome.failure.partialText = partialText;
          known.set(request.requestId, { submission: snap.outcome.failure.submission, text: partialText || undefined });
          return snap.outcome;
        }
        const data = dataRecord(snap.json?.data);
        const resultObj = isRecord(data?.result) ? (data?.result as Record<string, unknown>) : undefined;
        const count = typeof resultObj?.count === 'number' ? resultObj.count : Number(resultObj?.count ?? 0);
        const text = typeof resultObj?.text === 'string' ? resultObj.text : '';
        const html = typeof resultObj?.html === 'string' ? resultObj.html : '';
        if (Number.isFinite(count) && count > baseIndex && text) {
          if (text !== lastText) {
            lastText = text;
            lastHtml = html;
            partialText = text;
            stableCount = 0;
          } else {
            stableCount += 1;
            if (stableCount >= stablePolls) {
              const value: BackendResponse = {
                requestId: request.requestId,
                text: lastText,
                markdown: lastHtml || lastText,
                truncated: false,
                submission: 'submitted',
              };
              known.set(request.requestId, { submission: 'submitted', text: lastText, truncated: false });
              return { ok: true, value };
            }
          }
        } else {
          stableCount = 0;
        }
        await sleep(Math.min(pollMs, remaining() ?? pollMs));
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      const out = classifyCommandError(detail, submitted, false);
      known.set(request.requestId, { submission: out.failure.submission, text: partialText || undefined });
      return out;
    } finally {
      await cleanup();
    }
  };

  return {
    name: CHROME_USE_PERPLEXITY_BACKEND_NAME,
    capabilities: CHROME_USE_PERPLEXITY_CAPABILITIES,
    ask: (request) => serialize(() => ask(request)),
    status: async (requestId: string): Promise<BackendStatus> => {
      const k = known.get(requestId);
      // This POC keeps no persistent receipt across processes; without
      // in-process evidence the submission state is unknown (never claim
      // not_submitted for a request that may have been sent elsewhere).
      if (!k) return { requestId, submission: 'unknown' };
      return {
        requestId,
        submission: k.submission,
        ...(k.text ? { text: k.text } : {}),
        ...(k.truncated !== undefined ? { truncated: k.truncated } : {}),
        ...(k.cancelled !== undefined ? { cancelled: k.cancelled } : {}),
      };
    },
    resume: async (request: BackendRequest): Promise<BackendOutcome<BackendResponse>> =>
      failure(
        'invalid_output',
        'unknown',
        `The chrome-use Perplexity backend does not support resuming requests (request '${request.requestId}').`,
      ),
    cancel: async (_requestId: string): Promise<BackendOutcome<{ cancelled: boolean }>> => ({
      ok: true,
      value: { cancelled: false },
    }),
  };
}
