import type { Locator, Page } from 'playwright';
import { pollUntilStable } from '../core/polling.js';
import type { CapturedResponse, ProviderActions, ProviderConfig } from '../types.js';
import { submitPromptToComposer } from './submit.js';

/** Models the web app can run: one chat model plus a "DeepThink" reasoning mode. */
const DEEPSEEK_MODELS = ['deepseek-chat', 'deepseek-reasoner'];

export const DEEPSEEK_CONFIG: ProviderConfig = {
  name: 'deepseek',
  displayName: 'DeepSeek',
  url: 'https://chat.deepseek.com',
  loginUrl: 'https://chat.deepseek.com/sign_in',
  models: DEEPSEEK_MODELS,
  defaultModel: 'deepseek-chat',
  defaultTimeoutMs: 5 * 60 * 1000,
};

const SELECTORS = {
  /** Composer: the app renders a plain textarea with a "DeepSeek" placeholder. */
  composer: 'textarea[name="user query"], textarea[placeholder*="DeepSeek"]',
  /** Final answer block (markdown rendered by the app). */
  answer: '.ds-assistant-message-main-content',
  /** Reasoning ("DeepThink") block — rendered separately from the answer. */
  thinking: '.ds-think-content',
  /** Wrapper of a single chat message (user and assistant messages alike). */
  message: '.ds-message',
  /** Container of the app's toasts (rate limits, network errors, ...). */
  notifications: '.ds-notification-container',
  /** DeepThink toggle in the composer toolbar. */
  thinkToggle: '.ds-toggle-button:has-text("DeepThink"), .ds-toggle-button:has-text("深度思考")',
} as const;

const THINK_TOGGLE_TIMEOUT_MS = 5_000;
const THINK_STATE_POLL_MS = 200;
const THINK_STATE_POLLS = 25;

/**
 * Known service-error / rate-limit messages of the DeepSeek web app.
 * Checked against the text the app itself renders for the current turn, so a
 * failed turn raises instead of silently timing out.
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

/** Extract a DeepSeek service-error message from text rendered by the app. */
export function extractDeepSeekFailureText(text: string): string | null {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (!normalized) return null;

  for (const pattern of FAILURE_PATTERNS) {
    const match = normalized.match(pattern);
    if (match) return match[0];
  }
  return null;
}

/** State of the DeepThink toggle. */
type ThinkState = 'on' | 'off' | 'unknown';

interface AnswerSnapshot {
  /** Number of answer blocks rendered so far. */
  count: number;
  /** Text of the last answer block. */
  text: string;
  /** HTML of the last answer block. */
  html: string;
}

/** A rendered answer candidate. */
export interface AnswerBlock {
  text: string;
  html: string;
  /** True when the block belongs to the reasoning ("DeepThink") area. */
  insideThinking: boolean;
}

/**
 * Snapshot of the rendered answer blocks. The reasoning block is excluded so
 * the reasoning text is never mistaken for the final answer.
 */
async function readAnswerBlocks(page: Page): Promise<AnswerBlock[]> {
  return page.evaluate(
    ({ answerSelector, thinkingSelector }) =>
      Array.from(document.querySelectorAll(answerSelector)).map((el) => ({
        text: ((el as HTMLElement).innerText ?? '').trim(),
        html: el.innerHTML,
        insideThinking: Boolean(el.closest(thinkingSelector)),
      })),
    { answerSelector: SELECTORS.answer, thinkingSelector: SELECTORS.thinking },
  );
}

/** The final answer is the last block outside the reasoning area. */
export function pickAnswer(blocks: AnswerBlock[]): AnswerSnapshot {
  const answers = blocks.filter((block) => !block.insideThinking);
  const last = answers[answers.length - 1];
  return {
    count: answers.length,
    text: last?.text ?? '',
    html: last?.html ?? '',
  };
}

async function readAnswers(page: Page): Promise<AnswerSnapshot> {
  return pickAnswer(await readAnswerBlocks(page));
}

/**
 * Text the app renders for the current turn besides the answer itself:
 * the newest assistant message without its answer and reasoning blocks (this
 * is where the app puts inline service errors) plus the toast containers.
 */
interface TurnSignals {
  /** Newest assistant message without answer and reasoning. */
  errorText: string;
  /** Text of the app's toast containers. */
  toastText: string;
}

