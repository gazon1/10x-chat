import { randomBytes } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createChatgptUseBackend } from '../../src/backend/chatgpt-use.js';
import { runCli } from './helpers.js';

/**
 * The live scenario of the ChatGPT backend: it drives the real `chatgpt-use`
 * CLI, so it needs the CLI and a logged-in ChatGPT.
 *
 * It is opt-in: `TEN_X_CHAT_E2E_CHATGPT_USE=1` runs it.
 */
const live = (process.env.TEN_X_CHAT_E2E_CHATGPT_USE ?? '').trim() !== '';

const TIMEOUT_MS = 5 * 60 * 1000;

describe.skipIf(!live)('the ChatGPT backend of chatgpt-use (live)', () => {
  it(
    'sends a prompt to ChatGPT and reads the answer',
    async () => {
      const backend = createChatgptUseBackend();
      const marker = `tenxchate2e${randomBytes(3).toString('hex')}`;
      const requestId = `e2e-${randomBytes(4).toString('hex')}`;

      const outcome = await backend.ask({
        requestId,
        prompt: `Answer with the marker ${marker} and nothing else.`,
        timeoutMs: 120_000,
      });

      expect(outcome.ok).toBe(true);
      if (!outcome.ok) return;
      expect(outcome.value.text).toContain(marker);
      expect(outcome.value.submission).toBe('submitted');

      // The receipt of the request knows that it reached ChatGPT.
      const state = await backend.status(requestId);
      expect(state.submission).toBe('submitted');

      // A resume waits for the reply of the request — it never sends the
      // prompt again.
      const resumed = await backend.resume({
        requestId,
        prompt: `Answer with the marker ${marker} and nothing else.`,
      });
      expect(resumed.ok).toBe(true);
      if (resumed.ok) expect(resumed.value.text).toContain(marker);

      // A finished request cannot be cancelled any more.
      const cancelled = await backend.cancel(requestId);
      expect(cancelled.ok).toBe(true);
      if (cancelled.ok) expect(cancelled.value.cancelled).toBe(false);
    },
    TIMEOUT_MS,
  );

  it(
    'runs a chat through the CLI',
    async () => {
      const marker = `tenxchate2e${randomBytes(3).toString('hex')}`;
      const res = await runCli(
        [
          'chat',
          '-p',
          `Answer with the marker ${marker} and nothing else.`,
          '--backend',
          'chatgpt-use',
        ],
        { TEN_X_CHAT_HOME: await mkdtemp(path.join(os.tmpdir(), '10x-chat-e2e-')) },
      );

      expect(res.code).toBe(0);
      expect(res.stdout).toContain('Backend: chatgpt-use');
      expect(res.stdout).toContain(marker);
    },
    TIMEOUT_MS,
  );
});
