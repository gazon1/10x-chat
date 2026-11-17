import { describe, expect, it } from 'vitest';
import { resolveHeadlessMode } from '../src/browser/mode.js';
import { getProvider } from '../src/providers/index.js';

describe('resolveHeadlessMode', () => {
  it('runs the providers that need a visible browser headed', () => {
    expect(resolveHeadlessMode(getProvider('chatgpt').config, true)).toBe(false);
    expect(resolveHeadlessMode(getProvider('claude').config, true)).toBe(false);
    expect(resolveHeadlessMode(getProvider('perplexity').config, true)).toBe(false);
  });

  it('keeps headless mode for Gemini when config prefers headless', () => {
    expect(resolveHeadlessMode(getProvider('gemini').config, true)).toBe(true);
  });

  it('follows the config file for a provider without a headed requirement', () => {
    expect(resolveHeadlessMode(getProvider('grok').config, true)).toBe(true);
    expect(resolveHeadlessMode(getProvider('grok').config, false)).toBe(false);
  });

  it('decides by the provider config, not by a list of provider names', () => {
    expect(resolveHeadlessMode({ requiresHeaded: false }, true)).toBe(true);
    expect(resolveHeadlessMode({ requiresHeaded: true }, false)).toBe(false);
  });

  it('honors explicit headed override for any provider', () => {
    expect(resolveHeadlessMode(getProvider('grok').config, true, true)).toBe(false);
  });

  it('honors explicit headless override for providers that prefer headed', () => {
    expect(resolveHeadlessMode(getProvider('chatgpt').config, true, false, true)).toBe(true);
  });
});
