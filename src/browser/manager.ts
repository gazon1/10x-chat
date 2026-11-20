import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { BrowserContext, Page } from 'playwright';
import { getIsolatedProfileDir, getSharedProfileDir } from '../paths.js';
import type { ProfileMode, ProviderName } from '../types.js';
import { launchSharedBrowserSession, requestDaemonStop } from './daemon.js';
import {
  type BrowserOp,
  browserError,
  createDebugCollector,
  type DebugCollector,
  isBrowserDebugEnabled,
  saveDebugArtifacts,
} from './diagnostics.js';
import { getChromium, getEngineName } from './engine.js';
import { acquireProfileLock, type ProfileLock } from './lock.js';
import { CHROMIUM_ARGS } from './process.js';
import { saveStorageState } from './state.js';
import { detectChromeChannel, STEALTH_INIT_SCRIPT } from './stealth.js';

async function markProfileClean(profileDir: string): Promise<void> {
  const prefsPath = path.join(profileDir, 'Default', 'Preferences');
  try {
    const prefs = JSON.parse(await readFile(prefsPath, 'utf8')) as {
      profile?: { exit_type?: string; exited_cleanly?: boolean };
    };
    prefs.profile = { ...(prefs.profile ?? {}), exit_type: 'Normal', exited_cleanly: true };
    await writeFile(prefsPath, JSON.stringify(prefs));
  } catch {
    // New profile or unreadable prefs; Chrome will create/fix it.
  }
}

export interface BrowserSession {
  context: BrowserContext;
  page: Page;
  /** Profile lock (only set in isolated mode; null in shared mode). */
  lock: ProfileLock | null;
  /**
   * The cookies of this session live in the shared storage-state.json.
   *
   * A persistent context (isolated or named profile) keeps its cookies in its
   * own directory — those must never be written into the shared state, that
   * would cross the boundary of the isolation.
   */
  sharedState: boolean;
  close: () => Promise<void>;
}

const ownedSessions = new Set<BrowserSession>();

export function hasOwnedBrowserSessions(): boolean {
  return ownedSessions.size > 0;
}

function trackOwnedSession(session: BrowserSession): BrowserSession {
  let closing: Promise<void> | undefined;
  const originalClose = session.close;
  const tracked: BrowserSession = {
    ...session,
    close: async () => {
      if (closing) return closing;
      closing = (async () => {
        try {
          await originalClose();
        } finally {
          ownedSessions.delete(tracked);
        }
      })();
      return closing;
    },
  };
  ownedSessions.add(tracked);
  return tracked;
}

/** Close every browser session this process still owns. */
export async function closeOwnedBrowserSessions(): Promise<void> {
  const sessions = [...ownedSessions];
  await Promise.allSettled(sessions.map((session) => session.close()));
}

/**
 * Clean up the browser resources this process owns on exit.
 *
 * Only the sessions this process opened are closed. The shared daemon is
 * stopped only through its own safety barrier, so a daemon used by another
 * invocation is never terminated.
 */
export async function cleanupBrowserOnProcessExit(): Promise<void> {
  if (!hasOwnedBrowserSessions()) return;
  await closeOwnedBrowserSessions().catch(() => {});
  await requestDaemonStop().catch(() => {});
}

export interface LaunchOptions {
  provider: ProviderName;
  headless?: boolean;
  /** Initial URL to navigate to after launch. */
  url?: string;
  /**
   * Profile mode:
   * - 'shared': each process launches its own browser but loads shared
   *   cookies/storage from a common state file. Truly parallel across
   *   processes — no locks, no conflicts.
   * - 'isolated': per-provider persistent context with profile lock
   *   (original behavior).
   * Defaults to 'shared'.
   */
  profileMode?: ProfileMode;
  /** Named profile under ~/.10x-chat/profiles/<name>. Forces isolated persistent mode. */
  profile?: string;
  /**
   * If true, use a persistent context even in shared mode.
   * Used by `login` command which needs the user to interact and have
   * state auto-persisted to disk. After login, storage state is exported
   * for use by regular (non-persistent) shared sessions.
   */
  persistent?: boolean;
  /** Internal operation label for diagnostics (e.g. chat, login). */
  operation?: string;
}

