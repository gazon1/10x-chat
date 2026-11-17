import type { Page } from 'playwright';
import { pollUntilStable } from '../core/polling.js';
import type { CapturedResponse, ProviderActions, ProviderConfig } from '../types.js';
import { submitPromptToComposer } from './submit.js';

export const DEEPSEEK_CONFIG: ProviderConfig = {
  name: 'deepseek',
  displayName: 'DeepSeek',
  url: 'https://chat.deepseek.com',
  loginUrl: 'https://chat.deepseek.com/sign_in',
  /** The web app exposes one chat model and a "DeepThink" reasoning toggle. */
  models: ['deepseek-chat', 'deepseek-reasoner'],
  defaultModel: 'deepseek-chat',
  defaultTimeoutMs: 5 * 60 * 1000,
};

const SELECTORS = {
  /** Composer: the app renders a plain textarea named "user query". */
  composer: 'textarea[name="user query"], textarea[placeholder*="DeepSeek"]',
  /** Final answer block (markdown rendered by the app). */
  answer: '.ds-assistant-message-main-content',
  /** Reasoning ("DeepThink") block — rendered separately from the answer. */
  thinking: '.ds-think-content',
  /** DeepThink toggle in the composer toolbar. */
  thinkToggle: '.ds-toggle-button:has-text("DeepThink"), .ds-toggle-button:has-text("深度思考")',
} as const;

/**
 * Known service-error / rate-limit messages of the DeepSeek web app.
 * Checked against the visible page text so a failed turn raises instead of
 * silently timing out.
 */
const FAILURE_PATTERNS: RegExp[] = [
  /Server busy, please try again later\.?/i,
  /Server is temporarily unavailable\.?/i,
  /System temporarily unavailable\.?/i,
  /Too many requests\.? Try again later\.?/i,
  /Network Error\. Please check your network status\.?/i,
  /Check your internet connection and try again\.?/i,
  /The message you sent is too long\. Please modify it and resend\.?/i,
];

/** Extract a DeepSeek service-error message from visible page text. */
export function extractDeepSeekFailureText(text: string): string | null {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (!normalized) return null;

  for (const pattern of FAILURE_PATTERNS) {
    const match = normalized.match(pattern);
    if (match) return match[0];
  }
  return null;
}

interface AnswerSnapshot {
  /** Number of answer blocks rendered so far. */
  count: number;
  /** Text of the last answer block. */
  text: string;
  /** HTML of the last answer block. */
  html: string;
}

/**
 * Snapshot of the rendered answer blocks. The reasoning block is excluded so
 * the reasoning text is never mistaken for the final answer.
 */
async function readAnswers(page: Page): Promise<AnswerSnapshot> {
  return page.evaluate(
    ({ answerSelector, thinkingSelector }) => {
      const blocks = Array.from(document.querySelectorAll(answerSelector)).filter(
        (el) => !el.closest(thinkingSelector),
      );
      const last = blocks[blocks.length - 1] as HTMLElement | undefined;
      return {
        count: blocks.length,
        text: (last?.innerText ?? '').trim(),
        html: last?.innerHTML ?? '',
      };
    },
    { answerSelector: SELECTORS.answer, thinkingSelector: SELECTORS.thinking },
  );
}

async function readVisibleText(page: Page): Promise<string> {
  return page.evaluate(() => document.body?.innerText ?? '').catch(() => '');
}

/**
 * Answer state captured right before the prompt is sent, so an older answer
 * from a previous turn is not mistaken for the new one.
 */
const answerBaseline = new WeakMap<Page, AnswerSnapshot>();

export const deepseekActions: ProviderActions = {
  async isLoggedIn(page: Page): Promise<boolean> {
    try {
      await page.waitForLoadState('domcontentloaded').catch(() => {});
      if (page.url().includes('/sign_in')) return false;

      const composerVisible = await page
        .locator(SELECTORS.composer)
        .first()
        .isVisible({ timeout: 8_000 })
        .catch(() => false);
      return composerVisible;
    } catch {
      return false;
    }
  },

  async selectModel(page: Page, model: string): Promise<void> {
    // The web app has a single chat model plus a reasoning toggle.
    const wantsThinking = /reasoner|think/i.test(model);
    const toggle = page.locator(SELECTORS.thinkToggle).first();
    const visible = await toggle.isVisible({ timeout: 5_000 }).catch(() => false);
    if (!visible) {
      console.warn(`DeepSeek DeepThink toggle not found — skipping model selection for "${model}"`);
      return;
    }

    const enabled = await toggle
      .evaluate(
        (el) =>
          el.classList.contains('ds-toggle-button--selected') ||
          el.getAttribute('aria-pressed') === 'true',
      )
      .catch(() => false);
    if (enabled === wantsThinking) return;

    await toggle.click({ force: true });
    await page.waitForTimeout(500);
  },

  async submitPrompt(page: Page, prompt: string): Promise<void> {
    await submitPromptToComposer(page, prompt, {
      composerSelector: SELECTORS.composer,
      // The send button has no stable label; the app submits on plain Enter.
      submit: false,
    });

    answerBaseline.set(page, await readAnswers(page));

    await page.keyboard.press('Enter');
    await page.waitForTimeout(500);
  },

  async captureResponse(
    page: Page,
    opts: { timeoutMs: number; onChunk?: (chunk: string) => void },
  ): Promise<CapturedResponse> {
    const { timeoutMs, onChunk } = opts;
    const startTime = Date.now();
    const baseline = answerBaseline.get(page) ?? { count: 0, text: '', html: '' };

    let html = '';
    const { text, truncated } = await pollUntilStable(page, {
      getText: async (p) => {
        const failure = extractDeepSeekFailureText(await readVisibleText(p));
        if (failure) throw new Error(failure);

        const snapshot = await readAnswers(p);
        const isFresh =
          snapshot.count > baseline.count ||
          (snapshot.text.length > 0 && snapshot.text !== baseline.text);
        if (!isFresh) return '';

        html = snapshot.html;
        return snapshot.text;
      },
      timeoutMs,
      onChunk,
    });

    if (!text) {
      const failure = extractDeepSeekFailureText(await readVisibleText(page));
      throw new Error(failure ?? 'DeepSeek returned no response.');
    }

    const elapsed = Date.now() - startTime;
    return {
      text,
      markdown: html,
      truncated,
      thinkingTime: Math.round(elapsed / 1000),
    };
  },
};
