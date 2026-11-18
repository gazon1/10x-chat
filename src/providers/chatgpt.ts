import type { Page } from 'playwright';
import { conversationIdFromUrl } from '../core/conversations.js';
import {
  AntibotChallengeError,
  isChallengeVisible,
  ProviderGenerationError,
} from '../core/failures.js';
import type {
  CapturedResponse,
  GeneratedImage,
  ProviderActions,
  ProviderConfig,
} from '../types.js';
import { clickSendButton, submitPromptToComposer } from './submit.js';

const chatgptSubmitBaseline = new WeakMap<
  Page,
  {
    turnCount: number;
    /** The text of every assistant message of the chat before the prompt. */
    bodies: string[];
    /** The joined text of the assistant messages before the prompt. */
    latestText: string;
    errorText: string;
    url: string;
  }
>();
const chatgptPendingFiles = new WeakMap<Page, string[]>();

const ASSISTANT_TURN_FALLBACK_SELECTORS = [
  '[data-conversation-role="assistant"]',
  '[data-chatgpt-search-unit-key$=":assistant"]',
  'div.agent-turn',
  'article[data-testid^="conversation-turn-"]:has(.markdown)',
  'div[data-message-id]:has(.markdown)',
  '[data-message-author-role="assistant"]',
  '.markdown',
] as const;

const ASSISTANT_TURN_COUNT_SELECTORS = [
  '[data-conversation-role="assistant"]',
  '[data-chatgpt-search-unit-key$=":assistant"]',
  'div.agent-turn',
  'article[data-testid^="conversation-turn-"]:has(.markdown)',
  'div[data-message-id]:has(.markdown)',
  '[data-message-author-role="assistant"]',
] as const;

const ASSISTANT_CONTENT_FALLBACK_SELECTORS = [
  '[data-markdown-text-style="assistant-message"]',
  '[data-response-body]',
  '[data-dil-response]',
  '[class*="MarkdownRoot"]',
  'div.agent-turn .markdown',
  'article[data-testid^="conversation-turn-"]:has(.markdown) .markdown',
  'div[data-message-id]:has(.markdown) .markdown',
  'div.agent-turn',
  'article[data-testid^="conversation-turn-"]:has(.markdown)',
  'div[data-message-id]:has(.markdown)',
  '[data-message-author-role="assistant"]',
  '.markdown',
] as const;

/**
 * The strict selectors of an assistant message body.
 *
 * A single answer of ChatGPT can be split into several messages (a long
 * review is streamed as two), and one message can hold several nested body
 * elements. Every message must be captured — the last one alone is only the
 * tail of the answer.
 */
const ASSISTANT_BODY_SELECTORS = [
  '[data-markdown-text-style="assistant-message"]',
  '[data-response-body]',
  '[data-dil-response]',
] as const;

/** The container of one message of the current UI. */
const MESSAGE_CONTAINER_SELECTORS = [
  '[data-conversation-role="assistant"]',
  '[data-message-author-role="assistant"]',
  '[data-message-id]',
  'article[data-testid^="conversation-turn-"]',
  'div.agent-turn',
] as const;

/** One answer body of the assistant (one message of ChatGPT). */
interface AssistantBody {
  text: string;
  html: string;
}

/** The state of the assistant messages of the page. */
interface AssistantSnapshot {
  found: boolean;
  /** The bodies of the assistant messages, in the order of the document. */
  bodies: AssistantBody[];
  errorText: string;
}

export const CHATGPT_CONFIG: ProviderConfig = {
  name: 'chatgpt',
  displayName: 'ChatGPT',
  url: 'https://chatgpt.com',
  loginUrl: 'https://chatgpt.com/auth/login',
  models: [
    'Instant',
    'Medium',
    'High',
    'Extra High',
    'Pro',
    'Pro Extended',
    'Thinking',
    'GPT-5.6 Sol',
    'GPT-5.5',
    'GPT-5.4',
    'GPT-5.3',
    'o3',
  ],
  defaultModel: 'Pro',
  // Pro and Thinking need minutes, not seconds: a full PR review takes
  // ~11 min, and the old 5 min cut the answer off mid-stream.
  defaultTimeoutMs: 30 * 60 * 1000,
  botProtected: true,
};

function resolveChatGPTModelLabels(model: string): string[] {
  const normalized = normalizeModelLabel(model);
  const labels: string[] = [];

  if (/\b5\.6\b/.test(normalized)) labels.push('GPT-5.6 Sol');
  else if (/\b5\.5\b/.test(normalized)) labels.push('GPT-5.5');
  else if (/\b5\.4\b/.test(normalized)) labels.push('GPT-5.4');
  else if (/\b5\.3\b/.test(normalized)) labels.push('GPT-5.3');
  else if (/\bo3\b/.test(normalized)) labels.push('o3');

  if (normalized.includes('extra high') || normalized === 'xhigh') labels.push('Extra High');
  else if (normalized.includes('instant')) labels.push('Instant');
  else if (normalized.includes('medium')) labels.push('Medium');
  else if (normalized.includes('high')) labels.push('High');
  else if (normalized.includes('pro') || normalized.includes('thinking')) labels.push('Pro');

  return labels.length > 0 ? labels : [model];
}

