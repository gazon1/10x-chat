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

  it('drops a stale reason once something was attempted', () => {
    const state = roundTripState({ 'camoufox/chatgpt': ok }, 10, 'no storage state found');
    expect(state.reason).toBeUndefined();
    expect(state.status).toBe('partial');
  });

  it('counts a combination without credentials as skipped, not as a failure', () => {
    const state = roundTripState({ 'camoufox/gemini': { ok: false, skipped: true } }, 10);
    expect(state.skipped).toBe(1);
    expect(state.attempted).toBe(0);
    expect(state.failed).toBe(0);
    expect(state.status).toBe('unfinished');
  });

  it('is not done while some mandatory combination could not be measured', () => {
    const combos: Record<string, { ok: boolean; skipped?: boolean }> = {
      'camoufox/chatgpt': ok,
      'camoufox/gemini': { ok: false, skipped: true },
    };
    const state = roundTripState(combos, 10);
    expect(state.status).toBe('partial');
    expect(state.passed).toBe(1);
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

  it('drops a stale reason from a previous report once a combination was measured', () => {
    const merged = mergeRoundTrip(
      { status: 'unfinished', reason: 'no storage state found', combinations: {} },
      { status: 'partial', combinations: { 'camoufox/chatgpt': ok } },
      10,
    );
    expect(merged.reason).toBeUndefined();
    expect(merged.status).toBe('partial');
  });

  it('keeps the reason while nothing could be measured at all', () => {
    const merged = mergeRoundTrip(
      { status: 'unfinished', reason: 'no storage state found', combinations: {} },
      { status: 'unfinished', reason: 'no storage state found', combinations: {} },
      10,
    );
    expect(merged.reason).toBe('no storage state found');
    expect(merged.status).toBe('unfinished');
  });
});
