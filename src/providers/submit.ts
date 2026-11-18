import type { Page } from 'playwright';

/**
 * Shared prompt submission helper.
 *
 * All chat providers follow the same pattern:
 * 1. Wait for composer → click → select-all → delete
 * 2. Insert text via the right input path for the element type
 * 3. Wait → click send button
 *
 * This helper encapsulates that pattern so each provider only needs
 * to specify its selectors.
 */
export async function clickSendButton(
  page: Page,
  sendButtonSelector: string,
  sendTimeout = 5_000,
): Promise<void> {
  const deadline = Date.now() + sendTimeout;
  let clicked = false;
  if (typeof page.evaluate === 'function') {
    while (!clicked && Date.now() < deadline) {
      clicked = await page.evaluate((selector: string) => {
        const visible = (el: Element): el is HTMLElement => {
          if (!(el instanceof HTMLElement)) return false;
          const rect = el.getBoundingClientRect();
          const style = getComputedStyle(el);
          return (
            rect.width > 0 &&
            rect.height > 0 &&
            style.visibility !== 'hidden' &&
            style.display !== 'none' &&
            !el.hasAttribute('disabled') &&
            el.getAttribute('aria-disabled') !== 'true'
          );
        };
        const button = Array.from(document.querySelectorAll(selector)).find(visible);
        button?.click();
        return Boolean(button);
      }, sendButtonSelector);
      if (!clicked) await page.waitForTimeout(200);
    }
    if (process.env.TEN_X_CHAT_DEBUG_SUBMIT === '1') {
      console.error(`submit-debug clicked=${clicked}`);
    }
  } else {
    const sendButton = page.locator(sendButtonSelector).first();
    clicked = await sendButton
      .waitFor({ state: 'visible', timeout: sendTimeout })
      .then(async () => {
        await sendButton.click();
        return true;
      })
      .catch(() => false);
  }

  if (!clicked) {
    // ponytail: headless ChatGPT can hide the send button; Enter still submits.
    await page.keyboard.press('Enter');
  }
}

