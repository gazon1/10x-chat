import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { closeSync, mkdirSync, openSync } from 'node:fs';
import { readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Browser, BrowserContext, Cookie, Download, FileChooser, Page } from 'playwright';
import { resolveEffectiveProxy } from '../config.js';
import { getAppDir } from '../paths.js';
import { acquireProfileLock } from './lock.js';
import { requestedTimeoutMs, timeoutPlan } from './operation-timeout.js';
import { isProcessAlive } from './process.js';
import { fingerprintProxy } from './proxy.js';
import { loadStorageState, saveStorageState } from './state.js';

const DAEMON_FILE = 'browser-daemon.json';
/** The output of the detached daemon: the timings of its calls. */
const DAEMON_LOG_FILE = 'browser-daemon.log';
const DAEMON_LOCK_DIR = path.join(getAppDir(), 'browser-daemon-lock');
const STARTUP_TIMEOUT_MS = 15_000;
const HEALTH_TIMEOUT_MS = 3_000;
/** The time the daemon may need to finish the session creations that run. */
const SWITCH_TIMEOUT_MS = 15_000;

type JsonPrimitive = boolean | number | string | null;
type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

type SerializedValue =
  | JsonValue
  | { __type: 'regexp'; source: string; flags: string }
  | { __type: 'function'; source: string };

interface RpcRequest {
  kind: 'browser' | 'context' | 'page' | 'locator' | 'keyboard' | 'event';
  method: string;
  target?: Record<string, string | number | LocatorStep[] | undefined>;
  args?: SerializedValue[];
}

interface RpcSuccess {
  ok: true;
  result?: SerializedValue | RemoteHandle | JsonValue;
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

interface WaitForUrlPredicate {
  mode: 'changes' | 'startsWith';
  value: string;
}

type LocatorStep =
  | { type: 'locator'; selector: string }
  | { type: 'getByRole'; role: string; options?: JsonValue }
  | { type: 'first' }
  | { type: 'last' }
  | { type: 'nth'; index: number };

export interface DaemonState {
  pid: number;
  port: number;
  token: string;
  headless: boolean;
  /** Fingerprint of the proxy the daemon was started with (no secrets). */
  proxy?: string;
  createdAt: string;
}

interface SharedBrowserLaunchOptions {
  headless?: boolean;
  url?: string;
}

interface BrowserSessionProxy {
  context: BrowserContext;
  page: Page;
  close: () => Promise<void>;
}

class BrowserDaemonHttpClient {
  constructor(private readonly state: DaemonState) {}

  get headless(): boolean {
    return this.state.headless;
  }

  async request(request: RpcRequest): Promise<RpcSuccess> {
    let response: Response;
    try {
      // The bound of the client is derived from the bound of the call: it is
      // above the bound of the server, so a hung call is answered by the
      // server with an error and the invalidation of its session — the client
      // has to be able to read that answer. The bound is still there: a daemon
      // that never answers must not hang the run forever.
      const plan = timeoutPlan(
        requestedTimeoutMs(request.kind, request.method, request.args as unknown[] | undefined),
      );
      response = await fetch(`http://127.0.0.1:${this.state.port}/rpc`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.state.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(request),
        signal: AbortSignal.timeout(plan.clientMs),
      });
    } catch (error) {
      throw new Error(`Browser daemon request failed: ${getErrorMessage(error)}`);
    }

    let body: RpcResponse;
    try {
      body = (await response.json()) as RpcResponse;
    } catch (error) {
      throw new Error(
        `Browser daemon request failed with invalid response (status ${response.status}): ${getErrorMessage(error)}`,
      );
    }

    if (!response.ok || !body.ok) {
      const message =
        typeof body === 'object' && body && 'error' in body
          ? body.error
          : `Browser daemon request failed with status ${response.status}`;
      throw new Error(message);
    }

    return body;
  }

