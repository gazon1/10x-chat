import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const lock = { release: vi.fn(async () => {}) };
  const page = { goto: vi.fn(async () => {}), close: vi.fn(async () => {}) };
  const context = {
    pages: vi.fn(() => [page]),
    newPage: vi.fn(async () => page),
    close: vi.fn(async () => {}),
    addInitScript: vi.fn(async () => {}),
    on: vi.fn(),
    tracing: { start: vi.fn(async () => {}), stop: vi.fn(async () => {}) },
  };
  const chromium = { launchPersistentContext: vi.fn(async () => context) };
  return {
    lock,
    page,
    context,
    chromium,
    acquireProfileLock: vi.fn(async () => lock),
    getChromium: vi.fn(async () => chromium),
    getEngineName: vi.fn(() => 'cloakbrowser'),
    markClean: vi.fn(async () => {}),
    mkdir: vi.fn(async () => {}),
    readFile: vi.fn(async () => '{}'),
    writeFile: vi.fn(async () => {}),
    saveStorageState: vi.fn(async () => {}),
    getSharedProfileDir: vi.fn(() => '/tmp/10x-shared'),
    getIsolatedProfileDir: vi.fn((name: string) => `/tmp/10x-${name}`),
    detectChromeChannel: vi.fn(() => undefined),
    saveDebugArtifacts: vi.fn(async () => undefined),
    createDebugCollector: vi.fn(() => ({ attach: vi.fn(), dump: vi.fn(async () => ({})) })),
    isBrowserDebugEnabled: vi.fn(() => false),
  };
});

vi.mock('node:fs/promises', () => ({
  mkdir: mocks.mkdir,
  readFile: mocks.readFile,
  writeFile: mocks.writeFile,
}));
vi.mock('../src/paths.js', () => ({
  getSharedProfileDir: mocks.getSharedProfileDir,
  getIsolatedProfileDir: mocks.getIsolatedProfileDir,
}));
vi.mock('../src/browser/daemon.js', () => ({
  launchSharedBrowserSession: vi.fn(),
  requestDaemonStop: vi.fn(async () => 'stopped'),
}));
vi.mock('../src/browser/engine.js', () => ({
  getChromium: mocks.getChromium,
  getEngineName: mocks.getEngineName,
}));
vi.mock('../src/browser/lock.js', () => ({
  acquireProfileLock: mocks.acquireProfileLock,
}));
vi.mock('../src/browser/state.js', () => ({
  saveStorageState: mocks.saveStorageState,
}));
vi.mock('../src/browser/stealth.js', () => ({
  detectChromeChannel: mocks.detectChromeChannel,
  STEALTH_INIT_SCRIPT: 'stealth',
}));
vi.mock('../src/browser/diagnostics.js', async () => {
  const actual = await vi.importActual<typeof import('../src/browser/diagnostics.js')>(
    '../src/browser/diagnostics.js',
  );
  return {
    ...actual,
    createDebugCollector: mocks.createDebugCollector,
    isBrowserDebugEnabled: mocks.isBrowserDebugEnabled,
    saveDebugArtifacts: mocks.saveDebugArtifacts,
  };
});

import { requestDaemonStop } from '../src/browser/daemon.js';
import {
  cleanupBrowserOnProcessExit,
  closeOwnedBrowserSessions,
  hasOwnedBrowserSessions,
  launchBrowser,
} from '../src/browser/manager.js';