function opOf(opts: LaunchOptions, operation: string): BrowserOp {
  return { provider: opts.provider, operation, url: opts.url, startedAt: Date.now() };
}

async function withStage<T>(op: BrowserOp, stage: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    throw browserError(`Browser ${stage} failed`, { ...op, stage }, error);
  }
}

async function attachDebug(
  op: BrowserOp,
  context: BrowserContext | undefined,
  page: Page | undefined,
): Promise<DebugCollector | undefined> {
  if (!isBrowserDebugEnabled() || !context) return undefined;
  const collector = createDebugCollector();
  if (page) collector.attach(page);
  context.on('page', (p) => collector.attach(p));
  await context.tracing
    ?.start({ screenshots: true, snapshots: true, sources: false })
    .catch(() => {});
  return collector;
}

async function finalizeDebug(
  op: BrowserOp,
  context: BrowserContext | undefined,
  page: Page | undefined,
  collector: DebugCollector | undefined,
  failed: boolean,
): Promise<void> {
  if (!isBrowserDebugEnabled() || !context) return;
  if (failed) {
    const dir = await saveDebugArtifacts(op, page, context, collector).catch(() => undefined);
    if (dir) {
      await context.tracing?.stop({ path: path.join(dir, 'trace.zip') }).catch(() => {});
    } else {
      await context.tracing?.stop().catch(() => {});
    }
    return;
  }
  await context.tracing?.stop().catch(() => {});
}

/**
 * Launch a browser session for a provider.
 *
 * **Shared mode (default):** Connects to (or starts) a shared browser daemon and
 * creates an isolated browser context loaded with shared cookies from
 * `~/.10x-chat/profiles/default/storage-state.json`. Multiple invocations can
 * run in parallel against the same Chromium process.
 *
 * **Shared + persistent** (login only): Uses `launchPersistentContext` on the
 * shared profile dir so the user can interact and cookies auto-persist.
 * Requires profile lock (only one login at a time).
 *
 * **Isolated mode:** Each provider gets its own persistent Chromium context
 * and profile directory. Original behavior with profile lock.
 */
export async function launchBrowser(opts: LaunchOptions): Promise<BrowserSession> {
  const { profileMode = 'shared', persistent = false, profile } = opts;

  if (profile || profileMode === 'isolated') {
    return launchIsolatedBrowser(opts);
  }

  if (persistent) {
    return launchSharedPersistentBrowser(opts);
  }

  return launchSharedBrowser(opts);
}

/**
 * Shared mode (non-persistent): connects to or launches a shared browser daemon.
 * Multiple CLI invocations share the same Chromium process. Browser is only
 * stopped when the daemon becomes idle.
 */
async function launchSharedBrowser(opts: LaunchOptions): Promise<BrowserSession> {
  const { headless = true, url } = opts;
  const op = opOf(opts, opts.operation ?? 'session');
  try {
    const session = await withStage(op, 'launch-shared', () =>
      launchSharedBrowserSession({ headless, url }),
    );
    const close = async () => {
      try {
        await withStage(op, 'close-shared', session.close);
      } finally {
        // no local debug artifacts; daemon owns page/context internals
      }
    };
    return trackOwnedSession({
      context: session.context,
      page: session.page,
      lock: null,
      sharedState: true,
      close,
    });
  } catch (error) {
    throw browserError(
      'Failed to launch shared browser session',
      { ...op, stage: 'launch-shared' },
      error,
    );
  }
}

/**
 * Shared mode (persistent): for login command.
 * Uses persistent context so cookies auto-save to disk.
 * Requires lock since persistent contexts can't share a profile dir.
 */
