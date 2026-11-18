/**
 * The transition to a new chat must not lose the conversation.
 *
 * When the context window of the chat is full, the provider continues it in a
 * new chat with an automatic summary. The new chat has no permanent URL until
 * its first message is sent: a run that fails in between must leave the
 * previous conversation in place, so the next run can pick the work up.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getStoredConversation,
  resolveConversationContext,
  saveStoredConversation,
} from '../src/core/conversations.js';
import type { ProviderActions, ProviderConfig } from '../src/types.js';

const fake = {
  page: {
    url: () => '',
    evaluate: async () => '',
    title: async () => '',
    locator: () => ({ first: () => ({ isVisible: async () => false }) }),
  },
  provider: undefined as unknown as { config: ProviderConfig; actions: ProviderActions },
};

vi.mock('../src/browser/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/browser/index.js')>()),
  launchBrowser: async () => ({
    page: fake.page,
    context: {},
    sharedState: false,
    close: async () => {},
  }),
}));

vi.mock('../src/providers/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/providers/index.js')>()),
  getProvider: () => fake.provider,
}));

const { runChat } = await import('../src/core/orchestrator.js');

describe('the continuation of an exhausted chat', () => {
  const originalEnv = process.env;
  let tempHome = '';

  beforeEach(async () => {
    tempHome = await mkdtemp(path.join(os.tmpdir(), 'ten-x-chat-continuation-'));
    process.env = { ...originalEnv, TEN_X_CHAT_HOME: tempHome };
  });

  afterEach(async () => {
    process.env = originalEnv;
    if (tempHome) await rm(tempHome, { recursive: true, force: true });
  });

  it('keeps the previous conversation when the run fails right after the new chat', async () => {
    const context = await resolveConversationContext();
    await saveStoredConversation(context, 'chatgpt', {
      id: 'abc',
      url: 'https://chatgpt.com/c/abc',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });

    let currentUrl = 'https://chatgpt.com/c/abc';
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
        contextWindowFull: async () => true,
        // The new chat has a local id: no permanent URL until it is sent.
        continueInNewChat: async () => {
          currentUrl = 'https://chatgpt.com/c/local-chatgpt%3A62043ce8';
          return true;
        },
        submitPrompt: async () => {
          throw new Error('the prompt could not be sent');
        },
        captureResponse: async () => ({ text: '', markdown: '', truncated: false }),
      } as unknown as ProviderActions,
    };

    await expect(runChat({ prompt: 'hello', provider: 'chatgpt' })).rejects.toThrow();

    expect((await getStoredConversation(context, 'chatgpt'))?.id).toBe('abc');
  });
});
