import { describe, expect, it, vi } from 'vitest';
import { submitPromptToComposer } from '../src/providers/submit.js';

function createSubmitPage(options: { contenteditable: boolean; fillFails?: boolean }) {
  const { contenteditable, fillFails = false } = options;
  const composer = {
    waitFor: vi.fn(async () => {}),
    click: vi.fn(async () => {}),
    fill: fillFails
      ? vi.fn(async () => {
          throw new Error('fill failed');
        })
      : vi.fn(async () => {}),
    evaluate: vi.fn(async (_fn: unknown, arg?: string) => {
      if (arg === undefined) return contenteditable;
      // The text landed in the composer.
      return true;
    }),
  };

  const sendButton = {
    waitFor: vi.fn(async () => {}),
    click: vi.fn(async () => {}),
  };

  const locator = vi.fn((selector: string) => {
    if (selector === '#composer') {
      return {
        first: () => ({ ...composer, isVisible: vi.fn(async () => contenteditable) }),
      };
    }

    if (selector === '#send') {
      return {
        first: () => ({ ...sendButton, isVisible: vi.fn(async () => true) }),
      };
    }

    throw new Error(`Unexpected selector: ${selector}`);
  });

  return {
    page: {
      locator,
      keyboard: {
        type: vi.fn(async () => {}),
        insertText: vi.fn(async () => {}),
        press: vi.fn(async () => {}),
      },
      waitForTimeout: vi.fn(async () => {}),
    },
    composer,
    sendButton,
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
    expect(composer.fill).toHaveBeenCalledWith('Hello from ProseMirror');
    // One keystroke per character is too slow for a long prompt.
    expect(page.keyboard.type).not.toHaveBeenCalled();
    expect(sendButton.click).toHaveBeenCalled();
  });

  it('falls back to typing when the composer refuses the insertion', async () => {
    const { page, sendButton } = createSubmitPage({
      contenteditable: true,
      fillFails: true,
    });

    await submitPromptToComposer(page as never, 'Hello from ProseMirror', {
      composerSelector: '#composer',
      sendButtonSelector: '#send',
    });

    expect(page.keyboard.type).toHaveBeenCalledWith('Hello from ProseMirror');
    expect(sendButton.click).toHaveBeenCalled();
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
