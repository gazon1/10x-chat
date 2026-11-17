import { spawn } from 'node:child_process';
import { chmod, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig, resolveEffectiveProxy } from '../src/config.js';
import { getProviderApiKey } from '../src/core/credentials.js';
import {
  getSecretStore,
  getSecretsPath,
  PROXY_PASSWORD_SECRET,
  PROXY_USERNAME_SECRET,
  redactSecretValues,
} from '../src/secrets.js';

const SECRET = 'sk-do-not-print-me';

describe('secrets store', () => {
  const originalEnv = process.env;
  let tempHome = '';

  beforeEach(async () => {
    tempHome = await mkdtemp(path.join(os.tmpdir(), 'ten-x-chat-secrets-'));
    process.env = { ...originalEnv, TEN_X_CHAT_HOME: tempHome };
  });

  afterEach(async () => {
    process.env = originalEnv;
    if (tempHome) await rm(tempHome, { recursive: true, force: true });
  });

  it('stores a secret and reads it back in a later run', async () => {
    const store = getSecretStore();
    await store.set('openai-key', SECRET);

    // A new store instance — a later invocation of the CLI.
    expect(await getSecretStore().get('openai-key')).toBe(SECRET);
    expect(await getSecretStore().list()).toEqual(['openai-key']);
  });

  it('replaces a secret with the same name', async () => {
    const store = getSecretStore();
    await store.set('openai-key', 'first');
    await store.set('openai-key', 'second');

    expect(await store.get('openai-key')).toBe('second');
    expect(await store.list()).toEqual(['openai-key']);
  });

  it('removes a secret and reports an unknown one', async () => {
    const store = getSecretStore();
    await store.set('openai-key', SECRET);

    expect(await store.remove('openai-key')).toBe(true);
    expect(await store.get('openai-key')).toBeUndefined();
    expect(await store.remove('openai-key')).toBe(false);
  });

  it('rejects an invalid secret name', async () => {
    await expect(getSecretStore().set('../escape', SECRET)).rejects.toThrow(/Invalid secret name/);
  });

  it('rejects an invalid secret name on a read and on a delete', async () => {
    const store = getSecretStore();
    await expect(store.get('../escape')).rejects.toThrow(/Invalid secret name/);
    await expect(store.remove('../escape')).rejects.toThrow(/Invalid secret name/);
  });

  it('fails clearly on a file with an invalid secret name', async () => {
    await writeFile(getSecretsPath(), JSON.stringify({ 'bad name': SECRET }), {
      encoding: 'utf8',
      mode: 0o600,
    });

    await expect(getSecretStore().list()).rejects.toThrow(/corrupt/);
    await expect(getSecretStore().get('openai-key')).rejects.toThrow(/not allowed/);
  });

  it('reads a secret whose name is a property of Object.prototype from the file', async () => {
    // The name is written by hand — a literal `{'__proto__': …}` would set
    // the prototype instead of an own property.
    await writeFile(getSecretsPath(), `{"__proto__":"${SECRET}"}`, {
      encoding: 'utf8',
      mode: 0o600,
    });

    const store = getSecretStore();
    expect(await store.get('__proto__')).toBe(SECRET);
    expect(await store.list()).toEqual(['__proto__']);
  });

  it('stores a secret whose name is a property of Object.prototype', async () => {
    // `__proto__` is a valid name (letters, dashes, underscores) and a plain
    // object would turn the assignment into a setter of the prototype.
    await getSecretStore().set('__proto__', SECRET);

    expect(await getSecretStore().get('__proto__')).toBe(SECRET);
    expect(await getSecretStore().list()).toEqual(['__proto__']);
  });

  it('does not report an inherited property as a stored secret', async () => {
    const store = getSecretStore();
    expect(await store.get('toString')).toBeUndefined();
    expect(await store.get('constructor')).toBeUndefined();
    expect(await store.remove('toString')).toBe(false);
  });

  it('removes a secret whose name is a property of Object.prototype', async () => {
    const store = getSecretStore();
    await store.set('__proto__', SECRET);

    expect(await store.remove('__proto__')).toBe(true);
    expect(await store.get('__proto__')).toBeUndefined();
  });

  it('keeps the file readable by its owner only', async () => {
    if (process.platform === 'win32') return; // no POSIX modes on Windows
    await getSecretStore().set('openai-key', SECRET);

    const fileMode = (await stat(getSecretsPath())).mode & 0o777;
    const dirMode = (await stat(path.dirname(getSecretsPath()))).mode & 0o777;
    expect(fileMode).toBe(0o600);
    expect(dirMode).toBe(0o700);
  });

  it('tightens the mode of an already existing directory', async () => {
    if (process.platform === 'win32') return; // no POSIX modes on Windows
    // The directory exists already (the config file created it) — `mkdir`
    // does not change the mode of an existing directory.
    await chmod(tempHome, 0o755);

    await getSecretStore().set('openai-key', SECRET);

    expect((await stat(tempHome)).mode & 0o777).toBe(0o700);
  });

  it('tightens the directory before it reads the secrets', async () => {
    if (process.platform === 'win32') return; // no POSIX modes on Windows
    await getSecretStore().set('openai-key', SECRET);
    // The mode of the file alone does not protect it: a directory that other
    // users may write lets them replace the file.
    await chmod(tempHome, 0o777);

    expect(await getSecretStore().list()).toEqual(['openai-key']);
    expect((await stat(tempHome)).mode & 0o777).toBe(0o700);
  });

  it('keeps both secrets when two writes run at the same time', async () => {
    const store = getSecretStore();
    await Promise.all([store.set('openai-key', SECRET), store.set('deepseek-key', 'sk-second')]);

    expect(await store.list()).toEqual(['deepseek-key', 'openai-key']);
  });

  it('writes atomically and leaves no temp file behind', async () => {
    await getSecretStore().set('openai-key', SECRET);

    const files = await readdir(tempHome);
    expect(files.filter((file) => file.endsWith('.tmp'))).toEqual([]);
    expect(files).toContain('secrets.json');
  });

  it('fails clearly on a corrupt store instead of returning nothing', async () => {
    await writeFile(getSecretsPath(), '{ not json', { encoding: 'utf8', mode: 0o600 });

    await expect(getSecretStore().list()).rejects.toThrow(/corrupt/);
    await expect(getSecretStore().get('openai-key')).rejects.toThrow(/corrupt/);
  });

  it('fails clearly when the store cannot be read', async () => {
    if (process.platform === 'win32') return;
    if (typeof process.getuid === 'function' && process.getuid() === 0) return; // root reads anything
    await writeFile(getSecretsPath(), JSON.stringify({ 'openai-key': SECRET }), {
      encoding: 'utf8',
      mode: 0o600,
    });
    await chmod(getSecretsPath(), 0o000);

    try {
      await expect(getSecretStore().get('openai-key')).rejects.toThrow(/Cannot read secrets file/);
    } finally {
      await chmod(getSecretsPath(), 0o600);
    }
  });

  it('refuses a store that other users can read', async () => {
    if (process.platform === 'win32') return; // no POSIX modes on Windows
    await writeFile(getSecretsPath(), JSON.stringify({ 'openai-key': SECRET }), {
      encoding: 'utf8',
      mode: 0o644,
    });

    await expect(getSecretStore().get('openai-key')).rejects.toThrow(
      /must not be readable by other users/,
    );
  });

  it('reads the file format of the proxy settings of #34', async () => {
    // The format of PR #34: the credentials of the proxy in one object. They
    // are two secrets of the store now.
    await writeFile(
      getSecretsPath(),
      JSON.stringify({ proxy: { username: 'proxy-user', password: 'proxy-pass' } }),
      { encoding: 'utf8', mode: 0o600 },
    );

    const store = getSecretStore();
    expect(await store.get(PROXY_USERNAME_SECRET)).toBe('proxy-user');
    expect(await store.get(PROXY_PASSWORD_SECRET)).toBe('proxy-pass');
    expect(await store.list()).toEqual(['proxy.password', 'proxy.username']);
  });
});

