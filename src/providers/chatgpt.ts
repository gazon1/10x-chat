import type { Page } from 'playwright';
import { conversationIdFromUrl } from '../core/conversations.js';
import {
  AntibotChallengeError,
  ContextWindowFullError,
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
    /**
     * The number of the messages of the user when the prompt was sent: a
     * message that appears later is the prompt of this run.
     */
    userCount: number;
    /** The flat text of the last message of the user when the prompt was sent. */
    lastUserText: string;
    /**
     * The pieces of the prompt that must be in the DOM when it has landed.
     * The chat collapses its history, so the number of the messages of the
     * user is not a reliable sign that the prompt is there.
     */
    markers: string[];
    /** The prompt of this run: the message of the user must not be taken
     * for the answer. */
    promptText: string;
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

/** The message of the user. */
const USER_MESSAGE_SELECTORS = '[data-message-author-role="user"], [data-conversation-role="user"]';

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
  /** The text of the last message of the user. */
  lastUserText: string;
  /**
   * The bodies come from the fallback of the snapshot: the last visible match
   * of the page, not the body of the message of the assistant. While the
   * answer is still rendering it is a label of the thinking UI.
   */
  viaFallback: boolean;
  /**
   * The bodies belong to the turn of the prompt of this run: the message of
   * the user that holds the prompt has landed, and the answer follows it.
   *
   * Then they are the answer of this run, even when their text is the same
   * as the text of the answer of the previous turn: the difference is not
   * visible in the text.
   */
  scoped: boolean;
  /** The message of the user that holds the prompt of this run. */
  promptMatched: boolean;
  /** The number of the messages of the user in the chat. */
  userCount: number;
  /** The number of the turns of the assistant in the chat. */
  turnCount: number;
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
 * The pieces of the prompt that must be in the DOM when it has landed.
 *
 * The chat collapses its history ("Show more"), so the number of the messages
 * of the user is not a reliable sign. The text of the message of the user is:
 * the tail of the prompt is in the DOM even when the message is collapsed.
 *
 * The list is never empty for a prompt that has text: an empty list would
 * mean "the prompt has landed" for every prompt, and the answer of the
 * previous turn would be taken for the answer of this run.
 */
function promptMarkers(prompt: string): string[] {
  const flat = prompt.replace(/\s+/g, '').toLowerCase();
  if (!flat) return [];
  const markers: string[] = [];
  const tail = flat.slice(-60);
  if (tail.length >= 20) markers.push(tail);
  const middle = flat.slice(Math.floor(flat.length / 2), Math.floor(flat.length / 2) + 60);
  if (middle.length >= 20) markers.push(middle);
  // A short prompt has no long piece: its whole text is the marker.
  if (markers.length === 0) markers.push(flat);
  return markers;
}

/** The text without its whitespace and in lower case. */
function flatText(value: string): string {
  return value.replace(/\s+/g, '').toLowerCase();
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
 * How many polls pass between two checks of the context window.
 *
 * The banner is read from the page: a check on every poll would cost an
 * evaluation per second for nothing.
 */
const CONTEXT_CHECK_POLLS = 5;

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
 *
 * The snapshot is scoped to the prompt of this run: the bodies are the ones
 * that follow the message of the user that holds the prompt. The caller needs
 * to know that the prompt has landed — until then the answer of the previous
 * turn is still in the DOM.
 */
async function getLatestAssistantSnapshot(
  page: Page,
  opts: {
    asked?: string;
    markers?: string[];
    baselineUserCount?: number;
    baselineLastUserText?: string;
  } = {},
): Promise<AssistantSnapshot> {
  const asked = flatText(opts.asked ?? '');
  const markers = opts.markers ?? [];
  const baselineUserCount = opts.baselineUserCount ?? 0;
  const baselineLastUserText = flatText(opts.baselineLastUserText ?? '');
  return page.evaluate(
    ({
      bodySelectors,
      fallbackSelectors,
      messageSelectors,
      userSelectors,
      turnSelectors,
      asked,
      markers,
      baselineUserCount,
      baselineLastUserText,
    }) => {
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

      const flatOf = (value: string): string => value.replace(/\s+/g, '').toLowerCase();

      // The text of a message of the user: the label of the message ("You
      // said:") is not a part of the prompt.
      const userTextOf = (element: Element): string => {
        const own = textOf(element);
        const parent = element.parentElement ? textOf(element.parentElement) : '';
        return flatOf(parent.length > own.length ? parent : own);
      };

      /**
       * Whether the message of the user holds the prompt of this run.
       *
       * The match is positive: a short prompt must be the whole message, and
       * a long one is recognized by a piece of it — the chat shows the tail
       * of the message even when the history is collapsed.
       */
      const holdsPrompt = (element: Element): boolean => {
        if (!asked) return false;
        const text = userTextOf(element);
        if (!text) return false;
        if (asked.length < 20) {
          return text.replace(/^yousaid:/, '') === asked;
        }
        return markers.some((marker) => text.includes(marker));
      };

      const groups = new Map<Element, { text: string; html: string; element: Element }>();

      // The messages of the user: the answer of this run is what follows the
      // one that holds the prompt.
      const userTurns = Array.from(document.querySelectorAll(userSelectors));
      const lastUserTurn = userTurns.length > 0 ? userTurns[userTurns.length - 1] : null;
      // The text of the last message of the user.
      const lastUserText = lastUserTurn
        ? (
            ((lastUserTurn.parentElement as HTMLElement)?.innerText ??
              lastUserTurn.textContent ??
              '') as string
          ).slice(-800)
        : '';

      // The message of the user that holds the prompt of this run: the last
      // one that holds it — the same prompt can be in the chat twice.
      let promptTurn: Element | null = null;
      for (const turn of userTurns) {
        if (holdsPrompt(turn)) promptTurn = turn;
      }
      // The prompt has landed: a new message of the user appeared, and it is
      // the one that holds the prompt. The text of the message is the sign:
      // the chat collapses its history, so the number of the messages of the
      // user is not a reliable one.
      const newUserTurn =
        userTurns.length > baselineUserCount || flatOf(lastUserText) !== baselineLastUserText;
      const landed = asked
        ? newUserTurn && promptTurn !== null && promptTurn === lastUserTurn
        : lastUserTurn !== null;
      // The bodies of the answer of this run are the ones after the prompt.
      const anchor = landed && promptTurn ? promptTurn : lastUserTurn;

      // The turns of the assistant in the chat: a new one means that the
      // assistant has answered.
      const turnElements = new Set<Element>();
      for (const selector of turnSelectors) {
        for (const element of Array.from(document.querySelectorAll(selector))) {
          if (element.closest(userSelectors)) continue;
          turnElements.add(element);
        }
      }
      const turnRoots = new Set<Element>();
      for (const element of turnElements) {
        let node = element.parentElement;
        let root = element;
        while (node) {
          if (turnElements.has(node)) root = node;
          node = node.parentElement;
        }
        turnRoots.add(root);
      }
      const turnCount = turnRoots.size;

      // Every body element of the page, no matter which selector found it.
      const matched = new Set<Element>();
      for (const selector of bodySelectors) {
        for (const element of Array.from(document.querySelectorAll(selector))) {
          matched.add(element);
        }
      }

      // The body of one message is nested in several elements that carry the
      // same text (`data-dil-response` > `assistant-message` > `response-body`).
      // The current UI has no container of its own, so without this the message
      // would be counted once per element and the answer would repeat.
      const outermostMatched = (element: Element): Element => {
        let node = element.parentElement;
        let outermost: Element | null = null;
        while (node) {
          if (matched.has(node)) outermost = node;
          node = node.parentElement;
        }
        return outermost ?? element;
      };

      for (const element of matched) {
        if (element.closest(userSelectors)) continue;
        const text = textOf(element);
        if (!text) continue;
        const container = element.closest(messageSelectors.join(',')) ?? outermostMatched(element);
        const known = groups.get(container);
        if (!known || text.length > known.text.length) {
          groups.set(container, { text, html: element.innerHTML || '', element });
        }
      }

      const sorted = Array.from(groups.values()).sort((a, b) =>
        a.element.compareDocumentPosition(b.element) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1,
      );

      // The renderer of a message can nest the body of the message in several
      // elements, and it can render the same message twice while it streams.
      // The text of such a body is contained in the text of the bigger one —
      // keep the biggest one, or the answer repeats.
      const normalize = (value: string): string => value.replace(/\s+/g, ' ').trim();
      const withoutDuplicates = (
        list: { text: string; html: string }[],
      ): { text: string; html: string }[] =>
        list.filter((body, index) => {
          const text = normalize(body.text);
          if (!text) return false;
          return !list.some(
            (other, otherIndex) =>
              otherIndex !== index &&
              normalize(other.text).length > text.length &&
              normalize(other.text).includes(text),
          );
        });

      // Only the messages after the prompt belong to the answer of this run.
      const afterAnchor = anchor
        ? sorted.filter(
            (group) =>
              anchor.compareDocumentPosition(group.element) & Node.DOCUMENT_POSITION_FOLLOWING,
          )
        : sorted;
      const bodies = withoutDuplicates(afterAnchor.map(({ text, html }) => ({ text, html })));

      if (bodies.length > 0) {
        // The bodies were taken from the messages after the prompt of this
        // run: they are the answer of this turn.
        return {
          found: true,
          bodies,
          errorText,
          lastUserText,
          viaFallback: false,
          scoped: landed,
          promptMatched: promptTurn !== null,
          userCount: userTurns.length,
          turnCount,
        };
      }

      // Fallback for the other UI variants: the last visible match.
      for (const selector of fallbackSelectors) {
        const matches = Array.from(document.querySelectorAll(selector));
        if (matches.length === 0) continue;
        // The answer of this turn is after the prompt. If there is one, the
        // fallback is scoped to it — the answer of the previous turn must not
        // be taken for the answer of this run.
        const afterPrompt = anchor
          ? matches.filter(
              (element) =>
                anchor.compareDocumentPosition(element) & Node.DOCUMENT_POSITION_FOLLOWING,
            )
          : [];
        const scoped = landed && afterPrompt.length > 0;
        const candidates = afterPrompt.length > 0 ? afterPrompt : matches;
        const visibleMatches = candidates.filter(isVisible);
        const last = (visibleMatches.length > 0 ? visibleMatches : candidates).at(-1);
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
          lastUserText,
          viaFallback: true,
          scoped,
          promptMatched: promptTurn !== null,
          userCount: userTurns.length,
          turnCount,
        };
      }

      return {
        found: false,
        bodies: [],
        errorText,
        lastUserText,
        viaFallback: true,
        scoped: false,
        promptMatched: promptTurn !== null,
        userCount: userTurns.length,
        turnCount,
      };
    },
    {
      bodySelectors: [...ASSISTANT_BODY_SELECTORS],
      fallbackSelectors: [...ASSISTANT_CONTENT_FALLBACK_SELECTORS],
      messageSelectors: [...MESSAGE_CONTAINER_SELECTORS],
      userSelectors: USER_MESSAGE_SELECTORS,
      turnSelectors: [...ASSISTANT_TURN_COUNT_SELECTORS],
      asked,
      markers,
      baselineUserCount,
      baselineLastUserText,
    },
  );
}

/** The length of the common beginning of two texts. */
function commonPrefixLength(left: string, right: string): number {
  const limit = Math.min(left.length, right.length);
  let index = 0;
  while (index < limit && left[index] === right[index]) index++;
  return index;
}

/**
 * The message of the user is rendered in the same elements as the answer:
 * the current UI puts the text of the prompt into a markdown root of its
 * own. A body that is a part of the prompt is the message of the user, not
 * the answer of the assistant.
 */
function isPromptEcho(text: string, prompt: string): boolean {
  const flat = (value: string): string => value.replace(/\s+/g, '').toLowerCase();
  const body = flat(text);
  const asked = flat(prompt);
  if (body.length < 40 || !asked) return false;
  return asked.includes(body);
}

/**
 * The assistant messages that are new since the baseline.
 *
 * The old messages of a reused chat stay in the DOM: the answer of this run
 * is everything after them. The transcript can also be re-rendered, which
 * loses the old messages — then the last old message that is still there
 * marks the start of the new ones.
 *
 * A scoped snapshot holds the messages of the turn of the user only, so it
 * needs no comparison with the baseline: the answer of this run can have the
 * same text as the answer of the previous turn, and a comparison by text
 * would drop it.
 */
function newAssistantBodies(
  baseline: string[],
  current: AssistantBody[],
  scoped = false,
): AssistantBody[] {
  if (scoped) return current;
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
  const state = await page.evaluate(readContinuationDomState, continuationDomOptions());
  return state.bannerPresent;
}

/**
 * Click the "New chat" button of the "Context window full" banner.
 *
 * The button is the one the banner check has found — its index among the
 * buttons of the page. The button of the sidebar is not a candidate: the
 * banner box holds the words of the banner and does not hold the
 * conversation, the sidebar button finds those words only in the body of the
 * app, many levels up.
 */
async function clickContextFullNewChat(page: Page, index: number): Promise<boolean> {
  return page.evaluate((position: number) => {
    const button = document.querySelectorAll('button')[position] as HTMLElement | undefined;
    if (!button) return false;
    button.click();
    return true;
  }, index);
}

/**
 * The words of the banner of the exhausted context window.
 */
const CONTEXT_FULL_PATTERN = 'context window full';

/**
 * The label of the button that continues the chat in a new one.
 */
const NEW_CHAT_LABEL_PATTERN = '^new chat$';

/**
 * The longest text a box without a conversation may have to be the banner.
 *
 * The words of the banner are in the body of the app as well — the summary of
 * a continuation can mention the exhausted window itself. When the app has
 * no container of the conversation, only a short box can be the banner: the
 * text around it is the whole app.
 */
const BANNER_MAX_TEXT = 400;

/**
 * The words the app uses when it continues an exhausted conversation in a new
 * chat: "Continued from …", a summary of the old chat, and so on.
 */
const CONTINUATION_MARKER_PATTERN =
  'continued from|previous conversation|earlier conversation|summary|контекст|продолж';

/**
 * The container of the conversation.
 *
 * The marker of the continuation is read from it: the navigation of the app
 * holds the titles of the old conversations, and one of them can carry the
 * word "summary" — a chat that was never continued would look like one.
 */
const CONTINUATION_SCOPE_SELECTOR = 'main, #thread, [role="main"]';

/** The navigation of the app: the sidebar with the list of the conversations. */
const NAVIGATION_SELECTOR = 'nav, aside, [role="navigation"], [data-testid*="sidebar" i]';

/**
 * Does the text hold a sign that the native continuation has happened?
 */
export function hasContinuationMarker(text: string): boolean {
  return new RegExp(CONTINUATION_MARKER_PATTERN, 'i').test(text);
}

/**
 * Does the URL point to a conversation other than the one before the click?
 *
 * The id in the URL is the only proof of the identity of the conversation: the
 * number of the turns can change because the UI re-rendered or because the
 * summary was inserted into the old chat. A URL without an id proves nothing
 * — the landing page can still show the old conversation.
 */
export function conversationIdChanged(
  beforeId: string | undefined,
  afterId: string | undefined,
): boolean {
  return afterId !== undefined && afterId !== beforeId;
}

/**
 * Was the conversation replaced by another one?
 *
 * The summary of the old chat is the sign of the native continuation. Without
 * it the structural sign is used: the new chat shows fewer turns than the
 * exhausted one and has at least one turn of its own — that is not the old
 * conversation.
 */
export function conversationReplaced(
  beforeTurns: number,
  afterTurns: number,
  hasSummaryMarker: boolean,
): boolean {
  if (hasSummaryMarker) return true;
  return afterTurns > 0 && afterTurns < beforeTurns;
}

/**
 * The signals of a finished transition into the new chat.
 */
export interface ContinuationSignals {
  /** The banner of the exhausted context window is gone. */
  bannerGone: boolean;
  /** The composer of the new chat is visible and can be typed into. */
  composerUsable: boolean;
  /** The URL points to a conversation other than the one before the click. */
  conversationChanged: boolean;
  /** The new chat shows the continuation of the exhausted one. */
  continuationSignal: boolean;
  /** The exhausted conversation is no longer on the screen. */
  oldConversationGone: boolean;
}

/**
 * Is the continuation ready to be used?
 *
 * Every signal is required: the orchestrator sends the prompt of the run into
 * the chat that the transition leaves behind, and a guess would write it into
 * the exhausted conversation.
 */
export function continuationReady(signals: ContinuationSignals): boolean {
  return (
    signals.bannerGone &&
    signals.composerUsable &&
    signals.conversationChanged &&
    signals.continuationSignal &&
    signals.oldConversationGone
  );
}

/** The state of the page that the continuation is judged by. */
export interface ContinuationDomState {
  /** The banner of the exhausted context window is on the screen. */
  bannerPresent: boolean;
  /**
   * The index of the "New chat" button of the banner among the buttons of the
   * page, or -1 when there is no banner.
   */
  newChatButtonIndex: number;
  /** The composer of the new chat is visible and can be typed into. */
  composerUsable: boolean;
  /** The conversation shows the continuation of the exhausted one. */
  summaryMarker: boolean;
  /** The exhausted conversation is no longer on the screen. */
  oldConversationGone: boolean;
}

/**
 * The selectors of the continuation check.
 *
 * The scope is the conversation itself, the navigation is the sidebar with the
 * list of the conversations: a title there can carry the word "summary" and
 * make the marker look present in a chat that was never continued.
 */
export interface ContinuationDomOptions {
  /** The pattern of the marker of the continuation. */
  markerPattern: string;
  /** The selector of the container of the conversation. */
  scopeSelector: string;
  /** The selector of the navigation of the app. */
  navigationSelector: string;
  /** The pattern of the words of the banner of the exhausted window. */
  bannerPattern: string;
  /** The pattern of the label of the button of the banner. */
  newChatLabel: string;
  /** The longest text a box without a conversation may have to be the banner. */
  bannerMaxText: number;
}

/** The options of the check of the continuation. */
function continuationDomOptions(): ContinuationDomOptions {
  return {
    markerPattern: CONTINUATION_MARKER_PATTERN,
    scopeSelector: CONTINUATION_SCOPE_SELECTOR,
    navigationSelector: NAVIGATION_SELECTOR,
    bannerPattern: CONTEXT_FULL_PATTERN,
    newChatLabel: NEW_CHAT_LABEL_PATTERN,
    bannerMaxText: BANNER_MAX_TEXT,
  };
}

/**
 * Read the state of the page for the continuation.
 *
 * The marker of the continuation is searched in the conversation and nowhere
 * else: the navigation holds the titles of the old conversations, and one of
 * them can carry the word "summary".
 *
 * The banner of the exhausted window is found by its own structure and not by
 * the words of the page: the summary of a continuation can mention the
 * exhausted window, and the body of the app then carries the words of the
 * banner while the banner is long gone. The banner is the box that holds the
 * words and the "New chat" button and does not hold the conversation.
 *
 * The document is an argument so that the check can be run against a fake one
 * in the test; in the browser it is the document of the page.
 */
export function readContinuationDomState(
  options: ContinuationDomOptions,
  doc: Document = document,
): ContinuationDomState {
  const banner = findContextFullBanner(options, doc);

  const composerUsable = Array.from(
    doc.querySelectorAll('div.ProseMirror[contenteditable="true"], textarea'),
  ).some((element) => {
    const rect = element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    if (element.closest('[aria-disabled="true"], [disabled]')) return false;
    const editable =
      element.tagName === 'TEXTAREA' || element.getAttribute('contenteditable') === 'true';
    if (!editable) return false;
    // The composer must not be covered: the overlay of the banner of the
    // exhausted window stays in the DOM for a while.
    const center = doc.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    return center === element || element.contains(center);
  });

  const stale = Array.from(doc.querySelectorAll('[data-10x-exhausted="1"]')).some((element) => {
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  });

  // The text of the conversation: the container of the chat when the app has
  // one, the rest of the page without the navigation otherwise.
  const scope = doc.querySelector(options.scopeSelector) ?? doc.body;
  const parts: string[] = [];
  const walk = (node: Node): void => {
    if (node.nodeType === 3) {
      parts.push(node.textContent || '');
      return;
    }
    if (node.nodeType === 1 && (node as Element).closest(options.navigationSelector)) return;
    for (const child of Array.from(node.childNodes)) walk(child);
  };
  if (scope) walk(scope);

  return {
    bannerPresent: banner.present,
    newChatButtonIndex: banner.buttonIndex,
    composerUsable,
    summaryMarker: new RegExp(options.markerPattern, 'i').test(parts.join(' ')),
    oldConversationGone: !stale,
  };
}

/**
 * Find the banner of the exhausted context window.
 *
 * The banner is the box that holds the words of the banner and the visible
 * "New chat" button and does not hold the conversation. The button of the
 * sidebar is not the banner: it finds the words of the banner only in the
 * body of the app, and the body holds the conversation.
 */
function findContextFullBanner(
  options: ContinuationDomOptions,
  doc: Document,
): { present: boolean; buttonIndex: number } {
  const conversation = doc.querySelector(options.scopeSelector);
  const buttons = Array.from(doc.querySelectorAll('button'));
  const words = new RegExp(options.bannerPattern, 'i');
  const label = new RegExp(options.newChatLabel, 'i');

  let best: { index: number; depth: number } | null = null;
  for (let index = 0; index < buttons.length; index++) {
    const button = buttons[index];
    const text = (button.innerText || button.getAttribute('aria-label') || '').trim();
    if (!label.test(text)) continue;
    const rect = button.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) continue;

    let depth = 0;
    let node: HTMLElement | null = button.parentElement;
    while (node && node !== doc.body && node !== doc.documentElement) {
      depth++;
      const box = node.innerText || node.textContent || '';
      if (words.test(box)) {
        const holdsConversation = conversation ? node.contains(conversation) : false;
        const short = box.length <= options.bannerMaxText;
        // The box of the banner does not hold the conversation, and it is
        // short: the text around the banner is the whole app, and the words of
        // the banner are in it as well.
        if (!holdsConversation && short) {
          if (!best || depth < best.depth) best = { index, depth };
          break;
        }
      }
      node = node.parentElement;
    }
  }

  return best ? { present: true, buttonIndex: best.index } : { present: false, buttonIndex: -1 };
}