export async function submitPromptToComposer(
  page: Page,
  prompt: string,
  opts: {
    composerSelector: string;
    /** Optional — providers that submit with a keyboard shortcut can omit it. */
    sendButtonSelector?: string;
    composerTimeout?: number;
    sendTimeout?: number;
    submit?: boolean;
  },
): Promise<void> {
  const {
    composerSelector,
    sendButtonSelector,
    composerTimeout = 15_000,
    sendTimeout = 5_000,
    submit = true,
  } = opts;

  // Find the first VISIBLE composer element.
  // ChatGPT has a hidden fallback textarea that locator.first() picks up, and
  // after a context-window transition a hidden ProseMirror sits in front of the
  // visible one — so every sub-selector is tried with the `:visible` filter
  // until one of them has a visible match.
  let composer = page.locator(composerSelector).first();
  const selectors = composerSelector.split(',').map((s) => s.trim());
  for (const sel of selectors) {
    const candidate = page.locator(`${sel}:visible`).first();
    const visible = await candidate.isVisible().catch(() => false);
    if (visible) {
      composer = candidate;
      break;
    }
  }
  await composer.waitFor({ state: 'visible', timeout: composerTimeout });

  await composer.click().catch(() => {});

  const isContentEditable = await composer
    .evaluate((element) => {
      if (!(element instanceof HTMLElement)) return false;
      return element.isContentEditable || element.getAttribute('contenteditable') === 'true';
    })
    .catch(() => false);

  if (isContentEditable) {
    // The text goes to the focused element, not to the composer: a click that
    // an overlay swallowed leaves the focus somewhere else, and the prompt
    // disappears. The focus is therefore set explicitly.
    const focusComposer = async (): Promise<void> => {
      await composer
        .evaluate((element) => {
          if (element instanceof HTMLElement) element.focus();
        })
        .catch(() => {});
    };

    // The lines of the composer, read per block: the composer turns the
    // newlines of the prompt into paragraphs, and the text of the paragraphs
    // is concatenated without a separator. A prompt that lost its line
    // structure — the typing fallback of a code prompt, for instance — does
    // not land.
    const readLines = async (): Promise<string[]> =>
      composer
        .evaluate((element) => {
          const clean = (value: string): string =>
            value.replace(/[\u00a0\u200b\ufeff]/g, ' ').replace(/\s+$/, '');

          const blocks = new Set(['P', 'DIV', 'LI', 'PRE', 'BLOCKQUOTE', 'SECTION']);
          const collect = (node: Node, out: string[]): void => {
            for (const child of Array.from(node.childNodes)) {
              if (child.nodeType === 3) {
                out.push(child.textContent ?? '');
                continue;
              }
              if (child.nodeType !== 1) continue;
              const childElement = child as HTMLElement;
              // Hidden nodes hold no text of the prompt.
              if (
                typeof childElement.checkVisibility === 'function' &&
                !childElement.checkVisibility()
              ) {
                continue;
              }
              if (childElement.tagName === 'BR') {
                out.push('\n');
                continue;
              }
              const isBlock = blocks.has(childElement.tagName);
              if (isBlock) out.push('\n');
              collect(childElement, out);
              if (isBlock) out.push('\n');
            }
          };

          // Only the editable part of the composer holds the prompt.
          const editable =
            element.getAttribute('contenteditable') === 'true' ||
            (element as HTMLElement).isContentEditable
              ? element
              : (element.querySelector('[contenteditable="true"]') ?? element);

          const parts: string[] = [];
          collect(editable, parts);
          const collected = parts.join('');
          const text =
            collected.trim().length === 0
              ? // No child nodes: the composer is a plain text holder.
                (() => {
                  const rendered = (element as HTMLElement).innerText;
                  return typeof rendered === 'string' ? rendered : (editable.textContent ?? '');
                })()
              : collected;
          return text
            .split('\n')
            .map(clean)
            .filter((line) => line.length > 0);
        })
        .catch(() => [] as string[]);

    // Empty the composer before every insertion: a partly inserted prompt that
    // stays in the composer is sent twice — once as a half prompt, once as the
    // whole one.
    const clearComposer = async (): Promise<void> => {
      await focusComposer();
      await page.keyboard.press('ControlOrMeta+a');
      await page.keyboard.press('Backspace');
      // The composer must be empty now: an insertion into a composer that
      // still holds the old text produces a prompt that is not the one asked
      // for.
      const left = await readLines();
      if (left.length > 0) {
        throw new Error('The composer could not be cleared — the old text is still in it.');
      }
    };

    await clearComposer();

    const landed = async (): Promise<boolean> => {
      const expected = prompt
        .split(/\r?\n/)
        .map((line) => line.replace(/[\u00a0\u200b\ufeff]/g, ' ').replace(/\s+$/, ''))
        .filter((line) => line.length > 0);
      if (expected.length === 0) return false;
      const actual = await readLines();
      // Exactly the prompt, line by line: extra words mean that the composer
      // held something else — the old text of a previous prompt, for instance
      // — and missing line breaks mean that the prompt was flattened.
      return (
        actual.length === expected.length && actual.every((line, index) => line === expected[index])
      );
    };

    // One insertion instead of one keystroke per character: a rich composer
    // types slowly, and a long prompt took minutes — long enough to kill the
    // daemon request. `fill` is not used here: on a busy contenteditable it
    // waits for the element forever instead of failing, and the request never
    // comes back.
    let inserted = false;
    for (let attempt = 0; attempt < 2 && !inserted; attempt++) {
      if (attempt > 0) await clearComposer();
      try {
        await page.keyboard.insertText(prompt);
        inserted = await landed();
      } catch {
        inserted = false;
      }
    }
    if (!inserted) {
      // Typing is the last resort: one keystroke per character. Split it, so
      // no single request runs into the deadline of the HTTP client. The
      // composer is emptied first: a partly inserted prompt would be sent
      // twice.
      //
      // The line breaks are typed as Shift+Enter: in a chat composer a
      // newline is Enter, and Enter sends — the prompt would leave in
      // pieces, one message per paragraph. Shift+Enter inserts the line
      // break. A composer that does not support it keeps the prompt on one
      // line, and the verification below rejects it — a flattened code
      // prompt is worse than a failed run.
      await clearComposer();
      const lines = prompt.split(/\r?\n/);
      const chunkSize = 400;
      for (const [index, line] of lines.entries()) {
        if (index > 0) await page.keyboard.press('Shift+Enter');
        for (let start = 0; start < line.length; start += chunkSize) {
          await page.keyboard.type(line.slice(start, start + chunkSize));
        }
      }
      inserted = await landed();
    }
    if (!inserted) {
      // The editor refused the text. A mutation of the DOM is not an input:
      // the rich editor keeps the prompt in its own state, and it would send
      // an empty or stale prompt. A failed insertion is reported instead —
      // a wrong prompt is worse than a failed run.
      throw new Error('The prompt could not be entered into the composer of the chat.');
    }
  } else {
    try {
      await composer.fill(prompt);
    } catch {
      await composer.evaluate((element, text) => {
        if (element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement) {
          element.value = text;
        } else if (element instanceof HTMLElement) {
          element.innerText = text;
        } else {
          return;
        }
        element.dispatchEvent(new Event('input', { bubbles: true }));
        element.dispatchEvent(new Event('change', { bubbles: true }));
      }, prompt);
    }
  }

  await page.waitForTimeout(300);

  if (submit && sendButtonSelector) {
    await clickSendButton(page, sendButtonSelector, sendTimeout);
  }
}
