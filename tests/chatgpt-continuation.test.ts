/**
 * The continuation of an exhausted ChatGPT chat must land in a new chat.
 *
 * The app hides the banner of the exhausted context window before it renders
 * the new chat. A continuation that only waits for the banner would report
 * success while the old chat is still on the screen — and the prompt of the
 * run would be sent to the exhausted chat.
 *
 * The decision itself is pure: the DOM is only read, the signals are judged by
 * `continuationReady`, so it can be tested without a browser.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  type ContinuationDomState,
  type ContinuationSignals,
  continuationReady,
  conversationIdChanged,
  conversationReplaced,
  hasContinuationMarker,
  readContinuationDomState,
} from '../src/providers/chatgpt.js';

const OLD_URL = 'https://chatgpt.com/c/old-chat';
const NEW_URL = 'https://chatgpt.com/c/new-chat';

const READY: ContinuationSignals = {
  bannerGone: true,
  composerUsable: true,
  conversationChanged: true,
  continuationSignal: true,
  oldConversationGone: true,
};

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
  summaryMarker?: boolean;
  /** The app stays on the landing page: the URL has no conversation id. */
  keepLandingPage?: boolean;
  /** The exhausted conversation stays on the screen. */
  staleConversation?: boolean;
  /** The composer of the new chat cannot be used. */
  composerUsable?: boolean;
}) {
  const {
    switchAfter,
    turnsBefore = 4,
    turnsAfter = 1,
    summaryMarker = true,
    keepLandingPage = false,
    staleConversation = false,
    composerUsable = true,
  } = options;
  const state = {
    url: OLD_URL,
    turns: turnsBefore,
    polls: 0,
    switched: false,
    clicked: false,
    /** The URL of the app at every check of the composer. */
    observedUrls: [] as string[],
  };

  const domState = () => ({
    // The banner is on the screen until the button of the banner is clicked.
    bannerPresent: !state.clicked,
    newChatButtonIndex: 0,
    composerUsable,
    summaryMarker,
    oldConversationGone: !staleConversation,
  });

  const page = {
    url: () => state.url,
    waitForTimeout: vi.fn(async () => {}),
    // The app is asked for the state of the page with an object of options,
    // the exhausted conversation is marked with an array of selectors and the
    // button of the banner is clicked with its index.
    evaluate: vi.fn(async (_fn: unknown, arg: unknown) => {
      if (Array.isArray(arg)) return undefined;
      if (typeof arg === 'number') {
        state.clicked = true;
        return true;
      }

      if (!state.clicked) return domState();

      state.polls++;
      if (!state.switched && state.polls > switchAfter) {
        state.switched = true;
        state.url = keepLandingPage ? 'https://chatgpt.com/' : NEW_URL;
        state.turns = turnsAfter;
      }
      state.observedUrls.push(state.url);
      // The banner is gone and the composer is back.
      return domState();
    }),
    locator: () => ({ count: async () => state.turns }),
  };

  return { page, state };
}

describe('the signals of a finished continuation', () => {
  it('is ready when every signal is there', () => {
    expect(continuationReady(READY)).toBe(true);
  });

  it('is not ready when the conversation did not change', () => {
    expect(continuationReady({ ...READY, conversationChanged: false })).toBe(false);
  });

  it('is not ready without the sign of the continuation', () => {
    expect(continuationReady({ ...READY, continuationSignal: false })).toBe(false);
  });

  it('is not ready when the composer cannot be used', () => {
    expect(continuationReady({ ...READY, composerUsable: false })).toBe(false);
  });

  it('is not ready while the banner is on the screen', () => {
    expect(continuationReady({ ...READY, bannerGone: false })).toBe(false);
  });

  it('is not ready while the exhausted conversation is still on the screen', () => {
    expect(continuationReady({ ...READY, oldConversationGone: false })).toBe(false);
  });
});

describe('the identity of the conversation', () => {
  it('is changed by a different id in the URL', () => {
    expect(conversationIdChanged('old-chat', 'new-chat')).toBe(true);
  });

  it('is not changed by the same id', () => {
    expect(conversationIdChanged('old-chat', 'old-chat')).toBe(false);
  });

  it('is not changed when the URL has no id: the landing page can show the old chat', () => {
    expect(conversationIdChanged('old-chat', undefined)).toBe(false);
    expect(conversationIdChanged(undefined, undefined)).toBe(false);
  });
});

