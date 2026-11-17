import { readFile, stat } from 'node:fs/promises';
import { getSecretsPath } from './paths.js';

/**
 * The secrets of the application.
 *
 * The secrets are the things that must not live in the config file: a config
 * file is copied around, printed into bug reports and kept in a repository.
 * The secrets file lives next to the config file (`~/.10x-chat/secrets.json`)
 * and must not be readable by other users of the machine.
 */

/** The credentials of the proxy. */
export interface ProxySecrets {
  username?: string;
  password?: string;
}

/** Everything the secrets file can carry. */
export interface AppSecrets {
  proxy?: ProxySecrets;
}

const SECRET_KEYS = ['proxy'] as const;

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Check that only the owner of the file can read it.
 *
 * The file holds a password: every local process of the machine can read the
 * environment and the command line of a process, and it can read this file too
 * when the permissions allow it.
 */
async function assertPrivateFile(filePath: string): Promise<void> {
  // Windows has no POSIX permissions: the check would only be noise there.
  if (process.platform === 'win32') return;

  const info = await stat(filePath);
  if ((info.mode & 0o077) !== 0) {
    throw new Error(
      `Invalid secrets file ${filePath}: it must not be readable by other users (chmod 600).`,
    );
  }
}

function validateSecrets(raw: unknown, secretsPath: string): AppSecrets {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error(`Invalid secrets file ${secretsPath}: expected an object at the top level`);
  }

  const parsed = raw as Record<string, unknown>;
  for (const key of Object.keys(parsed)) {
    if (!(SECRET_KEYS as readonly string[]).includes(key)) {
      throw new Error(
        `Invalid secrets file ${secretsPath}: unknown key "${key}" ` +
          `(known keys: ${SECRET_KEYS.join(', ')})`,
      );
    }
  }

  const secrets: AppSecrets = {};
  if (parsed.proxy === undefined) return secrets;

  if (typeof parsed.proxy !== 'object' || parsed.proxy === null || Array.isArray(parsed.proxy)) {
    throw new Error(`Invalid secrets file ${secretsPath}: "proxy" must be an object`);
  }

  const proxy = parsed.proxy as Record<string, unknown>;
  const result: ProxySecrets = {};
  for (const key of ['username', 'password'] as const) {
    const value = proxy[key];
    if (value === undefined) continue;
    if (typeof value !== 'string' || !value) {
      throw new Error(
        `Invalid secrets file ${secretsPath}: "proxy.${key}" must be a non-empty string`,
      );
    }
    result[key] = value;
  }
  for (const key of Object.keys(proxy)) {
    if (key !== 'username' && key !== 'password') {
      throw new Error(
        `Invalid secrets file ${secretsPath}: unknown key "proxy.${key}" ` +
          `(known keys: username, password)`,
      );
    }
  }
  secrets.proxy = result;
  return secrets;
}

/**
 * Load the secrets from disk.
 *
 * A missing file yields no secrets — that is the only case that falls back.
 * A broken file is an error: a password that is silently dropped would send the
 * browser through a proxy that cannot authenticate it.
 *
 * No error message ever names a value: the file holds the password.
 */
export async function loadSecrets(): Promise<AppSecrets> {
  const secretsPath = getSecretsPath();

  let raw: string;
  try {
    raw = await readFile(secretsPath, 'utf-8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw new Error(`Cannot read secrets file ${secretsPath}: ${message(error)}`);
  }

  await assertPrivateFile(secretsPath);

  let parsed: unknown;
  try {
    const JSON5Module = await import('json5');
    const JSON5 = JSON5Module.default ?? JSON5Module;
    parsed = JSON5.parse(raw);
  } catch {
    // The parser error quotes the content of the file — and the content is the
    // password. The message names the file, nothing else.
    throw new Error(`Invalid secrets file ${secretsPath}: cannot be parsed`);
  }

  return validateSecrets(parsed, secretsPath);
}
