/**
 * The reuse of the conversation.
 *
 * A provider web app starts a new conversation on its landing page. The run
 * stores the conversation of the current repository and branch, so the next
 * run opens that conversation instead of starting over. The test runs two
 * chats after another: the second one must open the conversation of the
 * first one.
 *
 * The runs name `headed` because the plain chat of ChatGPT is served by its
 * backend now: the reuse of this test belongs to the browser path, which a
 * browser flag keeps (`wantsBrowser` in `src/core/orchestrator.ts`).
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
    let currentUrl = 'https://chatgpt.com/';
    fake.page = {
      url: () => currentUrl,
      evaluate: async () => '',
      title: async () => '',
      locator: () => ({ first: () => ({ isVisible: async () => false }) }),
    } as never;
    fake.provider = {
      config: { url: 'https://chatgpt.com/', displayName: 'ChatGPT' } as ProviderConfig,
      actions: {
        isLoggedIn: async () => true,
        submitPrompt: async () => {
          currentUrl = 'https://chatgpt.com/c/abc';
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
    await runChat({ prompt: 'hello', provider: 'chatgpt', headed: true });
    expect(fake.launched[0]).toBe('https://chatgpt.com/');

    // The conversation of the run is stored.
    expect((await getStoredConversation(context, 'chatgpt'))?.id).toBe('abc');

    // The second run opens that conversation instead of the landing page.
    await runChat({ prompt: 'again', provider: 'chatgpt', headed: true });
    expect(fake.launched[1]).toBe('https://chatgpt.com/c/abc');
  });
});
