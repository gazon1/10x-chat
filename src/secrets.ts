import { randomUUID } from 'node:crypto';
import type { Stats } from 'node:fs';
import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { acquireLock } from './core/lock.js';
import { createSecretServiceBackend, KEYRING_SERVICE, type KeyringBackend } from './keyring.js';
import { getConfigPath, getSecretsPath } from './paths.js';
import type { CredentialStorage } from './types.js';

export { getSecretsPath };

/** The name of the lock file that guards the read-modify-write cycle. */
const LOCK_NAME = 'secrets.lock';

/** How long a writer waits for a busy store before giving up. */
const LOCK_TIMEOUT_MS = 10_000;

/** The environment variable that overrides the setting of the config file. */
export const CREDENTIAL_STORAGE_ENV = 'TEN_X_CHAT_CREDENTIAL_STORAGE';

/** The values of the `credentialStorage` setting. */
export const CREDENTIAL_STORAGE_VALUES: readonly CredentialStorage[] = ['auto', 'keyring', 'file'];

/**
 * The secrets store.
 *
 * A secret is a named value (a provider API key, the credentials of the proxy)
 * that must not live in `config.json`, in the command line, in a log or in a
 * session file. The store is deliberately narrow — a list, a read, a write and
 * a delete — so that an OS keychain can replace the file later without
 * touching a single caller.
 *
 * The interface never returns a value in an error message and never writes a
 * value to anything but the store itself.
 */
export interface SecretStore {
  /** The names of the stored secrets (never their values). */
  list(): Promise<string[]>;
  /** The value of a secret, or `undefined` when it is not stored. */
  get(name: string): Promise<string | undefined>;
  /** Store a secret, replacing an existing one with the same name. */
  set(name: string, value: string): Promise<void>;
  /** Delete a secret. Returns `false` when it was not stored. */
  remove(name: string): Promise<boolean>;
  /**
   * Where the secrets live — for the output of the CLI.
   *
   * The store never tells a value to anybody but the caller that asked for
   * it; the location is a name, not a value.
   */
  location(): Promise<string>;
}

/** A secret name: letters, numbers, dots, dashes, underscores. */
export const SECRET_NAME_PATTERN = /^[A-Za-z0-9._-]+$/;

/** The name of the secret that holds the user name of the proxy. */
export const PROXY_USERNAME_SECRET = 'proxy.username';

/** The name of the secret that holds the password of the proxy. */
export const PROXY_PASSWORD_SECRET = 'proxy.password';

/**
 * Whether a name may be used as the name of a secret.
 *
 * Every character of the name is checked on its own: the whole name has to
 * match, so a trailing line terminator (`\n`, `\r`, `\r\n`) can never slip
 * through — the end of the name is not anchored by a regular expression
 * alone. (In JavaScript `$` does not match before a trailing newline, but the
 * name is compared character by character anyway.)
 *
 * The names `__proto__`, `constructor` and `toString` are ordinary names: the
 * store keeps them as own properties of an object without a prototype, so
 * they are never confused with something inherited from `Object.prototype`.
 */
export function isSecretName(name: string): boolean {
  if (name.length === 0) return false;
  for (const character of name) {
    if (!SECRET_NAME_PATTERN.test(character)) return false;
  }
  return name !== '.' && name !== '..';
}