function isChatGPTFamilyLabel(model: string): boolean {
  return /^(?:GPT-5\.[3-6](?: Sol)?|o3)$/i.test(model);
}

const SELECTORS = {
  composer:
    '#prompt-textarea.ProseMirror[contenteditable="true"][role="textbox"], #prompt-textarea[contenteditable="true"], [data-testid="composer-input"], div.ProseMirror[contenteditable="true"], textarea, .wcDTda_fallbackTextarea',
  sendButton:
    '#composer-submit-button, button[aria-label="Send prompt"], [data-testid="send-button"]',
  // The composer button is "Stop" while the answer is generated (it becomes
  // the voice/record button when idle). The old labels are kept for the other
  // UI variants.
  stopButton:
    'button[aria-label="Stop"], button[aria-label="Stop streaming"], button[aria-label="Stop generating"], button[data-testid="stop-button"]',
  assistantTurn: ASSISTANT_TURN_FALLBACK_SELECTORS.join(', '),
  loginPage: 'button:has-text("Log in"), button:has-text("Sign up")',
  /** Hidden file input — exclude the dedicated photo/camera inputs */
  fileInput: 'input[type="file"]:not(#upload-photos):not(#upload-camera)',
  modelPicker:
    'button.__composer-pill, button[data-testid="model-switcher-dropdown-button"], button[aria-label="Model selector"], button[aria-label*="model" i], button[aria-haspopup="menu"], button[aria-haspopup="listbox"], button[aria-haspopup="dialog"]',
  modelOption: 'button,[role="menuitemradio"],[role="menuitem"],[role="option"]',
} as const;

const MODEL_OPTION_SCOPE_SELECTORS = [
  '[role="menu"]',
  '[data-radix-menu-content]',
  '[role="listbox"]',
  '[data-radix-popper-content-wrapper]',
  '[data-headlessui-portal]',
  '[data-floating-ui-portal]',
  '[role="dialog"]',
] as const;

