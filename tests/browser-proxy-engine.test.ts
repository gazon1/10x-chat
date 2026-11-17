import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  launch: vi.fn(async () => ({ id: 'browser' })),
  launchPersistentContext: vi.fn(async () => ({ id: 'context' })),
}));

vi.mock('cloakbrowser', () => ({
  launch: mocks.launch,
  launchPersistentContext: mocks.launchPersistentContext,
}));

const SECRET = 'sup3r-s3cret';
const LOGIN = 'proxy-user';

/**
 * The proxy of the config file must reach the browser — in both browser modes:
 * the shared daemon (`launch`) and the persistent context of the isolated and
 * the named profile (`launchPersistentContext`).
 */
describe('the proxy of the browser', () => {
  const originalEnv = process.env;
  let tempHome = '';

  beforeEach(async () => {
    tempHome = await mkdtemp(path.join(os.tmpdir(), 'ten-x-chat-engine-proxy-'));
    process.env = { ...originalEnv, TEN_X_CHAT_HOME: tempHome };
    mocks.launch.mockClear();
    mocks.launchPersistentContext.mockClear();
  });

  afterEach(async () => {
    process.env = originalEnv;
    if (tempHome) await rm(tempHome, { recursive: true, force: true });
  });

  const writeConfig = (content: string) =>
    writeFile(path.join(tempHome, 'config.json'), content, 'utf8');

  const writeSecrets = async (content: string) => {
    const secretsPath = path.join(tempHome, 'secrets.json');
    await writeFile(secretsPath, content, { encoding: 'utf8', mode: 0o600 });
    await chmod(secretsPath, 0o600);
  };

  const launchOptionsOf = (call: unknown[]): Record<string, unknown> =>
    (call[0] as { launchOptions: Record<string, unknown> }).launchOptions;

  it('hands the proxy of the config file to the browser', async () => {
    await writeConfig(
      JSON.stringify({
        proxy: {
          enabled: true,
          server: 'http://config.example.com:3128',
          bypass: ['localhost'],
        },
      }),
    );
    await writeSecrets(JSON.stringify({ 'proxy.username': LOGIN, 'proxy.password': SECRET }));

    const { getChromium } = await import('../src/browser/engine.js');
    const chromium = await getChromium();
    await chromium.launch({ headless: true });

    const launchOptions = launchOptionsOf(mocks.launch.mock.calls[0]);
    expect(launchOptions.proxy).toEqual({
      server: 'http://config.example.com:3128',
      username: LOGIN,
      password: SECRET,
      bypass: 'localhost',
    });
  });

  it('hands the proxy of the config file to a persistent context', async () => {
    await writeConfig(
      JSON.stringify({ proxy: { enabled: true, server: 'http://config.example.com:3128' } }),
    );

    const { getChromium } = await import('../src/browser/engine.js');
    const chromium = await getChromium();
    await chromium.launchPersistentContext('/tmp/profile', { headless: true });

    const launchOptions = launchOptionsOf(mocks.launchPersistentContext.mock.calls[0]);
    expect(launchOptions.proxy).toEqual({ server: 'http://config.example.com:3128' });
  });

  it('hands no proxy to the browser when the proxy is switched off', async () => {
    await writeConfig(JSON.stringify({ proxy: { enabled: false } }));

    const { getChromium } = await import('../src/browser/engine.js');
    const chromium = await getChromium();
    await chromium.launch({ headless: true });

    const launchOptions = launchOptionsOf(mocks.launch.mock.calls[0]);
    expect(launchOptions.proxy).toBeUndefined();
  });

  it('keeps the credentials out of the environment of the browser', async () => {
    await writeConfig(
      JSON.stringify({ proxy: { enabled: true, server: 'http://config.example.com:3128' } }),
    );
    await writeSecrets(JSON.stringify({ 'proxy.username': LOGIN, 'proxy.password': SECRET }));

    const { getChromium } = await import('../src/browser/engine.js');
    const chromium = await getChromium();
    await chromium.launch({ headless: true });

    const launchOptions = launchOptionsOf(mocks.launch.mock.calls[0]);
    expect(JSON.stringify(launchOptions.env)).not.toContain(SECRET);
  });
});
