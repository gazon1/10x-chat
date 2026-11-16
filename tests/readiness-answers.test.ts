import { describe, expect, it } from 'vitest';
import { answerSnapshot, topLevelAnswers } from '../spike/readiness/answers.mjs';
import {
  alternativeContainer,
  PROVIDERS,
  selectorAlternatives,
} from '../spike/readiness/providers.mjs';

describe('topLevelAnswers', () => {
  it('counts a nested element as the same answer', () => {
    // The Gemini DOM of one answer: the container `model-response` with the
    // answer text and the `message-content` inside it.
    const entries = [
      { path: '1.8.0.0.1', text: 'PROBE1' },
      { path: '1.8.0.0.1.0', text: 'PROBE1' },
      { path: '1.8.0.0.1.0.0', text: 'PROBE1' },
    ];
    expect(topLevelAnswers(entries)).toHaveLength(1);
    expect(answerSnapshot(entries)).toEqual({ count: 1, texts: ['PROBE1'] });
  });

  it('counts two answers as two', () => {
    const entries = [
      { path: '1.8.0.0.1', text: 'PROBE1' },
      { path: '1.8.0.0.1.0', text: 'PROBE1' },
      { path: '1.8.0.0.2', text: 'PROBE2' },
      { path: '1.8.0.0.2.0', text: 'PROBE2' },
    ];
    expect(answerSnapshot(entries)).toEqual({ count: 2, texts: ['PROBE1', 'PROBE2'] });
  });

  it('does not confuse siblings with nested elements', () => {
    const entries = [
      { path: '0.1', text: 'a' },
      { path: '0.2', text: 'b' },
      { path: '1.0', text: 'c' },
    ];
    expect(answerSnapshot(entries)).toEqual({ count: 3, texts: ['a', 'b', 'c'] });
  });
});

describe('the answer selector of a provider', () => {
  it('never matches two DOM levels of the same answer', () => {
    for (const provider of PROVIDERS) {
      const alternatives = selectorAlternatives(provider.response);
      const containers = alternatives.map(alternativeContainer);
      const duplicated = containers.filter(
        (container, index) => containers.indexOf(container) !== index,
      );
      expect(
        duplicated,
        `${provider.name}: the alternatives of "${provider.response}" share the container "${duplicated[0]}" — one answer would be counted twice`,
      ).toEqual([]);
    }
  });

  it('addresses Gemini on a single DOM level', () => {
    const gemini = PROVIDERS.find((provider) => provider.name === 'gemini');
    expect(gemini?.response).toBe('model-response .model-response-text');
  });
});