function normalizeModelLabel(text: string | null | undefined): string {
  return (text ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
}

async function getAssistantTurnCount(page: Page): Promise<number> {
  for (const selector of ASSISTANT_TURN_COUNT_SELECTORS) {
    const count = await page
      .locator(selector)
      .count()
      .catch(() => 0);
    if (count > 0) {
      return count;
    }
  }

  return page
    .locator(SELECTORS.assistantTurn)
    .count()
    .catch(() => 0);
}

/**
 * The labels ChatGPT renders in the assistant node while it works ("Thinking",
 * "Reviewed potential bugs"). They can stay unchanged for longer than the
 * stability window, so a stable label must never be taken for the answer.
 */
const ACTIVITY_TEXT =
  /^\s*(?:pro\s+)?(?:thinking|reasoning|searching|analyzing|processing|working|responding|finalizing|reviewing|assessing|reading|browsing|running|checking|listing|considering|drafting|writing|inspecting|examining|summarizing|reviewed|assessed|analyzed|read|searched|browsed|ran|checked|listed|considered|drafted|wrote|inspected|examined|thought|summarized)(?:\s+[^.!?\n]{0,160})?(?:\.\.\.|…)?\.?\s*$/i;

/** The text ChatGPT shows when the answer generation failed. */
const GENERATION_ERROR_TEXT =
  /\b(?:streaming error|error (?:in|while) (?:the )?(?:message )?(?:stream|response)|there was an error (?:generating|while generating)|failed to generate (?:a )?response|network error|connection (?:lost|failed)|something (?:went|seems to have gone) wrong)\b/i;

/**
 * An unknown error message still starts with a failure word.
 *
 * The answer itself can talk about a failure — a review of the streaming code
 * does — so only an answer that *starts* like a failure is a failure.
 */
const GENERATION_ERROR_START =
  /^\s*(?:sorry|oops|uh|error|failed|failure|unable|couldn'?t|can'?t|network|connection|something|there\s+(?:was|is)\s+an?\s+error|streaming\s+error)\b/i;

/**
 * How many polls a short activity-like text may stay stable before it is taken
 * for the answer. A real label ends when the generation ends; a very short
 * answer ("Read the PR description.") must not wait for the whole timeout.
 */
const ACTIVITY_GRACE_POLLS = 20;

/**
 * The error the page reports instead of the answer, if any.
 *
 * An error element is trusted even with an unknown wording; an unknown error
 * in the answer text is recognized by the failure word it starts with.
 */
function generationErrorOf(
  snapshot: { text: string; errorText: string },
  baseline: { latestText: string; errorText: string },
): string | undefined {
  const errorText = snapshot.errorText !== baseline.errorText ? snapshot.errorText.trim() : '';
  const text = snapshot.text !== baseline.latestText ? snapshot.text.trim() : '';

  if (errorText) {
    const known = GENERATION_ERROR_TEXT.exec(errorText);
    if (known) return known[0];
    return errorText.slice(0, 200);
  }

  // The answer itself can talk about a streaming error — a review of the
  // streaming code does — so only an answer that starts like a failure is
  // taken for one.
  if (text.length > 0 && text.length <= 200) {
    const known = GENERATION_ERROR_TEXT.exec(text);
    if (known && GENERATION_ERROR_START.test(text)) return known[0];
    if (GENERATION_ERROR_START.test(text)) return text;
  }
  return undefined;
}

/**
 * The assistant messages of the page.
 *
 * The messages are grouped by the container they belong to: one answer can be
 * split into several messages, and one message can hold several nested body
 * elements (the markdown root, the response body, the dil renderer). The
 * longest text of a group is the answer of that message.
 */
async function getLatestAssistantSnapshot(page: Page): Promise<AssistantSnapshot> {
  return page.evaluate(
    ({ bodySelectors, fallbackSelectors, messageSelectors }) => {
      const errorText = Array.from(
        document.querySelectorAll('[role="alert"], [data-testid*="error"]'),
      )
        .map((element) => (element as HTMLElement).innerText || element.textContent || '')
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 400);

      const isVisible = (element: Element): boolean => {
        const style = window.getComputedStyle(element);
        if (style.display === 'none' || style.visibility === 'hidden') return false;
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      };

      const textOf = (element: Element): string =>
        ((element as HTMLElement).innerText || element.textContent || '').trim();

      const groups = new Map<Element, { text: string; html: string; element: Element }>();
      for (const selector of bodySelectors) {
        for (const element of Array.from(document.querySelectorAll(selector))) {
          if (element.closest('[data-message-author-role="user"]')) continue;
          const text = textOf(element);
          if (!text) continue;
          const container = element.closest(messageSelectors.join(',')) ?? element;
          const known = groups.get(container);
          if (!known || text.length > known.text.length) {
            groups.set(container, { text, html: element.innerHTML || '', element });
          }
        }
      }

      const bodies = Array.from(groups.values())
        .sort((a, b) =>
          a.element.compareDocumentPosition(b.element) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1,
        )
        .map(({ text, html }) => ({ text, html }));

      if (bodies.length > 0) return { found: true, bodies, errorText };

      // Fallback for the other UI variants: the last visible match.
      for (const selector of fallbackSelectors) {
        const matches = Array.from(document.querySelectorAll(selector));
        if (matches.length === 0) continue;
        const visibleMatches = matches.filter(isVisible);
        const last = (visibleMatches.length > 0 ? visibleMatches : matches).at(-1);
        if (!(last instanceof Element)) continue;
        return {
          found: true,
          bodies: [
            {
              text: textOf(last),
              html: 'innerHTML' in last ? last.innerHTML || '' : '',
            },
          ],
          errorText,
        };
      }

      return { found: false, bodies: [], errorText };
    },
    {
      bodySelectors: [...ASSISTANT_BODY_SELECTORS],
      fallbackSelectors: [...ASSISTANT_CONTENT_FALLBACK_SELECTORS],
      messageSelectors: [...MESSAGE_CONTAINER_SELECTORS],
    },
  );
}

/**
 * The assistant messages that are new since the baseline.
 *
 * The old messages of a reused chat stay in the DOM: the answer of this run
 * is everything after them. The transcript can also be re-rendered, which
 * loses the old messages — then the last old message that is still there
 * marks the start of the new ones.
 */
function newAssistantBodies(baseline: string[], current: AssistantBody[]): AssistantBody[] {
  if (baseline.length === 0) return current;
  const normalize = (value: string): string => value.replace(/\s+/g, ' ').trim();

  let start = 0;
  while (
    start < baseline.length &&
    start < current.length &&
    normalize(baseline[start]) === normalize(current[start].text)
  ) {
    start++;
  }
  if (start > 0) return current.slice(start);

  for (let index = baseline.length - 1; index >= 0; index--) {
    const found = current.findIndex((body) => normalize(body.text) === normalize(baseline[index]));
    if (found >= 0) return current.slice(found + 1);
  }

  return current;
}

