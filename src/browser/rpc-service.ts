/**
 * The RPC service of the browser daemon.
 *
 * The daemon speaks HTTP: the client sends a request, the service runs the
 * Playwright operation and answers. The service owns the sessions (contexts
 * and pages) and the bound of every operation: an operation that does not
 * answer in time invalidates its session, so a later operation cannot work on
 * a half-changed page.
 *
 * The service is a class on purpose: a test can drive the real lifecycle with
 * a browser of its own — no daemon, no real browser.
 */
import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Browser, BrowserContext, Download, FileChooser, Locator, Page } from 'playwright';
import { redactText } from './diagnostics.js';
import { getEngineName } from './engine.js';
import {
  CLOSE_TIMEOUT_MS,
  InvalidatedHandles,
  invalidateOnTimeout,
  OPERATION_TIMEOUT_MS,
  operationBoundMs,
  RPC_TIMEOUT_MS,
  requestedTimeoutMs,
  timeoutPlan,
  withLateResultCleanup,
  withOperationTimeout,
} from './operation-timeout.js';
import { STEALTH_INIT_SCRIPT } from './stealth.js';
import { SwitchGate } from './switch-gate.js';

export function redactError(error: unknown): string {
  const msg = error instanceof Error ? error.message : String(error);
  return redactText(msg);
}

type JsonPrimitive = boolean | number | string | null;

export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

type SerializedValue =
  | JsonValue
  | { __type: 'regexp'; source: string; flags: string }
  | { __type: 'function'; source: string };

type LocatorStep =
  | { type: 'locator'; selector: string }
  | { type: 'getByRole'; role: string; options?: JsonValue }
  | { type: 'first' }
  | { type: 'last' }
  | { type: 'nth'; index: number };

export interface RpcRequest {
  kind: 'browser' | 'context' | 'page' | 'locator' | 'keyboard' | 'event';
  method: string;
  target?: {
    contextId?: string;
    pageId?: string;
    steps?: LocatorStep[];
    eventId?: string;
  };
  args?: SerializedValue[];
}

export interface RpcSuccess {
  ok: true;
  result?: JsonValue | RemoteHandle;
  pageState?: { pageId: string; url: string };
}

export interface RpcError {
  ok: false;
  error: string;
}

export type RpcResponse = RpcSuccess | RpcError;

export interface RemoteHandle {
  __handle: true;
  handleType: 'context' | 'page' | 'filechooser' | 'download';
  id: string;
  contextId?: string;
  pageId?: string;
  url?: string;
  suggestedFilename?: string;
}

export interface RpcServiceOptions {
  /** The browser of the service. */
  browser: Browser | null;
  /** The barrier of a switching daemon. */
  switchGate?: SwitchGate;
  /** The bound of one browser operation. */
  operationTimeoutMs?: number;
  /** The bound of a whole RPC. */
  rpcTimeoutMs?: number;
  /** The bound of a close that must not outlive the invalidation. */
  closeTimeoutMs?: number;
}

function serializeValue(value: unknown): JsonValue {
  if (value === undefined) return null;
  return value as JsonValue;
}

function deserializeValue(value: SerializedValue): unknown {
  if (value && typeof value === 'object') {
    if ('__type' in value && value.__type === 'regexp') {
      return new RegExp(String(value.source), String(value.flags));
    }

    if ('__type' in value && value.__type === 'function') {
      return new Function(`return (${value.source});`)();
    }

    if (Array.isArray(value)) {
      return value.map((entry) => deserializeValue(entry as SerializedValue));
    }

    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        deserializeValue(entry as SerializedValue),
      ]),
    );
  }

  return value;
}

function toContextHandle(contextId: string): RemoteHandle {
  return {
    __handle: true,
    handleType: 'context',
    id: contextId,
  };
}

function toPageHandle(pageId: string, contextId: string, page: Page): RemoteHandle {
  return {
    __handle: true,
    handleType: 'page',
    id: pageId,
    contextId,
    pageId,
    url: page.url(),
  };
}

/**
 * The handle of a file chooser.
 *
 * The page is part of the handle: the client sends it back with the event, so
 * a timed-out event operation invalidates the page of the event and not
 * nothing.
 */
function toFileChooserHandle(eventId: string, pageId: string): RemoteHandle {
  return {
    __handle: true,
    handleType: 'filechooser',
    id: eventId,
    pageId,
  };
}

