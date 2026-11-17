import { spawn } from 'node:child_process';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { createSecretServiceBackend, type KeyringBackend } from '../src/keyring.js';
import {
  CREDENTIAL_STORAGE_ENV,
  getSecretStore,
  getSecretsPath,
  parseCredentialStorage,
} from '../src/secrets.js';

const SECRET = 'sk-do-not-print-me';

/** A keyring in memory — the real one needs a secret service. */
class FakeBackend implements KeyringBackend {
  readonly entries = new Map<string, string>();
  /** Reads a wrong value — a keyring that cannot be verified. */
  broken = false;

  async list(): Promise<string[]> {
    return [...this.entries.keys()];
  }

  async get(name: string): Promise<string | undefined> {
    if (this.broken) return 'a-different-value';
    return this.entries.get(name);
  }

  async set(name: string, value: string): Promise<void> {
    this.entries.set(name, value);
  }

  async remove(name: string): Promise<boolean> {
    return this.entries.delete(name);
  }
}

const exists = async (filePath: string): Promise<boolean> => {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
};

/** Wait until the predicate is true — the child processes work on their own. */
async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('Timed out while waiting for the child process');
}

describe('the keyring store', () => {
  const originalEnv = process.env;
  let tempHome = '';
  let backend = new FakeBackend();

  beforeEach(async () => {
    tempHome = await mkdtemp(path.join(os.tmpdir(), 'ten-x-chat-keyring-'));
    process.env = { ...originalEnv, TEN_X_CHAT_HOME: tempHome };
    // The tests choose the store themselves.
    delete process.env[CREDENTIAL_STORAGE_ENV];
    backend = new FakeBackend();
  });

  afterEach(async () => {
    process.env = originalEnv;
    if (tempHome) await rm(tempHome, { recursive: true, force: true });
  });

  const keyringStore = () =>
    getSecretStore({ storage: 'keyring', backendFactory: async () => backend });

  it('stores a secret and reads it back', async () => {
    const store = keyringStore();
    await store.set('openai-key', SECRET);

    expect(await store.get('openai-key')).toBe(SECRET);
    expect(await store.list()).toEqual(['openai-key']);
  });

  it('replaces a secret with the same name and removes it', async () => {
    const store = keyringStore();
    await store.set('openai-key', 'first');
    await store.set('openai-key', 'second');

    expect(await store.get('openai-key')).toBe('second');
    expect(await store.remove('openai-key')).toBe(true);
    expect(await store.get('openai-key')).toBeUndefined();
    expect(await store.remove('openai-key')).toBe(false);
  });

  it('rejects an invalid secret name', async () => {
    await expect(keyringStore().set('../escape', SECRET)).rejects.toThrow(/Invalid secret name/);
  });

  it('rejects an invalid secret name on a read and on a delete', async () => {
    await expect(keyringStore().get('../escape')).rejects.toThrow(/Invalid secret name/);
    await expect(keyringStore().remove('../escape')).rejects.toThrow(/Invalid secret name/);
    // Nothing reached the keyring.
    expect(backend.entries.size).toBe(0);
  });

  it('keeps a secret whose name is a property of Object.prototype', async () => {
    const store = keyringStore();
    await store.set('__proto__', SECRET);

    expect(await store.get('__proto__')).toBe(SECRET);
    expect(await store.list()).toEqual(['__proto__']);
    expect(await store.remove('__proto__')).toBe(true);
    expect(await store.get('__proto__')).toBeUndefined();
  });

  it('ignores the entries of another program', async () => {
    backend.entries.set('foreign entry', 'value');
    backend.entries.set('openai-key', SECRET);

    expect(await keyringStore().list()).toEqual(['openai-key']);
  });

  it('migrates the secrets of the file store into the keyring', async () => {
    await writeFile(
      getSecretsPath(),
      JSON.stringify({ 'openai-key': SECRET, 'proxy.password': 'proxy-pass' }),
      { encoding: 'utf8', mode: 0o600 },
    );

    const store = keyringStore();
    expect(await store.list()).toEqual(['openai-key', 'proxy.password']);
    expect(backend.entries.get('openai-key')).toBe(SECRET);
    // The file is deleted only after every secret was read back.
    expect(await exists(getSecretsPath())).toBe(false);
  });

  it('keeps the file when the migration cannot be verified', async () => {
    await writeFile(getSecretsPath(), JSON.stringify({ 'openai-key': SECRET }), {
      encoding: 'utf8',
      mode: 0o600,
    });
    backend.broken = true;

    await expect(keyringStore().list()).rejects.toThrow(/could not be migrated/);
    expect(await exists(getSecretsPath())).toBe(true);
  });

  it('migrates a secret that the keyring already holds with the same value', async () => {
    await writeFile(getSecretsPath(), JSON.stringify({ 'openai-key': SECRET }), {
      encoding: 'utf8',
      mode: 0o600,
    });
    backend.entries.set('openai-key', SECRET);

    const store = keyringStore();
    expect(await store.list()).toEqual(['openai-key']);
    expect(backend.entries.get('openai-key')).toBe(SECRET);
    expect(await exists(getSecretsPath())).toBe(false);
  });

  it('refuses to overwrite a secret of the keyring with an older value', async () => {
    await writeFile(getSecretsPath(), JSON.stringify({ 'openai-key': 'old-key' }), {
      encoding: 'utf8',
      mode: 0o600,
    });
    backend.entries.set('openai-key', 'new-key');

    const error = await keyringStore()
      .list()
      .catch((err: unknown) => err as Error);
    expect(error.message).toMatch(/could not be migrated/);
    expect(error.message).toMatch(/already holds a different value/);
    // The message names the secret, never its value.
    expect(error.message).not.toContain('old-key');
    expect(error.message).not.toContain('new-key');

    // The newer value survived and the file is untouched.
    expect(backend.entries.get('openai-key')).toBe('new-key');
    expect(await exists(getSecretsPath())).toBe(true);
    expect(await readFile(getSecretsPath(), 'utf-8')).toContain('old-key');
  });

  it('finds every conflict before it writes the first secret', async () => {
    await writeFile(
      getSecretsPath(),
      JSON.stringify({ 'openai-key': 'old-key', 'deepseek-key': 'file-value' }),
      { encoding: 'utf8', mode: 0o600 },
    );
    backend.entries.set('openai-key', 'new-key');

    await expect(keyringStore().list()).rejects.toThrow(/already holds a different value/);

    // The secret without a conflict was not written — the keyring is untouched.
    expect(backend.entries.has('deepseek-key')).toBe(false);
    expect(await exists(getSecretsPath())).toBe(true);
  });

  it('migrates the file store once, even when two processes start at the same time', async () => {
    // Two processes migrate the same file: the second one must wait for the
    // lock and find the file gone — otherwise it writes the old values over
    // the new ones.
    await writeFile(getSecretsPath(), JSON.stringify({ 'openai-key': SECRET }), {
      encoding: 'utf8',
      mode: 0o600,
    });

    const logFile = path.join(tempHome, 'writes.log');
    const startedFile = path.join(tempHome, 'started');
    const releaseFile = path.join(tempHome, 'release');
    const secretsModule = path
      .resolve(import.meta.dirname, '..', 'src', 'secrets.ts')
      .replaceAll(path.sep, '/');
    // A keyring in memory, but every write is appended to a shared log: the
    // test sees how many times the migration wrote the secret.
    const script = path.join(tempHome, 'migrator.mjs');
    await writeFile(
      script,
      `const { appendFile, readFile, writeFile } = await import('node:fs/promises');\n` +
        `const { getSecretStore } = await import('file://${secretsModule}');\n` +
        `const [logFile, startedFile, releaseFile] = process.argv.slice(2);\n` +
        `const entries = new Map();\n` +
        `const backend = {\n` +
        `  async list() { return [...entries.keys()]; },\n` +
        `  async get(name) { return entries.get(name); },\n` +
        `  async set(name, value) {\n` +
        `    entries.set(name, value);\n` +
        `    await appendFile(logFile, name + '\\n');\n` +
        `    await writeFile(startedFile, 'started', { flag: 'wx' }).catch(() => {});\n` +
        `    for (;;) {\n` +
        `      try { await readFile(releaseFile); break; } catch {}\n` +
        `      await new Promise((r) => setTimeout(r, 20));\n` +
        `    }\n` +
        `  },\n` +
        `  async remove() { return false; },\n` +
        `};\n` +
        `await getSecretStore({ storage: 'keyring', backendFactory: async () => backend }).list();\n`,
      'utf8',
    );

    const run = () =>
      new Promise<void>((resolve, reject) => {
        const child = spawn(
          process.execPath,
          ['--import', 'tsx', script, logFile, startedFile, releaseFile],
          {
            cwd: path.resolve(import.meta.dirname, '..'),
            env: { ...originalEnv, TEN_X_CHAT_HOME: tempHome },
            stdio: 'ignore',
          },
        );
        child.on('error', reject);
        child.on('exit', (code) =>
          code === 0 ? resolve() : reject(new Error(`migrator exited with ${code}`)),
        );
      });

    const first = run();
    // The first process is inside the migration: the file of the store is
    // still there and the lock is held.
    await waitFor(() => exists(startedFile));
    const second = run();
    // The second process has the time to read the file and to write the
    // secret — it must not.
    await new Promise((resolve) => setTimeout(resolve, 3000));
    await writeFile(releaseFile, 'go', 'utf8');
    await Promise.all([first, second]);

    expect(await readFile(logFile, 'utf-8')).toBe('openai-key\n');
    expect(await exists(getSecretsPath())).toBe(false);
  }, 60_000);

  it('never writes a value into the file store', async () => {
    await keyringStore().set('openai-key', SECRET);

    expect(await exists(getSecretsPath())).toBe(false);
  });

  it('names the store in its location', async () => {
    expect(await keyringStore().location()).toMatch(/keyring/);
  });

  it('stores a secret in the real system keyring', async () => {
    const service = `10x-chat-test-${process.pid}`;
    const real = await createSecretServiceBackend(service).catch(() => undefined);
    if (!real) return; // no secret service on this machine — the fake backend covers the logic

    const store = getSecretStore({ storage: 'keyring', backendFactory: async () => real });
    await store.set('probe-key', SECRET);

    expect(await store.get('probe-key')).toBe(SECRET);
    expect(await store.list()).toContain('probe-key');
    expect(await store.remove('probe-key')).toBe(true);
  });
});