  async stop(): Promise<void> {
    await fetch(`http://127.0.0.1:${this.state.port}/stop`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.state.token}`,
      },
      signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
    }).catch(() => {
      // Best effort; caller falls back to pid kill if needed.
    });
  }
}

interface RemotePageState {
  currentUrl: string;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Whether a running daemon can serve the request.
 *
 * The headless mode is a property of the browser process: a daemon that runs
 * headed must not serve a headless request (the user would get a visible
 * window) and a headless daemon must not serve a headed request.
 */
export function isDaemonCompatible(
  state: DaemonState,
  requestedHeadless: boolean,
  requestedProxy: string,
): boolean {
  if (state.headless !== requestedHeadless) return false;
  // The proxy is a property of the browser process: a daemon that runs with
  // another proxy cannot be reused.
  return state.proxy === requestedProxy;
}

function serializeValue(value: unknown): SerializedValue {
  if (value instanceof RegExp) {
    return {
      __type: 'regexp',
      source: value.source,
      flags: value.flags,
    };
  }

  if (typeof value === 'function') {
    return {
      __type: 'function',
      source: value.toString(),
    };
  }

  if (Array.isArray(value)) {
    return value.map((entry) => serializeValue(entry)) as SerializedValue;
  }

  if (value && typeof value === 'object') {
    const entries = Object.entries(value).map(([key, entry]) => [key, serializeValue(entry)]);
    return Object.fromEntries(entries) as SerializedValue;
  }

  return value as SerializedValue;
}

function deserializeHandle(
  client: BrowserDaemonHttpClient,
  handle: RemoteHandle,
): BrowserContext | Page | FileChooser | Download {
  switch (handle.handleType) {
    case 'context':
      return createRemoteContextProxy(client, handle.id);
    case 'page':
      return createRemotePageProxy(
        client,
        handle.id,
        handle.contextId ?? '',
        handle.url ?? 'about:blank',
      );
    case 'filechooser':
      return createRemoteFileChooserProxy(client, handle.id, handle.pageId ?? '');
    case 'download':
      return createRemoteDownloadProxy(
        client,
        handle.id,
        handle.pageId ?? '',
        handle.suggestedFilename ?? '',
      );
  }
}

async function decodeResult(
  client: BrowserDaemonHttpClient,
  response: RpcSuccess,
  pageState?: RemotePageState,
): Promise<unknown> {
  if (response.pageState && pageState) {
    pageState.currentUrl = response.pageState.url;
  }

  const { result } = response;
  if (
    result &&
    typeof result === 'object' &&
    '__handle' in result &&
    result.__handle === true &&
    'handleType' in result
  ) {
    return deserializeHandle(client, result as RemoteHandle);
  }

  return result;
}

function createRemoteBrowserProxy(client: BrowserDaemonHttpClient): Browser {
  return {
    newContext: async (options?: Record<string, unknown>) => {
      const response = await client.request({
        kind: 'browser',
        method: 'newContext',
        args: [serializeValue(options ?? {})],
      });
      const result = await decodeResult(client, response);
      return result as BrowserContext;
    },
    close: async () => {
      // A remote client disconnect should not stop the shared daemon.
    },
    isConnected: () => true,
  } as unknown as Browser;
}

function createRemoteContextProxy(
  client: BrowserDaemonHttpClient,
  contextId: string,
): BrowserContext {
  return {
    newPage: async () => {
      const response = await client.request({
        kind: 'context',
        method: 'newPage',
        target: { contextId },
      });
      const result = await decodeResult(client, response);
      return result as Page;
    },
    close: async () => {
      await client.request({
        kind: 'context',
        method: 'close',
        target: { contextId },
      });
    },
    storageState: async (options?: { path?: string }) => {
      const response = await client.request({
        kind: 'context',
        method: 'storageState',
        target: { contextId },
        args: [serializeValue(options ?? {})],
      });
      const result = await decodeResult(client, response);
      return result as { cookies: Cookie[]; origins: Array<Record<string, unknown>> };
    },
    cookies: async (urls?: string[]) => {
      const response = await client.request({
        kind: 'context',
        method: 'cookies',
        target: { contextId },
        args: [serializeValue(urls ?? [])],
      });
      const result = await decodeResult(client, response);
      return (result ?? []) as Cookie[];
    },
  } as unknown as BrowserContext;
}

function createRemotePageProxy(
  client: BrowserDaemonHttpClient,
  pageId: string,
  contextId: string,
  initialUrl: string,
): Page {
  const pageState: RemotePageState = { currentUrl: initialUrl };
  const context = createRemoteContextProxy(client, contextId);

  const invoke = async (method: string, args: unknown[] = []) => {
    const response = await client.request({
      kind: 'page',
      method,
      target: { pageId },
      args: args.map((arg) => serializeValue(arg)),
    });
    return decodeResult(client, response, pageState);
  };

  return {
    goto: async (url: string, options?: Record<string, unknown>) =>
      invoke('goto', [url, options ?? {}]),
    waitForTimeout: async (timeout: number) => invoke('waitForTimeout', [timeout]),
    waitForLoadState: async (state?: string) => invoke('waitForLoadState', [state ?? 'load']),
    waitForURL: async (
      url: string | RegExp | WaitForUrlPredicate,
      options?: Record<string, unknown>,
    ) => invoke('waitForURL', [url, options ?? {}]),
    waitForEvent: async (event: string, options?: Record<string, unknown>) =>
      invoke('waitForEvent', [event, options ?? {}]),
    evaluate: async (pageFunction: unknown, arg?: unknown) =>
      invoke('evaluate', [pageFunction, arg]),
    close: async () => invoke('close'),
    title: async () => invoke('title'),
    url: () => pageState.currentUrl,
    context: () => context,
    getByRole: (role: string, options?: Record<string, unknown>) =>
      createRemoteLocatorProxy(client, pageId, pageState, [
        { type: 'getByRole', role, options: serializeValue(options ?? {}) as JsonValue },
      ]),
    locator: (selector: string) =>
      createRemoteLocatorProxy(client, pageId, pageState, [{ type: 'locator', selector }]),
    keyboard: createRemoteKeyboardProxy(client, pageId, pageState),
  } as unknown as Page;
}

function createRemoteKeyboardProxy(
  client: BrowserDaemonHttpClient,
  pageId: string,
  pageState: RemotePageState,
): Page['keyboard'] {
  const invoke = async (method: string, args: unknown[] = []) => {
    const response = await client.request({
      kind: 'keyboard',
      method,
      target: { pageId },
      args: args.map((arg) => serializeValue(arg)),
    });
    return decodeResult(client, response, pageState);
  };

  return {
    press: async (key: string, options?: Record<string, unknown>) =>
      invoke('press', [key, options ?? {}]),
    type: async (text: string, options?: Record<string, unknown>) =>
      invoke('type', [text, options ?? {}]),
    insertText: async (text: string) => invoke('insertText', [text]),
  } as Page['keyboard'];
}

function createRemoteLocatorProxy(
  client: BrowserDaemonHttpClient,
  pageId: string,
  pageState: RemotePageState,
  steps: LocatorStep[],
): ReturnType<Page['locator']> {
  const invoke = async (method: string, args: unknown[] = []) => {
    const response = await client.request({
      kind: 'locator',
      method,
      target: { pageId, steps },
      args: args.map((arg) => serializeValue(arg)),
    });
    return decodeResult(client, response, pageState);
  };

  return {
    locator: (selector: string) =>
      createRemoteLocatorProxy(client, pageId, pageState, [
        ...steps,
        { type: 'locator', selector },
      ]),
    first: () => createRemoteLocatorProxy(client, pageId, pageState, [...steps, { type: 'first' }]),
    last: () => createRemoteLocatorProxy(client, pageId, pageState, [...steps, { type: 'last' }]),
    nth: (index: number) =>
      createRemoteLocatorProxy(client, pageId, pageState, [...steps, { type: 'nth', index }]),
    waitFor: async (options?: Record<string, unknown>) => invoke('waitFor', [options ?? {}]),
    isVisible: async (options?: Record<string, unknown>) => invoke('isVisible', [options ?? {}]),
    click: async (options?: Record<string, unknown>) => invoke('click', [options ?? {}]),
    fill: async (value: string) => invoke('fill', [value]),
    count: async () => invoke('count'),
    textContent: async (options?: Record<string, unknown>) =>
      invoke('textContent', [options ?? {}]),
    innerHTML: async (options?: Record<string, unknown>) => invoke('innerHTML', [options ?? {}]),
    setInputFiles: async (files: string | string[]) => invoke('setInputFiles', [files]),
    evaluate: async (pageFunction: unknown, arg?: unknown) =>
      invoke('evaluate', [pageFunction, arg]),
  } as unknown as ReturnType<Page['locator']>;
}

/**
 * The proxy of a file chooser.
 *
 * The page of the event is sent with the call: a timed-out event operation
 * invalidates the page of the event instead of nothing.
 */
function createRemoteFileChooserProxy(
  client: BrowserDaemonHttpClient,
  eventId: string,
  pageId: string,
): FileChooser {
  return {
    setFiles: async (files: string | string[]) => {
      await client.request({
        kind: 'event',
        method: 'setFiles',
        target: { eventId, pageId },
        args: [serializeValue(files)],
      });
    },
  } as unknown as FileChooser;
}

/** The proxy of a download. The page of the event is sent with the call. */
function createRemoteDownloadProxy(
  client: BrowserDaemonHttpClient,
  eventId: string,
  pageId: string,
  suggestedFilename: string,
): Download {
  return {
    suggestedFilename: () => suggestedFilename,
    saveAs: async (filePath: string) => {
      await client.request({
        kind: 'event',
        method: 'saveAs',
        target: { eventId, pageId },
        args: [serializeValue(filePath)],
      });
    },
  } as unknown as Download;
}

function getDaemonStatePathInternal(): string {
  return path.join(getAppDir(), DAEMON_FILE);
}

function getDaemonStatePath(): string {
  return getDaemonStatePathInternal();
}

async function clearDaemonState(): Promise<void> {
  await rm(getDaemonStatePathInternal(), { force: true }).catch(() => {
    // ignore
  });
}

async function readDaemonState(): Promise<DaemonState | null> {
  try {
    const raw = await readFile(getDaemonStatePathInternal(), 'utf-8');
    const state = JSON.parse(raw) as Partial<DaemonState>;
    if (
      typeof state.pid !== 'number' ||
      typeof state.port !== 'number' ||
      typeof state.token !== 'string'
    ) {
      return null;
    }

    if (!isProcessAlive(state.pid)) {
      await clearDaemonState();
      return null;
    }

    return {
      pid: state.pid,
      port: state.port,
      token: state.token,
      headless: Boolean(state.headless),
      proxy: typeof state.proxy === 'string' ? state.proxy : undefined,
      createdAt: typeof state.createdAt === 'string' ? state.createdAt : new Date().toISOString(),
    };
  } catch {
    return null;
  }
}

/** What the daemon tells about its own work. */
export interface DaemonHealth {
  /** The browser contexts that are still open. */
  activeContexts: number;
  /** The pages that are still open. */
  activePages: number;
  /**
   * The session creations that are still running. A context that is being
   * created is not in `activeContexts` yet, but it is a session of another
   * process that must not lose its browser.
   */
  pendingCreations: number;
}

/**
 * Ask the daemon how much work it still has.
 *
 * @returns the health of the daemon, or `undefined` when it does not answer
 */
export async function fetchDaemonHealth(state: DaemonState): Promise<DaemonHealth | undefined> {
  try {
    const response = await fetch(`http://127.0.0.1:${state.port}/health`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${state.token}`,
      },
      signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
    });
    if (!response.ok) return undefined;
    const body = (await response.json()) as {
      activeContexts?: number;
      activePages?: number;
      pendingCreations?: number;
    };
    return {
      activeContexts: body.activeContexts ?? 0,
      activePages: body.activePages ?? 0,
      pendingCreations: body.pendingCreations ?? 0,
    };
  } catch {
    return undefined;
  }
}

