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
import { nodeProcessRunner, type ProcessResult, type ProcessRunner } from './process-runner.js';
import { createRequestQueue, getSharedRequestQueue, type RequestQueue } from './queue.js';

export type { ProcessResult, ProcessRunner };
export { nodeProcessRunner };

/**
 * Perplexity POC driven by the `chrome-use` CLI (user's real Chrome via the
 * extension relay). Narrow adapter: no Playwright/Page objects cross this
 * boundary. Site-specific selectors and flow live here only.
 *
 * POC limits (explicit, never silent): no attachments, model selection, image
 * output, streaming chunks, conversation reuse, or cancellation. One ask = one
 * chrome-use session; tabs are closed with `done` on every path.
 */

export const CHROME_USE_PERPLEXITY_BACKEND_NAME = 'chrome-use-perplexity';

export const CHROME_USE_PERPLEXITY_CAPABILITIES: BackendCapabilities = Object.freeze({
  attachments: false,
  streaming: false,
  // Before-submission cancellation is explicit. Active cancellation is best
  // effort and not guaranteed to interrupt an in-flight chrome-use command.
  cancellation: false,
  conversationReuse: false,
  modelSelection: false,
  imageOutput: false,
  maxConcurrentRequests: 1,
});

const PERPLEXITY_URL = 'https://www.perplexity.ai';
const COMPOSER = 'div[role="textbox"][contenteditable="true"]';
const SUBMIT = 'button[aria-label="Submit"]';
const CMD_TIMEOUT_FLOOR_MS = 5_000;

/**
 * The marker of a command that never ran.
 *
 * A chrome-use that could not be started created no session, so there is
 * nothing to tear down; a command that ran may have created one.
 */
const NOT_STARTED = 'could not be started';

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
  /**
   * Serialization boundary for this backend.
   *
   * By default, backends created in the same process with the same `command`
   * share a queue. That models one chrome-use/Chrome session boundary per CLI
   * command. Pass an explicit queue to isolate tests or intentionally model a
   * separate session.
   */
  queue?: RequestQueue;
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
  return {
    ok: false,
    failure: { kind, submission, message, ...(partialText ? { partialText } : {}) },
  };
}