describe('secret references in the config file', () => {
  const originalEnv = process.env;
  let tempHome = '';

  beforeEach(async () => {
    tempHome = await mkdtemp(path.join(os.tmpdir(), 'ten-x-chat-secrets-'));
    process.env = { ...originalEnv, TEN_X_CHAT_HOME: tempHome };
  });

  afterEach(async () => {
    process.env = originalEnv;
    if (tempHome) await rm(tempHome, { recursive: true, force: true });
  });

  const writeConfig = (content: string) =>
    writeFile(path.join(tempHome, 'config.json'), content, 'utf8');

  it('names the provider of a missing key', async () => {
    await writeConfig(JSON.stringify({ providerKeys: { chatgpt: 'openai-key' } }));

    await expect(loadConfig()).rejects.toThrow(/No secret named "openai-key"/);
    await expect(loadConfig()).rejects.toThrow(/providerKeys\.chatgpt/);
  });

  it('never puts the value of a secret into the error', async () => {
    await getSecretStore().set('openai-key', SECRET);
    await writeConfig(JSON.stringify({ providerKeys: { chatgpt: 'other-key' } }));

    const error = await loadConfig().catch((err: unknown) => err as Error);
    expect(error.message).toContain('No secret named "other-key"');
    expect(error.message).not.toContain(SECRET);
  });

  it('accepts a config file whose secrets are stored', async () => {
    await getSecretStore().set('openai-key', SECRET);
    await writeConfig(JSON.stringify({ providerKeys: { chatgpt: 'openai-key' } }));

    const config = await loadConfig();
    expect(config.providerKeys?.chatgpt).toBe('openai-key');
  });

  it('reports an unknown provider of a key', async () => {
    await writeConfig(JSON.stringify({ providerKeys: { nope: 'openai-key' } }));

    await expect(loadConfig()).rejects.toThrow(/unknown provider "nope"/);
  });

  it('reads the API key of a provider', async () => {
    await getSecretStore().set('openai-key', SECRET);
    await writeConfig(JSON.stringify({ providerKeys: { chatgpt: 'openai-key' } }));

    expect(await getProviderApiKey('chatgpt')).toBe(SECRET);
    expect(await getProviderApiKey('gemini')).toBeUndefined();
  });
});

