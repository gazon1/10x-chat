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
  return index === -1 ? 'http' : server.slice(0, index).toLowerCase();
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

  // `user:pass@host:port` has no scheme — parse it with a temporary one.
  const candidate = trimmed.includes('://') ? trimmed : `http://${trimmed}`;
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    // Not a URL at all: hand it over unchanged.
    return { server: trimmed };
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
 * The proxy of the environment.
 *
 * Chromium ignores the standard proxy variables, so they have to be turned
 * into a launch option explicitly. `HTTPS_PROXY` wins over `HTTP_PROXY`,
 * `NO_PROXY` becomes the bypass list.
 *
 * @param env the environment to read (the process environment by default)
 */
export function proxyFromEnv(env: NodeJS.ProcessEnv = process.env): BrowserProxy | undefined {
  const raw = env.HTTPS_PROXY ?? env.HTTP_PROXY;
  if (!raw?.trim()) return undefined;

  const proxy = splitProxyCredentials(raw);
  const bypass = (env.NO_PROXY ?? '')
    .split(',')
    .map((host) => host.trim())
    .filter(Boolean)
    .join(',');
  return { ...proxy, ...(bypass ? { bypass } : {}) };
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
 * @param proxy the proxy with separated credentials
 */
export function proxyLaunchOptions(proxy: BrowserProxy): { proxy: BrowserProxy } {
  const scheme = schemeOf(proxy.server);
  if ((scheme === 'socks4' || scheme === 'socks5') && (proxy.username || proxy.password)) {
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
      server: proxy.server,
      ...(proxy.username ? { username: proxy.username } : {}),
      ...(proxy.password ? { password: proxy.password } : {}),
      ...(proxy.bypass ? { bypass: proxy.bypass } : {}),
    },
  };
}