/**
 * Whether a daemon still has the work of another process.
 *
 * Such a daemon must not be stopped: it would end the session of that
 * process. A creation that is still running counts as work — the context
 * does not exist yet, but the session does.
 */
export function daemonIsBusy(health: DaemonHealth | undefined): boolean {
  return (
    health !== undefined &&
    (health.activeContexts > 0 || health.activePages > 0 || health.pendingCreations > 0)
  );
}

/**
 * Whether the daemon may be stopped after the switch barrier.
 *
 * Only a daemon that is idle and whose session creations all finished may be
 * stopped: a creation that is still running belongs to a session of another
 * process, and a wait that ran into its timeout is not an idle daemon.
 */
export function daemonMayBeStopped(drained: DaemonHealth & { drained: boolean }): boolean {
  return drained.drained && !daemonIsBusy(drained);
}

/**
 * The error for a daemon that cannot be switched while it is busy.
 *
 * @param reason why the daemon does not fit the request (headless mode, proxy)
 */
export function daemonBusyError(reason: string, health: DaemonHealth): Error {
  const load =
    health.pendingCreations > 0
      ? `${health.pendingCreations} pending creation(s)`
      : `${health.activePages} active page(s)`;
  return new Error(
    `The shared browser daemon is busy with another session ` +
      `(${load}) and cannot be switched to ${reason}: ` +
      `stopping it would end that session. Wait for the other session to finish, ` +
      `then run the command again.`,
  );
}

