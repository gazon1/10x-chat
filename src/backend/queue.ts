import type { BackendOutcome, BackendRequest } from './contract.js';
import { withQueueWait } from './contract.js';

/**
 * A small in-process request queue.
 *
 * It enforces a capacity limit at the backend boundary: at most `capacity`
 * requests run at the same time, the rest wait in FIFO order. The queue is the
 * session boundary for serialization — two backend instances that target the
 * same configured account/session must share one queue.
 *
 * The queue owns scheduling mechanics only: queue wait accounting, FIFO
 * waiting, abort-before-start, active slot counting, and wake. Backend-specific
 * active cancellation/error semantics stay in the backend.
 */
export interface RequestQueue {
  /** Enqueue a request; it starts when a slot is free. */
  enqueue<T extends { queueWaitMs?: number; activeSlots?: number; text?: string }>(
    request: BackendRequest,
    task: () => Promise<BackendOutcome<T>>,
    options?: {
      /** Best-effort backend cancellation when an active request is aborted. */
      onActiveAbort?: () => void;
    },
  ): Promise<BackendOutcome<T>>;
  /** Requests currently running. */
  readonly active: number;
  /** Requests waiting for a slot. */
  readonly waiting: number;
  /** Configured concurrency capacity. */
  readonly capacity: number;
}

interface WaitingEntry {
  signal?: AbortSignal;
  start: () => void;
  onAbort?: () => void;
}

function cancelledBeforeStart(requestId: string): BackendOutcome<never> {
  return {
    ok: false,
    failure: {
      kind: 'cancelled',
      message: `The request '${requestId}' was cancelled before it started.`,
      submission: 'not_submitted',
    },
  };
}

/**
 * Convert an aborted outcome to an explicit cancelled failure.
 *
 * If the backend already reported cancellation, keep it. If the backend returned
 * success after abort, preserve the answer as partial text and report cancelled
 * with submitted state. If the backend returned a different failure, preserve
 * submission/partial text and report cancelled.
 */
function cancelledAfterAbort<T extends { text?: string }>(
  requestId: string,
  outcome: BackendOutcome<T>,
): BackendOutcome<T> {
  if (!outcome.ok) {
    if (outcome.failure.kind === 'cancelled') return outcome;
    return {
      ok: false,
      failure: {
        kind: 'cancelled',
        message: `The request '${requestId}' was cancelled.`,
        submission: outcome.failure.submission === 'not_submitted' ? 'not_submitted' : 'submitted',
        ...(outcome.failure.partialText ? { partialText: outcome.failure.partialText } : {}),
      },
    };
  }
  const partialText =
    typeof outcome.value.text === 'string' && outcome.value.text !== ''
      ? outcome.value.text
      : undefined;
  return {
    ok: false,
    failure: {
      kind: 'cancelled',
      message: `The request '${requestId}' was cancelled.`,
      submission: 'submitted',
      ...(partialText ? { partialText } : {}),
    },
  };
}

const SHARED_QUEUES = new Map<string, RequestQueue>();

/**
 * Return a shared in-process queue for a session boundary.
 *
 * Backends that target the same configured account/session must share one
 * queue, otherwise two backend instances could exceed the session's concurrency
 * limit. The key should identify the actual session boundary (for example the
 * CLI command/profile that owns the browser session). Tests may pass an explicit
 * queue to avoid cross-test sharing.
 */
export function getSharedRequestQueue(key: string, capacity = 1): RequestQueue {
  const existing = SHARED_QUEUES.get(key);
  if (existing) return existing;
  const created = createRequestQueue(capacity);
  SHARED_QUEUES.set(key, created);
  return created;
}

/** Visible for tests only: clear shared queues. */
export function resetSharedRequestQueues(): void {
  SHARED_QUEUES.clear();
}

export function createRequestQueue(capacity = 1): RequestQueue {
  const limit = Math.max(1, Math.floor(capacity));
  let active = 0;
  const waiting: WaitingEntry[] = [];

  const removeWaiting = (entry: WaitingEntry): void => {
    const index = waiting.indexOf(entry);
    if (index >= 0) waiting.splice(index, 1);
  };

  const wake = (): void => {
    while (active < limit && waiting.length > 0) {
      const next = waiting.shift();
      if (!next) return;
      if (next.onAbort && next.signal) next.signal.removeEventListener('abort', next.onAbort);
      active += 1;
      next.start();
    }
  };

  const enqueue: RequestQueue['enqueue'] = (request, task, options) => {
    const queuedAt = Date.now();
    return new Promise((resolve) => {
      let settled = false;
      const finish = (outcome: BackendOutcome<any>): void => {
        if (settled) return;
        settled = true;
        resolve(outcome);
      };

      const start = (): void => {
        if (request.signal?.aborted) {
          active = Math.max(0, active - 1);
          wake();
          finish(cancelledBeforeStart(request.requestId));
          return;
        }
        const startedAt = Date.now();
        const onActiveAbort = request.signal
          ? (): void => {
              options?.onActiveAbort?.();
            }
          : undefined;
        if (onActiveAbort && request.signal) {
          request.signal.addEventListener('abort', onActiveAbort, { once: true });
        }
        void task()
          .catch(
            (error): BackendOutcome<any> => ({
              ok: false,
              failure: {
                kind: 'invalid_output',
                message: error instanceof Error ? error.message : String(error),
                submission: 'unknown',
              },
            }),
          )
          .then((outcome) => {
            if (request.signal?.aborted) {
              finish(
                withQueueWait(
                  cancelledAfterAbort(request.requestId, outcome),
                  startedAt - queuedAt,
                  active,
                ),
              );
              return;
            }
            finish(withQueueWait(outcome, startedAt - queuedAt, active));
          })
          .finally(() => {
            if (onActiveAbort && request.signal) {
              request.signal.removeEventListener('abort', onActiveAbort);
            }
            active = Math.max(0, active - 1);
            wake();
          });
      };

      if (request.signal?.aborted) {
        finish(cancelledBeforeStart(request.requestId));
        return;
      }

      if (active < limit) {
        active += 1;
        start();
        return;
      }

      const entry: WaitingEntry = { signal: request.signal, start };
      if (request.signal) {
        const onAbort = (): void => {
          removeWaiting(entry);
          finish(cancelledBeforeStart(request.requestId));
        };
        entry.onAbort = onAbort;
        request.signal.addEventListener('abort', onAbort, { once: true });
      }
      waiting.push(entry);
    });
  };

  return {
    enqueue,
    get active() {
      return active;
    },
    get waiting() {
      return waiting.length;
    },
    capacity: limit,
  };
}
