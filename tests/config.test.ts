import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

describe('Config Loading', () => {
  const originalEnv = process.env;
  let tempHome = '';

  beforeEach(async () => {
    tempHome = await mkdtemp(path.join(os.tmpdir(), 'ten-x-chat-config-'));
    process.env = {
      ...originalEnv,
      TEN_X_CHAT_HOME: tempHome,
    };
  });

  afterEach(async () => {
    process.env = originalEnv;
    if (tempHome) await rm(tempHome, { recursive: true, force: true });
  });

  const writeConfig = (content: string) =>
    writeFile(path.join(tempHome, 'config.json'), content, 'utf8');

  it('loads JSON config from disk', async () => {
    await writeConfig(JSON.stringify({ profileMode: 'isolated', headless: false }, null, 2));

    const { loadConfig } = await import('../src/config.js');
    const config = await loadConfig();

    expect(config.profileMode).toBe('isolated');
    expect(config.headless).toBe(false);
  });

  it('loads JSON5 config from disk', async () => {
    await writeConfig(
      '{\n        // provider profile mode\n        profileMode: "isolated",\n        headless: false,\n      }',
    );

    const { loadConfig } = await import('../src/config.js');
    const config = await loadConfig();

    expect(config.profileMode).toBe('isolated');
    expect(config.headless).toBe(false);
  });

  it('falls back to the defaults without a config file', async () => {
    const { CONFIG_KEYS, loadConfig } = await import('../src/config.js');
    const config = await loadConfig();

    expect(config.defaultProvider).toBe('chatgpt');
    expect(config.profileMode).toBe('shared');
    expect(config.headless).toBe(true);
    expect(config.defaultTimeoutMs).toBeUndefined();
    expect(CONFIG_KEYS).toContain('profileMode');
  });

  it('reports an unparsable config file with its path', async () => {
    await writeConfig('{ profileMode: "isolated"');

    const { loadConfig } = await import('../src/config.js');
    await expect(loadConfig()).rejects.toThrow(/Invalid config file .*config\.json/);
  });

  it('reports an unknown key instead of ignoring it', async () => {
    await writeConfig(JSON.stringify({ profileMod: 'isolated' }));

    const { loadConfig } = await import('../src/config.js');
    await expect(loadConfig()).rejects.toThrow(/unknown key "profileMod"/);
  });

  it('reports an invalid provider', async () => {
    await writeConfig(JSON.stringify({ defaultProvider: 'nope' }));

    const { loadConfig } = await import('../src/config.js');
    await expect(loadConfig()).rejects.toThrow(/"defaultProvider" must be one of/);
  });

  it('reports an invalid profile mode', async () => {
    await writeConfig(JSON.stringify({ profileMode: 'per-provider' }));

    const { loadConfig } = await import('../src/config.js');
    await expect(loadConfig()).rejects.toThrow(/"profileMode" must be one of/);
  });

  it('reports an invalid headless value', async () => {
    await writeConfig(JSON.stringify({ headless: 'yes' }));

    const { loadConfig } = await import('../src/config.js');
    await expect(loadConfig()).rejects.toThrow(/"headless" must be true or false/);
  });

  it('reports an invalid timeout', async () => {
    await writeConfig(JSON.stringify({ defaultTimeoutMs: -1 }));

    const { loadConfig } = await import('../src/config.js');
    await expect(loadConfig()).rejects.toThrow(/"defaultTimeoutMs" must be a positive number/);
  });

  it('saves and reloads a config', async () => {
    const { loadConfig, saveConfig } = await import('../src/config.js');

    await saveConfig({
      defaultProvider: 'gemini',
      defaultModel: 'pro',
      defaultTimeoutMs: 60_000,
      headless: false,
      profileMode: 'isolated',
    });

    const config = await loadConfig();
    expect(config.defaultProvider).toBe('gemini');
    expect(config.defaultModel).toBe('pro');
    expect(config.defaultTimeoutMs).toBe(60_000);
    expect(config.profileMode).toBe('isolated');
  });

  it('refuses to save an invalid config', async () => {
    const { saveConfig } = await import('../src/config.js');

    await expect(
      saveConfig({
        defaultProvider: 'nope',
        headless: true,
        profileMode: 'shared',
      }),
    ).rejects.toThrow(/"defaultProvider" must be one of/);
  });
});

