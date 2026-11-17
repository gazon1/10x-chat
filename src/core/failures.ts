import chalk from 'chalk';
import type { BrowserContext, Page } from 'playwright';
import { saveStorageState } from '../browser/state.js';
import type { Provider, ProviderName } from '../types.js';

/**
 * The failure kinds of a provider run.
 *
 * They answer the question the user actually has when a run fails: does the
 * site block the browser, is the session gone, or is the site not there at
 * all?
 */
export type FailureKind = 'antibot' | 'unauthorized' | 'unavailable';

/** The site answered with a bot challenge (Cloudflare) instead of the app. */
export class AntibotChallengeError extends Error {
  constructor(message = 'The site answered with a bot challenge (Cloudflare).') {
    super(message);
    this.name = 'AntibotChallengeError';
  }
}

/** The session is not authorized any more — the provider asks to log in. */
export class UnauthorizedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnauthorizedError';
  }
}

/** The site could not be loaded. */
export class SiteUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SiteUnavailableError';
  }
}

/** The kind of a failure, or undefined when the error is not classified. */
export function failureKind(error: unknown): FailureKind | undefined {
  if (error instanceof AntibotChallengeError) return 'antibot';
  if (error instanceof UnauthorizedError) return 'unauthorized';
  if (error instanceof SiteUnavailableError) return 'unavailable';
  return undefined;
}

/** Keep the kind of a failure when the error is wrapped with its context. */
export function reclassify(kind: FailureKind, message: string): Error {
  switch (kind) {
    case 'antibot':
      return new AntibotChallengeError(message);
    case 'unauthorized':
      return new UnauthorizedError(message);
    case 'unavailable':
      return new SiteUnavailableError(message);
  }
}

/** What the user can do about a failure. */
export function failureHint(kind: FailureKind): string {
  switch (kind) {
    case 'antibot':
      return 'The site showed a bot challenge. Run with --headed and complete the challenge in the browser window.';
    case 'unauthorized':
      return 'The session is not authorized. Log in first: 10x-chat login <provider>';
    case 'unavailable':
      return 'The site did not load. Check the network and the proxy.';
  }
}

/** Print the hint of a classified failure — nothing for an unclassified one. */
export function printFailureHint(error: unknown): void {
  const kind = failureKind(error);
  if (kind) console.error(chalk.yellow(`Hint: ${failureHint(kind)}`));
}

// ── Bot challenge ───────────────────────────────────────────────

/** The titles of the Cloudflare interstitial. */
const CHALLENGE_TITLE =
  /just a moment|attention required|checking your browser|verify you are human/i;

/** The elements of the Cloudflare interstitial. */
const CHALLENGE_SELECTORS =
  '#challenge-running, #challenge-form, .cf-browser-verification, #cf-challenge-running';

/** Is this the title of a bot challenge? */
export function isChallengeTitle(title: string): boolean {
  return CHALLENGE_TITLE.test(title);
}

/** Is a bot challenge on the page? */
export async function isChallengeVisible(page: Page): Promise<boolean> {
  const title = await page.title().catch(() => '');
  if (isChallengeTitle(title)) return true;
  return page
    .locator(CHALLENGE_SELECTORS)
    .first()
    .isVisible()
    .catch(() => false);
}

/**
 * Wait until the user has solved the challenge in the window.
 *
 * One attempt with a deadline: the challenge is either gone or the run fails.
 * There is no retry loop — a challenge that repeats itself is a block, not a
 * slow page.
 */
export async function waitForChallengeToPass(page: Page, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await isChallengeVisible(page))) return true;
    await page.waitForTimeout(1000).catch(() => {});
  }
  return !(await isChallengeVisible(page));
}

/** How long the user has to solve a challenge in the visible window. */
export const MANUAL_CHALLENGE_TIMEOUT_MS = 120_000;

export interface SessionCheck {
  page: Page;
  /** The browser is visible — the user can solve a challenge in it. */
  headed: boolean;
  /** The provider's own login check. */
  isLoggedIn: () => Promise<boolean>;
  /** The display name of the provider (for the error message). */
  provider?: string;
  /** The command that logs the user in (for the error message). */
  loginCommand?: string;
  /** Persist the session — the next run reuses the cleared state. */
  saveSession?: () => Promise<void>;
  /** How long the user has to solve the challenge. */
  timeoutMs?: number;
}

