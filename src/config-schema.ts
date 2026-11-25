import { validateProxyServer } from './browser/proxy.js';
import { isValidProvider, listProviders } from './providers/index.js';
import type {
  AppConfig,
  CredentialStorage,
  ProfileMode,
  ProviderName,
  ProxyConfig,
} from './types.js';

/**
 * The schema of the config file.
 *
 * The validation lives in its own module: `loadConfig()` and the secrets
 * store both have to reject a broken config file, and a second, partial copy
 * of the rules would accept files that the first one rejects.
 */

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
  'chatgptProject',
] as const;

/** The keys of the proxy section of the config file. */
const PROXY_KEYS = ['enabled', 'server', 'bypass'] as const;

const PROFILE_MODES: readonly ProfileMode[] = ['shared', 'isolated'];

/** The values of the `credentialStorage` setting. */
export const CREDENTIAL_STORAGE_VALUES: readonly CredentialStorage[] = ['auto', 'keyring', 'file'];

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** An error that names the config file and the problem in it. */
export function configError(configPath: string, problem: string): Error {
  return new Error(`Invalid config file ${configPath}: ${problem}`);
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

  if (parsed.chatgptProject !== undefined) {
    if (typeof parsed.chatgptProject !== 'string' || !parsed.chatgptProject.trim()) {
      throw configError(
        configPath,
        '"chatgptProject" must be the name of an existing ChatGPT Project (a non-empty string)',
      );
    }
    config.chatgptProject = parsed.chatgptProject.trim();
  }

  return config;
}