/** The handle of a download. The page is part of it, like the file chooser. */
function toDownloadHandle(eventId: string, pageId: string, download: Download): RemoteHandle {
  return {
    __handle: true,
    handleType: 'download',
    id: eventId,
    pageId,
    suggestedFilename: download.suggestedFilename(),
  };
}

function resolveLocator(page: Page, steps?: LocatorStep[]): Locator {
  if (!steps || steps.length === 0) {
    throw new Error('Missing locator steps');
  }

  let current: Page | Locator = page;
  for (const step of steps) {
    switch (step.type) {
      case 'locator':
        current = current.locator(step.selector);
        break;
      case 'getByRole':
        current = current.getByRole(
          step.role as never,
          deserializeValue(step.options ?? {}) as never,
        );
        break;
      case 'first':
        current = (current as Locator).first();
        break;
      case 'last':
        current = (current as Locator).last();
        break;
      case 'nth':
        current = (current as Locator).nth(step.index);
        break;
    }
  }

  return current as Locator;
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf-8'));
}

export class RpcService {
  private readonly browser: Browser | null;
  private readonly switchGate: SwitchGate;
  private readonly operationTimeoutMs: number;
  private readonly rpcTimeoutMs: number;
  private readonly closeTimeoutMs: number;

  private readonly contexts = new Map<string, BrowserContext>();
  private readonly pages = new Map<string, { page: Page; contextId: string }>();
  private readonly fileChoosers = new Map<string, FileChooser>();
  private readonly downloads = new Map<string, Download>();
  /**
   * The sessions of the operations that did not answer in time.
   *
   * Their handle is refused from now on: the operation may still run in the
   * browser, and a later operation on the same page would work on a
   * half-changed document.
   */
  private readonly invalidatedHandles = new InvalidatedHandles();
  private activePageCount = 0;

  constructor(options: RpcServiceOptions) {
    this.browser = options.browser;
    this.switchGate = options.switchGate ?? new SwitchGate();
    this.operationTimeoutMs = options.operationTimeoutMs ?? OPERATION_TIMEOUT_MS;
    this.rpcTimeoutMs = options.rpcTimeoutMs ?? RPC_TIMEOUT_MS;
    this.closeTimeoutMs = options.closeTimeoutMs ?? CLOSE_TIMEOUT_MS;
  }

  /** The state of the service, for the health endpoint of the daemon. */
  health(): {
    activeContexts: number;
    activePages: number;
    pendingCreations: number;
    switching: boolean;
  } {
    return {
      activeContexts: this.contexts.size,
      activePages: this.activePageCount,
      pendingCreations: this.switchGate.pendingCreations,
      switching: this.switchGate.isClosed,
    };
  }

