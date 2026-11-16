/**
 * The providers of the readiness matrix (issue #13).
 *
 * The selectors live here (and not inside the matrix itself) so that they can
 * be checked by unit tests: a selector that matches two DOM levels of the
 * same answer counts every answer twice.
 */

/**
 * @typedef {object} Provider
 * @property {string} name the provider id
 * @property {string} url the page that is opened
 * @property {number} runs how many times the provider is measured
 * @property {boolean} cloudflare whether the provider is behind Cloudflare
 * @property {string} composer the composer of the prompt
 * @property {string} send the button that sends the prompt
 * @property {string} response the answer of the provider — one DOM level
 * @property {string} login the login wall of the provider
 */

/** @type {Provider[]} */
export const PROVIDERS = [
  {
    name: 'chatgpt',
    url: 'https://chatgpt.com',
    runs: 30,
    cloudflare: true,
    // The current ChatGPT UI has no #prompt-textarea: the composer is a
    // ProseMirror textbox, the send button is aria-label="Send" and the
    // assistant turn is marked with data-conversation-role="assistant".
    composer: 'div.ProseMirror[contenteditable="true"][role="textbox"], #prompt-textarea',
    send: 'button[aria-label="Send"], #composer-submit-button, [data-testid="send-button"]',
    response:
      '[data-conversation-role="assistant"], [data-message-author-role="assistant"], .agent-turn',
    login: 'button:has-text("Log in"), button:has-text("Sign up")',
  },
  {
    name: 'gemini',
    url: 'https://gemini.google.com/app',
    runs: 10,
    cloudflare: false,
    composer: '.ql-editor[contenteditable="true"], div[role="textbox"][aria-label*="Enter"]',
    send: 'button.send-button, button[aria-label="Send message"]',
    // One DOM level: the text of the answer. The container `model-response`
    // holds the answer as `message-content` as well — a selector that matches
    // both counts every answer twice.
    response: 'model-response .model-response-text',
    login: 'a:has-text("Sign in")',
  },
  {
    name: 'claude',
    url: 'https://claude.ai/new',
    runs: 10,
    cloudflare: false,
    // The composer is the ProseMirror textbox. The UI also keeps a hidden
    // TEXTAREA (the same enterkeyhint) that comes first in the DOM under
    // Firefox — filling that one silently loses the prompt, so the textbox
    // is addressed explicitly.
    composer:
      'div.ProseMirror[contenteditable="true"][role="textbox"], div[contenteditable="true"][role="textbox"], div[enterkeyhint="enter"][role="textbox"]',
    send: 'button[aria-label="Send message"], button[aria-label*="Send"], button[type="submit"]',
    // The current Claude UI marks the assistant turn with
    // data-testid="assistant-message"; the answer text itself lives in
    // [data-perf-reply-text] inside it. The user turn is
    // [data-testid="user-message"].
    response: '[data-testid="assistant-message"], [data-cds="AssistantMessage"]',
    login: 'button:has-text("Log in")',
  },
];

/**
 * The alternatives of a selector: `a, b` are two alternatives.
 *
 * @param {string} selector a CSS selector
 * @returns {string[]} the alternatives of the selector
 */
export function selectorAlternatives(selector) {
  return selector
    .split(',')
    .map((alternative) => alternative.trim())
    .filter(Boolean);
}

/**
 * The container of an alternative: the first part of the selector.
 *
 * Two alternatives that share their container may match two elements of the
 * *same* answer — the container and the element inside it. That is how one
 * answer used to be counted twice.
 *
 * @param {string} alternative one alternative of a selector
 * @returns {string} the container of the alternative
 */
export function alternativeContainer(alternative) {
  return alternative.split(/\s+/)[0] ?? alternative;
}
