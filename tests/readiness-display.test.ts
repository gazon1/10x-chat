import { describe, expect, it } from 'vitest';
import {
  displayAvailable,
  displaySocket,
  forceX11Backend,
  harnessDisplay,
  resolveDisplay,
} from '../spike/readiness/display.mjs';

describe('the display of the harness', () => {
  it('defaults to the virtual display :99', () => {
    expect(resolveDisplay({})).toBe(':99');
    expect(resolveDisplay({ SPIKE_DISPLAY: ':77' })).toBe(':77');
  });

  it('maps a display to its X11 socket', () => {
    expect(displaySocket(':99')).toBe('/tmp/.X11-unix/X99');
    expect(displaySocket(':0')).toBe('/tmp/.X11-unix/X0');
    expect(displaySocket(':99.0')).toBe('/tmp/.X11-unix/X99');
  });

  it('checks whether the display exists', () => {
    expect(displayAvailable(':99', () => true)).toBe(true);
    expect(displayAvailable(':99', () => false)).toBe(false);
  });

  it('lets a headed browser only on an existing virtual display', () => {
    expect(harnessDisplay({ headless: false, display: ':99', exists: () => true })).toBe(':99');
    expect(() => harnessDisplay({ headless: false, display: ':77', exists: () => false })).toThrow(
      /steal the focus/,
    );
  });

  it('needs no display for a headless browser', () => {
    expect(harnessDisplay({ headless: true, display: ':77', exists: () => false })).toBeNull();
  });
});

describe('the Wayland cut', () => {
  it('forces the X11 backend and removes the compositor connection', () => {
    const env: Record<string, string | undefined> = {
      WAYLAND_DISPLAY: 'wayland-0',
      DISPLAY: ':0',
    };
    forceX11Backend(env);
    // Without this the browser opens its window on the real desktop — even
    // with DISPLAY pointing at the virtual one — and takes the user's focus.
    expect(env.WAYLAND_DISPLAY).toBeUndefined();
    expect(env.OZONE_PLATFORM).toBe('x11');
    expect(env.MOZ_ENABLE_WAYLAND).toBe('0');
  });
});