describe('launchBrowser lock cleanup', () => {
  beforeEach(async () => {
    await closeOwnedBrowserSessions();
    vi.clearAllMocks();
    mocks.lock.release.mockResolvedValue(undefined);
    mocks.page.goto.mockResolvedValue(undefined);
    mocks.context.pages.mockReturnValue([mocks.page]);
    mocks.context.newPage.mockResolvedValue(mocks.page as never);
    mocks.context.close.mockResolvedValue(undefined);
    mocks.chromium.launchPersistentContext.mockResolvedValue(mocks.context as never);
    mocks.acquireProfileLock.mockResolvedValue(mocks.lock as never);
    mocks.mkdir.mockResolvedValue(undefined);
    mocks.readFile.mockRejectedValue(new Error('no prefs'));
    mocks.isBrowserDebugEnabled.mockReturnValue(false);
    vi.mocked(requestDaemonStop).mockResolvedValue('stopped');
  });

  it('releases lock when isolated launch fails', async () => {
    mocks.chromium.launchPersistentContext.mockRejectedValueOnce(new Error('boom'));
    await expect(
      launchBrowser({ provider: 'chatgpt', profileMode: 'isolated', operation: 'chat' }),
    ).rejects.toThrow();
    expect(mocks.acquireProfileLock).toHaveBeenCalledTimes(1);
    expect(mocks.lock.release).toHaveBeenCalledTimes(1);
  });

  it('releases lock when isolated navigation fails', async () => {
    mocks.page.goto.mockRejectedValueOnce(new Error('nav failed'));
    await expect(
      launchBrowser({
        provider: 'chatgpt',
        profileMode: 'isolated',
        url: 'https://example.com',
        operation: 'chat',
      }),
    ).rejects.toThrow();
    expect(mocks.context.close).toHaveBeenCalledTimes(1);
    expect(mocks.lock.release).toHaveBeenCalledTimes(1);
  });

  it('does not leak lock when profile preparation fails before acquire', async () => {
    mocks.mkdir.mockRejectedValueOnce(new Error('disk full'));
    await expect(launchBrowser({ provider: 'chatgpt', profileMode: 'isolated' })).rejects.toThrow();
    expect(mocks.acquireProfileLock).not.toHaveBeenCalled();
    expect(mocks.lock.release).not.toHaveBeenCalled();
  });

  it('releases lock when shared persistent navigation fails', async () => {
    mocks.page.goto.mockRejectedValueOnce(new Error('nav failed'));
    await expect(
      launchBrowser({
        provider: 'chatgpt',
        persistent: true,
        url: 'https://example.com',
        operation: 'login',
      }),
    ).rejects.toThrow();
    expect(mocks.context.close).toHaveBeenCalledTimes(1);
    expect(mocks.lock.release).toHaveBeenCalledTimes(1);
  });

  it('releases lock when isolated close fails', async () => {
    mocks.context.close.mockRejectedValueOnce(new Error('close failed'));
    const session = await launchBrowser({ provider: 'chatgpt', profileMode: 'isolated' });
    await expect(session.close()).rejects.toThrow();
    expect(mocks.lock.release).toHaveBeenCalledTimes(1);
  });

  it('releases lock when shared persistent launch fails', async () => {
    mocks.chromium.launchPersistentContext.mockRejectedValueOnce(new Error('boom'));
    await expect(
      launchBrowser({ provider: 'chatgpt', persistent: true, operation: 'login' }),
    ).rejects.toThrow();
    expect(mocks.getSharedProfileDir).toHaveBeenCalled();
    expect(mocks.lock.release).toHaveBeenCalledTimes(1);
  });

  it('releases lock when shared persistent close fails', async () => {
    mocks.context.close.mockRejectedValueOnce(new Error('close failed'));
    const session = await launchBrowser({ provider: 'chatgpt', persistent: true });
    await expect(session.close()).rejects.toThrow();
    expect(mocks.saveStorageState).toHaveBeenCalledTimes(1);
    expect(mocks.lock.release).toHaveBeenCalledTimes(1);
  });
});

describe('browser session ownership cleanup', () => {
  beforeEach(async () => {
    await closeOwnedBrowserSessions();
    vi.clearAllMocks();
    mocks.lock.release.mockResolvedValue(undefined);
    mocks.page.goto.mockResolvedValue(undefined);
    mocks.context.pages.mockReturnValue([mocks.page]);
    mocks.context.newPage.mockResolvedValue(mocks.page as never);
    mocks.context.close.mockResolvedValue(undefined);
    mocks.chromium.launchPersistentContext.mockResolvedValue(mocks.context as never);
    mocks.acquireProfileLock.mockResolvedValue(mocks.lock as never);
    mocks.mkdir.mockResolvedValue(undefined);
    mocks.readFile.mockRejectedValue(new Error('no prefs'));
    mocks.isBrowserDebugEnabled.mockReturnValue(false);
    vi.mocked(requestDaemonStop).mockResolvedValue('stopped');
  });

  it('does not stop a daemon used by another invocation when an unrelated command exits', async () => {
    // Commands that never opened a browser own no session. Their process-exit
    // cleanup must not stop the shared daemon (including one busy with another
    // invocation's session).
    expect(hasOwnedBrowserSessions()).toBe(false);
    await cleanupBrowserOnProcessExit();
    expect(requestDaemonStop).not.toHaveBeenCalled();
  });

  it('closes an owned isolated session and asks the daemon barrier on exit', async () => {
    const session = await launchBrowser({ provider: 'chatgpt', profileMode: 'isolated' });
    expect(hasOwnedBrowserSessions()).toBe(true);

    await cleanupBrowserOnProcessExit();

    expect(mocks.context.close).toHaveBeenCalledTimes(1);
    expect(mocks.lock.release).toHaveBeenCalledTimes(1);
    expect(requestDaemonStop).toHaveBeenCalledTimes(1);
    expect(hasOwnedBrowserSessions()).toBe(false);
  });

  it('closes an owned shared daemon session and asks the daemon barrier on exit', async () => {
    const sharedClose = vi.fn(async () => {});
    const { launchSharedBrowserSession } = await import('../src/browser/daemon.js');
    vi.mocked(launchSharedBrowserSession).mockResolvedValue({
      context: mocks.context as never,
      page: mocks.page as never,
      close: sharedClose,
    });

    await launchBrowser({ provider: 'chatgpt', operation: 'chat' });
    await cleanupBrowserOnProcessExit();

    expect(sharedClose).toHaveBeenCalledTimes(1);
    expect(requestDaemonStop).toHaveBeenCalledTimes(1);
    expect(hasOwnedBrowserSessions()).toBe(false);
  });

  it('keeps cleanup idempotent for a session closed by the command', async () => {
    const session = await launchBrowser({ provider: 'chatgpt', profileMode: 'isolated' });
    await session.close();
    await cleanupBrowserOnProcessExit();

    expect(mocks.context.close).toHaveBeenCalledTimes(1);
    expect(requestDaemonStop).not.toHaveBeenCalled();
  });
});