  /**
   * The HTTP endpoint of the RPC.
   *
   * A call that does not answer within its bound fails here, and the session
   * of the operation is invalidated: the operation may still run inside the
   * browser, and a later operation on it would work on a half-changed page.
   */
  async handleRpcRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const startedAt = Date.now();
    let rpcLabel = 'unknown';
    let body: RpcRequest | undefined;
    try {
      body = (await readJsonBody(req)) as RpcRequest;
      rpcLabel = `${body.kind}.${body.method}`;
      // The bound is derived from the bound the caller asked for: a call that
      // waits for a long answer gets a long wait, and the final boundary of
      // the RPC stays above the bound of the operation — the operation reports
      // its own timeout first.
      const plan = timeoutPlan(
        requestedTimeoutMs(body.kind, body.method, body.args as unknown[] | undefined),
        this.operationTimeoutMs,
        this.rpcTimeoutMs,
      );
      const response = await withOperationTimeout(
        this.handleRpc(body),
        `rpc ${rpcLabel}`,
        plan.rpcMs,
      );
      // One line per call: a hung page operation is only visible in the
      // timings, not in the error of the client that waited for it.
      console.log(`[rpc] ${rpcLabel} ok ${Date.now() - startedAt}ms`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(response));
    } catch (error) {
      // A timed-out operation may still run inside the browser: the session of
      // the operation must not be used any more.
      const invalidated = await invalidateOnTimeout(error, body?.target, (handle) =>
        this.invalidateSession(handle),
      );
      if (invalidated) {
        console.error(
          `[rpc] ${rpcLabel} invalidated the session ${invalidated.kind} ${invalidated.id}`,
        );
      }
      console.error(`[rpc] ${rpcLabel} failed ${Date.now() - startedAt}ms: ${redactError(error)}`);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          ok: false,
          error: redactError(error),
        } satisfies RpcError),
      );
    }
  }

  private getContext(contextId?: string): BrowserContext {
    if (!contextId) {
      throw new Error('Missing contextId');
    }

    if (this.invalidatedHandles.isInvalidated('context', contextId)) {
      throw new Error(
        `Context ${contextId} was invalidated after a timed-out operation: this session is not usable any more.`,
      );
    }

    const context = this.contexts.get(contextId);
    if (!context) {
      throw new Error(`Context not found: ${contextId}`);
    }
    return context;
  }

  private getPage(pageId?: string): { page: Page; contextId: string } {
    if (!pageId) {
      throw new Error('Missing pageId');
    }

    if (this.invalidatedHandles.isInvalidated('page', pageId)) {
      throw new Error(
        `Page ${pageId} was invalidated after a timed-out operation: this session is not usable any more.`,
      );
    }

    const page = this.pages.get(pageId);
    if (!page) {
      throw new Error(`Page not found: ${pageId}`);
    }
    return page;
  }

  /**
   * Invalidate the session of an operation that did not answer in time.
   *
   * The operation may still run inside the browser. Closing the page aborts
   * the pending action of Playwright, and the handle is refused from now on:
   * the next operation on it fails with a clear error instead of working on a
   * half-changed page.
   */
  private async invalidateSession(handle: { kind: 'page' | 'context'; id: string }): Promise<void> {
    if (handle.kind === 'page') {
      const entry = this.pages.get(handle.id);
      this.pages.delete(handle.id);
      this.invalidatedHandles.invalidate('page', handle.id);
      if (!entry) return;
      this.activePageCount = Math.max(0, this.activePageCount - 1);
      await withOperationTimeout(entry.page.close(), 'page.close', this.closeTimeoutMs).catch(
        () => undefined,
      );
      return;
    }

    const context = this.contexts.get(handle.id);
    this.contexts.delete(handle.id);
    this.invalidatedHandles.invalidate('context', handle.id);
    for (const [pageId, entry] of this.pages.entries()) {
      if (entry.contextId !== handle.id) continue;
      this.pages.delete(pageId);
      this.invalidatedHandles.invalidate('page', pageId);
      this.activePageCount = Math.max(0, this.activePageCount - 1);
      await withOperationTimeout(entry.page.close(), 'page.close', this.closeTimeoutMs).catch(
        () => undefined,
      );
    }
    if (!context) return;
    await withOperationTimeout(context.close(), 'context.close', this.closeTimeoutMs).catch(
      () => undefined,
    );
  }

  private buildPageState(pageId: string): { pageId: string; url: string } {
    const entry = this.pages.get(pageId);
    return {
      pageId,
      url: entry?.page.url() ?? 'about:blank',
    };
  }

  /**
   * The bound of one operation.
   *
   * The bound the caller asked for wins: a call that waits for a long answer
   * gets a long wait. The default bound of the service is the bound of an
   * operation that names no bound of its own.
   */
  private operationBound(kind: string, method: string, args: unknown[] | undefined): number {
    return operationBoundMs(requestedTimeoutMs(kind, method, args), this.operationTimeoutMs);
  }

  /**
   * Run a blocking Playwright operation with the bound of the operation.
   *
   * Every dispatched operation goes through here: no operation waits longer
   * than the bound of the operation, whatever the method is. The bound of the
   * RPC stays above it — it is the final boundary of the call, not the bound
   * of the operation.
   */
  private async run<T>(
    kind: string,
    method: string,
    args: unknown[] | undefined,
    label: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    return withOperationTimeout(operation(), label, this.operationBound(kind, method, args));
  }

  private attachPage(page: Page, contextId: string): string {
    const pageId = randomUUID();
    this.pages.set(pageId, { page, contextId });
    this.activePageCount++;

    page.on('close', () => {
      if (this.pages.delete(pageId)) {
        this.activePageCount = Math.max(0, this.activePageCount - 1);
      }
    });

    return pageId;
  }

  private async handleRpc(body: RpcRequest): Promise<RpcResponse> {
    const args = (body.args ?? []).map((arg) => deserializeValue(arg));

    switch (body.kind) {
      case 'browser': {
        if (!this.browser) throw new Error('Browser is not available');
        if (body.method !== 'newContext') {
          throw new Error(`Unsupported browser method: ${body.method}`);
        }

        if (this.switchGate.isClosed) {
          throw new Error(
            'The browser daemon is switching to another mode: the new session was refused. ' +
              'Run the command again.',
          );
        }

        this.switchGate.start();
        try {
          // The creation of a context can outlast the bound of the operation.
          // The client never learns the id of such a context, so nobody can
          // close it: a context that arrives late is closed instead of being
          // registered.
          const context = await withLateResultCleanup(
            this.browser.newContext((args[0] as Record<string, unknown>) ?? {}),
            'browser.newContext',
            this.operationBound('browser', 'newContext', args),
            (late) => withOperationTimeout(late.close(), 'context.close', this.closeTimeoutMs),
          );
          // The context exists now: the initialization must not leave it
          // behind when it fails.
          try {
            // CloakBrowser is patched at the binary level; extra JS stealth makes it noisier.
            if (getEngineName() !== 'cloakbrowser') {
              await this.run('context', 'addInitScript', args, 'context.addInitScript', () =>
                context.addInitScript(STEALTH_INIT_SCRIPT),
              );
            }
          } catch (error) {
            await withOperationTimeout(context.close(), 'context.close', this.closeTimeoutMs).catch(
              () => undefined,
            );
            throw error;
          }
          const contextId = randomUUID();
          this.contexts.set(contextId, context);
          return { ok: true, result: toContextHandle(contextId) };
        } finally {
          this.switchGate.finish();
        }
      }

      case 'context': {
        const context = this.getContext(body.target?.contextId);

        if (body.method === 'newPage') {
          // A page that arrives after the bound is closed: the client never
          // learns its id, and a page of nobody stays in the browser.
          const page = await withLateResultCleanup(
            context.newPage(),
            'context.newPage',
            this.operationBound('context', 'newPage', args),
            (late) => withOperationTimeout(late.close(), 'page.close', this.closeTimeoutMs),
          );
          const pageId = this.attachPage(page, body.target?.contextId ?? '');
          return {
            ok: true,
            result: toPageHandle(pageId, body.target?.contextId ?? '', page),
            pageState: this.buildPageState(pageId),
          };
        }

        if (body.method === 'close') {
          const contextId = body.target?.contextId ?? '';
          await this.run('context', 'close', args, 'context.close', () => context.close());
          this.contexts.delete(contextId);
          for (const [pageId, entry] of this.pages.entries()) {
            if (entry.contextId === contextId) {
              this.pages.delete(pageId);
              this.activePageCount = Math.max(0, this.activePageCount - 1);
            }
          }
          return { ok: true, result: null };
        }

        if (body.method === 'storageState') {
          const options = (args[0] as Record<string, unknown>) ?? {};
          const result = await this.run(
            'context',
            'storageState',
            args,
            'context.storageState',
            () => context.storageState(options as never),
          );
          return { ok: true, result: serializeValue(result) };
        }

        if (body.method === 'cookies') {
          const result = await this.run('context', 'cookies', args, 'context.cookies', () =>
            context.cookies((args[0] as string[]) ?? []),
          );
          return { ok: true, result: serializeValue(result) };
        }

        throw new Error(`Unsupported context method: ${body.method}`);
      }

      case 'page': {
        const { page } = this.getPage(body.target?.pageId);
        const pageId = body.target?.pageId ?? '';

        switch (body.method) {
          case 'goto':
            await this.run('page', 'goto', args, 'page.goto', () =>
              page.goto(args[0] as string, (args[1] as Record<string, unknown>) ?? {}),
            );
            return { ok: true, result: null, pageState: this.buildPageState(pageId) };
          case 'waitForTimeout':
            await this.run('page', 'waitForTimeout', args, 'page.waitForTimeout', () =>
              page.waitForTimeout(Number(args[0] ?? 0)),
            );
            return { ok: true, result: null, pageState: this.buildPageState(pageId) };
          case 'waitForLoadState':
            // The options carry the bound of the caller: they must reach
            // Playwright, or a caller that asks for a long wait gets the
            // default bound of Playwright instead.
            await this.run('page', 'waitForLoadState', args, 'page.waitForLoadState', () =>
              page.waitForLoadState(
                (args[0] as never) ?? 'load',
                (args[1] as Record<string, unknown>) ?? {},
              ),
            );
            return { ok: true, result: null, pageState: this.buildPageState(pageId) };
          case 'waitForURL': {
            const matcher = args[0];
            const options = (args[1] as Record<string, unknown>) ?? {};
            if (typeof matcher === 'string' || matcher instanceof RegExp) {
              await this.run('page', 'waitForURL', args, 'page.waitForURL', () =>
                page.waitForURL(matcher, options as never),
              );
            } else if (matcher && typeof matcher === 'object') {
              const predicate = matcher as { mode?: string; value?: string };
              if (predicate.mode === 'changes') {
                await this.run('page', 'waitForURL', args, 'page.waitForURL', () =>
                  page.waitForURL((url) => url.toString() !== predicate.value, options as never),
                );
              } else if (predicate.mode === 'startsWith') {
                await this.run('page', 'waitForURL', args, 'page.waitForURL', () =>
                  page.waitForURL(
                    (url) => url.pathname.startsWith(predicate.value ?? ''),
                    options as never,
                  ),
                );
              } else {
                throw new Error('Unsupported waitForURL predicate');
              }
            } else {
              throw new Error('Unsupported waitForURL matcher');
            }
            return { ok: true, result: null, pageState: this.buildPageState(pageId) };
          }
          case 'waitForEvent': {
            const eventName = String(args[0] ?? '');
            const options = (args[1] as Record<string, unknown>) ?? {};
            if (eventName === 'filechooser') {
              const fileChooser = await this.run(
                'page',
                'waitForEvent',
                args,
                'page.waitForEvent',
                () => page.waitForEvent('filechooser', options as never),
              );
              const eventId = randomUUID();
              this.fileChoosers.set(eventId, fileChooser);
              return {
                ok: true,
                result: toFileChooserHandle(eventId, pageId),
                pageState: this.buildPageState(pageId),
              };
            }
            if (eventName === 'download') {
              const download = await this.run(
                'page',
                'waitForEvent',
                args,
                'page.waitForEvent',
                () => page.waitForEvent('download', options as never),
              );
              const eventId = randomUUID();
              this.downloads.set(eventId, download);
              return {
                ok: true,
                result: toDownloadHandle(eventId, pageId, download),
                pageState: this.buildPageState(pageId),
              };
            }
            throw new Error(`Unsupported page event: ${eventName}`);
          }
          case 'evaluate': {
            const pageFunction = args[0];
            const arg = args[1];
            let result: unknown;
            if (typeof pageFunction === 'string') {
              result = await this.run('page', 'evaluate', args, 'page.evaluate', () =>
                page.evaluate(pageFunction),
              );
            } else if (typeof pageFunction === 'function') {
              result = await this.run('page', 'evaluate', args, 'page.evaluate', () =>
                page.evaluate(pageFunction as never, arg as never),
              );
            } else {
              throw new Error('Unsupported evaluate payload');
            }
            return {
              ok: true,
              result: serializeValue(result),
              pageState: this.buildPageState(pageId),
            };
          }
          case 'close':
            await this.run('page', 'close', args, 'page.close', () => page.close());
            return { ok: true, result: null, pageState: { pageId, url: 'about:blank' } };
          case 'title': {
            const result = await this.run('page', 'title', args, 'page.title', () => page.title());
            return { ok: true, result, pageState: this.buildPageState(pageId) };
          }
          default:
            throw new Error(`Unsupported page method: ${body.method}`);
        }
      }

      case 'keyboard': {
        const { page } = this.getPage(body.target?.pageId);
        const pageId = body.target?.pageId ?? '';

        if (body.method === 'press') {
          await this.run('keyboard', 'press', args, 'keyboard.press', () =>
            page.keyboard.press(args[0] as string, (args[1] as Record<string, unknown>) ?? {}),
          );
          return { ok: true, result: null, pageState: this.buildPageState(pageId) };
        }

        if (body.method === 'type') {
          await this.run('keyboard', 'type', args, 'keyboard.type', () =>
            page.keyboard.type(args[0] as string, (args[1] as Record<string, unknown>) ?? {}),
          );
          return { ok: true, result: null, pageState: this.buildPageState(pageId) };
        }

        if (body.method === 'insertText') {
          // One input event instead of one keystroke per character: a long
          // prompt took minutes to type.
          await this.run('keyboard', 'insertText', args, 'keyboard.insertText', () =>
            page.keyboard.insertText(args[0] as string),
          );
          return { ok: true, result: null, pageState: this.buildPageState(pageId) };
        }

        throw new Error(`Unsupported keyboard method: ${body.method}`);
      }

      case 'locator': {
        const { page } = this.getPage(body.target?.pageId);
        const pageId = body.target?.pageId ?? '';
        const locator = resolveLocator(page, body.target?.steps);

        switch (body.method) {
          case 'waitFor':
            await this.run('locator', 'waitFor', args, 'locator.waitFor', () =>
              locator.waitFor(((args[0] as Record<string, unknown>) ?? {}) as never),
            );
            return { ok: true, result: null, pageState: this.buildPageState(pageId) };
          case 'isVisible': {
            const result = await this.run('locator', 'isVisible', args, 'locator.isVisible', () =>
              locator.isVisible(((args[0] as Record<string, unknown>) ?? {}) as never),
            );
            return { ok: true, result, pageState: this.buildPageState(pageId) };
          }
          case 'click':
            await this.run('locator', 'click', args, 'locator.click', () =>
              locator.click(((args[0] as Record<string, unknown>) ?? {}) as never),
            );
            return { ok: true, result: null, pageState: this.buildPageState(pageId) };
          case 'fill':
            await this.run('locator', 'fill', args, 'locator.fill', () =>
              locator.fill(
                String(args[0] ?? ''),
                (args[1] as Record<string, unknown>) ?? ({} as never),
              ),
            );
            return { ok: true, result: null, pageState: this.buildPageState(pageId) };
          case 'count': {
            const result = await this.run('locator', 'count', args, 'locator.count', () =>
              locator.count(),
            );
            return { ok: true, result, pageState: this.buildPageState(pageId) };
          }
          case 'textContent': {
            const result = await this.run(
              'locator',
              'textContent',
              args,
              'locator.textContent',
              () => locator.textContent(((args[0] as Record<string, unknown>) ?? {}) as never),
            );
            return {
              ok: true,
              result: serializeValue(result),
              pageState: this.buildPageState(pageId),
            };
          }
          case 'innerHTML': {
            const result = await this.run('locator', 'innerHTML', args, 'locator.innerHTML', () =>
              locator.innerHTML(((args[0] as Record<string, unknown>) ?? {}) as never),
            );
            return {
              ok: true,
              result: serializeValue(result),
              pageState: this.buildPageState(pageId),
            };
          }
          case 'setInputFiles':
            await this.run('locator', 'setInputFiles', args, 'locator.setInputFiles', () =>
              locator.setInputFiles(
                (args[0] as string | string[]) ?? [],
                (args[1] as Record<string, unknown>) ?? ({} as never),
              ),
            );
            return { ok: true, result: null, pageState: this.buildPageState(pageId) };
          case 'evaluate': {
            const pageFunction = args[0];
            const arg = args[1];
            let result: unknown;
            if (typeof pageFunction === 'function' || typeof pageFunction === 'string') {
              result =
                arg !== undefined
                  ? await this.run('locator', 'evaluate', args, 'locator.evaluate', () =>
                      locator.evaluate(pageFunction as never, arg as never),
                    )
                  : await this.run('locator', 'evaluate', args, 'locator.evaluate', () =>
                      locator.evaluate(pageFunction as never),
                    );
            } else {
              throw new Error('Unsupported evaluate payload');
            }
            return {
              ok: true,
              result: serializeValue(result),
              pageState: this.buildPageState(pageId),
            };
          }
          default:
            throw new Error(`Unsupported locator method: ${body.method}`);
        }
      }

      case 'event': {
        if (body.method === 'setFiles') {
          const chooser = this.fileChoosers.get(body.target?.eventId ?? '');
          if (!chooser) throw new Error('File chooser not found');
          await this.run('event', 'setFiles', args, 'event.setFiles', () =>
            chooser.setFiles((args[0] as string | string[]) ?? []),
          );
          this.fileChoosers.delete(body.target?.eventId ?? '');
          return { ok: true, result: null };
        }

        if (body.method === 'saveAs') {
          const download = this.downloads.get(body.target?.eventId ?? '');
          if (!download) throw new Error('Download not found');
          await this.run('event', 'saveAs', args, 'event.saveAs', () =>
            download.saveAs(String(args[0] ?? '')),
          );
          this.downloads.delete(body.target?.eventId ?? '');
          return { ok: true, result: null };
        }

        throw new Error(`Unsupported event method: ${body.method}`);
      }
    }
  }
}
