import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { BrowserContext, Page } from 'playwright';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getStorageStatePath, loadStorageState } from '../src/browser/state.js';
import {
  AntibotChallengeError,
  checkProviderSession,
  checkSession,
  classifySessionFailure,
  failureHint,
  failureKind,
  isChallengeTitle,
  isChallengeVisible,
  ProviderGenerationError,
  printFailureHint,
  reclassify,
  SiteUnavailableError,
  UnauthorizedError,
  waitForChallengeToPass,
} from '../src/core/failures.js';
import type { Provider } from '../src/types.js';

/**
 * A page that answers with a fixed script of titles: every call to title()
 * takes the next one, the last one repeats. That is enough to describe a
 * challenge that is solved while the user works on it.
 */
class FakePage {
  private readonly titles: string[];
  private current?: string;
  /** Called on every wait — the moment the user works on the challenge. */
  onWait?: () => void;

  constructor(
    titles: string[],
    private readonly pageUrl = 'https://example.test/',
  ) {
    this.titles = [...titles];
  }

  async title(): Promise<string> {
    if (this.current !== undefined) return this.current;
    if (this.titles.length > 1) return this.titles.shift() as string;
    return this.titles[0] ?? '';
  }

  /** The page shows this title from now on. */
  showTitle(title: string): void {
    this.current = title;
  }

  url(): string {
    return this.pageUrl;
  }

  locator(): unknown {
    return { first: () => ({ isVisible: async () => false }) };
  }

  async waitForTimeout(): Promise<void> {
    this.onWait?.();
  }
}

function asPage(page: FakePage): Page {
  return page as unknown as Page;
}

describe('bot challenge', () => {
  it('recognizes the titles of the Cloudflare interstitial', () => {
    expect(isChallengeTitle('Just a moment...')).toBe(true);
    expect(isChallengeTitle('Attention Required! | Cloudflare')).toBe(true);
    expect(isChallengeTitle('Checking your browser before accessing')).toBe(true);
    expect(isChallengeTitle('ChatGPT')).toBe(false);
  });

  it('detects a challenge on the page', async () => {
    expect(await isChallengeVisible(asPage(new FakePage(['Just a moment...'])))).toBe(true);
    expect(await isChallengeVisible(asPage(new FakePage(['ChatGPT'])))).toBe(false);
  });

  it('waits until the challenge is gone', async () => {
    const page = asPage(new FakePage(['Just a moment...', 'ChatGPT']));
    expect(await waitForChallengeToPass(page, 1_000)).toBe(true);
  });
});

