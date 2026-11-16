/**
 * Browser engine abstraction.
 *
 * Tries to use CloakBrowser.
 *
 * CloakBrowser reduces automation detection signals that
 * Playwright leaks, making browser automation less likely to trip
 * Cloudflare, DataDome, etc.
 */

import type { BrowserType } from 'playwright';

let _chromium: BrowserType | undefined;
let _engineName: 'cloakbrowser' | 'unknown' = 'unknown';
let _loaded = false;

/**
 * Proxy from the environment (HTTPS_PROXY / HTTP_PROXY, NO_PROXY).
 *
 * Chromium ignores the standard proxy env vars, so they have to be turned
 * into a launch option explicitly. CloakBrowser supports HTTP and SOCKS5
 * proxies, including credentials in the URL.
 */
function proxyFromEnv(): { server: string; bypass?: string } | undefined {
  const server = process.env.HTTPS_PROXY ?? process.env.HTTP_PROXY;
  if (!server) return undefined;
  const bypass = process.env.NO_PROXY?.split(',')
    .map((host) => host.trim())
    .filter(Boolean)
    .join(',');
  return { server, ...(bypass ? { bypass } : {}) };
}

async function loadEngine(): Promise<BrowserType> {
  if (_chromium) return _chromium;

  // Try CloakBrowser. It exposes launch helpers, not a BrowserType, so
  // adapt only the two methods 10x-chat uses.
  try {
    const cloakbrowser = await import('cloakbrowser');
    const humanize = process.env.TEN_X_CHAT_CLOAK_HUMANIZE !== '0';
    const cleanOptions = (options?: Record<string, unknown>) => {
      const { channel: _channel, ...rest } = options ?? {};
      const proxy = proxyFromEnv();
      return proxy ? { ...rest, proxy } : rest;
    };
    _chromium = {
      launch: async (options?: Record<string, unknown>) => {
        return cloakbrowser.launch({ ...cleanOptions(options), humanize });
      },
      launchPersistentContext: async (userDataDir: string, options?: Record<string, unknown>) => {
        return cloakbrowser.launchPersistentContext({
          userDataDir,
          ...cleanOptions(options),
          humanize,
        });
      },
    } as unknown as BrowserType;
    _engineName = 'cloakbrowser';
    _loaded = true;
    return _chromium;
  } catch (err) {
    throw new Error(
      `CloakBrowser is not installed or failed to load. Run: npm install cloakbrowser. Error: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/** Get the chromium browser type (async — loads engine on first call). */
export async function getChromium(): Promise<BrowserType> {
  return loadEngine();
}

/** Which engine is active. Returns 'unknown' if not yet loaded. */
export function getEngineName(): 'cloakbrowser' | 'unknown' {
  return _engineName;
}

/** Whether the engine has been loaded yet. */
export function isEngineLoaded(): boolean {
  return _loaded;
}
