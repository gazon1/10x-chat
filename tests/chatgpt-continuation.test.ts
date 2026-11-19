/**
 * The continuation of an exhausted ChatGPT chat must land in a new chat.
 *
 * The app hides the banner of the exhausted context window before it renders
 * the new chat. A continuation that only waits for the banner would report
 * success while the old chat is still on the screen — and the prompt of the
 * run would be sent to the exhausted chat.
 */
import { describe, expect, it, vi } from 'vitest';

const OLD_URL = 'https://chatgpt.com/c/old-chat';
const NEW_URL = 'https://chatgpt.com/c/new-chat';

/**
 * A page mock of the app around the banner of the exhausted context window.
 *
 * The banner disappears at once, the new chat appears after `switchAfter`
 * checks of the composer.
 */
function createSummaryChatPage(options: {
  switchAfter: number;
  turnsBefore?: number;
  turnsAfter?: number;
}) {
  const { switchAfter, turnsBefore = 4, turnsAfter = 1 } = options;
  const state = {
    url: OLD_URL,
    turns: turnsBefore,
    checks: 0,
    switched: false,
    /** The URL of the app at every check of the composer. */
    observedUrls: [] as string[],
  };

  const page = {
    url: () => state.url,
    waitForTimeout: vi.fn(async () => {}),
    evaluate: vi.fn(async () => {
      // The first call clicks the "New chat" button of the banner, every
      // other call checks the composer of the new chat.
      if (state.checks === 0) {
        state.checks++;
        return true;
      }
      state.checks++;
      if (!state.switched && state.checks > switchAfter) {
        state.switched = true;
        state.url = NEW_URL;
        state.turns = turnsAfter;
      }
      state.observedUrls.push(state.url);
      // The banner is gone and the composer is back.
      return true;
    }),
    locator: () => ({ count: async () => state.turns }),
  };

  return { page, state };
}

describe('the continuation of an exhausted ChatGPT chat', () => {
  it('waits for the new conversation instead of reporting success too early', async () => {
    const { page, state } = createSummaryChatPage({ switchAfter: 2 });

    const { chatgptActions } = await import('../src/providers/chatgpt.js');
    await expect(chatgptActions.continueInNewChat?.(page as never)).resolves.toBe(true);

    // The first check still saw the old conversation: the continuation must
    // not have stopped there.
    expect(state.observedUrls[0]).toBe(OLD_URL);
    expect(state.observedUrls.at(-1)).toBe(NEW_URL);
  });

  it('fails when the new conversation never appears', async () => {
    // The banner is gone, but the app stays in the exhausted chat: the run
    // must not send its prompt to it.
    const { page } = createSummaryChatPage({ switchAfter: Number.POSITIVE_INFINITY });

    const { chatgptActions } = await import('../src/providers/chatgpt.js');
    await expect(chatgptActions.continueInNewChat?.(page as never)).resolves.toBe(false);
  });

  it('continues when the app switches to the new conversation at once', async () => {
    const { page, state } = createSummaryChatPage({ switchAfter: 0 });

    const { chatgptActions } = await import('../src/providers/chatgpt.js');
    await expect(chatgptActions.continueInNewChat?.(page as never)).resolves.toBe(true);
    expect(state.url).toBe(NEW_URL);
  });
});
