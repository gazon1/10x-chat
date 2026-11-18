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
  // ChatGPT has a hidden fallback textarea that locator.first() picks up,
  // so we try each sub-selector individually until we find a visible one.
  let composer = page.locator(composerSelector).first();
  const selectors = composerSelector.split(',').map((s) => s.trim());
  for (const sel of selectors) {
    const candidate = page.locator(sel).first();
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

    await focusComposer();
    await page.keyboard.press('ControlOrMeta+a');
    await page.keyboard.press('Backspace');

    const landed = async (): Promise<boolean> =>
      composer
        .evaluate((element, text) => {
          // The composer turns the newlines of the prompt into paragraphs:
          // the text lands, but not character for character.
          const normalize = (value: string): string => value.replace(/\s+/g, ' ').trim();
          return normalize(element.textContent ?? '').includes(normalize(text));
        }, prompt)
        .catch(() => false);

    // One insertion instead of one keystroke per character: a rich composer
    // types slowly, and a long prompt took minutes — long enough to kill the
    // daemon request. `fill` is not used here: on a busy contenteditable it
    // waits for the element forever instead of failing, and the request never
    // comes back.
    let inserted = false;
    for (let attempt = 0; attempt < 2 && !inserted; attempt++) {
      if (attempt > 0) await focusComposer();
      try {
        await page.keyboard.insertText(prompt);
        inserted = await landed();
      } catch {
        inserted = false;
      }
    }
    if (!inserted) {
      // Typing is the last resort: one keystroke per character. Split it, so
      // no single request runs into the deadline of the HTTP client.
      const chunkSize = 400;
      for (let start = 0; start < prompt.length; start += chunkSize) {
        await page.keyboard.type(prompt.slice(start, start + chunkSize));
      }
      inserted = await landed();
    }
    if (!inserted) {
      await composer.evaluate((element, text) => {
        if (!(element instanceof HTMLElement)) return;
        element.focus();
        element.textContent = text;
        element.dispatchEvent(new InputEvent('input', { bubbles: true, data: text }));
        element.dispatchEvent(new Event('change', { bubbles: true }));
      }, prompt);
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