describe('The proxy section of the config', () => {
  const originalEnv = process.env;
  let tempHome = '';

  beforeEach(async () => {
    tempHome = await mkdtemp(path.join(os.tmpdir(), 'ten-x-chat-config-proxy-'));
    process.env = { ...originalEnv, TEN_X_CHAT_HOME: tempHome };
  });

  afterEach(async () => {
    process.env = originalEnv;
    if (tempHome) await rm(tempHome, { recursive: true, force: true });
  });

  const writeConfig = (content: string) =>
    writeFile(path.join(tempHome, 'config.json'), content, 'utf8');

  it('loads a proxy section', async () => {
    await writeConfig(
      JSON.stringify({
        proxy: {
          enabled: true,
          server: 'http://proxy.example.com:3128',
          bypass: ['localhost'],
        },
      }),
    );

    const { loadConfig } = await import('../src/config.js');
    const config = await loadConfig();

    expect(config.proxy).toEqual({
      enabled: true,
      server: 'http://proxy.example.com:3128',
      bypass: ['localhost'],
    });
  });

  it('loads a proxy that is switched off', async () => {
    await writeConfig(JSON.stringify({ proxy: { enabled: false } }));

    const { loadConfig } = await import('../src/config.js');
    const config = await loadConfig();

    expect(config.proxy).toEqual({ enabled: false });
  });

  it('reports an unknown key in the proxy section', async () => {
    await writeConfig(JSON.stringify({ proxy: { enabled: true, user: 'name' } }));

    const { loadConfig } = await import('../src/config.js');
    await expect(loadConfig()).rejects.toThrow(/unknown key "proxy\.user"/);
  });

  it('reports a proxy without an explicit state', async () => {
    await writeConfig(JSON.stringify({ proxy: { server: 'http://proxy.example.com:3128' } }));

    const { loadConfig } = await import('../src/config.js');
    await expect(loadConfig()).rejects.toThrow(/"proxy\.enabled" must be true or false/);
  });

  it('reports an enabled proxy without a server', async () => {
    await writeConfig(JSON.stringify({ proxy: { enabled: true } }));

    const { loadConfig } = await import('../src/config.js');
    await expect(loadConfig()).rejects.toThrow(/"proxy\.server" is required/);
  });

  it('reports an unsupported scheme without naming the URL', async () => {
    await writeConfig(
      JSON.stringify({ proxy: { enabled: true, server: 'ftp://proxy.example.com:21' } }),
    );

    const { loadConfig } = await import('../src/config.js');
    const error = await loadConfig().then(
      () => undefined,
      (reason: unknown) => reason as Error,
    );

    expect(error?.message).toMatch(/Unsupported proxy scheme "ftp"/);
    expect(error?.message).not.toContain('proxy.example.com');
  });

  it('reports credentials in the server without naming them', async () => {
    await writeConfig(
      JSON.stringify({
        proxy: { enabled: true, server: 'http://proxy-user:sup3r-s3cret@proxy.example.com:3128' },
      }),
    );

    const { loadConfig } = await import('../src/config.js');
    const error = await loadConfig().then(
      () => undefined,
      (reason: unknown) => reason as Error,
    );

    expect(error?.message).toMatch(/must not contain credentials/);
    expect(error?.message).not.toContain('sup3r-s3cret');
    expect(error?.message).not.toContain('proxy-user');
  });

  it('reports credentials in the server of a disabled proxy without naming them', async () => {
    // `enabled: false` switches the proxy off — it must not make the
    // credentials of a plaintext config file acceptable.
    await writeConfig(
      JSON.stringify({
        proxy: { enabled: false, server: 'http://proxy-user:sup3r-s3cret@proxy.example.com:3128' },
      }),
    );

    const { loadConfig } = await import('../src/config.js');
    const error = await loadConfig().then(
      () => undefined,
      (reason: unknown) => reason as Error,
    );

    expect(error?.message).toMatch(/must not contain credentials/);
    expect(error?.message).not.toContain('sup3r-s3cret');
    expect(error?.message).not.toContain('proxy-user');
  });

  it('reports a bypass list that is not a list of strings', async () => {
    await writeConfig(
      JSON.stringify({
        proxy: { enabled: true, server: 'http://proxy.example.com:3128', bypass: 5 },
      }),
    );

    const { loadConfig } = await import('../src/config.js');
    await expect(loadConfig()).rejects.toThrow(/"proxy\.bypass" must be an array of strings/);
  });

  it('reports a proxy that is not an object', async () => {
    await writeConfig(JSON.stringify({ proxy: 'http://proxy.example.com:3128' }));

    const { loadConfig } = await import('../src/config.js');
    await expect(loadConfig()).rejects.toThrow(/"proxy" must be an object/);
  });
});
