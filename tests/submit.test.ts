import { describe, expect, it, vi } from 'vitest';
import { submitPromptToComposer } from '../src/providers/submit.js';

/**
 * The composer of ChatGPT is a rich text editor: it turns the newlines of the
 * prompt into paragraphs, and the text of the paragraphs is concatenated
 * without a separator. The mock below reproduces that, and it runs the real
 * functions of the source against a fake element — so the comparison of the
 * source is the one under test, not a copy of it.
 */
type FakeNode = {
  nodeType: number;
  tagName?: string;
  textContent?: string;
  childNodes?: FakeNode[];
};

class FakeElement {
  textContent = '';
  innerHTML = '';
  isContentEditable = true;
  childNodes: FakeNode[] = [];
  getAttribute(): string | null {
    return null;
  }
  focus(): void {}
  dispatchEvent(): boolean {
    return true;
  }
}

/** The editor turns every line of the prompt into a paragraph. */
function setComposerText(element: FakeElement, value: string): void {
  const lines = value.split('\n');
  element.childNodes = lines.map((line) => ({
    nodeType: 1,
    tagName: 'P',
    textContent: line,
    childNodes: [{ nodeType: 3, textContent: line }],
  }));
  // The real DOM concatenates the paragraphs without a separator.
  element.textContent = lines.join('');
}

const globals = globalThis as unknown as { HTMLElement?: unknown; InputEvent?: unknown };
globals.HTMLElement = FakeElement;
globals.InputEvent = class InputEvent extends Event {
  data: string | null;
  constructor(type: string, init?: { data?: string }) {
    super(type);
    this.data = init?.data ?? null;
  }
};

function createSubmitPage(options: {
  contenteditable: boolean;
  insertFails?: boolean;
  insertDoesNotLand?: boolean;
  /** The typing fallback does not land either. */
  typeDoesNotLand?: boolean;
  /** The first insertion lands only half of the prompt. */
  insertLandsHalf?: boolean;
  /** The composer swallows the whitespace of the prompt. */
  losesSeparators?: boolean;
  /** The composer cannot be emptied — the old text stays in it. */
  clearFails?: boolean;
  /** The composer ignores Shift+Enter and flattens the prompt. */
  ignoresLineBreaks?: boolean;
  /** A hidden composer sits in front of the visible one. */
  hiddenFirst?: boolean;
}) {
  const {
    contenteditable,
    insertFails = false,
    insertDoesNotLand = false,
    typeDoesNotLand = false,
    insertLandsHalf = false,
    losesSeparators = false,
    clearFails = false,
    ignoresLineBreaks = false,
    hiddenFirst = false,
  } = options;
  // The raw text of the composer, before the editor merges the paragraphs.
  let raw = clearFails ? 'old prompt ' : '';
  const element = new FakeElement();
  element.isContentEditable = contenteditable;

  // A composer that swallows the whitespace turns "hello world" into
  // "helloworld" — the prompt is there, but the words are glued together.
  const applyText = (value: string): void => {
    raw += losesSeparators ? value.replace(/\s+/g, '') : value;
  };

  const composer = {
    waitFor: vi.fn(async () => {}),
    click: vi.fn(async () => {}),
    fill: vi.fn(async (value: string) => {
      raw = value;
    }),
    evaluate: vi.fn(async (fn: unknown, arg?: string) => {
      setComposerText(element, raw);
      const call = fn as (this: FakeElement, element: FakeElement, arg?: string) => unknown;
      return call.call(element, element, arg);
    }),
    isVisible: vi.fn(async () => contenteditable),
  };

  // ChatGPT puts a hidden composer in front of the visible one after a
  // context-window transition: `locator.first()` would pick this one.
  const hiddenComposer = {
    ...composer,
    waitFor: vi.fn(async () => {}),
    click: vi.fn(async () => {}),
    isVisible: vi.fn(async () => false),
  };

  const sendButton = {
    waitFor: vi.fn(async () => {}),
    click: vi.fn(async () => {}),
  };

  const locator = vi.fn((selector: string) => {
    // The composer is looked up with the `:visible` filter first.
    if (selector === '#composer' || selector === '#composer:visible') {
      const target = hiddenFirst && selector === '#composer' ? hiddenComposer : composer;
      return { first: () => target };
    }

    if (selector === '#send') {
      return {
        first: () => ({ ...sendButton, isVisible: vi.fn(async () => true) }),
      };
    }

    throw new Error(`Unexpected selector: ${selector}`);
  });

  let insertions = 0;
  const page = {
    locator,
    keyboard: {
      type: vi.fn(async (value: string) => {
        if (typeDoesNotLand) return;
        applyText(value);
      }),
      insertText: insertFails
        ? vi.fn(async () => {
            throw new Error('insertText failed');
          })
        : vi.fn(async (value: string) => {
            insertions++;
            if (insertDoesNotLand) return;
            if (insertLandsHalf && insertions === 1) {
              applyText(value.slice(0, Math.floor(value.length / 2)));
              return;
            }
            applyText(value);
          }),
      press: vi.fn(async (key: string) => {
        if (key === 'Backspace' && !clearFails) raw = '';
        // Shift+Enter inserts a line break.
        if (key === 'Shift+Enter' && !ignoresLineBreaks) raw += '\n';
      }),
    },
    waitForTimeout: vi.fn(async () => {}),
  };

  return {
    page,
    composer,
    hiddenComposer,
    sendButton,
    /** The text that is in the composer right now. */
    composerText: () => raw,
  };
}

