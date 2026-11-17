import { createHash } from 'node:crypto';

/**
 * Proxy configuration for the browser process.
 *
 * The credentials of a proxy must not reach the browser process: the command
 * line (`/proc/<pid>/cmdline`) and the environment (`/proc/<pid>/environ`) of
 * a process are readable by every local process of the machine.
 *
 * CloakBrowser's wrapper inlines the credentials into
 * `--proxy-server=http://user:pass@host:port`, so the proxy is handed to
 * Playwright instead: Playwright keeps the credentials in its own CDP session,
 * answers the authentication challenge of the proxy from there and starts the
 * browser with the bare proxy URL.
 */

/** A proxy with the credentials separated from the server URL. */
export interface BrowserProxy {
  /** Proxy URL without any userinfo, e.g. `http://proxy.example:3128`. */
  server: string;
  username?: string;
  password?: string;
  /** Comma-separated list of hosts that must bypass the proxy (`NO_PROXY`). */
  bypass?: string;
}

/**
 * Every environment variable that can carry a proxy configuration.
 *
 * They are removed from the environment of the browser process: Chromium does
 * not read them, but they would expose the credentials of the proxy.
 */
const PROXY_ENV_VARS = [
  'HTTPS_PROXY',
  'HTTP_PROXY',
  'ALL_PROXY',
  'https_proxy',
  'http_proxy',
  'all_proxy',
] as const;

/**
 * The proxy URL of the environment, in the order of precedence: the first
 * variable with a value wins.
 */
const PROXY_URL_ENV_VARS = [
  'HTTPS_PROXY',
  'https_proxy',
  'HTTP_PROXY',
  'http_proxy',
  'ALL_PROXY',
  'all_proxy',
] as const;

/** The bypass list of the environment (`NO_PROXY`), in the order of precedence. */
const NO_PROXY_ENV_VARS = ['NO_PROXY', 'no_proxy'] as const;

/**
 * The proxy schemes that Chromium can use.
 *
 * `http`/`https` are the only ones that can carry credentials (Basic auth is
 * answered by Playwright over CDP). `socks4`/`socks5` work without
 * credentials only — see `proxyLaunchOptions`.
 */
export const SUPPORTED_PROXY_SCHEMES = ['http', 'https', 'socks4', 'socks5'] as const;

const SUPPORTED_SCHEMES = new Set<string>(SUPPORTED_PROXY_SCHEMES);

