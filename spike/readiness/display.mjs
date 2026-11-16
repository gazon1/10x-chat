/**
 * The display the harness is allowed to open a browser on.
 *
 * A headed browser on the user's desktop takes the focus away from whatever
 * the user is doing. The harness therefore only ever uses a *virtual*
 * display (Xvfb): the display is forced for every browser process and a
 * missing virtual display is a hard error instead of a silent fallback to
 * the desktop display.
 */
import { existsSync } from 'node:fs';

/** The virtual display, `SPIKE_DISPLAY` or `:99`. */
export function resolveDisplay(env = process.env) {
  return env.SPIKE_DISPLAY ?? ':99';
}

/** The X11 socket of a display: `/tmp/.X11-unix/X<n>`. */
export function displaySocket(display) {
  const num = String(display).replace(/^:/, '').split('.')[0];
  return `/tmp/.X11-unix/X${num}`;
}

/** Is the display there? */
export function displayAvailable(display, exists = existsSync) {
  return exists(displaySocket(display));
}

/**
 * Force the browser backends onto X11 and cut the Wayland connection.
 *
 * The desktop session is a Wayland one (`WAYLAND_DISPLAY=wayland-0`). Both
 * Chromium (CloakBrowser) and Firefox (Camoufox) prefer the Wayland
 * compositor when it is available — and they then open their window on the
 * *real* desktop, no matter which `DISPLAY` they were given. That is what
 * steals the focus of the user.
 *
 * The compositor connection is therefore removed and the X11 backend is
 * requested explicitly: the browser talks to the virtual display only.
 */
export function forceX11Backend(env = process.env) {
  env.OZONE_PLATFORM = 'x11';
  env.MOZ_ENABLE_WAYLAND = '0';
  env.GDK_BACKEND = 'x11';
  delete env.WAYLAND_DISPLAY;
  return env;
}

/**
 * The display a browser may be opened on.
 *
 * @param {object} options
 * @param {boolean} options.headless a headless browser has no window
 * @param {string} options.display the virtual display of the harness
 * @param {Function} [options.exists] file existence check (for tests)
 * @returns {string|null} the display to use, `null` for a headless browser
 * @throws when a headed browser would have to fall back to the desktop
 */
export function harnessDisplay({ headless, display, exists = existsSync }) {
  if (headless) return null;
  if (!displayAvailable(display, exists)) {
    throw new Error(
      `the virtual display ${display} is not available — a headed browser would open a window on the desktop and steal the focus. ` +
        'Start Xvfb on it (e.g. `Xvfb :99 -screen 0 1920x1080x24 -nolisten tcp &`) or point SPIKE_DISPLAY at a running one. ' +
        'Headless runs (SPIKE_HEADLESS=1) do not need a display.',
    );
  }
  return display;
}
