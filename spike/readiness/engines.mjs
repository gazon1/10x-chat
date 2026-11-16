/**
 * Engine adapters: one interface, two runtimes.
 *
 * camoufox     — Firefox (Camoufox 0.5.9 / browser 158.0.1-beta.41)
 * cloakbrowser — Chromium (CloakBrowser wrapper, free tier build)
 *
 * The adapter hides the API difference (Camoufox wants `user_data_dir`,
 * CloakBrowser wants `userDataDir`) so every matrix scenario is literally the
 * same code for both engines.
 */
import { launch as cloakLaunch, launchPersistentContext as cloakLaunchPersistent } from 'cloakbrowser';
import { Camoufox } from '../camoufox/node_modules/camoufox/dist/index.js';

export const ENGINE_NAMES = ['camoufox', 'cloakbrowser'];

/**
 * CloakBrowser picks the Pro binary when CLOAKBROWSER_LICENSE_KEY is present.
 * In this environment the installed Pro build (156.0.8078.47.1) refuses to
 * start (exit code 76), while the free build (146.0.7680.177.5) works. The
 * harness therefore runs the free tier by default — that is also the tier the
 * cost/licensing section has to evaluate. Set CLOAKBROWSER_USE_PRO=1 to try
 * the Pro build instead.
 */
async function cloakLaunchFree(options) {
  if (process.env.CLOAKBROWSER_USE_PRO === '1') return cloakLaunch(options);
  const key = process.env.CLOAKBROWSER_LICENSE_KEY;
  delete process.env.CLOAKBROWSER_LICENSE_KEY;
  try {
    return await cloakLaunch(options);
  } finally {
    if (key !== undefined) process.env.CLOAKBROWSER_LICENSE_KEY = key;
  }
}

async function cloakLaunchPersistentFree(options) {
  if (process.env.CLOAKBROWSER_USE_PRO === '1') return cloakLaunchPersistent(options);
  const key = process.env.CLOAKBROWSER_LICENSE_KEY;
  delete process.env.CLOAKBROWSER_LICENSE_KEY;
  try {
    return await cloakLaunchPersistent(options);
  } finally {
    if (key !== undefined) process.env.CLOAKBROWSER_LICENSE_KEY = key;
  }
}


export const engines = {
  camoufox: {
    label: 'camoufox',
    processPattern: 'camoufox',
    async launch({ headless = true, proxy } = {}) {
      return Camoufox({ headless, proxy, geoip: false });
    },
    /** Returns a persistent BrowserContext (Camoufox returns the context itself). */
    async launchPersistent({ headless = true, proxy, userDataDir } = {}) {
      return Camoufox({ headless, proxy, geoip: false, user_data_dir: userDataDir });
    },
  },
  cloakbrowser: {
    label: 'cloakbrowser',
    processPattern: 'chromium-1',
    async launch({ headless = true, proxy } = {}) {
      return cloakLaunchFree({ headless, proxy });
    },
    /** Returns a persistent BrowserContext. */
    async launchPersistent({ headless = true, proxy, userDataDir } = {}) {
      return cloakLaunchPersistentFree({ userDataDir, headless, proxy });
    },
  },
};
