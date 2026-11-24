/**
 * The reuse of the conversation.
 *
 * A provider web app starts a new conversation on its landing page. The run
 * stores the conversation of the current repository and branch, so the next
 * run opens that conversation instead of starting over. The test runs two
 * chats after another: the second one must open the conversation of the
 * first one.
 *
 * The provider is gemini: the plain chat of chatgpt is served by its backend
 * and no longer reaches this path (`docs/capability-matrix.md`).
 */
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getStoredConversation, resolveConversationContext } from '../src/core/conversations.js';
import type { ProviderActions, ProviderConfig } from '../src/types.js';

const fake = {
  page: {
    url: () => '',
    evaluate: async () => '',
    title: async () => '',
    locator: () => ({ first: () => ({ isVisible: async () => false }) }),
  },
  provider: undefined as unknown as { config: ProviderConfig; actions: ProviderActions },
  /** The URLs the browser was launched with. */
  launched: [] as string[],
};

vi.mock('../src/browser/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/browser/index.js')>()),
  launchBrowser: async (options: { url?: string }) => {
    fake.launched.push(options.url ?? '');
    return {
      page: fake.page,
      context: {},
      sharedState: false,
      close: async () => {},
    };
  },
}));

vi.mock('../src/providers/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/providers/index.js')>()),
  getProvider: () => fake.provider,
}));

const { runChat } = await import('../src/core/orchestrator.js');

describe('the reuse of the conversation', () => {
  const originalEnv = process.env;
  let tempHome = '';

  beforeEach(async () => {
    tempHome = await mkdtemp(path.join(os.tmpdir(), 'ten-x-chat-reuse-'));
    process.env = { ...originalEnv, TEN_X_CHAT_HOME: tempHome };
    fake.launched = [];
  });

  afterEach(async () => {
    process.env = originalEnv;
    if (tempHome) await rm(tempHome, { recursive: true, force: true });
  });

  it('opens the conversation of the previous run', async () => {
    // The chat gets its permanent URL when the first message is sent: before
    // that it has a local id that cannot be reopened.
    let currentUrl = 'https://gemini.google.com/app';
    fake.page = {
      url: () => currentUrl,
      evaluate: async () => '',
      title: async () => '',
      locator: () => ({ first: () => ({ isVisible: async () => false }) }),
    } as never;
    fake.provider = {
      config: { url: 'https://gemini.google.com/app', displayName: 'Gemini' } as ProviderConfig,
      actions: {
        isLoggedIn: async () => true,
        submitPrompt: async () => {
          currentUrl = 'https://gemini.google.com/app/abc';
        },
        captureResponse: async () => ({
          text: 'the answer',
          markdown: 'the answer',
          truncated: false,
        }),
      } as unknown as ProviderActions,
    };

    const context = await resolveConversationContext();

    // The first run starts a new chat.
    await runChat({ prompt: 'hello', provider: 'gemini' });
    expect(fake.launched[0]).toBe('https://gemini.google.com/app');

    // The conversation of the run is stored.
    expect((await getStoredConversation(context, 'gemini'))?.id).toBe('abc');

    // The second run opens that conversation instead of the landing page.
    await runChat({ prompt: 'again', provider: 'gemini' });
    expect(fake.launched[1]).toBe('https://gemini.google.com/app/abc');
  });
});
