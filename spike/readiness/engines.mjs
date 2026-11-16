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
import {
  launch as cloakLaunch,
  launchPersistentContext as cloakLaunchPersistent,
} from 'cloakbrowser';
import { Camoufox } from '../camoufox/node_modules/camoufox/dist/index.js';
import { forceX11Backend, harnessDisplay, resolveDisplay } from './display.mjs';

export const ENGINE_NAMES = ['camoufox', 'cloakbrowser'];

/**
 * The only display the harness may open a browser on.
 *
 * A headed browser on the user's desktop takes the focus away from whatever
 * the user is doing, so the harness is restricted to a virtual display
 * (Xvfb). `SPIKE_DISPLAY` names it (`:99` by default).
 *
 * If that display is missing the harness refuses to start a headed browser
 * instead of silently falling back to the desktop display — the fallback is
 * exactly the thing that must not happen.
 */
export const HARNESS_DISPLAY = resolveDisplay();

/**
 * Force the harness onto the virtual display and make sure it exists.
 *
 * The browser must also be kept away from the Wayland compositor of the
 * desktop session — otherwise it opens its window on the real screen and
 * takes the focus away from the user.
 *
 * @param {boolean} headless a headless browser has no window and no focus
 */
function guardDisplay(headless) {
  // Always: a headless browser must not talk to the compositor either.
  forceX11Backend(process.env);
  const display = harnessDisplay({ headless, display: HARNESS_DISPLAY });
  if (display) {
    // The browser child processes inherit this.
    process.env.DISPLAY = display;
  }
}

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
      guardDisplay(headless);
      return Camoufox({ headless, proxy, geoip: false });
    },
    /** Returns a persistent BrowserContext (Camoufox returns the context itself). */
    async launchPersistent({ headless = true, proxy, userDataDir } = {}) {
      guardDisplay(headless);
      return Camoufox({ headless, proxy, geoip: false, user_data_dir: userDataDir });
    },
  },
  cloakbrowser: {
    label: 'cloakbrowser',
    processPattern: 'chromium-1',
    async launch({ headless = true, proxy } = {}) {
      guardDisplay(headless);
      return cloakLaunchFree({ headless, proxy });
    },
    /** Returns a persistent BrowserContext. */
    async launchPersistent({ headless = true, proxy, userDataDir } = {}) {
      guardDisplay(headless);
      return cloakLaunchPersistentFree({ userDataDir, headless, proxy });
    },
  },
};
