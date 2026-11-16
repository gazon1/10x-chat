/**
 * Pure helpers of the provider matrix.
 *
 * Two problems are solved here, away from the browser code, so both can be
 * unit-tested without launching anything:
 *
 * 1. **Outcome classification.** A redirect to a login page is an auth
 *    failure, not a provider error — the UI of the login page may still render
 *    a shell that looks like a normal page. The URL is therefore classified
 *    separately from the DOM and from infrastructure errors.
 * 2. **Answer bookkeeping.** A provider session can already contain history,
 *    so "the first assistant turn is visible and non-empty" does not prove
 *    that *this* prompt was answered. The number of answers is therefore
 *    counted before the prompt is sent, and only an answer that appeared
 *    afterwards counts.
 */

/** A page that means "the session is gone": the provider asked to log in again. */
export const LOGIN_URL = /\/login|\/signin|\/auth\/login|accounts\.google\.com/i;

/**
 * Text of a provider that serves the request but keeps the answer behind an
 * account ("Sign up and repeat your request", "Sign in to chat", …).
 *
 * Such a combination is *not measurable* without credentials — it says
 * nothing about the engine — so it is reported as `skipped` and not as a
 * failure of the browser.
 */
export const SIGNUP_WALL =
  /sign up and repeat your request|sign in to (continue|ask|chat|use perplexity)|log in to (continue|chat)|create an account to continue|sign in or sign up to continue/i;

/** The title of a Cloudflare interstitial. */
export const CF_TITLE =
  /just a moment|attention required|checking your browser|verify you are human/i;

/**
 * Classify one run.
 *
 * @param {object} run
 * @param {number} run.status HTTP status of the navigation (0 = failed)
 * @param {string} run.title page title
 * @param {string} run.url final URL (after redirects)
 * @param {boolean} run.cfVisible a Cloudflare challenge is on the page
 * @param {boolean} run.loginVisible a login form/button is on the page
 * @param {boolean} run.composerVisible the composer is on the page
 * @returns {'infra-error'|'cloudflare'|'auth-wall'|'composer-visible'|'provider-error'}
 */
export function classifyOutcome({
  status = 0,
  title = '',
  url = '',
  cfVisible = false,
  loginVisible = false,
  composerVisible = false,
} = {}) {
  if (status === 0) return 'infra-error';
  if (cfVisible || CF_TITLE.test(title) || status === 403 || status === 503) return 'cloudflare';
  // The provider redirected to a login page: the session is not authorized.
  // This is checked before the DOM, because a login page can render a composer
  // or a shell that would otherwise be classified as a provider error.
  if (LOGIN_URL.test(url)) return 'auth-wall';
  if (loginVisible && !composerVisible) return 'auth-wall';
  if (composerVisible) return 'composer-visible';
  return 'provider-error';
}

/** A marker that ties one exchange to its answer. */
export function newMarker(prefix = 'probe') {
  const stamp = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 8);
  return `${prefix}-${stamp}-${rand}`;
}

/**
 * The probe prompt: a fixed instruction plus the marker of this exchange.
 * The marker lets the harness tell "the answer to this prompt" from "an
 * answer that was already on the page".
 */
export function probePrompt(marker) {
  return `Reply with the single word: READY. Marker: ${marker}`;
}

/**
 * The index of the answer that appeared after the prompt was sent.
 *
 * @param {number} before how many answers were on the page before the prompt
 * @param {number} after how many answers are on the page now
 * @throws when no new answer appeared
 */
export function newAnswerIndex(before, after) {
  if (!Number.isInteger(before) || !Number.isInteger(after)) {
    throw new Error(`invalid answer counts (before=${before}, after=${after})`);
  }
  if (after <= before) {
    throw new Error(`no new answer appeared (before=${before}, after=${after})`);
  }
  // The new answer is the last one: providers append the assistant turn.
  return after - 1;
}

/** Did the answer mention the marker of the exchange? (diagnostic) */
export function containsMarker(text, marker) {
  return typeof text === 'string' && typeof marker === 'string' && text.includes(marker);
}