/** Check a secret name — the name becomes a key of the secrets file. */
export function assertSecretName(name: string): void {
  if (!isSecretName(name)) {
    throw new Error(
      `Invalid secret name "${name}": a name may contain only letters, numbers, dots, dashes and underscores`,
    );
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Check that only the owner of the file can read it.
 *
 * The file holds the passwords: every local process of the machine can read
 * the environment and the command line of a process, and it can read this
 * file too when the permissions allow it.
 */
async function assertPrivateFile(filePath: string): Promise<void> {
  // Windows has no POSIX permissions: the check would only be noise there.
  if (process.platform === 'win32') return;

  let info: Stats;
  try {
    info = await stat(filePath);
  } catch (error) {
    // No file — there is nothing to protect yet.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw new Error(`Cannot check the secrets file ${filePath}: ${message(error)}`);
  }
  if ((info.mode & 0o077) !== 0) {
    throw new Error(
      `Invalid secrets file ${filePath}: it must not be readable by other users (chmod 600).`,
    );
  }
}

/** The credentials of the proxy in the file format of #34. */
function isProxyCredentials(value: unknown): value is { username?: string; password?: string } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  for (const [key, entry] of Object.entries(value)) {
    if (key !== 'username' && key !== 'password') return false;
    if (typeof entry !== 'string' || !entry) return false;
  }
  return true;
}

/**
 * The file-backed store.
 *
 * The file is written atomically (temp file + rename) and stays readable by
 * its owner only (`0600`) — on Unix. On Windows the POSIX modes are ignored
 * by the file system; there the protection comes from the access rights of
 * the user profile (see `docs/secrets.md`).
 */
class FileSecretStore implements SecretStore {
  constructor(private readonly filePath: string) {}

  /** The stored secrets. A missing file is an empty store, a broken one an error. */
  async readAll(): Promise<Record<string, string>> {
    // The privacy of the file is not enough: a directory that other users may
    // write allows them to delete or to replace the file under us. The
    // directory is checked (and narrowed) before the file is read — a store
    // that cannot be made private is not read at all.
    await this.ensureDir(path.dirname(this.filePath));
    await assertPrivateFile(this.filePath);

    let raw: string;
    try {
      raw = await readFile(this.filePath, 'utf-8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return Object.create(null);
      throw new Error(`Cannot read secrets file ${this.filePath}: ${message(error)}`);
    }

    let parsed: unknown;
    try {
      // JSON5: a file that was written by hand may carry comments.
      const JSON5Module = await import('json5');
      const JSON5 = JSON5Module.default ?? JSON5Module;
      parsed = JSON5.parse(raw);
    } catch {
      // The parser error quotes the content of the file — and the content is
      // the password. The message names the file, nothing else.
      throw new Error(
        `Secrets file ${this.filePath} is corrupt — it cannot be parsed. ` +
          `Repair or delete the file, then set the secret again.`,
      );
    }

    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error(
        `Secrets file ${this.filePath} is corrupt — expected an object with the secret names as keys. ` +
          `Repair or delete the file, then set the secret again.`,
      );
    }

    // A dictionary without a prototype: `__proto__` is a valid secret name
    // (the pattern allows it), and a plain object would turn the assignment
    // into a setter of `Object.prototype` instead of an own property.
    const result: Record<string, string> = Object.create(null);
    for (const [name, value] of Object.entries(parsed as Record<string, unknown>)) {
      // A damaged store is an error, not a store with arbitrary names: every
      // operation of the store works with the name, and the name of the
      // keyring is an account of an entry.
      if (!isSecretName(name)) {
        throw new Error(
          `Secrets file ${this.filePath} is corrupt — the secret name "${name}" is not allowed: ` +
            `a name may contain only letters, numbers, dots, dashes and underscores. ` +
            `Repair or delete the file, then set the secret again.`,
        );
      }

      if (typeof value === 'string') {
        result[name] = value;
        continue;
      }

      // The file format of the proxy settings of #34: the credentials of the
      // proxy in one object. They are two secrets of the store now — the old
      // shape is read, the next write stores the new one.
      if (name === 'proxy' && isProxyCredentials(value)) {
        if (value.username !== undefined) result[PROXY_USERNAME_SECRET] = value.username;
        if (value.password !== undefined) result[PROXY_PASSWORD_SECRET] = value.password;
        continue;
      }

      throw new Error(
        `Secrets file ${this.filePath} is corrupt — the secret "${name}" is not a string. ` +
          `Repair or delete the file, then set the secret again.`,
      );
    }
    return result;
  }

  /**
   * Make sure the directory of the store exists and is private.
   *
   * `mkdir` applies the mode only to a directory it creates — an existing
   * directory (created earlier by the config file, for example) keeps its wide
   * mode. The explicit `chmod` closes that gap. On Windows the POSIX modes
   * are ignored by the file system (see `docs/secrets.md`).
   *
   * The check runs on every read as well: a directory that other users may
   * write lets them replace the secrets file under us — the mode of the file
   * alone does not protect it.
   */
  private async ensureDir(dir: string): Promise<void> {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    if (process.platform === 'win32') return;

    // Fail closed: a directory that we may not narrow stays writable by other
    // users, and they could replace the secrets file or the lock file under us.
    try {
      await chmod(dir, 0o700);
    } catch (error) {
      throw new Error(
        `Cannot make the secrets directory ${dir} private (chmod 700): ${message(error)}. ` +
          `Fix the permissions of the directory or point TEN_X_CHAT_HOME at a directory you own.`,
      );
    }

    const info = await stat(dir);
    if ((info.mode & 0o077) !== 0) {
      throw new Error(
        `Invalid secrets directory ${dir}: it must not be accessible by other users (chmod 700).`,
      );
    }
  }

  /** Write the secrets atomically, readable by the owner only. */
  private async writeAll(secrets: Record<string, string>): Promise<void> {
    const dir = path.dirname(this.filePath);
    await this.ensureDir(dir);

    // The temp file is unique per operation: two writers in parallel must not
    // share a name.
    const tmpPath = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(tmpPath, `${JSON.stringify(secrets, null, 2)}\n`, {
        encoding: 'utf-8',
        mode: 0o600,
      });
      // The mode of the temp file can be narrowed by the umask of the shell.
      await chmod(tmpPath, 0o600);
      await rename(tmpPath, this.filePath);
    } catch (error) {
      await rm(tmpPath, { force: true });
      throw new Error(`Cannot write secrets file ${this.filePath}: ${message(error)}`);
    }
  }

  /**
   * Run a read-modify-write cycle under the store lock.
   *
   * The lock is held between processes of the machine: without it two
   * concurrent `10x-chat secrets set` runs read the same file and the last
   * rename overwrites the secret of the first one. The migration into the
   * keyring uses the same lock — it reads the file, writes the keyring and
   * deletes the file as one operation.
   */
  async withLock<T>(fn: () => Promise<T>): Promise<T> {
    const dir = path.dirname(this.filePath);
    await this.ensureDir(dir);
    const lock = await acquireLock(dir, LOCK_NAME, {
      timeoutMs: LOCK_TIMEOUT_MS,
      hint: 'Another 10x-chat process is writing the secrets file.',
    });
    try {
      return await fn();
    } finally {
      await lock.release();
    }
  }

  async list(): Promise<string[]> {
    return Object.keys(await this.readAll()).sort();
  }

  async get(name: string): Promise<string | undefined> {
    assertSecretName(name);
    const secrets = await this.readAll();
    // An own property only: a name like `toString` must not resolve to
    // something inherited from `Object.prototype`.
    return Object.hasOwn(secrets, name) ? secrets[name] : undefined;
  }

  async set(name: string, value: string): Promise<void> {
    assertSecretName(name);
    if (!value) throw new Error(`The value of the secret "${name}" must not be empty`);
    await this.withLock(async () => {
      const secrets = await this.readAll();
      secrets[name] = value;
      await this.writeAll(secrets);
    });
  }

  async remove(name: string): Promise<boolean> {
    assertSecretName(name);
    return this.withLock(async () => {
      const secrets = await this.readAll();
      if (!Object.hasOwn(secrets, name)) return false;
      delete secrets[name];
      await this.writeAll(secrets);
      return true;
    });
  }

  /** Delete the file of the store — after the migration into the keyring. */
  async clear(): Promise<void> {
    await rm(this.filePath, { force: true });
  }

  async location(): Promise<string> {
    return `file: ${this.filePath}`;
  }
}