describe('the replacement of the conversation', () => {
  it('is counted when the new chat has fewer turns of its own', () => {
    expect(conversationReplaced(4, 1, false)).toBe(true);
  });

  it('is not counted when the number of the turns is the same or bigger', () => {
    expect(conversationReplaced(4, 4, false)).toBe(false);
    expect(conversationReplaced(4, 5, false)).toBe(false);
  });

  it('is not counted when the new chat has no turn at all', () => {
    expect(conversationReplaced(4, 0, false)).toBe(false);
  });

  it('is counted by the summary of the old chat', () => {
    expect(conversationReplaced(4, 4, true)).toBe(true);
  });
});

describe('the marker of the native continuation', () => {
  it('is found in the text of the new chat', () => {
    expect(hasContinuationMarker('Continued from Chat about the parser')).toBe(true);
    expect(hasContinuationMarker('Here is a summary of the earlier conversation')).toBe(true);
    expect(hasContinuationMarker('Контекст предыдущей беседы сохранён')).toBe(true);
    expect(hasContinuationMarker('Продолжение с прошлого раза')).toBe(true);
  });

  it('is not found in an ordinary chat', () => {
    expect(hasContinuationMarker('The answer of the assistant')).toBe(false);
  });
});

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

  it('fails when the URL has no conversation id', async () => {
    // The turns change, but the app stayed on the landing page: the number of
    // the turns is no proof of a new conversation.
    const { page } = createSummaryChatPage({
      switchAfter: 0,
      keepLandingPage: true,
    });

    const { chatgptActions } = await import('../src/providers/chatgpt.js');
    await expect(chatgptActions.continueInNewChat?.(page as never)).resolves.toBe(false);
  });

  it('fails while the exhausted conversation is still on the screen', async () => {
    const { page } = createSummaryChatPage({ switchAfter: 0, staleConversation: true });

    const { chatgptActions } = await import('../src/providers/chatgpt.js');
    await expect(chatgptActions.continueInNewChat?.(page as never)).resolves.toBe(false);
  });

  it('fails while the composer of the new chat cannot be used', async () => {
    const { page } = createSummaryChatPage({ switchAfter: 0, composerUsable: false });

    const { chatgptActions } = await import('../src/providers/chatgpt.js');
    await expect(chatgptActions.continueInNewChat?.(page as never)).resolves.toBe(false);
  });
});

/** A node of the fake page: only the parts the check reads. */
interface FakeNode {
  nodeType: number;
  textContent: string;
  childNodes: FakeNode[];
  closest?: (selector: string) => unknown;
}

function textNode(value: string): FakeNode {
  return { nodeType: 3, textContent: value, childNodes: [] };
}

function element(children: FakeNode[], options: { navigation?: boolean } = {}): FakeNode {
  return {
    nodeType: 1,
    textContent: '',
    childNodes: children,
    closest: () => (options.navigation ? {} : null),
  };
}

/** The page of the app: a sidebar with the conversations and the chat. */
function fakePage(options: { sidebar: string; chat: string; withScope: boolean }): Document {
  const sidebar = element([textNode(options.sidebar)], { navigation: true });
  const chat = element([textNode(options.chat)]);
  const scope = element([textNode(options.chat)]);

  return {
    body: { ...element([sidebar, chat]), innerText: `${options.sidebar} ${options.chat}` },
    querySelector: (selector: string) =>
      options.withScope && selector.includes('main') ? scope : null,
    querySelectorAll: () => [],
    elementFromPoint: () => null,
  } as unknown as Document;
}

const DOM_OPTIONS = {
  markerPattern:
    'continued from|previous conversation|earlier conversation|summary|контекст|продолж',
  scopeSelector: 'main, #thread, [role="main"]',
  navigationSelector: 'nav, aside, [role="navigation"], [data-testid*="sidebar" i]',
  bannerPattern: 'context window full',
  newChatLabel: '^new chat$',
  bannerMaxText: 400,
};

