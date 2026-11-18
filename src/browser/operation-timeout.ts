/**
 * The bound of one browser operation.
 *
 * An operation that does not answer within its bound is not finished: it may
 * still run inside the browser and leave the page in an unknown state. The
 * session of such an operation must be invalidated instead of being used
 * again — see `invalidatedHandle`.
 */
export const OPERATION_TIMEOUT_MS = 60_000;

/** The bound of a whole RPC. */
export const RPC_TIMEOUT_MS = 180_000;

/** The bound of a close that must not outlive the invalidation. */
export const CLOSE_TIMEOUT_MS = 5_000;

/** An operation that did not answer within its bound. */
export class OperationTimeoutError extends Error {
  constructor(
    readonly label: string,
    readonly timeoutMs: number,
  ) {
    super(`${label} did not answer within ${timeoutMs}ms`);
    this.name = 'OperationTimeoutError';
  }
}

/**
 * The bound of an operation.
 *
 * The operation itself is not cancelled by the bound — it is still running in
 * the browser. The caller has to invalidate the session of the operation, so
 * a later operation cannot work on a half-changed page.
 */
export async function withOperationTimeout<T>(
  operation: Promise<T>,
  label: string,
  timeoutMs: number = OPERATION_TIMEOUT_MS,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new OperationTimeoutError(label, timeoutMs)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Run an operation with a bound, and clean up its result if it arrives late.
 *
 * The creation of a browser context (or of a page) can outlast the bound of
 * the operation. The client never learns the id of such a context, so nobody
 * can close it any more — it stays in the browser for good. The late result
 * is closed instead of being used.
 */
export async function withLateResultCleanup<T>(
  creation: Promise<T>,
  label: string,
  timeoutMs: number,
  cleanup: (value: T) => Promise<void>,
): Promise<T> {
  try {
    return await withOperationTimeout(creation, label, timeoutMs);
  } catch (error) {
    void creation.then(
      (value) => {
        void Promise.resolve()
          .then(() => cleanup(value))
          .catch(() => undefined);
      },
      () => undefined,
    );
    throw error;
  }
}

/** The handle of the session that an operation works on. */
export interface SessionHandle {
  pageId?: string;
  contextId?: string;
}

/**
 * The session that a timed-out operation leaves in an unknown state.
 *
 * A page is the narrowest session: an operation on a page may still change
 * the page, and the next operation on the same page would work on a
 * half-changed document. Without a page the whole context is invalidated.
 */
export function invalidatedHandle(
  target: SessionHandle | undefined,
): { kind: 'page' | 'context'; id: string } | null {
  if (!target) return null;
  if (target.pageId) return { kind: 'page', id: target.pageId };
  if (target.contextId) return { kind: 'context', id: target.contextId };
  return null;
}

/**
 * The handles that must not be used any more.
 *
 * A handle of an invalidated session is refused with a clear error, so the
 * caller knows that the run cannot continue on it.
 */
export class InvalidatedHandles {
  private readonly handles = new Set<string>();

  invalidate(kind: 'page' | 'context', id: string): void {
    this.handles.add(`${kind}:${id}`);
  }

  isInvalidated(kind: 'page' | 'context', id: string): boolean {
    return this.handles.has(`${kind}:${id}`);
  }
}

/**
 * Invalidate the session of an operation that did not answer in time.
 *
 * A timed-out operation may still run inside the browser and leave the page
 * in an unknown state: the session of the operation must not be used any more
 * before the next operation is accepted. An operation that failed for another
 * reason leaves the session alone — the browser is in a known state.
 *
 * Returns the invalidated session, or null when there is nothing to
 * invalidate.
 */
export async function invalidateOnTimeout(
  error: unknown,
  target: SessionHandle | undefined,
  invalidate: (handle: { kind: 'page' | 'context'; id: string }) => Promise<void>,
): Promise<{ kind: 'page' | 'context'; id: string } | null> {
  if (!(error instanceof OperationTimeoutError)) return null;
  const handle = invalidatedHandle(target);
  if (!handle) return null;
  await invalidate(handle);
  return handle;
}
