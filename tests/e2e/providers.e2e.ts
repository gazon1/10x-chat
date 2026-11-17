import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { runCli } from './helpers.ts';

const PROVIDERS = ['chatgpt', 'gemini', 'claude', 'grok', 'perplexity', 'deepseek'] as const;

const DISPLAY_NAMES = ['ChatGPT', 'Gemini', 'Claude', 'Grok', 'Perplexity', 'DeepSeek'] as const;

/**
 * The live provider scenarios need a browser and a logged-in profile, so they
 * are opt-in: `TEN_X_CHAT_E2E_PROVIDERS=1` runs every provider, a comma
 * separated list (`chatgpt,gemini`) runs only those.
 *
 * They use the real data directory (`TEN_X_CHAT_HOME`, `~/.10x-chat` by
 * default), because the login lives in the browser profile there.
 */
const requested = (process.env.TEN_X_CHAT_E2E_PROVIDERS ?? '').trim();
const live = requested !== '';
const selected =
  requested === '' || requested === '1' || requested === 'all'
    ? PROVIDERS
    : PROVIDERS.filter((provider) => requested.split(',').includes(provider));

const TIMEOUT_MS = 5 * 60 * 1000;

describe.skipIf(!live)('provider round trips (live)', () => {
  it(
    'reports the login status of every provider',
    async () => {
      const result = await runCli(['login', '--status']);
      expect(result.code).toBe(0);
      for (const name of DISPLAY_NAMES) {
        expect(result.output).toContain(name);
      }
    },
    TIMEOUT_MS,
  );

  for (const provider of selected) {
    it(
      `sends a prompt to ${provider} and captures the answer`,
      async () => {
        // A unique marker per run: it can only appear in the answer if the
        // provider really replied to this prompt, and a stale capture from an
        // earlier run cannot satisfy it.
        const marker = `tenxchate2e${provider}${randomBytes(3).toString('hex')}`;
        const result = await runCli([
          'chat',
          '-p',
          `Answer with the marker ${marker} and nothing else.`,
          '--provider',
          provider,
          '--timeout',
          '120000',
        ]);
        expect(result.output).not.toContain('Error:');
        expect(result.code).toBe(0);
        expect(result.stdout).toContain('--- Response ---');
        expect(result.stdout).toMatch(/Session:\s*\S+/);
        // A response that is empty or only the echoed prompt is not an answer.
        const response = result.stdout.split('--- Response ---')[1] ?? '';
        expect(response.trim().length).toBeGreaterThan(0);
        // The answer must be about the prompt we sent, not arbitrary UI text.
        expect(response.toLowerCase()).toContain(marker);
      },
      TIMEOUT_MS,
    );
  }
});
