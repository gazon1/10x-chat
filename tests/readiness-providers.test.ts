import { describe, expect, it } from 'vitest';
import { PROVIDERS } from '../spike/readiness/providers.mjs';

describe('the provider table of the readiness matrix', () => {
  it('covers the providers that can be measured with a session', () => {
    // Two providers are not part of the matrix: Grok has no authorized session
    // in this environment (its combinations could only ever be `skipped`), and
    // Perplexity does not submit the prompt through the browser UI here (the
    // send button stays without a click handler, so nothing is sent). Neither
    // of them said anything about the engines.
    expect(PROVIDERS.map((provider) => provider.name)).toEqual(['chatgpt', 'gemini', 'claude']);
  });

  it('gives every provider a selector on one DOM level', () => {
    for (const provider of PROVIDERS) {
      expect(provider.composer, `${provider.name} composer`).toBeTruthy();
      expect(provider.send, `${provider.name} send`).toBeTruthy();
      expect(provider.response, `${provider.name} response`).toBeTruthy();
      expect(provider.runs, `${provider.name} runs`).toBeGreaterThan(0);
    }
  });
});
