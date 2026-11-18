// HTTP daemon architecture inspired by gstack (github.com/garrytan/gstack)

import { randomUUID } from 'node:crypto';
import { chmod, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage } from 'node:http';
import path from 'node:path';
import type { Browser, BrowserContext, Download, FileChooser, Locator, Page } from 'playwright';
import { resolveEffectiveProxy } from '../config.js';
import { getAppDir } from '../paths.js';
import { redactText } from './diagnostics.js';
import { getChromium, getEngineName } from './engine.js';
import {
  CLOSE_TIMEOUT_MS,
  InvalidatedHandles,
  invalidateOnTimeout,
  OPERATION_TIMEOUT_MS,
  RPC_TIMEOUT_MS,
  withLateResultCleanup,
  withOperationTimeout,
} from './operation-timeout.js';
import { CHROMIUM_ARGS } from './process.js';
import { fingerprintProxy } from './proxy.js';
import { detectChromeChannel, STEALTH_INIT_SCRIPT } from './stealth.js';
import { SwitchGate } from './switch-gate.js';

function redactError(error: unknown): string {
  const msg = error instanceof Error ? error.message : String(error);
  return redactText(msg);
}

/**
 * The bound of a whole RPC.
 *
 * It stays below the deadline of the HTTP request of the client (Bun aborts a
 * fetch after 360 s), so a stuck call surfaces as an error instead of killing
 * the run.
 */

type JsonPrimitive = boolean | number | string | null;
type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

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

