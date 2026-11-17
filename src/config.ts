import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { type BrowserProxy, proxyFromEnv, validateProxyServer } from './browser/proxy.js';
import { getConfigPath } from './paths.js';
import { isValidProvider, listProviders } from './providers/index.js';
import {
  getSecretStore,
  PROXY_PASSWORD_SECRET,
  PROXY_USERNAME_SECRET,
  parseCredentialStorage,
  requireSecret,
} from './secrets.js';
import {
  type AppConfig,
  DEFAULT_CONFIG,
  type ProfileMode,
  type ProviderName,
  type ProxyConfig,
} from './types.js';

/**
 * The keys of the config file. Every other key is an error — a typo like
 * `profile_mod` would otherwise be silently ignored.
 */
export const CONFIG_KEYS = [
  'defaultProvider',
  'defaultModel',
  'defaultTimeoutMs',
  'headless',
  'profileMode',
  'providerKeys',
  'proxy',
  'credentialStorage',
] as const;

/** The keys of the proxy section of the config file. */
const PROXY_KEYS = ['enabled', 'server', 'bypass'] as const;

const PROFILE_MODES: readonly ProfileMode[] = ['shared', 'isolated'];

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** An error that names the config file and the problem in it. */
function configError(configPath: string, problem: string): Error {
  return new Error(`Invalid config file ${configPath}: ${problem}`);
}

/**
 * Validate the proxy section of the config file.
 *
 * The credentials are not part of the config file — they live in the secrets
 * store. A server URL that carries them is rejected: the error names the
 * problem, never the URL (the URL can carry the password).
 */
function validateProxyConfig(raw: unknown, configPath: string): ProxyConfig {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw configError(configPath, '"proxy" must be an object');
  }

  const parsed = raw as Record<string, unknown>;
  for (const key of Object.keys(parsed)) {
    if (!(PROXY_KEYS as readonly string[]).includes(key)) {
      throw configError(
        configPath,
        `unknown key "proxy.${key}" (known keys: ${PROXY_KEYS.map((key) => `proxy.${key}`).join(', ')})`,
      );
    }
  }

  if (typeof parsed.enabled !== 'boolean') {
    throw configError(configPath, '"proxy.enabled" must be true or false');
  }

  const config: ProxyConfig = { enabled: parsed.enabled };

  if (parsed.server !== undefined) {
    if (typeof parsed.server !== 'string' || !parsed.server.trim()) {
      throw configError(configPath, '"proxy.server" must be a non-empty string');
    }
    config.server = parsed.server.trim();
    // The server is checked whenever it is present, not only when the proxy is
    // enabled: `enabled` decides whether the proxy is used, the credentials of a
    // disabled proxy are still credentials in a plaintext config file.
    try {
      validateProxyServer(config.server);
    } catch (error) {
      throw configError(configPath, `"proxy.server" is invalid — ${message(error)}`);
    }
  } else if (config.enabled) {
    throw configError(configPath, '"proxy.server" is required when "proxy.enabled" is true');
  }

  if (parsed.bypass !== undefined) {
    if (!Array.isArray(parsed.bypass) || parsed.bypass.some((host) => typeof host !== 'string')) {
      throw configError(configPath, '"proxy.bypass" must be an array of strings');
    }
    config.bypass = parsed.bypass.map((host) => host.trim()).filter(Boolean);
  }

  return config;
}

/**
 * Validate the parsed config file.
 *
 * Only a *missing* file falls back to the defaults. A file that exists but is
 * broken is an error: a silent fallback would hide a typo or a half-written
 * file until some later run behaves unexpectedly.
 */
export function validateConfig(raw: unknown, configPath: string): Partial<AppConfig> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw configError(configPath, 'expected an object at the top level');
  }

  const parsed = raw as Record<string, unknown>;
  for (const key of Object.keys(parsed)) {
    if (!(CONFIG_KEYS as readonly string[]).includes(key)) {
      throw configError(configPath, `unknown key "${key}" (known keys: ${CONFIG_KEYS.join(', ')})`);
    }
  }

  const config: Partial<AppConfig> = {};

  if (parsed.defaultProvider !== undefined) {
    if (typeof parsed.defaultProvider !== 'string' || !isValidProvider(parsed.defaultProvider)) {
      throw configError(
        configPath,
        `"defaultProvider" must be one of: ${listProviders().join(', ')} ` +
          `(got ${JSON.stringify(parsed.defaultProvider)})`,
      );
    }
    config.defaultProvider = parsed.defaultProvider;
  }

  if (parsed.defaultModel !== undefined) {
    if (typeof parsed.defaultModel !== 'string') {
      throw configError(
        configPath,
        `"defaultModel" must be a string (got ${JSON.stringify(parsed.defaultModel)})`,
      );
    }
    config.defaultModel = parsed.defaultModel;
  }

  if (parsed.defaultTimeoutMs !== undefined) {
    const timeout = parsed.defaultTimeoutMs;
    if (typeof timeout !== 'number' || !Number.isFinite(timeout) || timeout <= 0) {
      throw configError(
        configPath,
        `"defaultTimeoutMs" must be a positive number of milliseconds ` +
          `(got ${JSON.stringify(parsed.defaultTimeoutMs)})`,
      );
    }
    config.defaultTimeoutMs = timeout;
  }

  if (parsed.headless !== undefined) {
    if (typeof parsed.headless !== 'boolean') {
      throw configError(
        configPath,
        `"headless" must be true or false (got ${JSON.stringify(parsed.headless)})`,
      );
    }
    config.headless = parsed.headless;
  }

  if (parsed.profileMode !== undefined) {
    if (
      typeof parsed.profileMode !== 'string' ||
      !PROFILE_MODES.includes(parsed.profileMode as ProfileMode)
    ) {
      throw configError(
        configPath,
        `"profileMode" must be one of: ${PROFILE_MODES.join(', ')} ` +
          `(got ${JSON.stringify(parsed.profileMode)})`,
      );
    }
    config.profileMode = parsed.profileMode as ProfileMode;
  }

  if (parsed.providerKeys !== undefined) {
    const keys = parsed.providerKeys;
    if (typeof keys !== 'object' || keys === null || Array.isArray(keys)) {
      throw configError(
        configPath,
        '"providerKeys" must be an object with the provider names as keys',
      );
    }
    const providerKeys: Partial<Record<ProviderName, string>> = {};
    for (const [provider, secret] of Object.entries(keys)) {
      if (!isValidProvider(provider)) {
        throw configError(
          configPath,
          `"providerKeys" has an unknown provider "${provider}" ` +
            `(known providers: ${listProviders().join(', ')})`,
        );
      }
      if (typeof secret !== 'string' || !secret.trim()) {
        throw configError(
          configPath,
          `"providerKeys.${provider}" must be the name of a secret (a non-empty string)`,
        );
      }
      providerKeys[provider as ProviderName] = secret;
    }
    config.providerKeys = providerKeys;
  }

  if (parsed.proxy !== undefined) {
    config.proxy = validateProxyConfig(parsed.proxy, configPath);
  }

  if (parsed.credentialStorage !== undefined) {
    try {
      config.credentialStorage = parseCredentialStorage(parsed.credentialStorage);
    } catch (error) {
      throw configError(configPath, message(error));
    }
  }

  return config;
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