async function getVisibleModelPickerState(page: Page): Promise<{ found: boolean; text: string }> {
  return page.evaluate(
    ({ explicitSelector, candidateSelector }) => {
      const normalizeText = (value: string | null | undefined) =>
        (value ?? '').replace(/\s+/g, ' ').trim();
      const isVisible = (element: Element | null): element is HTMLElement => {
        if (!(element instanceof HTMLElement)) return false;
        if (element.hidden) return false;
        const style = window.getComputedStyle(element);
        if (style.display === 'none' || style.visibility === 'hidden') return false;
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      };

      const explicitPicker = Array.from(document.querySelectorAll(explicitSelector)).find(
        isVisible,
      );
      if (explicitPicker) {
        return { found: true, text: normalizeText(explicitPicker.textContent) };
      }

      const pickerTextRe = /instant|thinking|gpt|model|pro|medium|high|extended/i;
      const candidate = Array.from(document.querySelectorAll(candidateSelector)).find((element) => {
        return (
          isVisible(element) &&
          pickerTextRe.test(
            normalizeText(
              element.getAttribute('aria-label') ||
                element.textContent ||
                element.getAttribute('data-testid'),
            ),
          )
        );
      });

      return candidate
        ? { found: true, text: normalizeText(candidate.textContent) }
        : { found: false, text: '' };
    },
    {
      explicitSelector: 'button[data-testid="model-switcher-dropdown-button"]',
      candidateSelector: SELECTORS.modelPicker,
    },
  );
}

const MODEL_PILL_SELECTOR =
  'button.__composer-pill:has-text("Instant"), button.__composer-pill:has-text("Medium"), button.__composer-pill:has-text("High"), button.__composer-pill:has-text("Extra High"), button.__composer-pill:has-text("Pro"), button.__composer-pill:has-text("GPT-5")';

const MODEL_UI_PROBE_ATTEMPTS = 12;

/**
 * Is any model control visible on the page?
 *
 * The current ChatGPT UI (including the free plan) may not render a model
 * picker at all. Probing for it first keeps `selectModel` from blocking on the
 * long waits of the old picker flow.
 */
async function isModelUiPresent(page: Page): Promise<boolean> {
  const pill = page.locator(MODEL_PILL_SELECTOR).first();
  if (await pill.isVisible().catch(() => false)) return true;
  return Boolean((await getVisibleModelPickerState(page))?.found);
}

async function waitForModelUi(page: Page): Promise<boolean> {
  for (let attempt = 0; attempt < MODEL_UI_PROBE_ATTEMPTS; attempt++) {
    if (await isModelUiPresent(page)) return true;
    if (attempt < MODEL_UI_PROBE_ATTEMPTS - 1) await page.waitForTimeout(250);
  }
  return false;
}