describe('submitPromptToComposer', () => {
  it('inserts the prompt in one go for contenteditable composers', async () => {
    const { page, composer, sendButton } = createSubmitPage({ contenteditable: true });

    await submitPromptToComposer(page as never, 'Hello from ProseMirror', {
      composerSelector: '#composer',
      sendButtonSelector: '#send',
    });

    expect(composer.waitFor).toHaveBeenCalled();
    expect(composer.click).toHaveBeenCalled();
    expect(page.keyboard.press).toHaveBeenCalledWith('ControlOrMeta+a');
    expect(page.keyboard.press).toHaveBeenCalledWith('Backspace');
    expect(page.keyboard.insertText).toHaveBeenCalledWith('Hello from ProseMirror');
    // `fill` waits for the element forever on a busy contenteditable.
    expect(composer.fill).not.toHaveBeenCalled();
    // One keystroke per character is too slow for a long prompt.
    expect(page.keyboard.type).not.toHaveBeenCalled();
    expect(sendButton.click).toHaveBeenCalled();
  });

  it('lands a multi-paragraph prompt in one message', async () => {
    const { page, composerText } = createSubmitPage({ contenteditable: true });
    const prompt = 'First paragraph.\n\nSecond paragraph.\nThird line.';

    await submitPromptToComposer(page as never, prompt, {
      composerSelector: '#composer',
      sendButtonSelector: '#send',
    });

    // The composer merges the paragraphs, but the prompt must not be typed
    // character by character — a newline is Enter, and Enter sends.
    expect(page.keyboard.insertText).toHaveBeenCalledWith(prompt);
    expect(page.keyboard.type).not.toHaveBeenCalled();
    expect(composerText()).toBe(prompt);
  });

  it('falls back to typing when the composer refuses the insertion', async () => {
    const { page, sendButton } = createSubmitPage({
      contenteditable: true,
      insertFails: true,
    });

    await submitPromptToComposer(page as never, 'Hello from ProseMirror', {
      composerSelector: '#composer',
      sendButtonSelector: '#send',
    });

    expect(page.keyboard.type).toHaveBeenCalledWith('Hello from ProseMirror');
    expect(sendButton.click).toHaveBeenCalled();
  });

  it('types a multi-paragraph prompt with line breaks', async () => {
    const { page, composerText } = createSubmitPage({ contenteditable: true, insertFails: true });
    const prompt = 'First paragraph.\n\nSecond paragraph.';

    await submitPromptToComposer(page as never, prompt, {
      composerSelector: '#composer',
      sendButtonSelector: '#send',
    });

    // Enter would send the prompt — the line breaks are typed as Shift+Enter.
    const typed = page.keyboard.type.mock.calls.map((call) => call[0] as string);
    expect(typed.join('')).not.toContain('\n');
    expect(page.keyboard.press).toHaveBeenCalledWith('Shift+Enter');
    // The line structure of the prompt survives the typing.
    expect(composerText().split('\n').filter(Boolean)).toEqual([
      'First paragraph.',
      'Second paragraph.',
    ]);
  });

  it('does not send a prompt whose line structure was lost', async () => {
    // A composer that flattens the prompt would send broken code.
    const { page, sendButton } = createSubmitPage({
      contenteditable: true,
      insertFails: true,
      ignoresLineBreaks: true,
    });
    const prompt = 'def calculate():\n    return 42';

    await expect(
      submitPromptToComposer(page as never, prompt, {
        composerSelector: '#composer',
        sendButtonSelector: '#send',
      }),
    ).rejects.toThrow('could not be entered into the composer');

    expect(sendButton.click).not.toHaveBeenCalled();
  });

  it('types the prompt in chunks, so no request runs into the client deadline', async () => {
    const { page, sendButton } = createSubmitPage({
      contenteditable: true,
      insertDoesNotLand: true,
    });
    const prompt = 'x'.repeat(1000);

    await submitPromptToComposer(page as never, prompt, {
      composerSelector: '#composer',
      sendButtonSelector: '#send',
    });

    const typed = page.keyboard.type.mock.calls.map((call) => call[0] as string);
    expect(typed.length).toBeGreaterThan(1);
    expect(typed.join('')).toBe(prompt);
    expect(Math.max(...typed.map((chunk) => chunk.length))).toBeLessThanOrEqual(400);
    expect(sendButton.click).toHaveBeenCalled();
  });

  it('clears a partly inserted prompt before it inserts it again', async () => {
    const { page, composerText } = createSubmitPage({
      contenteditable: true,
      insertLandsHalf: true,
    });
    const prompt = 'Hello from ProseMirror';

    await submitPromptToComposer(page as never, prompt, {
      composerSelector: '#composer',
      sendButtonSelector: '#send',
    });

    // The half that landed must not stay: the composer holds the prompt once.
    expect(composerText()).toBe(prompt);
    expect(page.keyboard.type).not.toHaveBeenCalled();
  });

  it('skips a hidden composer that sits in front of the visible one', async () => {
    const { page, composer, hiddenComposer } = createSubmitPage({
      contenteditable: true,
      hiddenFirst: true,
    });

    await submitPromptToComposer(page as never, 'Hello from ProseMirror', {
      composerSelector: '#composer',
      sendButtonSelector: '#send',
    });

    // The hidden one would never receive the text.
    expect(hiddenComposer.waitFor).not.toHaveBeenCalled();
    expect(composer.waitFor).toHaveBeenCalled();
    expect(composer.click).toHaveBeenCalled();
  });

  it('fails when the editor accepts neither the insertion nor the typing', async () => {
    // A prompt that is not in the editor must not be sent: the provider would
    // answer something else.
    const { page, sendButton } = createSubmitPage({
      contenteditable: true,
      insertFails: true,
      typeDoesNotLand: true,
    });

    await expect(
      submitPromptToComposer(page as never, 'Hello from ProseMirror', {
        composerSelector: '#composer',
        sendButtonSelector: '#send',
      }),
    ).rejects.toThrow('could not be entered into the composer');

    expect(sendButton.click).not.toHaveBeenCalled();
  });

  it('does not accept a prompt whose word separators were lost', async () => {
    // "hello world" as "helloworld" is one word: the prompt is not in the
    // composer as it was written, so it must not be sent.
    const { page, sendButton } = createSubmitPage({
      contenteditable: true,
      losesSeparators: true,
    });

    await expect(
      submitPromptToComposer(page as never, 'Hello world', {
        composerSelector: '#composer',
        sendButtonSelector: '#send',
      }),
    ).rejects.toThrow('could not be entered into the composer');

    expect(sendButton.click).not.toHaveBeenCalled();
  });

  it('does not accept a prompt that is mixed with the old text of the composer', async () => {
    // The composer keeps the text of the previous prompt: the new one would
    // be sent together with it.
    const { page, sendButton } = createSubmitPage({
      contenteditable: true,
      clearFails: true,
    });

    await expect(
      submitPromptToComposer(page as never, 'Hello world', {
        composerSelector: '#composer',
        sendButtonSelector: '#send',
      }),
    ).rejects.toThrow('composer');

    expect(sendButton.click).not.toHaveBeenCalled();
  });

  it('still uses fill for textarea-style composers', async () => {
    const { page, composer, sendButton } = createSubmitPage({ contenteditable: false });

    await submitPromptToComposer(page as never, 'Hello from textarea', {
      composerSelector: '#composer',
      sendButtonSelector: '#send',
    });

    expect(composer.fill).toHaveBeenCalledWith('Hello from textarea');
    expect(page.keyboard.insertText).not.toHaveBeenCalled();
    expect(sendButton.click).toHaveBeenCalled();
  });
});
