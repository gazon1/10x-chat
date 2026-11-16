import { describe, expect, it } from 'vitest';
import {
  classifyOutcome,
  containsMarker,
  newAnswerIndex,
  newMarker,
  probePrompt,
  SIGNUP_WALL,
} from '../spike/readiness/probe.mjs';

describe('classifyOutcome', () => {
  it('reports a navigation failure as an infra error', () => {
    expect(classifyOutcome({ status: 0, title: 'ERR timeout' })).toBe('infra-error');
  });

  it('reports a Cloudflare interstitial as cloudflare', () => {
    expect(classifyOutcome({ status: 200, title: 'Just a moment...' })).toBe('cloudflare');
    expect(classifyOutcome({ status: 403, title: '' })).toBe('cloudflare');
  });

  it('reports a redirect to the login page as an auth wall, not a provider error', () => {
    const outcome = classifyOutcome({
      status: 200,
      title: 'Claude',
      url: 'https://claude.ai/login?from=logout&reauth=1',
      composerVisible: false,
      loginVisible: false,
    });
    expect(outcome).toBe('auth-wall');
  });

  it('reports a login page as an auth wall even when a shell is rendered', () => {
    expect(
      classifyOutcome({
        status: 200,
        title: 'ChatGPT',
        url: 'https://chatgpt.com/auth/login',
        composerVisible: true,
      }),
    ).toBe('auth-wall');
  });

  it('reports a reachable composer as composer-visible', () => {
    expect(
      classifyOutcome({ status: 200, title: 'Perplexity', url: 'https://www.perplexity.ai' }),
    ).toBe('provider-error');
    expect(
      classifyOutcome({
        status: 200,
        title: 'Perplexity',
        url: 'https://www.perplexity.ai',
        composerVisible: true,
      }),
    ).toBe('composer-visible');
  });

  it('falls back to a provider error when nothing else applies', () => {
    expect(classifyOutcome({ status: 200, title: 'Something', url: 'https://example.com' })).toBe(
      'provider-error',
    );
  });
});

describe('the paywall of a guest session', () => {
  it('recognises the text a provider answers a guest with', () => {
    expect(SIGNUP_WALL.test('Sign up and repeat your request.')).toBe(true);
    expect(SIGNUP_WALL.test('Sign in to continue')).toBe(true);
  });

  it('does not mistake a real answer for a paywall', () => {
    expect(SIGNUP_WALL.test('Claude responded: READY')).toBe(false);
    expect(SIGNUP_WALL.test('Sign up')).toBe(false);
    expect(SIGNUP_WALL.test('Log in')).toBe(false);
  });
});

describe('newAnswerIndex', () => {
  it('returns the index of the answer that appeared', () => {
    expect(newAnswerIndex(0, 1)).toBe(0);
    expect(newAnswerIndex(3, 4)).toBe(3);
  });

  it('throws when no new answer appeared', () => {
    expect(() => newAnswerIndex(2, 2)).toThrow(/no new answer/);
    expect(() => newAnswerIndex(2, 1)).toThrow(/no new answer/);
  });
});

describe('the probe prompt', () => {
  it('carries a unique marker', () => {
    const a = newMarker();
    const b = newMarker();
    expect(a).not.toBe(b);
    expect(probePrompt(a)).toContain(a);
  });

  it('detects whether the answer mentions the marker', () => {
    expect(containsMarker('READY marker-1', 'marker-1')).toBe(true);
    expect(containsMarker('READY', 'marker-1')).toBe(false);
    expect(containsMarker(undefined, 'marker-1')).toBe(false);
  });
});