/**
 * The error for a daemon whose session creations did not finish in time.
 *
 * The daemon still has the creation of another process running: it is not
 * idle, it is slow. Stopping it would end that session.
 */
export function daemonSwitchTimeoutError(reason: string, health: DaemonHealth): Error {
  return new Error(
    `The shared browser daemon could not be switched to ${reason}: ` +
      `a session of another process is still being created and did not finish in time ` +
      `(${health.pendingCreations} pending creation(s)). Stopping the daemon would end that session. ` +
      `Wait for the other session to finish, then run the command again.`,
  );
}

/** The load of a daemon that answered the switch request. */
export type DaemonSwitchHealth = DaemonHealth & { drained: boolean };

/** The answer of the daemon to a switch request. */
interface DaemonSwitchResponse {
  ok?: boolean;
  error?: string;
  activeContexts?: number;
  activePages?: number;
  pendingCreations?: number;
  drained?: boolean;
}

/**
 * Whether a reported load can be counted.
 *
 * A missing, negative or endless number is no load at all — it must not be
 * read as "no session".
 */
function isDaemonLoad(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

/**
 * The outcome of a switch request.
 *
 * The three states are not the same and must not be treated as such:
 *
 * - `switched`: the daemon answered and told what work it has left.
 * - `unavailable`: the daemon does not answer at all — it is really gone.
 * - `failed`: the daemon answered, but not with the result of the switch: the
 *   endpoint does not exist (a daemon of an older version), the daemon refused
 *   the request, the answer could not be read, or the answer is incomplete.
 *
 * A `failed` switch says nothing about the sessions of the daemon. It is not
 * a proof that the daemon is dead.
 */
export type DaemonSwitchResult =
  | { outcome: 'switched'; health: DaemonSwitchHealth }
  | { outcome: 'unavailable'; reason: string }
  | { outcome: 'failed'; reason: string; httpStatus?: number };

/**
 * Whether the request never reached the daemon: nothing listens on the port.
 *
 * Only this error proves that the daemon is gone. Every other error (a
 * timeout, a broken connection) leaves the daemon in an unknown state.
 */
function isConnectionRefused(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current instanceof Error; depth++) {
    if ((current as NodeJS.ErrnoException).code === 'ECONNREFUSED') return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * The error for a daemon that could not be switched and did not tell why.
 *
 * The daemon is left running: it may still serve the session of another
 * process, and a second daemon would break that session. An unknown answer is
 * never a proof that there is no session.
 *
 * @param reason why the daemon does not fit the request (headless mode, proxy)
 */
export function daemonSwitchFailedError(
  reason: string,
  failed: Extract<DaemonSwitchResult, { outcome: 'failed' }>,
): Error {
  const detail =
    failed.httpStatus === 404
      ? `${failed.reason} — the daemon does not know the switch endpoint; ` +
        `it was started by an older version of 10x-chat`
      : failed.httpStatus === 401
        ? `${failed.reason} — the daemon does not accept this client; ` +
          `its token does not match the state file`
        : failed.reason;

  return new Error(
    `The shared browser daemon could not be switched to ${reason}: ${detail}. ` +
      `The daemon was left running, because it may still serve the session of another process. ` +
      `Stop it (the pid is in ${getDaemonStatePath()}) and run the command again.`,
  );
}

/**
 * Ask the daemon to stop accepting new sessions and report what work it has
 * left.
 *
 * The daemon waits for the session creations that are already running, so a
 * session that starts in the meantime is visible in the answer — the switch
 * must not overtake it.
 *
 * @returns what the daemon answered; the outcome tells whether the daemon
 * still has the sessions of other processes
 */
export async function beginDaemonSwitch(state: DaemonState): Promise<DaemonSwitchResult> {
  let response: Response;
  try {
    response = await fetch(`http://127.0.0.1:${state.port}/switch`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${state.token}`,
      },
      signal: AbortSignal.timeout(SWITCH_TIMEOUT_MS),
    });
  } catch (error) {
    if (isConnectionRefused(error)) {
      return { outcome: 'unavailable', reason: getErrorMessage(error) };
    }
    return {
      outcome: 'failed',
      reason: `the daemon did not answer the switch request: ${getErrorMessage(error)}`,
    };
  }

  if (!response.ok) {
    return {
      outcome: 'failed',
      httpStatus: response.status,
      reason: `the daemon answered the switch request with HTTP ${response.status}`,
    };
  }

  let body: DaemonSwitchResponse;
  try {
    body = (await response.json()) as DaemonSwitchResponse;
  } catch (error) {
    return {
      outcome: 'failed',
      reason: `the daemon answered the switch request with an unreadable body: ${getErrorMessage(error)}`,
    };
  }

  if (body.ok !== true) {
    return {
      outcome: 'failed',
      reason: body.error ?? 'the daemon did not confirm the switch request',
    };
  }

  // The answer must be complete: a missing counter would look like "no
  // session", and a missing `drained` would look like "idle". Both would
  // allow the daemon to be stopped while it still serves another session.
  const { activeContexts, activePages, pendingCreations, drained } = body;
  if (
    !isDaemonLoad(activeContexts) ||
    !isDaemonLoad(activePages) ||
    !isDaemonLoad(pendingCreations) ||
    typeof drained !== 'boolean'
  ) {
    return {
      outcome: 'failed',
      reason: 'the daemon answered the switch request with an incomplete result',
    };
  }

  return {
    outcome: 'switched',
    health: {
      activeContexts,
      activePages,
      pendingCreations,
      drained,
    },
  };
}

/** Release the daemon: it accepts new sessions again. */
export async function abortDaemonSwitch(state: DaemonState): Promise<void> {
  await fetch(`http://127.0.0.1:${state.port}/switch/abort`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${state.token}`,
    },
    signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
  }).catch(() => {
    // best effort
  });
}

async function pingDaemon(state: DaemonState): Promise<boolean> {
  return (await fetchDaemonHealth(state)) !== undefined;
}

async function acquireDaemonStartLock() {
  return acquireProfileLock(DAEMON_LOCK_DIR, {
    timeoutMs: STARTUP_TIMEOUT_MS * 2,
    pollMs: 200,
  });
}

function getServerEntryPoint(): { command: string; args: string[] } {
  const currentFile = fileURLToPath(import.meta.url);
  const currentDir = path.dirname(currentFile);
  const jsPath = path.join(currentDir, 'server.js');
  const tsPath = path.join(currentDir, 'server.ts');
  const sourcePath = currentFile.endsWith('.ts') ? tsPath : jsPath;

  if (sourcePath.endsWith('.ts')) {
    return {
      command: process.execPath,
      args: ['--import', 'tsx', sourcePath],
    };
  }

  return {
    command: process.execPath,
    args: [sourcePath],
  };
}

async function waitForDaemonReady(headless: boolean, proxy: string): Promise<DaemonState> {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;

  while (Date.now() < deadline) {
    const state = await readDaemonState();
    if (state && isDaemonCompatible(state, headless, proxy)) {
      const healthy = await pingDaemon(state);
      if (healthy) return state;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  throw new Error('Timed out waiting for browser daemon to start');
}

async function startDaemon(headless: boolean, proxy: string): Promise<DaemonState> {
  const entry = getServerEntryPoint();
  // The daemon is detached: its output would be lost without a file. The log
  // is the only place where a hung page operation is visible.
  mkdirSync(getAppDir(), { recursive: true });
  const logFd = openSync(path.join(getAppDir(), DAEMON_LOG_FILE), 'a');
  try {
    const child = spawn(entry.command, entry.args, {
      detached: true,
      stdio: ['ignore', logFd, logFd],
      env: {
        ...process.env,
        TEN_X_CHAT_BROWSER_HEADLESS: headless ? '1' : '0',
        TEN_X_CHAT_BROWSER_STATE_FILE: getDaemonStatePathInternal(),
      },
    });
    child.unref();
  } finally {
    closeSync(logFd);
  }
  return waitForDaemonReady(headless, proxy);
}

/**
 * What to do with a daemon after the switch request.
 *
 * Only an answered switch tells whether the daemon may be stopped. Every
 * other answer leaves the daemon alone: a second daemon would break the
 * session of another process that the old daemon may still serve.
 */
export type DaemonSwitchAction =
  | { action: 'stop' }
  | { action: 'restart' }
  | { action: 'refuse'; error: Error };

/**
 * Read the switch result and decide what happens to the daemon.
 *
 * @param reason why the daemon does not fit the request (headless mode, proxy)
 */
export function decideDaemonSwitch(result: DaemonSwitchResult, reason: string): DaemonSwitchAction {
  if (result.outcome === 'unavailable') {
    // The daemon does not answer at all: it is really gone and cannot serve
    // a session any more.
    return { action: 'restart' };
  }

  if (result.outcome === 'failed') {
    // The daemon answered, but not with the result of the switch: it does
    // not know the endpoint, refused the request, or answered something
    // unreadable. It may still serve the session of another process, so it
    // is neither stopped nor replaced by a second daemon.
    return { action: 'refuse', error: daemonSwitchFailedError(reason, result) };
  }

  const drained = result.health;

  // A wait that ran into its timeout does not mean "no work": a creation is
  // still running and belongs to a session of another process. The switch is
  // refused in that case.
  if (!drained.drained) {
    return { action: 'refuse', error: daemonSwitchTimeoutError(reason, drained) };
  }

  if (!daemonMayBeStopped(drained)) {
    return { action: 'refuse', error: daemonBusyError(reason, drained) };
  }

  return { action: 'stop' };
}

async function ensureDaemonState(headless: boolean): Promise<DaemonState> {
  // The daemon runs the browser with the effective proxy: the config file
  // first, the environment second. The fingerprint of it decides whether the
  // running daemon can serve the request.
  const proxy = fingerprintProxy(await resolveEffectiveProxy());
  const existing = await readDaemonState();
  if (existing && isDaemonCompatible(existing, headless, proxy) && (await pingDaemon(existing))) {
    return existing;
  }

  const lock = await acquireDaemonStartLock();
  try {
    const current = await readDaemonState();
    if (current) {
      const health = await fetchDaemonHealth(current);
      const healthy = health !== undefined;
      if (healthy && isDaemonCompatible(current, headless, proxy)) {
        return current;
      }

      if (healthy) {
        // The daemon does not fit the request: it runs in another headless
        // mode or with another proxy. It may only be stopped when it has no
        // session of another process any more — otherwise that session would
        // lose its browser.
        const reason =
          current.headless !== headless
            ? `a different headless mode (${current.headless ? 'headless' : 'headed'} → ` +
              `${headless ? 'headless' : 'headed'})`
            : 'a different proxy';

        if (daemonIsBusy(health)) {
          throw daemonBusyError(reason, health);
        }

        // Barrier: the daemon stops accepting new sessions and waits for the
        // session creations that are already running. A session that starts
        // in the meantime is then visible — the check above and the stop
        // cannot be overtaken any more.
        const decision = decideDaemonSwitch(await beginDaemonSwitch(current), reason);

        if (decision.action === 'restart') {
          await clearDaemonState();
          return startDaemon(headless, proxy);
        }

        if (decision.action === 'refuse') {
          // The daemon keeps running and serves sessions again.
          await abortDaemonSwitch(current);
          throw decision.error;
        }

        await new BrowserDaemonHttpClient(current).stop();

        if (isProcessAlive(current.pid)) {
          try {
            process.kill(current.pid, 'SIGTERM');
          } catch {
            // already gone
          }
        }
      }

      await clearDaemonState();
    }

    return startDaemon(headless, proxy);
  } finally {
    await lock.release();
  }
}

async function getDaemonClient(headless = true): Promise<BrowserDaemonHttpClient> {
  const state = await ensureDaemonState(headless);
  return new BrowserDaemonHttpClient(state);
}

export async function stopDaemon(): Promise<void> {
  const state = await readDaemonState();
  if (!state) return;

  const healthy = await pingDaemon(state);
  if (!healthy) {
    await clearDaemonState();
    return;
  }

  const client = new BrowserDaemonHttpClient(state);
  await client.stop();

  if (isProcessAlive(state.pid)) {
    try {
      process.kill(state.pid, 'SIGTERM');
    } catch {
      // already gone
    }
  }

  await clearDaemonState();
}

export async function launchSharedBrowserSession(
  opts: SharedBrowserLaunchOptions,
): Promise<BrowserSessionProxy> {
  const { headless = true, url } = opts;
  const startedAt = Date.now();
  const client = await getDaemonClient(headless);
  const storageStatePath = await loadStorageState();

  const browser = createRemoteBrowserProxy(client);
  let context: BrowserContext | undefined;
  let page: Page | undefined;
  try {
    context = (await browser.newContext({
      viewport: { width: 1280, height: 900 },
      ...(storageStatePath ? { storageState: storageStatePath } : {}),
    })) as BrowserContext;
    page = (await context.newPage()) as Page;

    if (url) {
      await page.goto(url, { waitUntil: 'domcontentloaded' });
    }
  } catch (error) {
    await context?.close().catch(() => {
      // best effort
    });
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Browser launch-shared failed (operation=session headless=${headless} elapsedMs=${Date.now() - startedAt}): ${message}`,
    );
  }

  const close = async () => {
    try {
      await saveStorageState(context!);
    } catch {
      // best effort
    }

    await page!.close().catch(() => {
      // already closed
    });
    await context!.close().catch(() => {
      // already closed
    });
  };

  return { context: context!, page: page!, close };
}

export type { WaitForUrlPredicate };
