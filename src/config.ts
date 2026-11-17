import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { type BrowserProxy, proxyFromEnv } from './browser/proxy.js';
import { configError, validateConfig } from './config-schema.js';
import { getConfigPath } from './paths.js';
import {
  getSecretStore,
  PROXY_PASSWORD_SECRET,
  PROXY_USERNAME_SECRET,
  requireSecret,
} from './secrets.js';
import { type AppConfig, DEFAULT_CONFIG } from './types.js';

export { CONFIG_KEYS, validateConfig } from './config-schema.js';

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Check that every secret the config refers to is stored.
 *
 * A reference to a secret that does not exist is a configuration error: the
 * run would fail later with a much worse message. The error names the
 * reference and the provider — never the value of the secret.
 */
async function validateSecretReferences(
  config: Partial<AppConfig>,
  configPath: string,
): Promise<void> {
  const store = getSecretStore();
  const references: [string, string][] = [];
  for (const [provider, name] of Object.entries(config.providerKeys ?? {})) {
    references.push([name, `config key "providerKeys.${provider}"`]);
  }

  for (const [name, context] of references) {
    try {
      await requireSecret(store, name, context);
    } catch (error) {
      throw configError(configPath, message(error));
    }
  }
}

/**
 * The proxy that the browser has to use.
 *
 * The order is: the config file, then the environment, then no proxy. A config
 * file with `proxy.enabled: false` switches the proxy off completely — the
 * environment is *not* used as a fallback then.
 *
 * The credentials come from the secrets store (`proxy.username` and
 * `proxy.password`), never from the config file.
 *
 * @param env the environment to read (the process environment by default)
 * @returns the proxy, or `null` when there is none
 */
export async function resolveEffectiveProxy(
  env: NodeJS.ProcessEnv = process.env,
): Promise<BrowserProxy | null> {
  // The secret references are not checked here: a missing API key of a
  // provider must not keep the browser from starting.
  const config = await loadConfig({ checkSecrets: false });

  if (config.proxy) {
    if (!config.proxy.enabled) return null;

    const server = config.proxy.server;
    if (!server) {
      throw new Error(
        'Invalid proxy configuration: "proxy.server" is required when "proxy.enabled" is true.',
      );
    }

    const store = getSecretStore();
    const username = await store.get(PROXY_USERNAME_SECRET);
    const password = await store.get(PROXY_PASSWORD_SECRET);
    const bypass = (config.proxy.bypass ?? []).join(',');
    return {
      server,
      ...(bypass ? { bypass } : {}),
      ...(username ? { username } : {}),
      ...(password ? { password } : {}),
    };
  }

  return proxyFromEnv(env) ?? null;
}

/**
 * Load the config from disk.
 *
 * A missing file yields the built-in defaults — that is the only case that
 * falls back. An unreadable or invalid file is an error that names the file
 * and the problem (see `docs/config-contract.md`).
 *
 * @param options `checkSecrets: false` skips the check of the secret
 *   references — used by the commands that repair the config
 */
export async function loadConfig(options: { checkSecrets?: boolean } = {}): Promise<AppConfig> {
  const configPath = getConfigPath();

  let raw: string;
  try {
    raw = await readFile(configPath, 'utf-8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { ...DEFAULT_CONFIG };
    }
    throw new Error(`Cannot read config file ${configPath}: ${message(error)}`);
  }

  let parsed: unknown;
  try {
    const JSON5Module = await import('json5');
    const JSON5 = JSON5Module.default ?? JSON5Module;
    parsed = JSON5.parse(raw);
  } catch (error) {
    throw configError(configPath, `cannot be parsed — ${message(error)}`);
  }

  const config = { ...DEFAULT_CONFIG, ...validateConfig(parsed, configPath) };
  if (options.checkSecrets !== false) {
    await validateSecretReferences(config, configPath);
  }
  return config;
}

/** Save the config to disk (atomic write: temp file + rename). */
export async function saveConfig(config: AppConfig): Promise<void> {
  const configPath = getConfigPath();
  validateConfig(config, configPath);

  await mkdir(path.dirname(configPath), { recursive: true });
  const tmpPath = `${configPath}.${process.pid}.tmp`;
  try {
    await writeFile(tmpPath, JSON.stringify(config, null, 2), 'utf-8');
    await rename(tmpPath, configPath);
  } catch (error) {
    await import('node:fs/promises').then(({ rm }) => rm(tmpPath, { force: true }));
    throw new Error(`Cannot write config file ${configPath}: ${message(error)}`);
  }
}