async function launchSharedPersistentBrowser(opts: LaunchOptions): Promise<BrowserSession> {
  const { headless = true, url } = opts;
  const op = opOf(opts, opts.operation ?? 'login');
  const profileDir = getSharedProfileDir();
  await withStage(op, 'prepare-profile', () => mkdir(profileDir, { recursive: true }));

  const lock = await withStage(op, 'acquire-lock', () => acquireProfileLock(profileDir));
  await markProfileClean(profileDir);

  let context: BrowserContext | undefined;
  let page: Page | undefined;
  let collector: DebugCollector | undefined;
  try {
    const channel = detectChromeChannel();
    context = await withStage(op, 'launch-context', async () =>
      (await getChromium()).launchPersistentContext(profileDir, {
        headless,
        viewport: { width: 1280, height: 900 },
        ...(channel ? { channel } : {}),
        args: CHROMIUM_ARGS,
      }),
    );
    if (getEngineName() !== 'cloakbrowser') {
      await context.addInitScript(STEALTH_INIT_SCRIPT);
    }

    page = context.pages()[0] ?? (await context.newPage());
    collector = await attachDebug(op, context, page);

    if (url) {
      await withStage({ ...op, url }, 'navigate', () =>
        page!.goto(url, { waitUntil: 'domcontentloaded' }),
      );
    }
  } catch (error) {
    await finalizeDebug(
      { ...op, stage: 'launch-shared-persistent' },
      context,
      page,
      collector,
      true,
    );
    await context?.close().catch(() => {});
    await lock.release();
    throw error;
  }

  const close = async () => {
    let failed = false;
    try {
      await withStage(op, 'save-storage-state', () => saveStorageState(context!));
    } catch {
      // best effort
    }
    try {
      await withStage(op, 'close-context', () => context!.close());
    } catch (error) {
      failed = true;
      throw error;
    } finally {
      await finalizeDebug(
        { ...op, stage: 'close-shared-persistent' },
        context,
        page,
        collector,
        failed,
      );
      await lock.release();
    }
  };

  return trackOwnedSession({ context, page, lock, sharedState: false, close });
}

/**
 * Isolated mode (original behavior).
 * Per-provider persistent context with profile lock.
 */
async function launchIsolatedBrowser(opts: LaunchOptions): Promise<BrowserSession> {
  const { provider, headless = true, url, profile } = opts;
  const op = opOf(opts, opts.operation ?? 'session');
  const profileDir = getIsolatedProfileDir(profile ?? provider);
  await withStage(op, 'prepare-profile', () => mkdir(profileDir, { recursive: true }));

  const lock = await withStage(op, 'acquire-lock', () => acquireProfileLock(profileDir));
  await markProfileClean(profileDir);

  let context: BrowserContext | undefined;
  let page: Page | undefined;
  let collector: DebugCollector | undefined;
  try {
    const channel = detectChromeChannel();
    context = await withStage(op, 'launch-context', async () =>
      (await getChromium()).launchPersistentContext(profileDir, {
        headless,
        viewport: { width: 1280, height: 900 },
        ...(channel ? { channel } : {}),
        args: CHROMIUM_ARGS,
      }),
    );
    if (getEngineName() !== 'cloakbrowser') {
      await context.addInitScript(STEALTH_INIT_SCRIPT);
    }

    page = context.pages()[0] ?? (await context.newPage());
    collector = await attachDebug(op, context, page);

    if (url) {
      await withStage({ ...op, url }, 'navigate', () =>
        page!.goto(url, { waitUntil: 'domcontentloaded' }),
      );
    }
  } catch (error) {
    await finalizeDebug({ ...op, stage: 'launch-isolated' }, context, page, collector, true);
    await context?.close().catch(() => {});
    await lock.release();
    throw error;
  }

  const close = async () => {
    let failed = false;
    try {
      await withStage(op, 'close-context', () => context!.close());
    } catch (error) {
      failed = true;
      throw error;
    } finally {
      await finalizeDebug({ ...op, stage: 'close-isolated' }, context, page, collector, failed);
      await lock.release();
    }
  };

  return trackOwnedSession({ context, page, lock, sharedState: false, close });
}