/**
 * The keyring-backed store.
 *
 * The name of a secret is the account of an entry, its value the password of
 * the entry. The secrets of the file store are migrated on the first use:
 * they are written into the keyring, read back and compared — only then the
 * file is deleted. A migration that fails keeps the file.
 */
class KeyringSecretStore implements SecretStore {
  private migrated?: Promise<void>;

  constructor(
    private readonly backend: KeyringBackend,
    private readonly file: FileSecretStore,
  ) {}

  /**
   * Move the secrets of the file store into the keyring.
   *
   * The whole cycle runs under the lock of the file store: two processes that
   * read the same file must not migrate it at the same time — the second one
   * would write the old values over the new ones. The file is read again
   * inside the lock: another process may have migrated it already.
   *
   * The keyring is **not** a copy of the file: a secret that the keyring
   * already holds is never overwritten. A conflict — the keyring holds
   * another value under the same name — stops the migration before the first
   * write: a conflict that is found halfway would leave the keyring half
   * migrated, and the file would be deleted in the end.
   */
  private async migrate(): Promise<void> {
    await this.file.withLock(async () => {
      const secrets = await this.file.readAll();
      const entries = Object.entries(secrets);
      if (entries.length === 0) return;

      // Every conflict is found before the first write.
      const conflicts: string[] = [];
      const missing: [string, string][] = [];
      for (const [name, value] of entries) {
        const stored = await this.backend.get(name);
        if (stored === undefined) {
          // Not in the keyring — it can be moved.
          missing.push([name, value]);
        } else if (stored !== value) {
          // The keyring holds another value: the file is not the source of
          // truth here, and overwriting it would lose the newer credential.
          conflicts.push(name);
        }
        // The same value: the keyring already holds it — nothing to do.
      }

      if (conflicts.length > 0) {
        throw new Error(
          `The secrets of the file store could not be migrated into the system keyring: ` +
            `the keyring already holds a different value for ${conflicts
              .map((name) => `"${name}"`)
              .join(', ')}. ` +
            `The file is kept and the keyring is untouched — remove the secret from the keyring ` +
            `or update the file, then try again.`,
        );
      }

      for (const [name, value] of missing) await this.backend.set(name, value);

      // The file is only deleted when every secret was read back unchanged.
      for (const [name, value] of entries) {
        const stored = await this.backend.get(name);
        if (stored !== value) {
          throw new Error(
            `The secrets of the file store could not be migrated into the system keyring: ` +
              `the secret "${name}" was not stored. The file is kept — repair it and try again.`,
          );
        }
      }

      await this.file.clear();
    });
  }