describe('the session check of a run', () => {
  it('lets the user solve the challenge in the open window and continues', async () => {
    const page = asPage(new FakePage(['Just a moment...', 'ChatGPT']));
    const saveSession = vi.fn();

    await checkSession({
      page,
      headed: true,
      timeoutMs: 1_000,
      isLoggedIn: async () => true,
      saveSession,
    });

    // The clearance cookie is kept — the next run reuses the session.
    expect(saveSession).toHaveBeenCalledTimes(1);
  });

  it('fails after one attempt when the challenge is not solved', async () => {
    const page = asPage(new FakePage(['Just a moment...']));

    await expect(
      checkSession({
        page,
        headed: true,
        timeoutMs: 0,
        isLoggedIn: async () => true,
      }),
    ).rejects.toBeInstanceOf(AntibotChallengeError);
  });

  it('fails without a window when the browser is headless', async () => {
    const page = asPage(new FakePage(['Just a moment...']));
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    await expect(
      checkSession({
        page,
        headed: false,
        timeoutMs: 0,
        isLoggedIn: async () => true,
      }),
    ).rejects.toBeInstanceOf(AntibotChallengeError);
    // No hint about a window the user cannot see.
    expect(log).not.toHaveBeenCalled();
    log.mockRestore();
  });

  it('does not probe the provider while the challenge is unsolved', async () => {
    const page = asPage(new FakePage(['Just a moment...']));
    const isLoggedIn = vi.fn(async () => true);

    await expect(
      checkSession({ page, headed: true, timeoutMs: 0, isLoggedIn }),
    ).rejects.toBeInstanceOf(AntibotChallengeError);
    expect(isLoggedIn).not.toHaveBeenCalled();
  });

  it('does not loop when the provider keeps reporting a challenge', async () => {
    const page = asPage(new FakePage(['ChatGPT']));
    const isLoggedIn = vi.fn(async () => {
      throw new AntibotChallengeError();
    });

    await expect(
      checkSession({ page, headed: true, timeoutMs: 0, isLoggedIn }),
    ).rejects.toBeInstanceOf(AntibotChallengeError);
    // The initial check and one retry — never a loop.
    expect(isLoggedIn.mock.calls.length).toBeLessThanOrEqual(2);
  });

  it('solves a challenge that appears while the provider checks the session', async () => {
    const page = new FakePage(['ChatGPT']);
    const saveSession = vi.fn();
    const isLoggedIn = vi.fn(async () => {
      // The provider waits for its selectors — the challenge shows up there.
      if (isLoggedIn.mock.calls.length === 1) page.showTitle('Just a moment...');
      return isLoggedIn.mock.calls.length > 1;
    });
    // The user solves the challenge in the window.
    page.onWait = () => page.showTitle('ChatGPT');

    await checkSession({
      page: asPage(page),
      headed: true,
      timeoutMs: 1_000,
      isLoggedIn,
      saveSession,
    });

    // The challenge was solved and the cleared session saved.
    expect(isLoggedIn).toHaveBeenCalledTimes(2);
    expect(saveSession).toHaveBeenCalledTimes(1);
  });

  it('calls a challenge that appears during the check an antibot failure', async () => {
    const page = new FakePage(['ChatGPT']);
    const isLoggedIn = vi.fn(async () => {
      page.showTitle('Just a moment...');
      return false;
    });

    await expect(
      checkSession({ page: asPage(page), headed: true, timeoutMs: 50, isLoggedIn }),
    ).rejects.toBeInstanceOf(AntibotChallengeError);
  });

  it('calls a challenge that appears during the check an antibot failure without a window', async () => {
    const page = new FakePage(['ChatGPT']);
    const isLoggedIn = vi.fn(async () => {
      page.showTitle('Just a moment...');
      return false;
    });

    await expect(
      checkSession({ page: asPage(page), headed: false, timeoutMs: 50, isLoggedIn }),
    ).rejects.toBeInstanceOf(AntibotChallengeError);
  });

  it('reports a session that is not authorized', async () => {
    const page = asPage(new FakePage(['ChatGPT'], '/auth/login'));

    await expect(
      checkSession({
        page,
        headed: true,
        provider: 'ChatGPT',
        loginCommand: '10x-chat login chatgpt',
        isLoggedIn: async () => false,
      }),
    ).rejects.toThrow(/10x-chat login chatgpt/);
  });

  it('reports a site that is not available', async () => {
    const page = asPage(new FakePage(['502 Bad Gateway']));

    await expect(
      checkSession({
        page,
        headed: true,
        provider: 'ChatGPT',
        isLoggedIn: async () => false,
      }),
    ).rejects.toBeInstanceOf(SiteUnavailableError);
  });
});