async function clickVisibleModelOption(page: Page, model: string): Promise<boolean> {
  return page.evaluate(
    ({ modelLabel, optionSelector, scopeSelectors, excludedSelector }) => {
      const normalizeText = (value: string | null | undefined) =>
        (value ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
      const isVisible = (element: Element | null): element is HTMLElement => {
        if (!(element instanceof HTMLElement)) return false;
        if (element.hidden) return false;
        const style = window.getComputedStyle(element);
        if (style.display === 'none' || style.visibility === 'hidden') return false;
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      };
      const matchesModel = (element: Element) => {
        const text = normalizeText(element.textContent);
        return text.includes(modelLabel);
      };
      const isSubmenuTrigger = (element: Element) =>
        element.getAttribute('aria-haspopup') === 'menu' ||
        element.hasAttribute('data-has-submenu');
      const isExcluded = (element: Element) =>
        Boolean(
          excludedSelector &&
            (element.matches(excludedSelector) || element.closest(excludedSelector)),
        );

      for (const scopeSelector of scopeSelectors) {
        const scopes = Array.from(document.querySelectorAll(scopeSelector));
        for (const scope of scopes) {
          const option = Array.from(scope.querySelectorAll(optionSelector)).find((element) => {
            return isVisible(element) && matchesModel(element) && !isSubmenuTrigger(element);
          });
          if (option instanceof HTMLElement) {
            option.click();
            return true;
          }
        }
      }

      const fallbackOption = Array.from(document.querySelectorAll(optionSelector)).find(
        (element) => {
          return (
            isVisible(element) &&
            !isExcluded(element) &&
            matchesModel(element) &&
            !isSubmenuTrigger(element)
          );
        },
      );

      if (!(fallbackOption instanceof HTMLElement)) {
        return false;
      }

      fallbackOption.click();
      return true;
    },
    {
      modelLabel: normalizeModelLabel(model),
      optionSelector: SELECTORS.modelOption,
      scopeSelectors: [...MODEL_OPTION_SCOPE_SELECTORS],
      excludedSelector: SELECTORS.modelPicker,
    },
  );
}

/**
 * Dismiss ChatGPT onboarding modals, cookie banners, and other overlays
 * that can block the composer input. Fails silently if no overlays are present.
 */
async function dismissOverlays(page: Page): Promise<void> {
  const overlaySelectors = [
    // Login/signup modal that blocks all pointer events
    '#modal-no-auth-login button:has-text("Stay logged out")',
    '#modal-no-auth-login button:has-text("Continue without login")',
    '#modal-no-auth-login button:has-text("Not now")',
    '#modal-no-auth-login button[aria-label="Close"]',
    // Onboarding modal skip/dismiss buttons
    '#modal-onboarding button:has-text("Skip")',
    '#modal-onboarding button:has-text("Next")',
    '#modal-onboarding button:has-text("Okay")',
    '#modal-onboarding button:has-text("Got it")',
    '#modal-onboarding button:has-text("Done")',
    '[data-testid="onboarding-skip"]',
    // Generic dialog dismiss
    'dialog button:has-text("Dismiss")',
    'dialog button:has-text("Close")',
    '[role="dialog"] button[aria-label="Close"]',
    // Cookie consent
    'button:has-text("Decline optional cookies")',
    'button:has-text("Accept all")',
    // "Stay logged out" prompt
    'button:has-text("Stay logged out")',
  ];

  for (const selector of overlaySelectors) {
    try {
      const btn = page.locator(selector).first();
      if (await btn.isVisible().catch(() => false)) {
        await btn.click({ force: true });
        await page.waitForTimeout(300);
      }
    } catch {
      // Ignore — overlay may not exist
    }
  }

  const noAuthModal = page.locator('#modal-no-auth-login').first();
  if (await noAuthModal.isVisible().catch(() => false)) {
    await page.keyboard.press('Escape').catch(() => {});
    await page.waitForTimeout(300);
  }

  // Last-resort cleanup: sometimes ChatGPT leaves the no-auth modal mounted
  // even though the authenticated composer is visible underneath. In that
  // case, the overlay keeps intercepting clicks for image/chat submission.
  const modalStillVisible = await noAuthModal.isVisible().catch(() => false);
  if (modalStillVisible) {
    const removed = await page.evaluate((composerSelector: string) => {
      const isVisible = (element: Element | null): element is HTMLElement => {
        if (!(element instanceof HTMLElement)) return false;
        if (element.hidden) return false;
        const style = window.getComputedStyle(element);
        if (style.display === 'none' || style.visibility === 'hidden') return false;
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      };

      const composerVisible = Array.from(document.querySelectorAll(composerSelector)).some(
        isVisible,
      );
      if (!composerVisible) return false;

      const modal = document.querySelector('#modal-no-auth-login');
      if (!(modal instanceof HTMLElement)) return false;
      modal.remove();
      return true;
    }, SELECTORS.composer);

    if (removed) {
      await page.waitForTimeout(150);
    }
  }
}

/**
 * Is the context window of the chat exhausted?
 *
 * The app shows a banner ("Context window full") with a "New chat" button
 * that continues the conversation in a new chat with an automatic summary.
 */
async function detectContextFull(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    for (const button of Array.from(document.querySelectorAll('button'))) {
      const label = (button.innerText || button.getAttribute('aria-label') || '').trim();
      if (!/^new chat$/i.test(label)) continue;
      const rect = button.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) continue;

      let node: HTMLElement | null = button.parentElement;
      while (node) {
        if (/context window full/i.test(node.innerText || '')) return true;
        node = node.parentElement;
      }
    }
    return false;
  });
}

/**
 * Click the "New chat" button of the "Context window full" banner.
 *
 * The app has several "New chat" buttons: the one of the sidebar, a hidden
 * variant of it, and the one of the banner. The button of the banner is the
 * one whose nearest ancestor with the text "Context window full" is the
 * closest one — the sidebar button finds that text only in the body, many
 * levels up.
 */
async function clickContextFullNewChat(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    let best: { button: HTMLElement; depth: number } | null = null;

    for (const button of Array.from(document.querySelectorAll('button'))) {
      const label = (button.innerText || button.getAttribute('aria-label') || '').trim();
      if (!/^new chat$/i.test(label)) continue;
      const rect = button.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) continue;

      let depth = 0;
      let found = -1;
      let node: HTMLElement | null = button.parentElement;
      while (node) {
        depth++;
        if (/context window full/i.test(node.innerText || '')) {
          found = depth;
          break;
        }
        node = node.parentElement;
      }
      if (found < 0) continue;
      if (!best || found < best.depth) best = { button, depth: found };
    }

    if (!best) return false;
    best.button.click();
    return true;
  });
}

/**
 * Continue the conversation in a new chat with an automatic summary.
 *
 * This is the native mechanism of the app for an exhausted context window:
 * the new chat starts with "Continued from <old chat>" and a summary of it,
 * so the work goes on instead of dying at the context limit.
 */