  private ensureMigrated(): Promise<void> {
    this.migrated ??= this.migrate();
    return this.migrated;
  }

  async list(): Promise<string[]> {
    await this.ensureMigrated();
    const names = await this.backend.list();
    // Only our own names: the service may hold entries of another program.
    // The same validation as the one of a user-supplied name — one function,
    // one contract.
    return names.filter((name) => isSecretName(name)).sort();
  }

  async get(name: string): Promise<string | undefined> {
    assertSecretName(name);
    await this.ensureMigrated();
    return this.backend.get(name);
  }

  async set(name: string, value: string): Promise<void> {
    assertSecretName(name);
    if (!value) throw new Error(`The value of the secret "${name}" must not be empty`);
    await this.ensureMigrated();
    await this.backend.set(name, value);
  }

  async remove(name: string): Promise<boolean> {
    assertSecretName(name);
    await this.ensureMigrated();
    return this.backend.remove(name);
  }

  async location(): Promise<string> {
    return `keyring: Secret Service (service ${KEYRING_SERVICE})`;
  }
}

/**
 * The store of this run: the keyring, the file, or the first that works.
 *
 * The backend is chosen on the first use: the keyring is asked whether it is
 * reachable, and `auto` falls back to the file when it is not.
 */
class SelectedSecretStore implements SecretStore {
  private resolved?: Promise<SecretStore>;

  constructor(
    private readonly filePath: string,
    private readonly options: SecretStoreOptions,
  ) {}

  private async select(): Promise<SecretStore> {
    const storage = this.options.storage ?? (await readCredentialStorage());
    const file = new FileSecretStore(this.filePath);
    if (storage === 'file') return file;

    try {
      const factory = this.options.backendFactory ?? createSecretServiceBackend;
      return new KeyringSecretStore(await factory(), file);
    } catch (error) {
      if (storage === 'keyring') {
        throw new Error(
          `The system keyring (Secret Service) is not available: ${message(error)}. ` +
            `Start a secret service (gnome-keyring, kwallet) or set "credentialStorage": "file" ` +
            `in the config file.`,
        );
      }
      // `auto`: the file store is the fallback.
      return file;
    }
  }

  private store(): Promise<SecretStore> {
    this.resolved ??= this.select();
    return this.resolved;
  }

  async list(): Promise<string[]> {
    return (await this.store()).list();
  }

  async get(name: string): Promise<string | undefined> {
    return (await this.store()).get(name);
  }

  async set(name: string, value: string): Promise<void> {
    return (await this.store()).set(name, value);
  }

  async remove(name: string): Promise<boolean> {
    return (await this.store()).remove(name);
  }