interface RpcRequest {
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

interface RpcSuccess {
  ok: true;
  result?: JsonValue | RemoteHandle;
  pageState?: { pageId: string; url: string };
}

interface RpcError {
  ok: false;
  error: string;
}

type RpcResponse = RpcSuccess | RpcError;

interface RemoteHandle {
  __handle: true;
  handleType: 'context' | 'page' | 'filechooser' | 'download';
  id: string;
  contextId?: string;
  pageId?: string;
  url?: string;
  suggestedFilename?: string;
}

interface DaemonStateFile {
  pid: number;
  port: number;
  token: string;
  headless: boolean;
  /** Fingerprint of the proxy the browser was started with (no secrets). */
  proxy?: string;
  createdAt: string;
}

const STATE_PATH =
  process.env.TEN_X_CHAT_BROWSER_STATE_FILE ?? path.join(getAppDir(), 'browser-daemon.json');
const AUTH_TOKEN = randomUUID();
const HEADLESS = process.env.TEN_X_CHAT_BROWSER_HEADLESS !== '0';
const IDLE_TIMEOUT_MS = 30 * 60 * 1000;
const SWITCH_TIMEOUT_MS = 10_000;
const MIN_PORT = 10_000;
const MAX_PORT = 60_000;

let browser: Browser | null = null;
let lastActivity = Date.now();
let activePageCount = 0;
let shuttingDown = false;

/**
 * The barrier of a switching daemon: while it is closed, no new session may
 * start, so the daemon can be replaced without taking the browser away from a
 * session that is just beginning.
 */
const switchGate = new SwitchGate();

const contexts = new Map<string, BrowserContext>();
const pages = new Map<string, { page: Page; contextId: string }>();
const fileChoosers = new Map<string, FileChooser>();
const downloads = new Map<string, Download>();
/**
 * The sessions of the operations that did not answer in time.
 *
 * Their handle is refused from now on: the operation may still run in the
 * browser, and a later operation on the same page would work on a
 * half-changed document.
 */
const invalidatedHandles = new InvalidatedHandles();

function touchActivity(): void {
  lastActivity = Date.now();
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

function toFileChooserHandle(eventId: string): RemoteHandle {
  return {
    __handle: true,
    handleType: 'filechooser',
    id: eventId,
  };
}

function toDownloadHandle(eventId: string, download: Download): RemoteHandle {
  return {
    __handle: true,
    handleType: 'download',
    id: eventId,
    suggestedFilename: download.suggestedFilename(),
  };
}

async function writeStateFile(port: number, proxy: string): Promise<void> {
  const state: DaemonStateFile = {
    pid: process.pid,
    port,
    token: AUTH_TOKEN,
    headless: HEADLESS,
    proxy,
    createdAt: new Date().toISOString(),
  };

  await mkdir(path.dirname(STATE_PATH), { recursive: true });
  const tmpPath = `${STATE_PATH}.${process.pid}.tmp`;
  await writeFile(tmpPath, JSON.stringify(state, null, 2), { mode: 0o600 });
  await rename(tmpPath, STATE_PATH);
  await chmod(STATE_PATH, 0o600).catch(() => {
    // ignore chmod failures
  });
}

async function clearStateFile(): Promise<void> {
  await rm(STATE_PATH, { force: true }).catch(() => {
    // ignore
  });
}

async function findPort(): Promise<number> {
  for (let attempt = 0; attempt < 20; attempt++) {
    const port = MIN_PORT + Math.floor(Math.random() * (MAX_PORT - MIN_PORT + 1));
    const available = await new Promise<boolean>((resolve) => {
      const tester = createServer();
      tester.once('error', () => resolve(false));
      tester.once('listening', () => {
        tester.close(() => resolve(true));
      });
      tester.listen(port, '127.0.0.1');
    });
    if (available) return port;
  }
  throw new Error(`Unable to find an available port in range ${MIN_PORT}-${MAX_PORT}`);
}

function getContext(contextId?: string): BrowserContext {
  if (!contextId) {
    throw new Error('Missing contextId');
  }

  if (invalidatedHandles.isInvalidated('context', contextId)) {
    throw new Error(
      `Context ${contextId} was invalidated after a timed-out operation: this session is not usable any more.`,
    );
  }

  const context = contexts.get(contextId);
  if (!context) {
    throw new Error(`Context not found: ${contextId}`);
  }
  return context;
}

function getPage(pageId?: string): { page: Page; contextId: string } {
  if (!pageId) {
    throw new Error('Missing pageId');
  }

  if (invalidatedHandles.isInvalidated('page', pageId)) {
    throw new Error(
      `Page ${pageId} was invalidated after a timed-out operation: this session is not usable any more.`,
    );
  }

  const page = pages.get(pageId);
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
async function invalidateSession(handle: { kind: 'page' | 'context'; id: string }): Promise<void> {
  if (handle.kind === 'page') {
    const entry = pages.get(handle.id);
    pages.delete(handle.id);
    invalidatedHandles.invalidate('page', handle.id);
    if (!entry) return;
    activePageCount = Math.max(0, activePageCount - 1);
    await withOperationTimeout(entry.page.close(), 'page.close', CLOSE_TIMEOUT_MS).catch(
      () => undefined,
    );
    return;
  }

  const context = contexts.get(handle.id);
  contexts.delete(handle.id);
  invalidatedHandles.invalidate('context', handle.id);
  for (const [pageId, entry] of pages.entries()) {
    if (entry.contextId !== handle.id) continue;
    pages.delete(pageId);
    invalidatedHandles.invalidate('page', pageId);
    activePageCount = Math.max(0, activePageCount - 1);
    await withOperationTimeout(entry.page.close(), 'page.close', CLOSE_TIMEOUT_MS).catch(
      () => undefined,
    );
  }
  if (!context) return;
  await withOperationTimeout(context.close(), 'context.close', CLOSE_TIMEOUT_MS).catch(
    () => undefined,
  );
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

function buildPageState(pageId: string): { pageId: string; url: string } {
  const entry = pages.get(pageId);
  return {
    pageId,
    url: entry?.page.url() ?? 'about:blank',
  };
}

function attachPage(page: Page, contextId: string): string {
  const pageId = randomUUID();
  pages.set(pageId, { page, contextId });
  activePageCount++;

  page.on('close', () => {
    if (pages.delete(pageId)) {
      activePageCount = Math.max(0, activePageCount - 1);
    }
  });

  return pageId;
}

async function handleRpc(body: RpcRequest): Promise<RpcResponse> {
  const args = (body.args ?? []).map((arg) => deserializeValue(arg));

  switch (body.kind) {
    case 'browser': {
      if (!browser) throw new Error('Browser is not available');
      if (body.method !== 'newContext') {
        throw new Error(`Unsupported browser method: ${body.method}`);
      }

      if (switchGate.isClosed) {
        throw new Error(
          'The browser daemon is switching to another mode: the new session was refused. ' +
            'Run the command again.',
        );
      }

      switchGate.start();
      try {
        // The creation of a context can outlast the bound of the operation.
        // The client never learns the id of such a context, so nobody can
        // close it: a context that arrives late is closed instead of being
        // registered.
        const context = await withLateResultCleanup(
          browser!.newContext((args[0] as Record<string, unknown>) ?? {}),
          'browser.newContext',
          OPERATION_TIMEOUT_MS,
          (late) => withOperationTimeout(late.close(), 'context.close', CLOSE_TIMEOUT_MS),
        );
        // The context exists now: the initialization must not leave it
        // behind when it fails.
        try {
          // CloakBrowser is patched at the binary level; extra JS stealth makes it noisier.
          if (getEngineName() !== 'cloakbrowser') {
            await withOperationTimeout(
              context.addInitScript(STEALTH_INIT_SCRIPT),
              'context.addInitScript',
              OPERATION_TIMEOUT_MS,
            );
          }
        } catch (error) {
          await withOperationTimeout(context.close(), 'context.close', CLOSE_TIMEOUT_MS).catch(
            () => undefined,
          );
          throw error;
        }
        const contextId = randomUUID();
        contexts.set(contextId, context);
        return { ok: true, result: toContextHandle(contextId) };
      } finally {
        switchGate.finish();
      }
    }

    case 'context': {
      const context = getContext(body.target?.contextId);

      if (body.method === 'newPage') {
        // A page that arrives after the bound is closed: the client never
        // learns its id, and a page of nobody stays in the browser.
        const page = await withLateResultCleanup(
          context.newPage(),
          'context.newPage',
          OPERATION_TIMEOUT_MS,
          (late) => withOperationTimeout(late.close(), 'page.close', CLOSE_TIMEOUT_MS),
        );
        const pageId = attachPage(page, body.target?.contextId ?? '');
        return {
          ok: true,
          result: toPageHandle(pageId, body.target?.contextId ?? '', page),
          pageState: buildPageState(pageId),
        };
      }

      if (body.method === 'close') {
        const contextId = body.target?.contextId ?? '';
        await context.close();
        contexts.delete(contextId);
        for (const [pageId, entry] of pages.entries()) {
          if (entry.contextId === contextId) {
            pages.delete(pageId);
            activePageCount = Math.max(0, activePageCount - 1);
          }
        }
        return { ok: true, result: null };
      }

      if (body.method === 'storageState') {
        const options = (args[0] as Record<string, unknown>) ?? {};
        const result = await context.storageState(options as never);
        return { ok: true, result: serializeValue(result) };
      }

      if (body.method === 'cookies') {
        const result = await context.cookies((args[0] as string[]) ?? []);
        return { ok: true, result: serializeValue(result) };
      }

      throw new Error(`Unsupported context method: ${body.method}`);
    }

    case 'page': {
      const { page } = getPage(body.target?.pageId);
      const pageId = body.target?.pageId ?? '';

      switch (body.method) {
        case 'goto':
          await page.goto(args[0] as string, (args[1] as Record<string, unknown>) ?? {});
          return { ok: true, result: null, pageState: buildPageState(pageId) };
        case 'waitForTimeout':
          await page.waitForTimeout(Number(args[0] ?? 0));
          return { ok: true, result: null, pageState: buildPageState(pageId) };
        case 'waitForLoadState':
          await page.waitForLoadState((args[0] as never) ?? 'load');
          return { ok: true, result: null, pageState: buildPageState(pageId) };
        case 'waitForURL': {
          const matcher = args[0];
          const options = (args[1] as Record<string, unknown>) ?? {};
          if (typeof matcher === 'string' || matcher instanceof RegExp) {
            await page.waitForURL(matcher, options as never);
          } else if (matcher && typeof matcher === 'object') {
            const predicate = matcher as { mode?: string; value?: string };
            if (predicate.mode === 'changes') {
              await page.waitForURL((url) => url.toString() !== predicate.value, options as never);
            } else if (predicate.mode === 'startsWith') {
              await page.waitForURL(
                (url) => url.pathname.startsWith(predicate.value ?? ''),
                options as never,
              );
            } else {
              throw new Error('Unsupported waitForURL predicate');
            }
          } else {
            throw new Error('Unsupported waitForURL matcher');
          }
          return { ok: true, result: null, pageState: buildPageState(pageId) };
        }
        case 'waitForEvent': {
          const eventName = String(args[0] ?? '');
          const options = (args[1] as Record<string, unknown>) ?? {};
          if (eventName === 'filechooser') {
            const fileChooser = await page.waitForEvent('filechooser', options as never);
            const eventId = randomUUID();
            fileChoosers.set(eventId, fileChooser);
            return {
              ok: true,
              result: toFileChooserHandle(eventId),
              pageState: buildPageState(pageId),
            };
          }
          if (eventName === 'download') {
            const download = await page.waitForEvent('download', options as never);
            const eventId = randomUUID();
            downloads.set(eventId, download);
            return {
              ok: true,
              result: toDownloadHandle(eventId, download),
              pageState: buildPageState(pageId),
            };
          }
          throw new Error(`Unsupported page event: ${eventName}`);
        }
        case 'evaluate': {
          const pageFunction = args[0];
          const arg = args[1];
          let result: unknown;
          if (typeof pageFunction === 'string') {
            result = await withOperationTimeout(page.evaluate(pageFunction), 'page.evaluate');
          } else if (typeof pageFunction === 'function') {
            result = await withOperationTimeout(
              page.evaluate(pageFunction as never, arg as never),
              'page.evaluate',
            );
          } else {
            throw new Error('Unsupported evaluate payload');
          }
          return { ok: true, result: serializeValue(result), pageState: buildPageState(pageId) };
        }
        case 'close':
          await page.close();
          return { ok: true, result: null, pageState: { pageId, url: 'about:blank' } };
        case 'title': {
          const result = await page.title();
          return { ok: true, result, pageState: buildPageState(pageId) };
        }
        default:
          throw new Error(`Unsupported page method: ${body.method}`);
      }
    }

    case 'keyboard': {
      const { page } = getPage(body.target?.pageId);
      const pageId = body.target?.pageId ?? '';

      if (body.method === 'press') {
        await page.keyboard.press(args[0] as string, (args[1] as Record<string, unknown>) ?? {});
        return { ok: true, result: null, pageState: buildPageState(pageId) };
      }

      if (body.method === 'type') {
        await page.keyboard.type(args[0] as string, (args[1] as Record<string, unknown>) ?? {});
        return { ok: true, result: null, pageState: buildPageState(pageId) };
      }

      if (body.method === 'insertText') {
        // One input event instead of one keystroke per character: a long
        // prompt took minutes to type.
        await page.keyboard.insertText(args[0] as string);
        return { ok: true, result: null, pageState: buildPageState(pageId) };
      }

      throw new Error(`Unsupported keyboard method: ${body.method}`);
    }

    case 'locator': {
      const { page } = getPage(body.target?.pageId);
      const pageId = body.target?.pageId ?? '';
      const locator = resolveLocator(page, body.target?.steps);

      switch (body.method) {
        case 'waitFor':
          await locator.waitFor(((args[0] as Record<string, unknown>) ?? {}) as never);
          return { ok: true, result: null, pageState: buildPageState(pageId) };
        case 'isVisible': {
          const result = await locator.isVisible(
            ((args[0] as Record<string, unknown>) ?? {}) as never,
          );
          return { ok: true, result, pageState: buildPageState(pageId) };
        }
        case 'click':
          await locator.click(((args[0] as Record<string, unknown>) ?? {}) as never);
          return { ok: true, result: null, pageState: buildPageState(pageId) };
        case 'fill':
          await locator.fill(String(args[0] ?? ''));
          return { ok: true, result: null, pageState: buildPageState(pageId) };
        case 'count': {
          const result = await locator.count();
          return { ok: true, result, pageState: buildPageState(pageId) };
        }
        case 'textContent': {
          const result = await locator.textContent(
            ((args[0] as Record<string, unknown>) ?? {}) as never,
          );
          return { ok: true, result: serializeValue(result), pageState: buildPageState(pageId) };
        }
        case 'innerHTML': {
          const result = await locator.innerHTML(
            ((args[0] as Record<string, unknown>) ?? {}) as never,
          );
          return { ok: true, result, pageState: buildPageState(pageId) };
        }
        case 'setInputFiles':
          await locator.setInputFiles((args[0] as string | string[]) ?? []);
          return { ok: true, result: null, pageState: buildPageState(pageId) };
        case 'evaluate': {
          const pageFunction = args[0];
          const arg = args[1];
          let result: unknown;
          if (typeof pageFunction === 'function' || typeof pageFunction === 'string') {
            result =
              arg !== undefined
                ? await withOperationTimeout(
                    locator.evaluate(pageFunction as never, arg as never),
                    'locator.evaluate',
                  )
                : await withOperationTimeout(
                    locator.evaluate(pageFunction as never),
                    'locator.evaluate',
                  );
          } else {
            throw new Error('Unsupported evaluate payload');
          }
          return {
            ok: true,
            result: serializeValue(result),
            pageState: buildPageState(pageId),
          };
        }
        default:
          throw new Error(`Unsupported locator method: ${body.method}`);
      }
    }

    case 'event': {
      if (body.method === 'setFiles') {
        const chooser = fileChoosers.get(body.target?.eventId ?? '');
        if (!chooser) throw new Error('File chooser not found');
        await chooser.setFiles((args[0] as string | string[]) ?? []);
        fileChoosers.delete(body.target?.eventId ?? '');
        return { ok: true, result: null };
      }

      if (body.method === 'saveAs') {
        const download = downloads.get(body.target?.eventId ?? '');
        if (!download) throw new Error('Download not found');
        await download.saveAs(String(args[0] ?? ''));
        downloads.delete(body.target?.eventId ?? '');
        return { ok: true, result: null };
      }

      throw new Error(`Unsupported event method: ${body.method}`);
    }
  }
}

async function shutdown(server?: ReturnType<typeof createServer>): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;

  await clearStateFile();

  // Close browser first — this aborts any pending Playwright actions, which
  // unblocks any active long-poll HTTP connections to the server.
  // Add a hard 3s timeout: browser.close() can hang if Playwright's IPC
  // channel is already broken (e.g. Chrome crashed or was kill -9'd).
  if (browser) {
    browser.removeAllListeners('disconnected');
    await Promise.race([
      browser.close().catch(() => {}),
      new Promise<void>((resolve) => setTimeout(resolve, 3000)),
    ]);
  }

  // Stop accepting new connections. Active connections will have been aborted
  // by browser.close() above, so this resolves quickly. We add a 2s hard
  // timeout so a stuck connection never prevents the process from exiting.
  if (server) {
    await Promise.race([
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
      new Promise<void>((resolve) => setTimeout(resolve, 2000)),
    ]).catch(() => {
      // ignore
    });
  }

  process.exit(0);
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf-8'));
}

async function main(): Promise<void> {
  const channel = detectChromeChannel();

  // The proxy of the daemon: the config file first, the environment second.
  // The browser gets exactly this proxy, and its fingerprint goes into the
  // state file — a client with another proxy switches the daemon.
  const proxy = await resolveEffectiveProxy();

  const chromium = await getChromium();
  const engineName = getEngineName();
  console.log(`Browser engine: ${engineName}${channel ? ' (channel: chrome)' : ''}`);

  browser = await chromium.launch({
    headless: HEADLESS,
    ...(channel ? { channel } : {}),
    args: CHROMIUM_ARGS,
  });

  // Inject stealth script into the default browser context
  // so every new page automatically gets the anti-detection patches
  browser.on('disconnected', () => {
    void clearStateFile().finally(() => process.exit(1));
  });

  const idleInterval = setInterval(() => {
    if (Date.now() - lastActivity > IDLE_TIMEOUT_MS) {
      void shutdown(server);
    }
  }, 60_000);
  idleInterval.unref();

  const port = await findPort();
  const server = createServer(async (req, res) => {
    const authHeader = req.headers.authorization;
    if (authHeader !== `Bearer ${AUTH_TOKEN}`) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'Unauthorized' } satisfies RpcError));
      return;
    }

    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          ok: true,
          activeContexts: contexts.size,
          activePages: activePageCount,
          // A context that is being created is a session of another process
          // too: it is not in `contexts` yet, but it must not be cut off.
          pendingCreations: switchGate.pendingCreations,
          switching: switchGate.isClosed,
          headless: HEADLESS,
          pid: process.pid,
        }),
      );
      return;
    }

    if (req.method === 'POST' && req.url === '/switch') {
      // Close the gate, wait for the session creations that are running and
      // report what is left: a session that started in the meantime is
      // visible now.
      switchGate.close();
      const drained = await switchGate.waitForIdle(SWITCH_TIMEOUT_MS);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          ok: true,
          activeContexts: contexts.size,
          activePages: activePageCount,
          pendingCreations: switchGate.pendingCreations,
          // A wait that ran into its timeout does not mean "no work": a
          // creation is still running and belongs to a session of another
          // process.
          drained,
        }),
      );
      return;
    }

    if (req.method === 'POST' && req.url === '/switch/abort') {
      // The switch was refused — the daemon serves sessions again.
      switchGate.open();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    if (req.method === 'POST' && req.url === '/stop') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      setTimeout(() => {
        void shutdown(server);
      }, 0);
      return;
    }

    if (req.method !== 'POST' || req.url !== '/rpc') {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'Not found' } satisfies RpcError));
      return;
    }

    touchActivity();

    let rpcLabel = 'unknown';
    const startedAt = Date.now();
    let body: RpcRequest | undefined;
    try {
      body = (await readJsonBody(req)) as RpcRequest;
      rpcLabel = `${body.kind}.${body.method}`;
      // The bound is below the deadline of the client's HTTP request: a call
      // that never answers must fail here, not kill the whole run.
      const response = await withOperationTimeout(
        handleRpc(body),
        `rpc ${rpcLabel}`,
        RPC_TIMEOUT_MS,
      );
      // One line per call: a hung page operation is only visible in the
      // timings, not in the error of the client that waited for it.
      console.log(`[rpc] ${rpcLabel} ok ${Date.now() - startedAt}ms`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(response));
    } catch (error) {
      // A timed-out operation may still run inside the browser: the session of
      // the operation must not be used any more.
      const invalidated = await invalidateOnTimeout(error, body?.target, invalidateSession);
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
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve());
  });

  await writeStateFile(port, fingerprintProxy(proxy));

  const cleanup = () => {
    void shutdown(server);
  };

  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);
}

void main().catch(async (error) => {
  console.error(redactError(error));
  await clearStateFile();
  process.exit(1);
});