describe('the marker in the page of the continuation', () => {
  it('is not read from the sidebar of the old conversations', () => {
    // The sidebar holds the title of an old conversation: it carries the word
    // "summary", but the new chat was never continued.
    const page = fakePage({
      sidebar: 'Summary of the architecture',
      chat: 'A new chat',
      withScope: true,
    });

    const state = readContinuationDomState(DOM_OPTIONS, page);
    expect(state.summaryMarker).toBe(false);
  });

  it('is not read from the navigation when the app has no container of the chat', () => {
    const page = fakePage({
      sidebar: 'Summary of the architecture',
      chat: 'A new chat',
      withScope: false,
    });

    const state = readContinuationDomState(DOM_OPTIONS, page);
    expect(state.summaryMarker).toBe(false);
  });

  it('is read from the conversation itself', () => {
    const page = fakePage({
      sidebar: 'Today',
      chat: 'Continued from Chat about the parser',
      withScope: true,
    });

    const state = readContinuationDomState(DOM_OPTIONS, page);
    expect(state.summaryMarker).toBe(true);
  });
});

/** An element of the fake page of the app. */
interface FakeElement extends FakeNode {
  nodeType: 1;
  tag: string;
  attrs: Record<string, string>;
  innerText: string;
  parentElement: FakeElement | null;
  getAttribute(name: string): string | null;
  getBoundingClientRect(): { width: number; height: number };
  contains(node: unknown): boolean;
}

/**
 * Does the element match the selector?
 *
 * The selectors of the app are simple: a tag, an id, an attribute with a
 * value or a part of a value.
 */
function matchesSelector(element: FakeElement, selector: string): boolean {
  return selector.split(',').some((part) => {
    const rule = part.trim();
    const tag = /^([a-zA-Z][\w-]*)/.exec(rule)?.[1];
    if (tag && element.tag !== tag) return false;
    const id = /#([\w-]+)/.exec(rule);
    if (id && element.attrs.id !== id[1]) return false;
    const exact = /\[([\w-]+)="([^"]*)"[^\]]*\]/.exec(rule);
    if (exact && element.attrs[exact[1]] !== exact[2]) return false;
    const containsAttr = /\[([\w-]+)\*="([^"]*)"[^\]]*\]/.exec(rule);
    if (containsAttr) {
      const value = element.attrs[containsAttr[1]];
      if (value === undefined || !value.toLowerCase().includes(containsAttr[2].toLowerCase())) {
        return false;
      }
    }
    if (!tag && !id && !exact && !containsAttr) return false;
    return true;
  });
}

/** An element of the fake page: the parts the check reads. */
function fakeElement(options: {
  tag: string;
  text?: string;
  attrs?: Record<string, string>;
  visible?: boolean;
  children?: FakeElement[];
}): FakeElement {
  const children = options.children ?? [];
  const text = options.text ?? children.map((child) => child.innerText).join(' ');
  const element: FakeElement = {
    nodeType: 1,
    tag: options.tag,
    attrs: options.attrs ?? {},
    innerText: text,
    textContent: text,
    childNodes: children,
    parentElement: null,
    getAttribute: (name: string) => element.attrs[name] ?? null,
    getBoundingClientRect: () =>
      options.visible === false ? { width: 0, height: 0 } : { width: 10, height: 10 },
    contains: (node: unknown) => {
      if (node === element) return true;
      return children.some((child) => child.contains(node));
    },
    closest: (selector: string) => {
      let node: FakeElement | null = element;
      while (node) {
        if (matchesSelector(node, selector)) return node;
        node = node.parentElement;
      }
      return null;
    },
  };
  for (const child of children) child.parentElement = element;
  return element;
}

/** The page of the app around the elements given. */
function fakeDocument(root: FakeElement): Document {
  const found = (selector: string): FakeElement[] => {
    const hits: FakeElement[] = [];
    const walk = (element: FakeElement): void => {
      for (const child of element.childNodes) {
        if ((child as FakeElement).nodeType !== 1) continue;
        const childElement = child as FakeElement;
        if (matchesSelector(childElement, selector)) hits.push(childElement);
        walk(childElement);
      }
    };
    walk(root);
    return hits;
  };
  return {
    body: root,
    documentElement: root,
    querySelector: (selector: string) => found(selector)[0] ?? null,
    querySelectorAll: (selector: string) => found(selector),
    elementFromPoint: () => null,
  } as unknown as Document;
}