  async location(): Promise<string> {
    return (await this.store()).location();
  }
}

/** How the store of this run is chosen. */
export interface SecretStoreOptions {
  /** Overrides the environment and the config file. */
  storage?: CredentialStorage;
  /** The factory of the keyring backend — the tests replace it. */
  backendFactory?: () => Promise<KeyringBackend>;
}

/**
 * Check the value of the `credentialStorage` setting.
 *
 * @param value the value from the config file or from the environment
 * @param context what the value is (for the message)
 */
export function parseCredentialStorage(
  value: unknown,
  context = '"credentialStorage"',
): CredentialStorage {
  if (
    typeof value === 'string' &&
    (CREDENTIAL_STORAGE_VALUES as readonly string[]).includes(value)
  ) {
    return value as CredentialStorage;
  }
  throw new Error(`${context} must be one of: ${CREDENTIAL_STORAGE_VALUES.join(', ')}`);
}

/**
 * Where the secrets of this run are stored.
 *
 * The environment wins over the config file, the config file over the default
 * (`auto` — the keyring when it is reachable, the file otherwise).
 *
 * A **missing** config file is the only case that falls back to the default.
 * A config file that cannot be read, cannot be parsed or does not hold an
 * object is an **error**: the store of the secrets is chosen by the config
 * file, and a broken one must not silently switch the run to the plaintext
 * file — `credentialStorage: "keyring"` is the promise that no secret ever
 * reaches a file, and a promise that cannot be read is not a promise that can
 * be broken quietly.
 */
async function readCredentialStorage(): Promise<CredentialStorage> {
  const fromEnv = process.env[CREDENTIAL_STORAGE_ENV]?.trim().toLowerCase();
  if (fromEnv) return parseCredentialStorage(fromEnv, CREDENTIAL_STORAGE_ENV);

  const configPath = getConfigPath();
  let raw: string;
  try {
    raw = await readFile(configPath, 'utf-8');
  } catch (error) {
    // No config file — the default. Every other error is a broken config
    // file, and a broken config file is an error (`loadConfig` reports the
    // same way — but the secrets commands do not run it).
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'auto';
    throw new Error(`Cannot read config file ${configPath}: ${message(error)}`);
  }

  let parsed: unknown;
  try {
    const JSON5Module = await import('json5');
    const JSON5 = JSON5Module.default ?? JSON5Module;
    parsed = JSON5.parse(raw);
  } catch (error) {
    throw new Error(
      `Invalid config file ${configPath}: cannot be parsed — ${message(error)}. ` +
        `The store of the secrets is not chosen while the config file is broken — ` +
        `repair it, then try again.`,
    );
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(
      `Invalid config file ${configPath}: expected an object at the top level. ` +
        `The store of the secrets is not chosen while the config file is broken — ` +
        `repair it, then try again.`,
    );
  }

  const value = (parsed as Record<string, unknown>).credentialStorage;
  if (value === undefined) return 'auto';
  return parseCredentialStorage(value, `"credentialStorage" in the config file ${configPath}`);
}

/** The store of the data directory of this run. */
export function getSecretStore(options: SecretStoreOptions = {}): SecretStore {
  return new SelectedSecretStore(getSecretsPath(), options);
}

/**
 * The value of a secret, with an error that names the reference — never the
 * value — when it is missing.
 *
 * @param name the name of the secret
 * @param context what refers to it (e.g. `providerKeys.chatgpt`), for the message
 */
export async function requireSecret(
  store: SecretStore,
  name: string,
  context: string,
): Promise<string> {
  const value = await store.get(name);
  if (value === undefined) {
    throw new Error(
      `No secret named "${name}" (${context}). Create it with: 10x-chat secrets set ${name}`,
    );
  }
  return value;
}

/**
 * Replace every known secret value in a text with `***`.
 *
 * Used before anything is printed: a secret that leaked into a config value
 * or an error message must not reach the terminal, a log or a session file.
 */
export function redactSecretValues(text: string, values: Iterable<string>): string {
  let result = text;
  // The longest value first: a short value that is part of a longer one must
  // not leave a tail of the longer one behind.
  for (const value of [...values].filter(Boolean).sort((a, b) => b.length - a.length)) {
    result = result.split(value).join('***');
  }
  return result;
}