/**
 * The login check of a run.
 *
 * A challenge is a state of its own: the user is asked to solve it in the
 * window that is already open, and the run continues when it is gone. There
 * is no second attempt — a challenge that is not solved in time fails the run
 * with an antibot error. A session that is not authorized fails with an
 * unauthorized error, a site that does not load with an unavailable one.
 */
export async function checkSession(opts: SessionCheck): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? MANUAL_CHALLENGE_TIMEOUT_MS;
  let recovered = false;

  const recover = async (): Promise<void> => {
    if (recovered || !opts.headed) {
      throw new AntibotChallengeError();
    }
    recovered = true;
    console.log(
      chalk.yellow(
        `Bot challenge detected — complete it in the browser window (${Math.round(timeoutMs / 1000)}s).`,
      ),
    );
    const passed = await waitForChallengeToPass(opts.page, timeoutMs);
    if (!passed) {
      throw new AntibotChallengeError('The bot challenge was not solved in time.');
    }
    await opts.saveSession?.();
  };

  let loggedIn: boolean;
  if (await isChallengeVisible(opts.page)) {
    await recover();
    loggedIn = await opts.isLoggedIn();
  } else {
    try {
      loggedIn = await opts.isLoggedIn();
    } catch (error) {
      if (!(error instanceof AntibotChallengeError)) throw error;
      await recover();
      loggedIn = await opts.isLoggedIn();
    }
  }

  if (loggedIn) return;

  // The challenge can appear while the provider's own check is waiting: most
  // providers answer "not logged in" instead of reporting the challenge. Ask
  // the page once more before calling the session lost.
  if (await isChallengeVisible(opts.page)) {
    await recover();
    loggedIn = await opts.isLoggedIn();
    if (loggedIn) return;
  }

  const kind = await classifySessionFailure(opts.page);
  if (kind === 'unavailable') {
    throw new SiteUnavailableError(
      `${opts.provider ?? 'The provider'} did not load (${opts.page.url()}).`,
    );
  }
  throw new UnauthorizedError(
    `Not logged in to ${opts.provider ?? 'the provider'}. Run: ${opts.loginCommand ?? '10x-chat login'}`,
  );
}

export interface ProviderSession {
  page: Page;
  context: BrowserContext;
  provider: Provider;
  providerName: ProviderName;
  /** The browser is headless — the user cannot solve a challenge in it. */
  headless: boolean;
  /** The cookies of this run live in the shared storage-state.json. */
  sharedState: boolean;
}

/**
 * The session check of a command that talks to a provider.
 *
 * One implementation for chat, research, image, delegate and history: a bot
 * challenge is solved in the window that is already open, the cleared session
 * is saved for the next run, and the failure is classified.
 */
export async function checkProviderSession(session: ProviderSession): Promise<void> {
  await checkSession({
    page: session.page,
    headed: !session.headless,
    provider: session.provider.config.displayName,
    loginCommand: `10x-chat login ${session.providerName}`,
    isLoggedIn: () => session.provider.actions.isLoggedIn(session.page),
    // An isolated or a named profile keeps its cookies in its own directory —
    // writing them into the shared state would cross the boundary of the
    // isolation and leak the session into the other providers.
    saveSession: session.sharedState ? () => saveStorageState(session.context) : undefined,
  });
}

// ── Session failure ─────────────────────────────────────────────
/** The URL of a login wall. */
const LOGIN_URL = /\/(?:log|sign)[_-]?in|auth\/login|accounts\.google\.com/i;

/** The title of a site that is not available. */
const UNAVAILABLE_TITLE =
  /502 bad gateway|503 service unavailable|504 gateway|site can'?t be reached|this site can'?t be reached/i;

/**
 * Why the session is not usable: the site asks to log in, or it is not
 * available at all.
 */
export async function classifySessionFailure(page: Page): Promise<'unauthorized' | 'unavailable'> {
  if (LOGIN_URL.test(page.url())) return 'unauthorized';
  const title = await page.title().catch(() => '');
  if (UNAVAILABLE_TITLE.test(title)) return 'unavailable';
  return 'unauthorized';
}
