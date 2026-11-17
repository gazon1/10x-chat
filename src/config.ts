import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { type BrowserProxy, proxyFromEnv, validateProxyServer } from './browser/proxy.js';
import { getConfigPath } from './paths.js';
import { isValidProvider, listProviders } from './providers/index.js';
import { loadSecrets } from './secrets.js';
import { type AppConfig, DEFAULT_CONFIG, type ProfileMode, type ProxyConfig } from './types.js';

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
  'proxy',
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
 * file. A server URL that carries them is rejected: the error names the
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
          `(got ${JSON.stringify(timeout)})`,
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

  if (parsed.proxy !== undefined) {
    config.proxy = validateProxyConfig(parsed.proxy, configPath);
  }

  return config;
}

/**
 * The proxy that the browser has to use.
 *
 * The order is: the config file, then the environment, then no proxy. A config
 * file with `proxy.enabled: false` switches the proxy off completely — the
 * environment is *not* used as a fallback then.
 *
 * The credentials come from the secrets file, never from the config file.
 *
 * @param env the environment to read (the process environment by default)
 * @returns the proxy, or `null` when there is none
 */
export async function resolveEffectiveProxy(
  env: NodeJS.ProcessEnv = process.env,
): Promise<BrowserProxy | null> {
  const config = await loadConfig();

  if (config.proxy) {
    if (!config.proxy.enabled) return null;

    const server = config.proxy.server;
    if (!server) {
      throw new Error(
        'Invalid proxy configuration: "proxy.server" is required when "proxy.enabled" is true.',
      );
    }

    const secrets = await loadSecrets();
    const bypass = (config.proxy.bypass ?? []).join(',');
    return {
      server,
      ...(bypass ? { bypass } : {}),
      ...(secrets.proxy?.username ? { username: secrets.proxy.username } : {}),
      ...(secrets.proxy?.password ? { password: secrets.proxy.password } : {}),
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
 */
export async function loadConfig(): Promise<AppConfig> {
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

  return { ...DEFAULT_CONFIG, ...validateConfig(parsed, configPath) };
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
