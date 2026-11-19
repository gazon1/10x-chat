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

/**
 * The margin between the bound of Playwright and the bound of the operation.
 *
 * The bound of the caller (the timeout option of Playwright) is the bound of
 * the operation itself. The margin gives the operation the time to report
 * its own timeout — a Playwright timeout is a normal answer, the bound of
 * the operation is the safety net for an operation that does not answer at
 * all.
 */
export const OPERATION_MARGIN_MS = 5_000;

/**
 * The margin between the bound of the operation and the bound of the RPC.
 *
 * The RPC bound is the final boundary of the call: it is above the bound of
 * the operation, so the operation can report its own timeout first.
 */
export const RPC_MARGIN_MS = 15_000;

/**
 * The margin between the bound of the RPC and the bound of the client.
 *
 * The client must wait longer than the server: the server answers the
 * timeout with an error and invalidates the session — the client has to be
 * able to read that answer. The margin covers the time the server needs for
 * the answer.
 */
export const CLIENT_BOUND_MARGIN_MS = 60_000;

/** The bound of a close that must not outlive the invalidation. */
export const CLOSE_TIMEOUT_MS = 5_000;

/**
 * The bound that the caller asked for, if the call names one.
 *
 * Playwright carries the bound of an operation in its options (`timeout`).
 * The caller knows how long it is willing to wait — a chat that waits for a
 * long answer asks for a long wait, and the bound of the service must not
 * be shorter than the wait of the caller.
 *
 * The index of the option argument of every method that carries one: the
 * bound is read from there and from nowhere else, so an argument that
 * happens to have a `timeout` field (the data of an `evaluate`) is not
 * mistaken for a bound.
 *
 * Only the methods of Playwright that take a `timeout` in their options are
 * listed. A method that takes no bound (`keyboard.press`, `locator.count`,
 * `page.evaluate`) is not in this table: it has no bound to preserve.
 */
const OPTIONS_ARG_INDEX: Record<string, number> = {
  'page.goto': 1,
  'page.waitForLoadState': 1,
  'page.waitForURL': 1,
  'page.waitForEvent': 1,
  // `waitForFunction(pageFunction, arg, options)`: the bound lives in the
  // third argument — the second one is the argument of the function.
  'page.waitForFunction': 2,
  'locator.waitFor': 0,
  'locator.isVisible': 0,
  'locator.click': 0,
  'locator.textContent': 0,
  'locator.innerHTML': 0,
  'locator.fill': 1,
  'locator.setInputFiles': 1,
};

/**
 * The bound that the caller asked for, if the call names one.
 *
 * `waitForTimeout` carries its bound in the sleep itself: the sleep is the
 * wait the caller ordered.
 */
export function requestedTimeoutMs(
  kind: string,
  method: string,
  args: unknown[] | undefined,
): number | undefined {
  if (kind === 'page' && method === 'waitForTimeout') {
    const sleep = args?.[0];
    return typeof sleep === 'number' && sleep > 0 ? sleep : undefined;
  }

  const index = OPTIONS_ARG_INDEX[`${kind}.${method}`];
  if (index === undefined) return undefined;

  const options = args?.[index];
  if (!options || typeof options !== 'object') return undefined;

  const timeout = (options as { timeout?: unknown }).timeout;
  return typeof timeout === 'number' && timeout > 0 ? timeout : undefined;
}

/**
 * The bound of one operation.
 *
 * The bound of the caller wins: an operation that waits longer than the
 * default bound of the service gets that time. The margin gives the
 * operation the time to report its own timeout — a Playwright timeout is a
 * normal answer, the bound of the operation is the safety net for an
 * operation that does not answer at all.
 */
export function operationBoundMs(requestedMs: number | undefined, defaultMs: number): number {
  return requestedMs === undefined ? defaultMs : requestedMs + OPERATION_MARGIN_MS;
}

/**
 * The final boundary of a whole call.
 *
 * It is above the bound of the operation — the operation reports its own
 * timeout first — and never below the default bound of the RPC.
 */
export function rpcBoundMs(operationMs: number, floorMs: number = RPC_TIMEOUT_MS): number {
  return Math.max(floorMs, operationMs + RPC_MARGIN_MS);
}

/**
 * The bound of the client request of an RPC.
 *
 * The client waits for the answer of the server: the boundary of the client
 * is above the boundary of the server.
 */
export function clientBoundMs(operationMs: number, floorMs: number = RPC_TIMEOUT_MS): number {
  return rpcBoundMs(operationMs, floorMs) + CLIENT_BOUND_MARGIN_MS;
}

/** The bounds of one call: the operation, the RPC and the client. */
export interface TimeoutPlan {
  /** The bound of the operation itself. */
  operationMs: number;
  /** The final boundary of the RPC. */
  rpcMs: number;
  /** The bound of the client that waits for the answer. */
  clientMs: number;
}

/**
 * The bounds of one call, derived from the bound the caller asked for.
 *
 * The three bounds are one hierarchy: the operation reports its own timeout
 * first, the RPC is the final boundary of the call, and the client waits
 * longer than the server — the server answers a hung call with an error, and
 * the client has to be able to read that answer.
 *
 * The client and the server derive the plan from the same request, so the
 * bound of the client is always above the bound of the server.
 */
export function timeoutPlan(
  requestedMs: number | undefined,
  operationDefaultMs: number = OPERATION_TIMEOUT_MS,
  rpcFloorMs: number = RPC_TIMEOUT_MS,
): TimeoutPlan {
  const operationMs = operationBoundMs(requestedMs, operationDefaultMs);
  const rpcMs = rpcBoundMs(operationMs, rpcFloorMs);
  return { operationMs, rpcMs, clientMs: rpcMs + CLIENT_BOUND_MARGIN_MS };
}

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