/**
 * The summary of a continuation: it can quote the words of the banner of the
 * exhausted context window.
 */
const SUMMARY_WITH_BANNER_WORDS =
  'Summary of the previous conversation — the banner "Context window full" has been answered.';

describe('the banner of the exhausted context window', () => {
  it('is not seen when only the summary of the continuation carries its words', () => {
    // The banner is gone, but the summary of the new chat holds the words of
    // the banner: the continuation must not wait for a banner that is not
    // there.
    const sidebar = fakeElement({
      tag: 'nav',
      children: [fakeElement({ tag: 'button', text: 'New chat' })],
    });
    const chat = fakeElement({
      tag: 'main',
      children: [fakeElement({ tag: 'p', text: SUMMARY_WITH_BANNER_WORDS })],
    });
    const page = fakeDocument(fakeElement({ tag: 'body', children: [sidebar, chat] }));

    const state = readContinuationDomState(DOM_OPTIONS, page);
    expect(state.bannerPresent).toBe(false);
    expect(state.newChatButtonIndex).toBe(-1);
  });

  it('is seen in the box with its words and the button of the new chat', () => {
    const sidebar = fakeElement({
      tag: 'nav',
      children: [fakeElement({ tag: 'button', text: 'New chat' })],
    });
    const banner = fakeElement({
      tag: 'div',
      text: 'Context window full',
      children: [fakeElement({ tag: 'button', text: 'New chat' })],
    });
    const chat = fakeElement({
      tag: 'main',
      children: [fakeElement({ tag: 'p', text: SUMMARY_WITH_BANNER_WORDS })],
    });
    const page = fakeDocument(fakeElement({ tag: 'body', children: [sidebar, banner, chat] }));

    const state = readContinuationDomState(DOM_OPTIONS, page);
    expect(state.bannerPresent).toBe(true);
    // The button of the banner, not the one of the sidebar.
    expect(state.newChatButtonIndex).toBe(1);
  });

  it('is not seen in a hidden button of the sidebar', () => {
    const sidebar = fakeElement({
      tag: 'nav',
      children: [fakeElement({ tag: 'button', text: 'New chat', visible: false })],
    });
    const banner = fakeElement({
      tag: 'div',
      text: 'Context window full',
      children: [fakeElement({ tag: 'button', text: 'New chat', visible: false })],
    });
    const page = fakeDocument(fakeElement({ tag: 'body', children: [sidebar, banner] }));

    const state = readContinuationDomState(DOM_OPTIONS, page);
    expect(state.bannerPresent).toBe(false);
  });
});

/**
 * The check of the continuation runs in the page.
 *
 * `page.evaluate` serializes the function into the page: the page does not
 * have the scope of the module. A helper of the module called by the function
 * is a ReferenceError there — the continuation is never detected, and the run
 * continues in the exhausted chat. The test runs the function the way the page
 * runs it: the source of the function, without the scope of the module.
 */
describe('the state of the page in the browser', () => {
  it('is read by the function as the page runs it', () => {
    const sidebar = fakeElement({
      tag: 'nav',
      children: [fakeElement({ tag: 'button', text: 'New chat' })],
    });
    const banner = fakeElement({
      tag: 'div',
      text: 'Context window full',
      children: [fakeElement({ tag: 'button', text: 'New chat' })],
    });
    const chat = fakeElement({
      tag: 'main',
      children: [fakeElement({ tag: 'p', text: SUMMARY_WITH_BANNER_WORDS })],
    });
    const page = fakeDocument(fakeElement({ tag: 'body', children: [sidebar, banner, chat] }));

    // The page runs the function with the document of the page as its
    // default: the function is serialized into the page, where the global
    // `document` is the one of the page.
    const inPage = new Function('document', `return (${readContinuationDomState.toString()});`)(
      page,
    ) as (options: typeof DOM_OPTIONS, doc?: Document) => ContinuationDomState;

    const state = inPage(DOM_OPTIONS);
    expect(state.bannerPresent).toBe(true);
    expect(state.newChatButtonIndex).toBe(1);
  });
});