/** Percent-decoding that keeps a malformed escape as it is. */
function decodeUserInfo(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** The scheme of a proxy URL (`http` when the URL has none). */
function schemeOf(server: string): string {
  const index = server.indexOf('://');
  const scheme = index === -1 ? 'http' : server.slice(0, index).toLowerCase();
  // Only a real scheme may be named in a message: everything else could be a
  // part of the credentials of a URL that could not be parsed.
  return /^[a-z][a-z0-9+.-]*$/.test(scheme) ? scheme : 'unknown';
}

/**
 * Parse a proxy URL, with a temporary scheme when it has none.
 *
 * @returns the URL, or `undefined` when the value is not a URL at all
 */
function parseProxyUrl(value: string): URL | undefined {
  const candidate = value.includes('://') ? value : `http://${value}`;
  try {
    return new URL(candidate);
  } catch {
    return undefined;
  }
}

/**
 * Remove the userinfo from a proxy URL that cannot be parsed.
 *
 * The raw value can carry the credentials (`ftp://user:pass@host:badport` is
 * not a URL, but it is readable) and it must not reach an error message, a log
 * or the command line of the browser.
 */
function stripUserInfo(raw: string): string {
  const index = raw.indexOf('://');
  const prefix = index === -1 ? '' : raw.slice(0, index + 3);
  const rest = index === -1 ? raw : raw.slice(index + 3);
  const at = rest.lastIndexOf('@');
  return at === -1 ? raw : `${prefix}${rest.slice(at + 1)}`;
}

/**
 * Split a proxy URL into the server URL and the credentials.
 *
 * The server URL never keeps the userinfo — the credentials are returned
 * separately, so they can be handed to Playwright instead of the browser.
 *
 * @param raw the proxy URL, with or without a scheme (`user:pass@host:port`)
 */
export function splitProxyCredentials(raw: string): BrowserProxy {
  const trimmed = raw.trim();
  if (!trimmed) return { server: trimmed };

  const url = parseProxyUrl(trimmed);
  if (!url) {
    // Not a URL at all: keep the host part only. The raw value may carry the
    // credentials, and it must not be handed on unchanged.
    return { server: stripUserInfo(trimmed) };
  }

  if (!url.username && !url.password) return { server: trimmed };

  // `url.host` is the host with the port and without the userinfo.
  const username = decodeUserInfo(url.username);
  const password = decodeUserInfo(url.password);
  return {
    server: `${url.protocol}//${url.host}`,
    ...(username ? { username } : {}),
    ...(password ? { password } : {}),
  };
}

/**
 * Check a proxy URL that comes from the config file.
 *
 * The error names the problem, never the URL: the URL can carry the
 * credentials, and an error message ends up in logs and in bug reports.
 *
 * @param server the proxy URL of the config file
 * @throws an Error that names the problem without the URL
 */
export function validateProxyServer(server: string): string {
  if (!server.includes('://')) {
    throw new Error(`The proxy URL must have a scheme (${SUPPORTED_PROXY_SCHEMES.join(', ')}).`);
  }

  const scheme = schemeOf(server);
  if (!SUPPORTED_SCHEMES.has(scheme)) {
    throw new Error(
      `Unsupported proxy scheme "${scheme}". ` +
        `Supported schemes: ${[...SUPPORTED_SCHEMES].join(', ')}.`,
    );
  }

  if (server.includes('@')) {
    throw new Error(
      `The proxy URL must not contain credentials — the user and the password belong ` +
        `into the secrets file, not into the config file.`,
    );
  }

  if (!parseProxyUrl(server)) {
    throw new Error(`The proxy URL cannot be parsed as a URL.`);
  }

  return server;
}

/**
 * The proxy of the environment.
 *
 * Chromium ignores the standard proxy variables, so they have to be turned
 * into a launch option explicitly. The first variable with a value wins
 * (`HTTPS_PROXY` → `https_proxy` → `HTTP_PROXY` → `http_proxy` → `ALL_PROXY`
 * → `all_proxy`), `NO_PROXY`/`no_proxy` becomes the bypass list.
 *
 * The environment is the fallback: the config file can name a proxy of its own
 * and can switch the proxy off completely (see `resolveEffectiveProxy()`).
 *
 * @param env the environment to read (the process environment by default)
 */
export function proxyFromEnv(env: NodeJS.ProcessEnv = process.env): BrowserProxy | undefined {
  const raw = PROXY_URL_ENV_VARS.map((name) => env[name]).find((value) => value?.trim());
  if (!raw?.trim()) return undefined;

  const proxy = splitProxyCredentials(raw);
  const noProxy = NO_PROXY_ENV_VARS.map((name) => env[name]).find((value) => value?.trim());
  const bypass = (noProxy ?? '')
    .split(',')
    .map((host) => host.trim())
    .filter(Boolean)
    .join(',');
  return { ...proxy, ...(bypass ? { bypass } : {}) };
}

/**
 * A fingerprint of a proxy.
 *
 * The shared browser daemon is started once and reused by every later
 * invocation, but the proxy is a property of the browser process: a daemon
 * that was started with another proxy would keep it. The fingerprint goes
 * into the state file of the daemon so that a changed proxy restarts it.
 *
 * Every effective field is part of the fingerprint — the server, the user, the
 * password and the bypass list. The fingerprint is a hash: the password never
 * leaves this function.
 *
 * @param proxy the effective proxy (`null` when there is none)
 */
export function fingerprintProxy(proxy: BrowserProxy | null | undefined): string {
  if (!proxy) return 'none';
  return createHash('sha256')
    .update(
      [proxy.server, proxy.username ?? '', proxy.password ?? '', proxy.bypass ?? ''].join('|'),
    )
    .digest('hex')
    .slice(0, 16);
}

/**
 * A fingerprint of the proxy of the environment.
 *
 * @param env the environment to read (the process environment by default)
 */
export function proxyFingerprint(env: NodeJS.ProcessEnv = process.env): string {
  return fingerprintProxy(proxyFromEnv(env));
}

/**
 * The environment of the browser process: the environment of this process
 * without the proxy variables.
 *
 * Playwright replaces (not merges) the environment of the browser, so the
 * complete environment is passed on — only the proxy variables are dropped.
 *
 * @param env the environment to copy (the process environment by default)
 */
export function browserProcessEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if ((PROXY_ENV_VARS as readonly string[]).includes(key)) continue;
    result[key] = value;
  }
  return result;
}

/**
 * The launch options that keep the credentials of the proxy out of the
 * browser process.
 *
 * The proxy is handed to Playwright, which authenticates from its own CDP
 * session: Chromium only sees the bare proxy URL in its command line and
 * answers the challenge of the proxy itself.
 *
 * A proxy that Chromium cannot use is rejected here, with an error that names
 * the problem but never the URL — the URL can carry the credentials.
 *
 * @param proxy the proxy with separated credentials
 */
export function proxyLaunchOptions(proxy: BrowserProxy): { proxy: BrowserProxy } {
  // The server URL must never carry the credentials: strip them again, the
  // caller may have built the object by hand.
  const normalized = splitProxyCredentials(proxy.server);
  const server = normalized.server;
  const username = proxy.username ?? normalized.username;
  const password = proxy.password ?? normalized.password;

  const scheme = schemeOf(server);
  if (!SUPPORTED_SCHEMES.has(scheme)) {
    // Only the scheme is named — the URL itself can carry the credentials.
    throw new Error(
      `Unsupported proxy scheme "${scheme}". ` +
        `Supported schemes: ${[...SUPPORTED_SCHEMES].join(', ')}.`,
    );
  }

  if (!parseProxyUrl(server)) {
    throw new Error(
      `Invalid proxy URL: the value cannot be parsed as a URL. ` +
        `Check the proxy environment variables (HTTPS_PROXY, HTTP_PROXY, ALL_PROXY).`,
    );
  }

  if ((scheme === 'socks4' || scheme === 'socks5') && (username || password)) {
    // Chromium can only authenticate a SOCKS proxy through its URL, and that
    // URL ends up in the command line of every process of the browser.
    throw new Error(
      `SOCKS proxy authentication is not supported without exposing the credentials in the ` +
        `process table: Chromium can only authenticate a SOCKS proxy through the URL of the ` +
        `--proxy-server flag. Use an HTTP proxy with credentials, or a local relay ` +
        `(see docs/refactor-4-9-camoufox-production-readiness.md).`,
    );
  }

  return {
    proxy: {
      server,
      ...(username ? { username } : {}),
      ...(password ? { password } : {}),
      ...(proxy.bypass ? { bypass: proxy.bypass } : {}),
    },
  };
}