describe('the choice of the store', () => {
  const originalEnv = process.env;
  let tempHome = '';

  beforeEach(async () => {
    tempHome = await mkdtemp(path.join(os.tmpdir(), 'ten-x-chat-keyring-'));
    process.env = { ...originalEnv, TEN_X_CHAT_HOME: tempHome };
    delete process.env[CREDENTIAL_STORAGE_ENV];
  });

  afterEach(async () => {
    process.env = originalEnv;
    if (tempHome) await rm(tempHome, { recursive: true, force: true });
  });

  const writeConfig = (content: string) =>
    writeFile(path.join(tempHome, 'config.json'), content, 'utf8');

  it('uses the file store when the config file asks for it', async () => {
    await writeConfig(JSON.stringify({ credentialStorage: 'file' }));

    expect(await getSecretStore().location()).toMatch(/^file: /);
  });

  it('uses the keyring when the config file asks for it', async () => {
    await writeConfig(JSON.stringify({ credentialStorage: 'keyring' }));
    const backend = new FakeBackend();

    const store = getSecretStore({ backendFactory: async () => backend });

    expect(await store.location()).toMatch(/^keyring: /);
  });

  it('falls back to the file when the keyring is not reachable', async () => {
    const store = getSecretStore({
      storage: 'auto',
      backendFactory: async () => {
        throw new Error('no secret service');
      },
    });

    expect(await store.location()).toMatch(/^file: /);
  });

  it('fails when the keyring is required but not reachable', async () => {
    const store = getSecretStore({
      storage: 'keyring',
      backendFactory: async () => {
        throw new Error('no secret service');
      },
    });

    await expect(store.list()).rejects.toThrow(/not available/);
  });

  it('lets the environment override the config file', async () => {
    await writeConfig(JSON.stringify({ credentialStorage: 'keyring' }));
    process.env[CREDENTIAL_STORAGE_ENV] = 'file';

    expect(await getSecretStore().location()).toMatch(/^file: /);
  });

  it('rejects an unknown value', () => {
    expect(() => parseCredentialStorage('nope')).toThrow(/must be one of/);
    expect(parseCredentialStorage('keyring')).toBe('keyring');
  });

  it('rejects an unknown value in the config file', async () => {
    await writeConfig(JSON.stringify({ credentialStorage: 'nope' }));

    await expect(loadConfig()).rejects.toThrow(/credentialStorage/);
  });
});
