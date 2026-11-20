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
import { resolveEffectiveProxy } from '../config.js';
import { type BrowserProxy, browserProcessEnv, proxyFromEnv, proxyLaunchOptions } from './proxy.ts';

let _chromium: BrowserType | undefined;
let _engineName: 'cloakbrowser' | 'unknown' = 'unknown';

/**
 * The launch options of the browser.
 *
 * The effective proxy (config file first, environment second) is handed to
 * Playwright through `launchOptions.proxy`: Playwright keeps the credentials
 * in its own CDP session and authenticates the browser from there. CloakBrowser
 * would otherwise inline them into `--proxy-server=http://user:pass@host:port`,
 * which puts the password into the command line of every process of the browser.
 *
 * The proxy variables are dropped from the environment of the browser for the
 * same reason — the environment of a process is readable by every local
 * process, and Chromium does not need them.
 *
 * @param proxy the effective proxy; `undefined` takes the proxy of the
 * environment, `null` means "no proxy at all" (a proxy that is switched off
 * must not fall back to the environment)
 */
export function buildLaunchOptions(
  options?: Record<string, unknown>,
  env: NodeJS.ProcessEnv = process.env,
  proxy?: BrowserProxy | null,
): Record<string, unknown> {
  const { channel: _channel, ...rest } = options ?? {};

  const launchOptions =
    rest.launchOptions && typeof rest.launchOptions === 'object'
      ? { ...(rest.launchOptions as Record<string, unknown>) }
      : {};

  // A proxy that the caller put into the options is the explicit one.
  const fromOptions = launchOptions.proxy as BrowserProxy | null | undefined;
  delete launchOptions.proxy;

  const effective =
    proxy === undefined ? (fromOptions === undefined ? proxyFromEnv(env) : fromOptions) : proxy;

  return {
    ...rest,
    launchOptions: {
      ...launchOptions,
      // The proxy variables are dropped even when no proxy is configured: a
      // variable that is not used can still carry the credentials of one
      // (e.g. `ALL_PROXY`), and the environment of a process is readable by
      // every local process of the machine.
      env: browserProcessEnv(env),
      ...(effective ? proxyLaunchOptions(effective) : {}),
    },
  };
}

async function loadEngine(): Promise<BrowserType> {
  if (_chromium) return _chromium;

  // Try CloakBrowser. It exposes launch helpers, not a BrowserType, so
  // adapt only the two methods 10x-chat uses.
  try {
    const cloakbrowser = await import('cloakbrowser');
    const humanize = process.env.TEN_X_CHAT_CLOAK_HUMANIZE !== '0';
    _chromium = {
      launch: async (options?: Record<string, unknown>) => {
        // The effective proxy: the config file first, the environment second.
        const proxy = await resolveEffectiveProxy();
        return cloakbrowser.launch({
          ...buildLaunchOptions(options, process.env, proxy),
          humanize,
        });
      },
      launchPersistentContext: async (userDataDir: string, options?: Record<string, unknown>) => {
        const proxy = await resolveEffectiveProxy();
        return cloakbrowser.launchPersistentContext({
          userDataDir,
          ...buildLaunchOptions(options, process.env, proxy),
          humanize,
        });
      },
    } as unknown as BrowserType;
    _engineName = 'cloakbrowser';
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
