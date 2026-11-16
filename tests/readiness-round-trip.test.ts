import { describe, expect, it } from 'vitest';
import { mergeRoundTrip, roundTripState } from '../spike/readiness/round-trip.mjs';

const ok = { ok: true, detail: { answerChars: [4, 4] } };
const bad = { ok: false, detail: 'the provider answered with an empty bubble' };

describe('roundTripState', () => {
  it('is unfinished without credentials', () => {
    const state = roundTripState({}, 10, 'no storage state found');
    expect(state.status).toBe('unfinished');
    expect(state.attempted).toBe(0);
    expect(state.mandatory).toBe(10);
  });

  it('is not done when only one combination passed', () => {
    const state = roundTripState({ 'camoufox/chatgpt': ok }, 10);
    expect(state.status).not.toBe('done');
    expect(state.status).toBe('partial');
  });

  it('is failed when a combination failed', () => {
    const state = roundTripState({ 'camoufox/chatgpt': bad }, 10);
    expect(state.status).toBe('failed');
    expect(state.failed).toBe(1);
  });

  it('is done only when every mandatory combination passed', () => {
    const combos: Record<string, { ok: boolean }> = {};
    for (let i = 0; i < 10; i++) combos[`engine${i}/provider${i}`] = ok;
    const state = roundTripState(combos, 10);
    expect(state.status).toBe('done');
    expect(state.passed).toBe(10);
  });
});

describe('mergeRoundTrip', () => {
  it('keeps the combinations of a per-engine run', () => {
    const merged = mergeRoundTrip(
      { combinations: { 'camoufox/chatgpt': ok } },
      { combinations: { 'cloakbrowser/chatgpt': ok } },
      10,
    );
    expect(Object.keys(merged.combinations)).toHaveLength(2);
    expect(merged.status).toBe('partial');
  });

  it('does not report done when the mandatory set is not covered', () => {
    const merged = mergeRoundTrip({ combinations: { 'camoufox/chatgpt': ok } }, {}, 10);
    expect(merged.status).not.toBe('done');
  });
});
