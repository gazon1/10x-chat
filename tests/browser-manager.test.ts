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

import { launchBrowser } from '../src/browser/manager.js';

describe('launchBrowser lock cleanup', () => {
  beforeEach(() => {
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