async function startSummaryChat(page: Page): Promise<boolean> {
  const clicked = await clickContextFullNewChat(page);
  if (!clicked) return false;

  // Wait until the banner is gone and the composer of the new chat is back.
  for (let attempt = 0; attempt < 30; attempt++) {
    await page.waitForTimeout(500);
    const ready = await page.evaluate(() => {
      const banner = /context window full/i.test(document.body?.innerText || '');
      const composer = Array.from(
        document.querySelectorAll('div.ProseMirror[contenteditable="true"], textarea'),
      ).some((element) => {
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      });
      return !banner && composer;
    });
    if (ready) break;
  }

  return true;
}

export const chatgptActions: ProviderActions = {
  async contextWindowFull(page: Page): Promise<boolean> {
    return detectContextFull(page);
  },

  async continueInNewChat(page: Page): Promise<boolean> {
    return startSummaryChat(page);
  },

  async newChat(page: Page): Promise<void> {
    const debug = process.env.TEN_X_CHAT_DEBUG_NEWCHAT === '1';
    const log = (...args: unknown[]): void => {
      if (debug) console.error('[newchat]', ...args);
    };

    // `?new=1` asks the app for a blank chat even when the base URL would
    // restore the last conversation. The unique parameter forces a document
    // navigation instead of an in-app route change.
    await page
      .goto(`https://chatgpt.com/?new=1&t=${Date.now()}`, { waitUntil: 'domcontentloaded' })
      .catch(() => {});
    // Let the app settle: it can restore the last conversation after the
    // initial DOM is ready, even when the URL is already `/`.
    await page.waitForTimeout(5_000);
    await dismissOverlays(page);

    // A restored conversation can keep the URL at `/`, so the URL alone is not
    // enough: the assistant turns must be gone too.
    const isFresh = async (): Promise<boolean> =>
      conversationIdFromUrl('chatgpt', page.url()) === undefined &&
      (await getAssistantTurnCount(page)) === 0;

    if (debug) log('after goto', page.url(), 'fresh', await isFresh());
    if (await isFresh()) return;

    // Fallback: the "New chat" control is both in the sidebar and in the mobile
    // toolbar. Do not use `:visible` — the shared daemon does not proxy the
    // Playwright selector engine reliably. Iterate the buttons instead.
    const buttons = page.locator('button[aria-label="New chat"]');
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const count = await buttons.count().catch(() => 0);
      log('buttons', count);
      for (let index = 0; index < count; index++) {
        const candidate = buttons.nth(index);
        if (!(await candidate.isVisible().catch(() => false))) continue;
        log('click', index);
        await candidate.click({ force: true }).catch(() => {});
        await page.waitForTimeout(1_000);
        const fresh = await isFresh();
        log('after click', page.url(), 'fresh', fresh);
        if (fresh) return;
      }
      await page.waitForTimeout(500);
    }
  },

  async selectModel(page: Page, model: string): Promise<void> {
    await dismissOverlays(page);

    // The new UI (and the free plan) has no model picker at all. Probe briefly
    // and keep the account's current model instead of waiting on the old one.
    if (!(await waitForModelUi(page))) return;

    for (const targetModel of resolveChatGPTModelLabels(model)) {
      // Current ChatGPT UI shows the thinking/model level as a composer pill near Send.
      const composerPill = page.locator(MODEL_PILL_SELECTOR).first();
      await composerPill.waitFor({ state: 'visible', timeout: 2_000 }).catch(() => {});
      if (await composerPill.isVisible().catch(() => false)) {
        const current = (await composerPill.textContent().catch(() => '')) ?? '';
        if (normalizeModelLabel(current) === normalizeModelLabel(targetModel)) continue;
        await composerPill.click({ force: true }).catch(() => {});
        await page.waitForTimeout(750);
        if (isChatGPTFamilyLabel(targetModel)) {
          await page
            .locator('[role="menuitem"][aria-haspopup="menu"]:has-text("GPT-5")')
            .first()
            .hover()
            .catch(() => {});
          await page.waitForTimeout(500);
        }
        const option = page
          .locator(
            `[role="menuitemradio"]:has-text("${targetModel}"), [role="option"]:has-text("${targetModel}"), button:has-text("${targetModel}")`,
          )
          .first();
        if (await option.isVisible().catch(() => false)) {
          await option.click({ force: true });
          await page.waitForTimeout(500);
          continue;
        }
        await page.keyboard.press('Escape').catch(() => {});
      }

      await page
        .locator(SELECTORS.modelPicker)
        .first()
        .waitFor({ state: 'visible', timeout: 2_000 })
        .catch(() => {});
      await page.waitForTimeout(500);
      const picker = await getVisibleModelPickerState(page);
      if (!picker.found) {
        console.warn(
          `ChatGPT model picker not found — skipping model selection for "${targetModel}"`,
        );
        return;
      }

      if (normalizeModelLabel(picker.text) === normalizeModelLabel(targetModel)) {
        continue;
      }

      const pickerClicked = await page.evaluate((sel: string) => {
        const visible = (el: Element): el is HTMLElement => {
          if (!(el instanceof HTMLElement)) return false;
          const rect = el.getBoundingClientRect();
          const style = getComputedStyle(el);
          return rect.width > 0 && rect.height > 0 && style.display !== 'none';
        };
        const button = Array.from(document.querySelectorAll(sel)).find(visible);
        button?.click();
        return Boolean(button);
      }, SELECTORS.modelPicker);
      if (!pickerClicked) return;
      await page.waitForTimeout(750);

      if (isChatGPTFamilyLabel(targetModel)) {
        await page
          .locator('[role="menuitem"][aria-haspopup="menu"]:has-text("GPT-5")')
          .first()
          .hover()
          .catch(() => {});
        await page.waitForTimeout(500);
      }
      const optionClicked = await clickVisibleModelOption(page, targetModel);
      if (!optionClicked) {
        console.warn(`Model "${targetModel}" not found in ChatGPT picker — using current model`);
        await page.keyboard.press('Escape').catch(() => {});
        return;
      }

      await page.waitForTimeout(500);
    }
  },

  async isLoggedIn(page: Page): Promise<boolean> {
    // Detect a bot challenge before anything else.
    // The orchestrator offers the user to solve it in the visible window.
    if (await isChallengeVisible(page)) {
      throw new AntibotChallengeError();
    }

    try {
      // Wait for either composer or login indicators to appear
      await page
        .locator(`${SELECTORS.composer}, ${SELECTORS.loginPage}`)
        .first()
        .waitFor({ state: 'visible', timeout: 8_000 })
        .catch(() => {});

      // Re-check for the challenge after the wait (page may have navigated)
      if (await isChallengeVisible(page)) {
        throw new AntibotChallengeError();
      }

      // Dismiss any overlays that might be hiding the composer
      await dismissOverlays(page);

      const composerVisible = await page.evaluate((sel: string) => {
        const bodyText = document.body?.innerText ?? '';
        if (/welcome back/i.test(bodyText) && /choose an account to continue/i.test(bodyText)) {
          return false;
        }

        const els = document.querySelectorAll(sel);
        for (let i = 0; i < els.length; i++) {
          const el = els[i];
          if (el instanceof HTMLElement && el.offsetWidth > 0 && el.offsetHeight > 0) return true;
        }
        return false;
      }, SELECTORS.composer);
      if (composerVisible) return true;

      const loginVisible = await page
        .locator(SELECTORS.loginPage)
        .first()
        .isVisible()
        .catch(() => false);
      if (loginVisible) return false;

      return false;
    } catch (err) {
      // Re-throw the challenge so the orchestrator can surface it
      if (err instanceof AntibotChallengeError) throw err;
      return false;
    }
  },

  async attachFiles(page: Page, filePaths: string[]): Promise<void> {
    // Upload after text entry; clearing ProseMirror before typing can delete attachment chips.
    chatgptPendingFiles.set(page, filePaths);
  },

  async submitPrompt(page: Page, prompt: string): Promise<void> {
    // Dismiss onboarding/welcome modals that block the composer
    await dismissOverlays(page);
    const snapshot = await getLatestAssistantSnapshot(page);
    chatgptSubmitBaseline.set(page, {
      turnCount: await getAssistantTurnCount(page),
      // An existing conversation already has an assistant response. Without
      // this baseline the capture would treat the old answer as the new one.
      bodies: snapshot.bodies.map((body) => body.text),
      latestText: snapshot.bodies
        .map((body) => body.text)
        .join('\n\n')
        .trim(),
      // An error banner can outlive the run that showed it; only a new one
      // belongs to this answer.
      errorText: snapshot.errorText,
      url: page.url(),
    });

    // ponytail: ChatGPT shows the composer before ProseMirror is actually ready under Xvfb.
    await page.waitForTimeout(3_000);
    const pendingFiles = chatgptPendingFiles.get(page) ?? [];
    await submitPromptToComposer(page, prompt, {
      composerSelector: SELECTORS.composer,
      sendButtonSelector: SELECTORS.sendButton,
      submit: pendingFiles.length === 0,
    });

    if (pendingFiles.length > 0) {
      await page.locator(SELECTORS.fileInput).first().setInputFiles(pendingFiles);
      // ponytail: large ZIPs need time to become sendable; wait for upload UI to settle.
      await page.waitForTimeout(10_000);
      await page
        .waitForFunction(
          () => !/uploading|processing file|preparing file/i.test(document.body?.innerText || ''),
          { timeout: 120_000 },
        )
        .catch(() => {});
      await clickSendButton(page, SELECTORS.sendButton);
      chatgptPendingFiles.delete(page);
    }
  },

  async captureResponse(
    page: Page,
    opts: { timeoutMs: number; onChunk?: (chunk: string) => void },
  ): Promise<CapturedResponse> {
    const { timeoutMs, onChunk } = opts;

    // While the answer is generated the composer shows a Stop button. The
    // assistant node can hold a short activity label ("Reviewed potential
    // bugs") for a long time before the text streams in, so a stable label
    // must never end the capture. Do not use `:visible` in the selector — the
    // shared daemon does not proxy the Playwright selector engine reliably.
    const isGenerating = async (): Promise<boolean> => {
      const stops = page.locator(SELECTORS.stopButton);
      const count = await stops.count().catch(() => 0);
      for (let index = 0; index < count; index++) {
        if (
          await stops
            .nth(index)
            .isVisible()
            .catch(() => false)
        )
          return true;
      }
      return false;
    };
    const startTime = Date.now();
    const baseline = chatgptSubmitBaseline.get(page) ?? {
      turnCount: await getAssistantTurnCount(page),
      bodies: [] as string[],
      latestText: '',
      errorText: '',
      url: page.url(),
    };

    // ponytail: direct text polling beats ChatGPT's constantly shifting turn DOM.
    let lastText = baseline.latestText;
    let emittedText = '';
    let stableCount = 0;
    let activityPolls = 0;
    let truncated = true;
    while (Date.now() - startTime < timeoutMs) {
      const snapshot = await getLatestAssistantSnapshot(page);
      const bodies = newAssistantBodies(baseline.bodies, snapshot.bodies);
      const text = bodies
        .map((body) => body.text)
        .join('\n\n')
        .trim();

      // The previous turn's answer is still in the DOM; only an error that is
      // new since the prompt belongs to this run.
      const generationError = generationErrorOf({ text, errorText: snapshot.errorText }, baseline);
      if (generationError) {
        throw new ProviderGenerationError(
          `ChatGPT reported an error while generating the answer: ${generationError}`,
        );
      }

      const streaming = await isGenerating();
      const activity = ACTIVITY_TEXT.test(text);

      if (bodies.length > 0 && text !== baseline.latestText) {
        if (text !== emittedText) {
          onChunk?.(
            emittedText && text.startsWith(emittedText) ? text.slice(emittedText.length) : text,
          );
          emittedText = text;
        }

        if (text === lastText && !streaming) {
          if (activity) {
            // A real label is followed by the answer when the generation ends;
            // a short answer that only looks like a label is accepted after
            // the grace window instead of waiting for the whole timeout.
            activityPolls++;
            if (activityPolls >= ACTIVITY_GRACE_POLLS) {
              truncated = false;
              break;
            }
            stableCount = 0;
          } else {
            activityPolls = 0;
            stableCount++;
            if (stableCount >= 3) {
              truncated = false;
              break;
            }
          }
        } else {
          stableCount = 0;
          activityPolls = 0;
        }
        lastText = text;
      }

      await page.waitForTimeout(1000);
    }

    if (!lastText || lastText === baseline.latestText) {
      throw new Error('Timed out waiting for ChatGPT assistant response');
    }

    // Extract the final HTML content using page.evaluate instead of locator.textContent/innerHTML.
    // ChatGPT's current UI exposes the nodes, but daemon-proxied locator text extraction can still
    // time out on them even after they are present in the DOM.
    const finalSnapshot = await getLatestAssistantSnapshot(page);
    const finalBodies = newAssistantBodies(baseline.bodies, finalSnapshot.bodies);
    const markdown =
      finalBodies.length > 0
        ? finalBodies.map((body) => body.html).join('\n\n')
        : finalSnapshot.bodies.map((body) => body.html).join('\n\n');

    // Extract generated images (DALL-E / GPT-Image)
    // ChatGPT uses alt="Generated image: <description>" and src containing
    // backend-api/estuary/content with file IDs.
    const images: GeneratedImage[] = await page.evaluate(() => {
      const seen = new Set<string>();
      const results: { url: string; alt: string; width: number; height: number }[] = [];
      const imgs = Array.from(
        document.querySelectorAll('img[alt^="Generated image"], img[src*="estuary/content"]'),
      );
      for (const img of imgs) {
        const src = img.getAttribute('src') ?? '';
        const alt = img.getAttribute('alt') ?? '';
        const w = (img as HTMLImageElement).naturalWidth;
        const h = (img as HTMLImageElement).naturalHeight;
        // Skip small icons/avatars and profile images
        if (w > 0 && w < 128 && h > 0 && h < 128) continue;
        if (alt === 'Profile image') continue;
        // Deduplicate by file ID in the URL
        const idMatch = src.match(/[?&]id=([^&]+)/);
        const key = idMatch ? idMatch[1] : src;
        if (!key || seen.has(key)) continue;
        seen.add(key);
        results.push({ url: src, alt, width: w, height: h });
      }
      return results;
    });

    const elapsed = Date.now() - startTime;

    return {
      text: lastText,
      markdown,
      truncated,
      thinkingTime: Math.round(elapsed / 1000),
      ...(images.length > 0 ? { images } : {}),
    };
  },
};