async function readTurnSignals(page: Page): Promise<TurnSignals> {
  return page.evaluate(
    ({ messageSelector, answerSelector, thinkingSelector, notificationsSelector }) => {
      const messages = Array.from(document.querySelectorAll(messageSelector));
      const assistant = messages.filter((el) => el.querySelector(answerSelector)).pop();

      let errorText = '';
      if (assistant) {
        const clone = assistant.cloneNode(true) as HTMLElement;
        for (const el of Array.from(clone.querySelectorAll(answerSelector))) el.remove();
        for (const el of Array.from(clone.querySelectorAll(thinkingSelector))) el.remove();
        errorText = (clone.textContent ?? '').trim();
      }

      const toastText = Array.from(document.querySelectorAll(notificationsSelector))
        .map((el) => (el.textContent ?? '').trim())
        .join(' ')
        .trim();

      return { errorText, toastText };
    },
    {
      messageSelector: SELECTORS.message,
      answerSelector: SELECTORS.answer,
      thinkingSelector: SELECTORS.thinking,
      notificationsSelector: SELECTORS.notifications,
    },
  );
}

/**
 * Service error of the *current* turn.
 *
 * Only content that appeared during this turn counts: the app renders service
 * errors inside the newest assistant message or as a toast. An old error left
 * in the chat history stays unchanged and must not fail the current request.
 */
async function readTurnFailure(page: Page, baseline: TurnSignals): Promise<string | null> {
  const signals = await readTurnSignals(page);

  if (signals.errorText !== baseline.errorText) {
    const failure = extractDeepSeekFailureText(signals.errorText);
    if (failure) return failure;
  }

  if (signals.toastText !== baseline.toastText) {
    const failure = extractDeepSeekFailureText(signals.toastText);
    if (failure) return failure;
  }

  return null;
}

/**
 * Answer state captured right before the prompt is sent, so an older answer
 * from a previous turn is not mistaken for the new one.
 */
const answerBaseline = new WeakMap<Page, AnswerSnapshot>();
/** App-rendered text captured right before the prompt is sent. */
const turnBaseline = new WeakMap<Page, TurnSignals>();

/** Read the state of the DeepThink toggle. */
async function readThinkState(toggle: Locator): Promise<ThinkState> {
  const state = await toggle
    .evaluate((el) => {
      const pressed = el.getAttribute('aria-pressed');
      if (pressed === 'true') return 'on';
      if (pressed === 'false') return 'off';
      if (el.classList.contains('ds-toggle-button--selected')) return 'on';
      if (el.classList.contains('ds-toggle-button')) return 'off';
      return 'unknown';
    })
    .catch(() => 'unknown');
  return state as ThinkState;
}

/** Wait until the DeepThink toggle reaches the wanted state. */
async function waitForThinkState(
  page: Page,
  toggle: Locator,
  desired: ThinkState,
): Promise<ThinkState> {
  let state = await readThinkState(toggle);
  for (let i = 0; i < THINK_STATE_POLLS && state !== desired; i++) {
    await page.waitForTimeout(THINK_STATE_POLL_MS);
    state = await readThinkState(toggle);
  }
  return state;
}

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
    if (!DEEPSEEK_MODELS.includes(model)) {
      throw new Error(
        `Unknown DeepSeek model "${model}". Expected one of: ${DEEPSEEK_MODELS.join(', ')}.`,
      );
    }

    // The web app has a single chat model plus a reasoning toggle.
    const wantsThinking = model === 'deepseek-reasoner';
    const toggle = page.locator(SELECTORS.thinkToggle).first();
    const visible = await toggle.isVisible({ timeout: THINK_TOGGLE_TIMEOUT_MS }).catch(() => false);
    if (!visible) {
      throw new Error(`DeepSeek DeepThink toggle not found — cannot select model "${model}".`);
    }

    const desired: ThinkState = wantsThinking ? 'on' : 'off';
    let state = await readThinkState(toggle);
    if (state === 'unknown') {
      throw new Error(`Cannot read the DeepThink toggle state — cannot select model "${model}".`);
    }
    if (state === desired) return;

    await toggle.click({ force: true });
    state = await waitForThinkState(page, toggle, desired);
    if (state !== desired) {
      throw new Error(
        `Failed to ${desired === 'on' ? 'enable' : 'disable'} DeepThink — model "${model}" was not applied.`,
      );
    }
  },

  async submitPrompt(page: Page, prompt: string): Promise<void> {
    await submitPromptToComposer(page, prompt, {
      composerSelector: SELECTORS.composer,
      // The send button has no stable label; the app submits on plain Enter.
      submit: false,
    });

    answerBaseline.set(page, await readAnswers(page));
    turnBaseline.set(page, await readTurnSignals(page));

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
    const turn = turnBaseline.get(page) ?? { errorText: '', toastText: '' };

    let html = '';
    const { text, truncated } = await pollUntilStable(page, {
      getText: async (p) => {
        const failure = await readTurnFailure(p, turn);
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
      const failure = await readTurnFailure(page, turn);
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
