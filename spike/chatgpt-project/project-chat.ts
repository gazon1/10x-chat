/**
 * Can 10x-chat create a conversation inside an existing ChatGPT Project?
 *
 * This is the reproducible half of docs/chatgpt-projects.md: it opens a
 * project page, sends a probe prompt, and then answers the only question that
 * matters — does the chat belong to the project?
 *
 *   bun run spike/chatgpt-project/project-chat.ts <project-id> [--headless]
 *
 * Headed by default — that is the session Issue #76 asks for, and a challenge
 * that appears mid-run needs a window a human can reach. `--headless` is the
 * opt-in for a machine without a display.
 *
 * The project id is the `g-p-<32 hex>` of any project URL. The script leaves
 * the probe conversation behind: it is the evidence, and deleting it is a
 * mutation the spike is not allowed to do.
 */

import { getChromium } from '../../src/browser/engine.ts';
import { getStorageStatePath } from '../../src/browser/state.ts';
import { isChallengeVisible, waitForChallengeToPass } from '../../src/core/failures.ts';
import { submitPromptToComposer } from '../../src/providers/submit.ts';

const COMPOSER =
  '#prompt-textarea.ProseMirror[contenteditable="true"][role="textbox"], #prompt-textarea[contenteditable="true"], div.ProseMirror[contenteditable="true"]';
const SEND =
  '#composer-submit-button, button[aria-label="Send prompt"], [data-testid="send-button"]';

const projectId = process.argv[2];
if (!projectId || !/^g-p-[0-9a-f]{32}$/i.test(projectId)) {
  console.error('usage: project-chat.ts g-p-<32 hex> [--headless]');
  process.exit(2);
}
const headless = process.argv.includes('--headless');

// The full Playwright API, not the daemon facade: a spike reads screenshots
// and `getByText`, which the facade does not proxy. The engine and the cookies
// are the ones a real run uses.
const browser = await (await getChromium()).launch({ headless });
const context = await browser.newContext({ storageState: getStorageStatePath() });
const page = await context.newPage();

/** Navigate and let the project page settle; it renders a shell first. */
const open = async (url: string): Promise<void> => {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForTimeout(2000);
  if (await isChallengeVisible(page)) {
    console.log('bot challenge — solve it in the window (120s)');
    if (!(await waitForChallengeToPass(page, 120_000))) throw new Error('challenge not solved');
  }
};

const waitForComposer = async (): Promise<boolean> => {
  for (let i = 0; i < 30; i++) {
    if (
      await page
        .locator(COMPOSER)
        .first()
        .isVisible()
        .catch(() => false)
    )
      return true;
    await page.waitForTimeout(2000);
  }
  return false;
};

try {
  await open(`https://chatgpt.com/g/${projectId}/project`);
  if (!(await waitForComposer())) {
    throw new Error(`the project page did not open (now at ${page.url()})`);
  }
  // A dead project redirects to the home page and still shows a composer, so
  // the URL — not the composer — is what proves the project opened: typing
  // after that redirect would write into the global chat list.
  if (!page.url().includes(`/g/${projectId}`)) {
    throw new Error(
      `refusing to submit: the project did not open, ChatGPT sent us to ${page.url()}`,
    );
  }
  const heading = (await page.locator('main h1, [role="main"] h1').first().textContent()) ?? '';
  console.log(`project page: ${page.url()}\nheading: ${heading.trim()}`);

  const marker = `PROJECT-PROBE-${Date.now()}`;
  await submitPromptToComposer(page, `Reply with exactly: ${marker}`, {
    composerSelector: COMPOSER,
    sendButtonSelector: SEND,
  });

  // The app writes the conversation id into the URL when the first message is
  // stored; waiting on the URL is faster and clearer than polling the page.
  await page.waitForURL(/\/c\/[0-9a-f-]{8,}/i, { timeout: 90_000 }).catch(() => {});
  const conversationUrl = page.url();
  if (!/\/c\/[0-9a-f-]{8,}/i.test(conversationUrl)) {
    throw new Error('no conversation was created');
  }
  const chatId = conversationUrl.split('/c/')[1] ?? '';
  console.log(`conversation: ${conversationUrl}`);

  // Wait for the answer, so the conversation is stored before it is checked.
  // The body of an answer of today's UI is `[data-markdown-text-style]`; the
  // `data-message-author-role` wrapper of this UI holds only the hidden label
  // "ChatGPT said:" (offsetHeight 0), so it can never carry the text.
  await page
    .waitForFunction(
      (needle: string) =>
        Array.from(
          document.querySelectorAll(
            '[data-markdown-text-style="assistant-message"], [data-response-body], [data-dil-response], [class*="MarkdownRoot"]',
          ),
        ).some((el) => (el.textContent ?? '').includes(needle)),
      marker,
      { timeout: 120_000 },
    )
    .catch(() => console.log('warning: the answer did not arrive, checking anyway'));

  // Signal 1: the app resolves the bare id into a project URL, or it does not.
  await open(`https://chatgpt.com/c/${chatId}`);
  await page.waitForTimeout(8000);
  const resolved = page.url();

  // Signal 2: the project page lists the chat itself. The query is scoped to
  // the project's own list: the sidebar carries global `/c/<id>` links too, and
  // one of those must never count as a listing.
  await open(`https://chatgpt.com/g/${projectId}/project`);
  const listed = await page
    .waitForFunction(
      (id: string) =>
        Array.from(
          document.querySelectorAll('main a[href*="/c/"], [role="main"] a[href*="/c/"]'),
        ).some((a) => (a.getAttribute('href') ?? '').includes(id)),
      chatId,
      { timeout: 45_000 },
    )
    .then(() => true)
    .catch(() => false);

  const inProject = resolved.includes(`/g/${projectId}`);
  console.log(
    JSON.stringify({ projectId, chatId, resolvedBareId: resolved, inProject, listed }, null, 1),
  );
  // Both signals must agree: one of them alone is a redirect or a render.
  process.exitCode = inProject && listed ? 0 : 1;
} finally {
  await context.close().catch(() => {});
  await browser.close().catch(() => {});
}
