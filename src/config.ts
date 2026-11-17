import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { getConfigPath } from './paths.js';
import { isValidProvider, listProviders } from './providers/index.js';
import { type AppConfig, DEFAULT_CONFIG, type ProfileMode } from './types.js';

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
] as const;

const PROFILE_MODES: readonly ProfileMode[] = ['shared', 'isolated'];

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** An error that names the config file and the problem in it. */
function configError(configPath: string, problem: string): Error {
  return new Error(`Invalid config file ${configPath}: ${problem}`);
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

  return config;
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
