import { describe, expect, it, vi } from 'vitest';
import { submitPromptToComposer } from '../src/providers/submit.js';

/**
 * The composer of ChatGPT is a rich text editor: it turns the newlines of the
 * prompt into paragraphs, and the text of the paragraphs is concatenated
 * without a separator. The mock below reproduces that, and it runs the real
 * functions of the source against a fake element — so the comparison of the
 * source is the one under test, not a copy of it.
 */
class FakeElement {
  textContent = '';
  innerHTML = '';
  isContentEditable = true;
  getAttribute(): string | null {
    return null;
  }
  focus(): void {}
  dispatchEvent(): boolean {
    return true;
  }
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
  /** The first insertion lands only half of the prompt. */
  insertLandsHalf?: boolean;
  /** A hidden composer sits in front of the visible one. */
  hiddenFirst?: boolean;
}) {
  const {
    contenteditable,
    insertFails = false,
    insertDoesNotLand = false,
    insertLandsHalf = false,
    hiddenFirst = false,
  } = options;
  // The raw text of the composer, before the editor merges the paragraphs.
  let raw = '';
  const element = new FakeElement();
  element.isContentEditable = contenteditable;

  const composer = {
    waitFor: vi.fn(async () => {}),
    click: vi.fn(async () => {}),
    fill: vi.fn(async (value: string) => {
      raw = value;
    }),
    evaluate: vi.fn(async (fn: unknown, arg?: string) => {
      // The editor merges the paragraphs: no separator between them.
      element.textContent = raw.replace(/\n+/g, '');
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
        raw += value;
      }),
      insertText: insertFails
        ? vi.fn(async () => {
            throw new Error('insertText failed');
          })
        : vi.fn(async (value: string) => {
            insertions++;
            if (insertDoesNotLand) return;
            if (insertLandsHalf && insertions === 1) {
              raw += value.slice(0, Math.floor(value.length / 2));
              return;
            }
            raw += value;
          }),
      press: vi.fn(async (key: string) => {
        if (key === 'Backspace') raw = '';
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

  it('types a multi-paragraph prompt without a newline', async () => {
    const { page } = createSubmitPage({ contenteditable: true, insertFails: true });
    const prompt = 'First paragraph.\n\nSecond paragraph.';

    await submitPromptToComposer(page as never, prompt, {
      composerSelector: '#composer',
      sendButtonSelector: '#send',
    });

    const typed = page.keyboard.type.mock.calls.map((call) => call[0] as string);
    expect(typed.join('')).not.toContain('\n');
    expect(typed.join('')).toBe('First paragraph. Second paragraph.');
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