describe('redaction of secret values', () => {
  it('replaces every known value', () => {
    const text = `key=${SECRET} other=${SECRET}`;
    expect(redactSecretValues(text, [SECRET])).toBe('key=*** other=***');
  });

  it('replaces the longest value first', () => {
    expect(redactSecretValues('abc', ['c', 'abc'])).toBe('***');
  });
});

describe('the proxy of the config file', () => {
  const originalEnv = process.env;
  let tempHome = '';

  beforeEach(async () => {
    tempHome = await mkdtemp(path.join(os.tmpdir(), 'ten-x-chat-secrets-'));
    process.env = { ...originalEnv, TEN_X_CHAT_HOME: tempHome };
  });

  afterEach(async () => {
    process.env = originalEnv;
    if (tempHome) await rm(tempHome, { recursive: true, force: true });
  });

  const writeConfig = (content: string) =>
    writeFile(path.join(tempHome, 'config.json'), content, 'utf8');

  it('takes the credentials from the secrets store', async () => {
    await writeConfig(
      JSON.stringify({ proxy: { enabled: true, server: 'http://proxy.example:3128' } }),
    );
    await getSecretStore().set(PROXY_USERNAME_SECRET, 'proxy-user');
    await getSecretStore().set(PROXY_PASSWORD_SECRET, 'proxy-pass');

    const proxy = await resolveEffectiveProxy({ HTTPS_PROXY: 'http://env.example:3128' });

    expect(proxy?.server).toBe('http://proxy.example:3128');
    expect(proxy?.username).toBe('proxy-user');
    expect(proxy?.password).toBe('proxy-pass');
  });

  it('falls back to the environment without a proxy section', async () => {
    const proxy = await resolveEffectiveProxy({ HTTPS_PROXY: 'http://env.example:3128' });
    expect(proxy?.server).toBe('http://env.example:3128');
  });

  it('works without a secrets file at all', async () => {
    await writeConfig(
      JSON.stringify({ proxy: { enabled: true, server: 'http://proxy.example:3128' } }),
    );

    const proxy = await resolveEffectiveProxy({});
    expect(proxy?.server).toBe('http://proxy.example:3128');
    expect(proxy?.username).toBeUndefined();
  });
});

describe('two processes writing at the same time', () => {
  const originalEnv = process.env;
  let tempHome = '';

  beforeEach(async () => {
    tempHome = await mkdtemp(path.join(os.tmpdir(), 'ten-x-chat-secrets-'));
    process.env = { ...originalEnv, TEN_X_CHAT_HOME: tempHome };
  });

  afterEach(async () => {
    process.env = originalEnv;
    if (tempHome) await rm(tempHome, { recursive: true, force: true });
  });

  it('keeps the secret of every process', async () => {
    // The store of the real code, run in two separate processes.
    const secretsModule = path
      .resolve(import.meta.dirname, '..', 'src', 'secrets.ts')
      .replaceAll(path.sep, '/');
    const script = path.join(tempHome, 'writer.mjs');
    await writeFile(
      script,
      `const { getSecretStore } = await import('file://${secretsModule}');\n` +
        `await getSecretStore().set(process.argv[2], 'value-of-' + process.argv[2]);\n`,
      'utf8',
    );

    const writers = ['openai-key', 'deepseek-key'].map(
      (name) =>
        new Promise<void>((resolve, reject) => {
          const child = spawn(process.execPath, ['--import', 'tsx', script, name], {
            cwd: path.resolve(import.meta.dirname, '..'),
            env: { ...originalEnv, TEN_X_CHAT_HOME: tempHome },
            stdio: 'ignore',
          });
          child.on('error', reject);
          child.on('exit', (code) =>
            code === 0 ? resolve() : reject(new Error(`writer exited with ${code}`)),
          );
        }),
    );
    await Promise.all(writers);

    expect(await getSecretStore().list()).toEqual(['deepseek-key', 'openai-key']);
  }, 30_000);
});
