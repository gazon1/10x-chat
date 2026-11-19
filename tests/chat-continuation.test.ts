/**
 * The transition to a new chat must not lose the conversation.
 *
 * When the context window of the chat is full, the provider continues it in a
 * new chat with an automatic summary. The new chat has no permanent URL until
 * its first message is sent: a run that fails in between must leave the
 * previous conversation in place, so the next run can pick the work up.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getStoredConversation,
  resolveConversationContext,
  saveStoredConversation,
} from '../src/core/conversations.js';
import { ContextWindowFullError } from '../src/core/failures.js';
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

  it('continues the conversation when the context runs out during the answer', async () => {
    // The answer of an exhausted chat never comes: the run continues the
    // conversation in a new chat and asks again.
    let banner = false;
    let attempts = 0;
    const submitPrompt = vi.fn(async () => {});
    fake.page = {
      url: () => 'https://chatgpt.com/c/abc',
      evaluate: async () => '',
      title: async () => '',
      locator: () => ({ first: () => ({ isVisible: async () => false }) }),
    } as never;
    fake.provider = {
      config: { url: 'https://chatgpt.com/', displayName: 'ChatGPT' } as ProviderConfig,
      actions: {
        isLoggedIn: async () => true,
        contextWindowFull: async () => banner,
        continueInNewChat: async () => {
          banner = false;
          return true;
        },
        submitPrompt,
        captureResponse: async () => {
          attempts++;
          if (attempts === 1) {
            // The context runs out while the answer is generated.
            banner = true;
            throw new ContextWindowFullError();
          }
          return { text: 'the answer', markdown: 'the answer', truncated: false };
        },
      } as unknown as ProviderActions,
    };

    const result = await runChat({ prompt: 'hello', provider: 'chatgpt' });

    expect(result.response).toBe('the answer');
    expect(submitPrompt).toHaveBeenCalledTimes(2);
  });

  it('attaches the files again in the new chat', async () => {
    // The files of the request belong to the old chat: the new chat must get
    // them too, so the answer is not produced without them.
    const file = path.join(tempHome, 'note.txt');
    await writeFile(file, 'hello', 'utf8');
    const attachFiles = vi.fn(async () => {});
    fake.page = {
      url: () => 'https://chatgpt.com/c/abc',
      evaluate: async () => '',
      title: async () => '',
      locator: () => ({ first: () => ({ isVisible: async () => false }) }),
    } as never;
    fake.provider = {
      config: { url: 'https://chatgpt.com/', displayName: 'ChatGPT' } as ProviderConfig,
      actions: {
        isLoggedIn: async () => true,
        contextWindowFull: async () => true,
        continueInNewChat: async () => true,
        attachFiles,
        submitPrompt: async () => {},
        captureResponse: async () => ({
          text: 'the answer',
          markdown: 'the answer',
          truncated: false,
        }),
      } as unknown as ProviderActions,
    };

    await runChat({ prompt: 'hello', provider: 'chatgpt', attach: [file] });

    // Once for the old chat, once for the new one.
    expect(attachFiles).toHaveBeenCalledTimes(2);
  });

  it('stops the run after too many continuations', async () => {
    // Every path that continues the chat counts: the limit belongs to the
    // run, not to the path that hit it. A chat that runs out again and again
    // does not fit into any context window.
    const continueInNewChat = vi.fn(async () => true);
    fake.page = {
      url: () => 'https://chatgpt.com/c/abc',
      evaluate: async () => '',
      title: async () => '',
      locator: () => ({ first: () => ({ isVisible: async () => false }) }),
    } as never;
    fake.provider = {
      config: { url: 'https://chatgpt.com/', displayName: 'ChatGPT' } as ProviderConfig,
      actions: {
        isLoggedIn: async () => true,
        contextWindowFull: async () => true,
        continueInNewChat,
        submitPrompt: async () => {},
        captureResponse: async () => {
          // The context runs out again while the answer is generated.
          throw new ContextWindowFullError();
        },
      } as unknown as ProviderActions,
    };

    await expect(runChat({ prompt: 'hello', provider: 'chatgpt' })).rejects.toThrow(
      /already continued in a new one 3 time/,
    );

    // The chat was continued exactly as often as the limit allows.
    expect(continueInNewChat).toHaveBeenCalledTimes(3);
  });

  it('aborts the continuation when the files cannot be attached again', async () => {
    // The prompt must not be sent without the files of the request: the
    // answer would look successful and be wrong.
    const file = path.join(tempHome, 'note.txt');
    await writeFile(file, 'hello', 'utf8');
    let attachments = 0;
    const attachFiles = vi.fn(async () => {
      attachments++;
      // The first attachment (to the old chat) works, the second one (to the
      // new chat) fails.
      if (attachments > 1) throw new Error('the upload failed');
    });
    const submitPrompt = vi.fn(async () => {});
    fake.page = {
      url: () => 'https://chatgpt.com/c/abc',
      evaluate: async () => '',
      title: async () => '',
      locator: () => ({ first: () => ({ isVisible: async () => false }) }),
    } as never;
    fake.provider = {
      config: { url: 'https://chatgpt.com/', displayName: 'ChatGPT' } as ProviderConfig,
      actions: {
        isLoggedIn: async () => true,
        contextWindowFull: async () => true,
        continueInNewChat: async () => true,
        attachFiles,
        submitPrompt,
        captureResponse: async () => ({
          text: 'the answer',
          markdown: 'the answer',
          truncated: false,
        }),
      } as unknown as ProviderActions,
    };

    await expect(runChat({ prompt: 'hello', provider: 'chatgpt', attach: [file] })).rejects.toThrow(
      /could not be attached/,
    );

    // The prompt was not sent without the files.
    expect(submitPrompt).not.toHaveBeenCalled();
  });
});