function unavailable(
  message: string,
  submission: BackendSubmission = 'not_submitted',
): FailureOutcome {
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
    if (submitted) {
      return failure(
        'timeout',
        'submitted',
        `Timed out waiting for the Perplexity answer: ${detail}`,
      );
    }
    // Pre-submit command timeout: no submit attempt was made from this call.
    return failure(
      'unavailable',
      'not_submitted',
      `Timed out before the prompt was sent to Perplexity: ${detail}`,
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
  const stablePolls = options.stablePolls ?? 5;
  // Best-effort in-process record: this POC has no persistent receipt, but
  // status() must not lie about a request it already handled in this process.
  const known = new Map<
    string,
    { submission: BackendSubmission; text?: string; truncated?: boolean; cancelled?: boolean }
  >();

  const capacity = CHROME_USE_PERPLEXITY_CAPABILITIES.maxConcurrentRequests ?? 1;
  // Session boundary: same configured chrome-use command/profile => same queue
  // by default. Custom runners (tests/injected process boundaries) get an
  // isolated queue unless an explicit queue is passed.
  const queue =
    options.queue ??
    (options.runner && options.runner !== nodeProcessRunner
      ? createRequestQueue(capacity)
      : getSharedRequestQueue(`chrome-use-perplexity:${command}`, capacity));
  // Per-session active request ids (in-process). This is best-effort and only
  // tracks requests submitted through this process boundary.
  const activeRequestIds = new Set<string>();

  const queued = (
    request: BackendRequest,
    task: () => Promise<BackendOutcome<BackendResponse>>,
  ): Promise<BackendOutcome<BackendResponse>> =>
    queue.enqueue(request, task);

  const run = async (
    args: string[],
    timeoutMs?: number,
    input?: string,
    signal?: AbortSignal,
  ): Promise<{ result?: ProcessResult; started: boolean; startError?: string }> => {
    try {
      const result = await runner.run(command, args, { timeoutMs, input, ...(signal ? { signal } : {}) });
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
    submitAttempt = false,
    signal?: AbortSignal,
  ): Promise<
    | { ok: true; json?: ChromeJson; result: ProcessResult }
    | { ok: false; outcome: FailureOutcome; started: boolean }
  > => {
    // Respect the caller/request budget: never run a command longer than the
    // remaining deadline (a floor above it would violate timeoutMs).
    const budget = timeoutMs ?? CMD_TIMEOUT_FLOOR_MS;
    const runTimeout =
      timeoutMs === undefined ? Math.max(budget, CMD_TIMEOUT_FLOOR_MS) : Math.max(budget, 1);
    const { result, started, startError } = await run(
      ['--session', session, ...sub],
      runTimeout,
      input,
      signal,
    );
    if (!started || !result) {
      const detail = startError ?? 'failed to start chrome-use';
      if (/ENOENT/i.test(detail)) {
        if (submitted || submitAttempt) {
          return {
            ok: false,
            outcome: failure(
              'unknown_submission',
              'unknown',
              `chrome-use ${NOT_STARTED} (prompt may have been submitted): ${detail}`,
            ),
            started: false,
          };
        }
        return {
          ok: false,
          outcome: unavailable(`chrome-use ${NOT_STARTED}: ${detail}`),
          started: false,
        };
      }
      if (submitAttempt && !submitted) {
        return {
          ok: false,
          outcome: failure(
            'unknown_submission',
            'unknown',
            `Failed to start submit command (prompt may have been submitted): ${detail}`,
          ),
          started: false,
        };
      }
      return {
        ok: false,
        outcome: classifyCommandError(detail, submitted, false),
        started: false,
      };
    }
    if (result.cancelled || signal?.aborted) {
      return {
        ok: false,
        outcome: failure(
          'cancelled',
          submitted ? 'submitted' : 'not_submitted',
          `The chrome-use command was cancelled (${sub[0] ?? 'chrome-use'}).`,
        ),
        started: true,
      };
    }
    if (result.timedOut) {
      if (submitAttempt && !submitted) {
        return {
          ok: false,
          outcome: failure(
            'timeout',
            'submitted',
            `command timed out (${sub[0] ?? 'chrome-use'}) - prompt may have been submitted`,
          ),
          started: true,
        };
      }
      return {
        ok: false,
        outcome: classifyCommandError(
          `command timed out (${sub[0] ?? 'chrome-use'})`,
          submitted,
          true,
        ),
        started: true,
      };
    }
    const json = parseJson(result.stdout);
    if (json && json.success === false) {
      const detail =
        typeof json.error === 'string' ? json.error : JSON.stringify(json.error ?? json);
      if (submitAttempt && !submitted) {
        return {
          ok: false,
          outcome: failure(
            'unknown_submission',
            'unknown',
            `Submit command failed (prompt may have been submitted): ${detail}`,
          ),
          started: true,
        };
      }
      return { ok: false, outcome: classifyCommandError(detail, submitted, false), started: true };
    }
    if (result.code !== 0) {
      const detail =
        (typeof json?.error === 'string' ? json.error : undefined) ||
        (result.stderr || result.stdout || `exit ${result.code}`).trim();
      if (submitAttempt && !submitted) {
        return {
          ok: false,
          outcome: failure(
            'unknown_submission',
            'unknown',
            `Submit command failed (prompt may have been submitted): ${detail || 'chrome-use failed'}`,
          ),
          started: true,
        };
      }
      return {
        ok: false,
        outcome: classifyCommandError(detail || 'chrome-use failed', submitted, false),
        started: true,
      };
    }
    if (json?.success !== true) {
      const detail = (result.stderr || result.stdout || 'invalid chrome-use JSON envelope').trim();
      if (submitAttempt && !submitted) {
        return {
          ok: false,
          outcome: failure(
            'unknown_submission',
            'unknown',
            `Submit command returned invalid result (prompt may have been submitted): ${detail || 'invalid chrome-use JSON envelope'}`,
          ),
          started: true,
        };
      }
      return {
        ok: false,
        outcome: classifyCommandError(
          detail || 'invalid chrome-use JSON envelope',
          submitted,
          false,
        ),
        started: true,
      };
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
    const ensureNotAborted = (submitted: boolean): FailureOutcome | undefined => {
      if (!request.signal?.aborted) return undefined;
      const submission = submitted ? 'submitted' : 'not_submitted';
      known.set(request.requestId, {
        submission,
        text: partialText || undefined,
        cancelled: true,
      });
      return failure('cancelled', submission, `The request '${request.requestId}' was cancelled.`);
    };

    let submitted = false;
    let partialText = '';
    // A session exists only after the open command was issued and only when the
    // process really started. A request whose deadline expired before the first
    // command must not touch the browser at all, and a chrome-use that could not
    // start created no session to tear down.
    let sessionStarted = false;

    const cleanup = async (): Promise<void> => {
      if (!sessionStarted) return;
      try {
        // Cleanup is lifecycle management: give it its own bounded budget so a
        // request timeout cannot starve tab/session teardown.
        await run(['--session', session, 'done', '--json'], 5_000);
      } catch {
        // best effort
      }
    };

    activeRequestIds.add(request.requestId);
    try {
      let t = ensureNotAborted(false) ?? ensureTime(false);
      if (t) return t;

      const opened = await cmd(
        session,
        ['open', PERPLEXITY_URL, '--json'],
        remaining(),
        false,
        undefined,
        false,
        request.signal,
      );
      if (!opened.ok) {
        // A chrome-use that never ran created no session: there is nothing to
        // tear down. A command that ran may have created one.
        sessionStarted = opened.started;
        known.set(request.requestId, {
          submission: opened.outcome.failure.submission,
          cancelled: opened.outcome.failure.kind === 'cancelled' ? true : undefined,
        });
        return opened.outcome;
      }
      sessionStarted = true;

      await cmd(
        session,
        [
          'eval',
          `(() => { let n=0; for (const b of document.querySelectorAll('button[aria-label="Close"]')) { const r=b.getBoundingClientRect(); if (r.width>0&&r.height>0){b.click();n++;} } document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true})); return n; })()`,
          '--json',
        ],
        Math.min(remaining() ?? 8_000, 8_000),
        false,
        undefined,
        false,
        request.signal,
      ).catch(() => undefined);

      t = ensureNotAborted(false) ?? ensureTime(false);
      if (t) return t;

      const waited = await cmd(
        session,
        ['wait', COMPOSER, '--json'],
        Math.min(remaining() ?? 20_000, 20_000),
        false,
        undefined,
        false,
        request.signal,
      );
      if (!waited.ok) {
        const f = waited.outcome.failure;
        if (f.kind === 'cancelled') {
          known.set(request.requestId, { submission: f.submission, cancelled: true });
          return waited.outcome;
        }
        // Before submit nothing reached Perplexity; keep submission valid
        // (timeout kind requires submitted, so map pre-submit timeout to unavailable).
        const kind =
          f.kind === 'timeout' || f.kind === 'unknown_submission' ? 'unavailable' : f.kind;
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
        undefined,
        false,
        request.signal,
      );
      if (!base.ok) {
        known.set(request.requestId, {
          submission: base.outcome.failure.submission,
          cancelled: base.outcome.failure.kind === 'cancelled' ? true : undefined,
        });
        return base.outcome;
      }
      const baseCountRaw = dataRecord(base.json?.data)?.result;
      const baseline = typeof baseCountRaw === 'number' ? baseCountRaw : Number(baseCountRaw ?? 0);
      const baseIndex = Number.isFinite(baseline) ? baseline : 0;

      t = ensureNotAborted(false) ?? ensureTime(false);
      if (t) return t;

      // Prefer fill --stdin so the prompt travels via stdin (not argv); fall
      // back to eval with the script sent via stdin and validate the result.
      const fillRes = await cmd(
        session,
        ['fill', COMPOSER, '--stdin', '--json'],
        Math.min(remaining() ?? 30_000, 30_000),
        false,
        request.prompt,
        false,
        request.signal,
      );
      if (!fillRes.ok) {
        if (fillRes.outcome.failure.kind === 'cancelled') {
          known.set(request.requestId, { submission: fillRes.outcome.failure.submission, cancelled: true });
          return fillRes.outcome;
        }
        const script = `(() => { const el = document.querySelector(${JSON.stringify(COMPOSER)}); if (!el) return false; el.focus(); const t = ${JSON.stringify(request.prompt)}; el.innerText = t; el.dispatchEvent(new Event('input',{bubbles:true})); el.dispatchEvent(new Event('change',{bubbles:true})); return (el.innerText||'').trim().length > 0; })()`;
        const evalFill = await cmd(
          session,
          ['eval', '--stdin', '--json'],
          Math.min(remaining() ?? 30_000, 30_000),
          false,
          script,
          false,
          request.signal,
        );
        if (!evalFill.ok) {
          known.set(request.requestId, {
            submission: evalFill.outcome.failure.submission,
            cancelled: evalFill.outcome.failure.kind === 'cancelled' ? true : undefined,
          });
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

      await cmd(
        session,
        ['press', 'Escape', '--json'],
        Math.min(remaining() ?? 3_000, 3_000),
        false,
        undefined,
        false,
        request.signal,
      ).catch(() => undefined);

      t = ensureNotAborted(false) ?? ensureTime(false);
      if (t) return t;

      const clicked = await cmd(
        session,
        ['click', SUBMIT, '--json'],
        Math.min(remaining() ?? 10_000, 10_000),
        false,
        undefined,
        true,
        request.signal,
      );
      if (!clicked.ok) {
        // A failed click cannot be proven unexecuted; never retry with Enter.
        known.set(request.requestId, {
          submission: clicked.outcome.failure.submission,
          cancelled: clicked.outcome.failure.kind === 'cancelled' ? true : undefined,
        });
        return clicked.outcome;
      }
      submitted = true;
      known.set(request.requestId, { submission: 'submitted' });

      let lastText = '';
      let stableCount = 0;
      let lastHtml = '';
      for (;;) {
        t = ensureNotAborted(true) ?? ensureTime(true);
        if (t) {
          if (partialText) t.failure.partialText = partialText;
          known.set(request.requestId, {
            submission: t.failure.submission,
            text: partialText || undefined,
            truncated: t.failure.kind === 'timeout' ? true : undefined,
            cancelled: t.failure.kind === 'cancelled' ? true : undefined,
          });
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
          undefined,
          false,
          request.signal,
        );
        if (!snap.ok) {
          if (partialText) snap.outcome.failure.partialText = partialText;
          known.set(request.requestId, {
            submission: snap.outcome.failure.submission,
            text: partialText || undefined,
            cancelled: snap.outcome.failure.kind === 'cancelled' ? true : undefined,
          });
          return snap.outcome;
        }
        const data = dataRecord(snap.json?.data);
        const resultObj = isRecord(data?.result)
          ? (data?.result as Record<string, unknown>)
          : undefined;
        const count =
          typeof resultObj?.count === 'number' ? resultObj.count : Number(resultObj?.count ?? 0);
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
              known.set(request.requestId, {
                submission: 'submitted',
                text: lastText,
                truncated: false,
              });
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
      const out = request.signal?.aborted
        ? failure(
            'cancelled',
            submitted ? 'submitted' : 'not_submitted',
            `The request '${request.requestId}' was cancelled.`,
            partialText || undefined,
          )
        : classifyCommandError(detail, submitted, false);
      known.set(request.requestId, {
        submission: out.failure.submission,
        text: partialText || undefined,
        cancelled: out.failure.kind === 'cancelled' ? true : undefined,
      });
      return out;
    } finally {
      activeRequestIds.delete(request.requestId);
      await cleanup();
    }
  };

  return {
    name: CHROME_USE_PERPLEXITY_BACKEND_NAME,
    capabilities: CHROME_USE_PERPLEXITY_CAPABILITIES,
    ask: (request) => queued(request, () => ask(request)),
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
    cancel: async (_requestId: string): Promise<BackendOutcome<{ cancelled: boolean }>> => {
      // This POC has no persistent receipt and cannot safely interrupt an active
      // chrome-use command across process boundaries. It reports the explicit
      // before-submission cancellation contract: queue/signal-driven cancellation
      // is supported; active in-flight interruption is not guaranteed.
      return { ok: true, value: { cancelled: false } };
    },
  };
}