/**
 * Mark the turns of the exhausted conversation.
 *
 * They are the content of the old chat: when the app has really moved into
 * the new chat, they are gone from the screen.
 */
async function markExhaustedConversation(page: Page): Promise<void> {
  await page.evaluate((selectors: readonly string[]) => {
    for (const node of Array.from(document.querySelectorAll('[data-10x-exhausted="1"]'))) {
      node.removeAttribute('data-10x-exhausted');
    }
    for (const selector of selectors) {
      for (const node of Array.from(document.querySelectorAll(selector))) {
        node.setAttribute('data-10x-exhausted', '1');
      }
    }
  }, ASSISTANT_TURN_COUNT_SELECTORS);
}

/**
 * Continue the conversation in a new chat with an automatic summary.
 *
 * This is the native mechanism of the app for an exhausted context window:
 * the new chat starts with "Continued from <old chat>" and a summary of it,
 * so the work goes on instead of dying at the context limit.
 */
async function startSummaryChat(page: Page): Promise<boolean> {
  // The identity of the chat before the click: the continuation must land in
  // a different conversation. The banner disappears before the app has
  // rendered the new chat, so the banner alone proves nothing.
  const beforeId = conversationIdFromUrl('chatgpt', page.url());
  const beforeTurns = await getAssistantTurnCount(page);
  await markExhaustedConversation(page);

  // The button of the banner is found by the same check that judges the state
  // of the page: the banner is a box with the words of the banner and the
  // "New chat" button, and it does not hold the conversation.
  const before = await page.evaluate(readContinuationDomState, continuationDomOptions());
  if (before.newChatButtonIndex < 0) return false;

  const clicked = await clickContextFullNewChat(page, before.newChatButtonIndex);
  if (!clicked) return false;

  // Wait until the transition has really happened: the banner is gone, the
  // composer of the new chat is usable, the URL names another conversation,
  // the new chat holds the continuation of the old one and the exhausted
  // conversation is no longer on the screen.
  let ready = false;
  for (let attempt = 0; attempt < 30; attempt++) {
    await page.waitForTimeout(500);
    const dom: ContinuationDomState = await page.evaluate(
      readContinuationDomState,
      continuationDomOptions(),
    );

    const afterId = conversationIdFromUrl('chatgpt', page.url());
    const afterTurns = await getAssistantTurnCount(page);

    const signals: ContinuationSignals = {
      bannerGone: !dom.bannerPresent,
      composerUsable: dom.composerUsable,
      conversationChanged: conversationIdChanged(beforeId, afterId),
      continuationSignal: conversationReplaced(beforeTurns, afterTurns, dom.summaryMarker),
      oldConversationGone: dom.oldConversationGone,
    };
    if (!continuationReady(signals)) continue;

    ready = true;
    break;
  }

  // The transition did not happen: the caller must not treat the exhausted
  // chat as a fresh one.
  return ready;
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
      turnCount: snapshot.turnCount,
      // The messages of the user before the prompt: a message that appears
      // later is the prompt of this run.
      userCount: snapshot.userCount,
      lastUserText: flatText(snapshot.lastUserText),
      // The pieces of the prompt that must be in the DOM when it has landed.
      markers: promptMarkers(prompt),
      // The message of the user is rendered in the same elements as the
      // answer: the capture must not take it for the answer.
      promptText: prompt,
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
          undefined,
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
      turnCount: 0,
      userCount: 0,
      lastUserText: '',
      // Without a prompt in this process there is no baseline: the gate of
      // the prompt stays off.
      markers: [] as string[],
      promptText: '',
      bodies: [] as string[],
      latestText: '',
      errorText: '',
      url: page.url(),
    };

    // ponytail: direct text polling beats ChatGPT's constantly shifting turn DOM.
    // The text of the last answer of this run: it starts empty, because a
    // scoped snapshot is the answer of this turn even when its text is the
    // text of the answer of the previous turn.
    let lastText = '';
    let lastScoped = false;
    let emittedText = '';
    let stableCount = 0;
    let activityPolls = 0;
    let truncated = true;
    let polls = 0;
    while (Date.now() - startTime < timeoutMs) {
      polls++;
      // The context window can run out while the answer is generated: the
      // banner appears and the answer never comes. The run continues the
      // conversation in a new chat instead of waiting for the timeout.
      if (polls % CONTEXT_CHECK_POLLS === 0) {
        const full = await detectContextFull(page).catch(() => false);
        if (full === true) throw new ContextWindowFullError();
      }
      const snapshot = await getLatestAssistantSnapshot(page, {
        asked: baseline.promptText,
        markers: baseline.markers,
        baselineUserCount: baseline.userCount,
        baselineLastUserText: baseline.lastUserText,
      });
      // The prompt of this run is not in the DOM yet: the answer of the
      // previous turn is still there, and it is not the answer of this run.
      // The gate is positive: an empty marker never means that the prompt
      // has landed.
      const scoped = snapshot.scoped === true;
      // A new turn of the assistant: it has answered the prompt.
      const turnAdvanced = snapshot.turnCount > baseline.turnCount;
      if (baseline.promptText && !scoped && !turnAdvanced) {
        await page.waitForTimeout(1000);
        continue;
      }
      const bodies = newAssistantBodies(baseline.bodies, snapshot.bodies, scoped).filter(
        (body) => !isPromptEcho(body.text, baseline.promptText),
      );
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

      // A scoped snapshot holds the answer of this turn: it is new even when
      // it has the same text as the answer of the previous turn. An unscoped
      // one may still show the answer of the previous turn.
      const fresh =
        bodies.length > 0 && text.length > 0 && (scoped || text !== baseline.latestText);
      if (fresh) {
        if (text !== emittedText && !activity && !snapshot.viaFallback) {
          // The renderer re-creates the message while it streams, so the text
          // can change from the beginning. Emit only what was not emitted yet:
          // the answer must not repeat itself in the stream.
          //
          // A label of the thinking UI ("Reviewed the diff") is not the answer:
          // it is not emitted, and it stays the base of the next delta, so the
          // answer that follows it is emitted whole.
          //
          // The fallback of the snapshot is the last visible match of the
          // page: while the answer is still rendering it is a label of the
          // thinking UI, and the renderer rewrites it. It is not streamed.
          const common = commonPrefixLength(emittedText, text);
          if (text.length > common) onChunk?.(text.slice(common));
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
        lastScoped = scoped;
      }

      await page.waitForTimeout(1000);
    }

    // A scoped answer is the answer of this turn, even when it has the same
    // text as the answer of the previous turn.
    if (!lastText || (!lastScoped && lastText === baseline.latestText)) {
      throw new Error('Timed out waiting for ChatGPT assistant response');
    }

    // Extract the final HTML content using page.evaluate instead of locator.textContent/innerHTML.
    // ChatGPT's current UI exposes the nodes, but daemon-proxied locator text extraction can still
    // time out on them even after they are present in the DOM.
    const finalSnapshot = await getLatestAssistantSnapshot(page, {
      asked: baseline.promptText,
      markers: baseline.markers,
      baselineUserCount: baseline.userCount,
      baselineLastUserText: baseline.lastUserText,
    });
    const finalBodies = newAssistantBodies(
      baseline.bodies,
      finalSnapshot.bodies,
      finalSnapshot.scoped === true,
    ).filter((body) => !isPromptEcho(body.text, baseline.promptText));
    const markdown =
      finalBodies.length > 0
        ? finalBodies.map((body) => body.html).join('\n\n')
        : finalSnapshot.bodies
            .filter((body) => !isPromptEcho(body.text, baseline.promptText))
            .map((body) => body.html)
            .join('\n\n');

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