describe('failure classification', () => {
  it('knows the kind of a failure', () => {
    expect(failureKind(new AntibotChallengeError())).toBe('antibot');
    expect(failureKind(new UnauthorizedError('no session'))).toBe('unauthorized');
    expect(failureKind(new SiteUnavailableError('down'))).toBe('unavailable');
    expect(failureKind(new ProviderGenerationError('stream failed'))).toBe('generation');
    expect(failureKind(new Error('something else'))).toBeUndefined();
  });

  it('keeps the kind when the error is wrapped', () => {
    const wrapped = reclassify('antibot', 'Chat operation failed (provider=chatgpt)');
    expect(failureKind(wrapped)).toBe('antibot');
    expect(wrapped.message).toContain('provider=chatgpt');
  });

  it('has a hint for every kind', () => {
    expect(failureHint('antibot')).toMatch(/--headed/);
    expect(failureHint('unauthorized')).toMatch(/login/);
    expect(failureHint('unavailable')).toMatch(/proxy/);
    expect(failureHint('generation')).toMatch(/generating/);
  });

  it('keeps the generation kind when the error is wrapped', () => {
    const wrapped = reclassify('generation', 'Chat operation failed (provider=chatgpt)');
    expect(wrapped).toBeInstanceOf(ProviderGenerationError);
    expect(failureKind(wrapped)).toBe('generation');
  });

  it('prints the hint of a classified failure and nothing else', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    printFailureHint(new AntibotChallengeError());
    expect(error.mock.calls[0]?.[0]).toMatch(/--headed/);

    error.mockClear();
    printFailureHint(new Error('something else'));
    expect(error).not.toHaveBeenCalled();

    error.mockRestore();
  });

  it('tells a login wall from a site that is not available', async () => {
    expect(await classifySessionFailure(asPage(new FakePage(['ChatGPT'], '/auth/login')))).toBe(
      'unauthorized',
    );
    expect(await classifySessionFailure(asPage(new FakePage(['502 Bad Gateway'])))).toBe(
      'unavailable',
    );
    expect(await classifySessionFailure(asPage(new FakePage(['ChatGPT'])))).toBe('unauthorized');
  });
});

describe('the session check of a provider command', () => {
  const originalEnv = process.env;
  let home: string;

  beforeEach(async () => {
    process.env = { ...originalEnv };
    home = await mkdtemp(path.join(os.tmpdir(), '10x-chat-session-'));
    process.env.TEN_X_CHAT_HOME = home;
  });

  afterEach(async () => {
    process.env = originalEnv;
    await rm(home, { recursive: true, force: true });
  });

  const provider = (isLoggedIn: () => Promise<boolean>): Provider => ({
    config: {
      name: 'chatgpt',
      displayName: 'ChatGPT',
      url: 'https://chatgpt.com',
      loginUrl: 'https://chatgpt.com/auth/login',
      defaultTimeoutMs: 1_000,
    },
    actions: {
      isLoggedIn,
      submitPrompt: async () => {},
      captureResponse: async () => ({ text: '', markdown: '' }),
    },
  });

  it('saves the cleared session after the user solved the challenge', async () => {
    const page = asPage(new FakePage(['Just a moment...', 'ChatGPT']));
    const context = {
      storageState: async ({ path: file }: { path: string }) => {
        await writeFile(file, JSON.stringify({ cookies: [{ name: 'cf_clearance' }], origins: [] }));
      },
    } as unknown as BrowserContext;

    await checkProviderSession({
      page,
      context,
      provider: provider(async () => true),
      providerName: 'chatgpt',
      headless: false,
      sharedState: true,
    });

    // The next run reuses the session.
    expect(await loadStorageState()).toBe(getStorageStatePath());
  });

  it('keeps an isolated profile out of the shared state', async () => {
    const page = asPage(new FakePage(['Just a moment...', 'ChatGPT']));
    const context = {
      storageState: async ({ path: file }: { path: string }) => {
        await writeFile(file, JSON.stringify({ cookies: [{ name: 'cf_clearance' }], origins: [] }));
      },
    } as unknown as BrowserContext;

    await checkProviderSession({
      page,
      context,
      provider: provider(async () => true),
      providerName: 'chatgpt',
      headless: false,
      // An isolated or named profile keeps its cookies in its own directory.
      sharedState: false,
    });

    expect(await loadStorageState()).toBeUndefined();
  });

  it('reports a provider that is not authorized', async () => {
    const page = asPage(new FakePage(['ChatGPT'], '/auth/login'));
    const context = { storageState: async () => {} } as unknown as BrowserContext;

    await expect(
      checkProviderSession({
        page,
        context,
        provider: provider(async () => false),
        providerName: 'chatgpt',
        headless: false,
      }),
    ).rejects.toBeInstanceOf(UnauthorizedError);
  });
});
