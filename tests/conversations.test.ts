import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type ConversationContext,
  clearStoredConversation,
  conversationIdFromUrl,
  getStoredConversation,
  isConversationGone,
  isReopenableConversationId,
  repoIdentityFromRemote,
  resolveConversationContext,
  type StoredConversation,
  saveStoredConversation,
  storeCurrentConversation,
} from '../src/core/conversations.js';
import type { ProviderName } from '../src/types.js';

const gitAvailable = (() => {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

function conversation(id: string, url: string): StoredConversation {
  return { id, url, updatedAt: '2026-01-01T00:00:00.000Z' };
}

function fakePage(url: string, text = '') {
  return {
    url: () => url,
    evaluate: async () => text,
  } as never;
}

describe('conversationIdFromUrl', () => {
  const cases: Array<[ProviderName, string, string | undefined]> = [
    ['chatgpt', 'https://chatgpt.com/c/abc-123', 'abc-123'],
    ['chatgpt', 'https://chatgpt.com/g/g-1/c/abc-123?model=x', 'abc-123'],
    ['chatgpt', 'https://chatgpt.com/', undefined],
    ['chatgpt', 'https://chatgpt.com/share/abc', undefined],
    ['gemini', 'https://gemini.google.com/app/abc?hl=en', 'abc'],
    ['gemini', 'https://gemini.google.com/app', undefined],
    ['claude', 'https://claude.ai/chat/abc', 'abc'],
    ['claude', 'https://claude.ai/new', undefined],
    ['grok', 'https://grok.com/c/abc', 'abc'],
    ['grok', 'https://grok.com/chat/abc', 'abc'],
    ['grok', 'https://grok.com/', undefined],
    ['perplexity', 'https://www.perplexity.ai/search/slug-abc', 'slug-abc'],
    ['perplexity', 'https://www.perplexity.ai/thread/abc', 'abc'],
    ['perplexity', 'https://www.perplexity.ai/', undefined],
    ['deepseek', 'https://chat.deepseek.com/a/chat/s/abc', 's/abc'],
    ['deepseek', 'https://chat.deepseek.com/', undefined],
  ];

  for (const [provider, url, expected] of cases) {
    it(`${provider}: ${url}`, () => {
      expect(conversationIdFromUrl(provider, url)).toBe(expected);
    });
  }

  it('returns undefined for a URL that cannot be parsed', () => {
    expect(conversationIdFromUrl('chatgpt', 'not a url')).toBeUndefined();
  });

  it('knows that a local chat id cannot be reopened', () => {
    // ChatGPT gives a fresh chat a local id until the first message is sent.
    const id = conversationIdFromUrl(
      'chatgpt',
      'https://chatgpt.com/c/local-chatgpt%3A62043ce8-0c80-4d09-8a6e-75ffbfb89d5e',
    );
    expect(id).toBe('local-chatgpt:62043ce8-0c80-4d09-8a6e-75ffbfb89d5e');
    expect(isReopenableConversationId(id)).toBe(false);
    expect(isReopenableConversationId('6afdac5a-4c48-83eb-a5de-9c7e8e823d71')).toBe(true);
    expect(isReopenableConversationId(undefined)).toBe(false);
  });
});

describe('conversation cache', () => {
  const originalEnv = process.env;
  let tempHome = '';

  beforeEach(async () => {
    tempHome = await mkdtemp(path.join(os.tmpdir(), 'ten-x-chat-conversations-'));
    process.env = { ...originalEnv, TEN_X_CHAT_HOME: tempHome };
  });

  afterEach(async () => {
    process.env = originalEnv;
    if (tempHome) await rm(tempHome, { recursive: true, force: true });
  });

  const main: ConversationContext = { repo: '/repo/one', branch: 'main' };
  const feature: ConversationContext = { repo: '/repo/one', branch: 'feature/x' };

  it('stores and reads a conversation per repo, branch and provider', async () => {
    await saveStoredConversation(main, 'chatgpt', conversation('abc', 'https://chatgpt.com/c/abc'));
    await saveStoredConversation(
      feature,
      'chatgpt',
      conversation('def', 'https://chatgpt.com/c/def'),
    );
    await saveStoredConversation(main, 'claude', conversation('ghi', 'https://claude.ai/chat/ghi'));

    expect((await getStoredConversation(main, 'chatgpt'))?.id).toBe('abc');
    expect((await getStoredConversation(feature, 'chatgpt'))?.id).toBe('def');
    expect((await getStoredConversation(main, 'claude'))?.id).toBe('ghi');
    expect(await getStoredConversation(main, 'gemini')).toBeUndefined();
  });

  it('does not store a chat that has no permanent URL yet', async () => {
    // The URL of a fresh ChatGPT chat points to the landing page when it is
    // opened again — such a chat must not become the stored conversation.
    await saveStoredConversation(
      main,
      'chatgpt',
      conversation('local-chatgpt:62043ce8', 'https://chatgpt.com/c/local-chatgpt%3A62043ce8'),
    );

    expect(await getStoredConversation(main, 'chatgpt')).toBeUndefined();
  });

  it('keeps the previous conversation when the new chat has no permanent URL yet', async () => {
    // A chat that continues in a new one has no permanent URL until its
    // first message is sent. A run that fails in between must not lose the
    // conversation: the previous one stays.
    await saveStoredConversation(main, 'chatgpt', conversation('abc', 'https://chatgpt.com/c/abc'));

    const stored = await storeCurrentConversation(
      main,
      'chatgpt',
      'https://chatgpt.com/c/local-chatgpt%3A62043ce8',
    );

    expect(stored).toBe(false);
    expect((await getStoredConversation(main, 'chatgpt'))?.id).toBe('abc');
  });

  it('replaces the previous conversation when the new chat has a permanent URL', async () => {
    await saveStoredConversation(main, 'chatgpt', conversation('abc', 'https://chatgpt.com/c/abc'));

    const stored = await storeCurrentConversation(main, 'chatgpt', 'https://chatgpt.com/c/def');

    expect(stored).toBe(true);
    expect((await getStoredConversation(main, 'chatgpt'))?.id).toBe('def');
  });

  it('writes the file atomically with owner-only permissions', async () => {
    await saveStoredConversation(main, 'chatgpt', conversation('abc', 'https://chatgpt.com/c/abc'));

    const filePath = path.join(tempHome, 'conversations.json');
    const parsed = JSON.parse(await readFile(filePath, 'utf8'));
    expect(parsed.repos['/repo/one'].main.chatgpt).toEqual(
      conversation('abc', 'https://chatgpt.com/c/abc'),
    );

    const info = await stat(filePath);
    expect(info.mode & 0o777).toBe(0o600);
  });

  it('clears only the requested conversation', async () => {
    await saveStoredConversation(main, 'chatgpt', conversation('abc', 'https://chatgpt.com/c/abc'));
    await saveStoredConversation(main, 'claude', conversation('def', 'https://claude.ai/chat/def'));

    await clearStoredConversation(main, 'chatgpt');

    expect(await getStoredConversation(main, 'chatgpt')).toBeUndefined();
    expect((await getStoredConversation(main, 'claude'))?.id).toBe('def');
  });

  it('treats a broken file as an empty cache and replaces it', async () => {
    const filePath = path.join(tempHome, 'conversations.json');
    await writeFile(filePath, '{ broken', 'utf8');

    expect(await getStoredConversation(main, 'chatgpt')).toBeUndefined();

    await saveStoredConversation(main, 'chatgpt', conversation('abc', 'https://chatgpt.com/c/abc'));
    expect((await getStoredConversation(main, 'chatgpt'))?.id).toBe('abc');
  });

  it('keeps the entries of two providers saved at the same time', async () => {
    await Promise.all([
      saveStoredConversation(main, 'chatgpt', conversation('abc', 'https://chatgpt.com/c/abc')),
      saveStoredConversation(main, 'claude', conversation('def', 'https://claude.ai/chat/def')),
    ]);

    expect((await getStoredConversation(main, 'chatgpt'))?.id).toBe('abc');
    expect((await getStoredConversation(main, 'claude'))?.id).toBe('def');
  });

  it('does not throw when clearing a conversation that is not stored', async () => {
    await expect(clearStoredConversation(main, 'gemini')).resolves.toBeUndefined();
  });
});

describe('repoIdentityFromRemote', () => {
  const cases: Array<[string, string | undefined]> = [
    ['git@github.com:Owner/Repo.git', 'github.com/owner/repo'],
    ['https://github.com/Owner/Repo', 'github.com/owner/repo'],
    ['https://github.com/Owner/Repo.git/', 'github.com/owner/repo'],
    ['ssh://git@github.com/Owner/Repo.git', 'github.com/owner/repo'],
    ['https://user:pass@github.com/Owner/Repo.git', 'github.com/owner/repo'],
    ['', undefined],
  ];

  for (const [remote, expected] of cases) {
    it(`${remote || '(empty)'} → ${expected ?? 'no identity'}`, () => {
      expect(repoIdentityFromRemote(remote)).toBe(expected);
    });
  }
});

describe('resolveConversationContext', () => {
  let dir = '';

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it('falls back to the working directory outside git', async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'ten-x-chat-nogit-'));
    const context = await resolveConversationContext(dir);

    expect(context.repo).toBe(path.resolve(dir));
    expect(context.branch).toBe('(no-git)');
  });

  it.skipIf(!gitAvailable)('uses the git common directory and the checked-out branch', async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'ten-x-chat-git-'));
    execFileSync('git', ['init'], { cwd: dir, stdio: 'ignore' });
    execFileSync('git', ['symbolic-ref', 'HEAD', 'refs/heads/main'], {
      cwd: dir,
      stdio: 'ignore',
    });
    execFileSync(
      'git',
      [
        '-c',
        'user.name=Test',
        '-c',
        'user.email=test@example.com',
        'commit',
        '--allow-empty',
        '-m',
        'init',
      ],
      { cwd: dir, stdio: 'ignore' },
    );
    execFileSync('git', ['checkout', '-b', 'feature/test'], { cwd: dir, stdio: 'ignore' });

    const subdir = path.join(dir, 'src', 'nested');
    await mkdir(subdir, { recursive: true });

    const context = await resolveConversationContext(subdir);
    expect(await realpath(context.repo)).toBe(path.join(await realpath(dir), '.git'));
    expect(context.branch).toBe('feature/test');
  });

  it.skipIf(!gitAvailable)('keys two worktrees of one repository the same', async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'ten-x-chat-worktree-'));
    execFileSync('git', ['init'], { cwd: dir, stdio: 'ignore' });
    execFileSync('git', ['symbolic-ref', 'HEAD', 'refs/heads/main'], {
      cwd: dir,
      stdio: 'ignore',
    });
    execFileSync(
      'git',
      [
        '-c',
        'user.name=Test',
        '-c',
        'user.email=test@example.com',
        'commit',
        '--allow-empty',
        '-m',
        'init',
      ],
      { cwd: dir, stdio: 'ignore' },
    );
    execFileSync('git', ['remote', 'add', 'origin', 'git@github.com:Owner/Repo.git'], {
      cwd: dir,
      stdio: 'ignore',
    });
    const worktree = path.join(dir, 'wt');
    execFileSync('git', ['worktree', 'add', '-b', 'feature/test', worktree], {
      cwd: dir,
      stdio: 'ignore',
    });

    const main = await resolveConversationContext(dir);
    const feature = await resolveConversationContext(worktree);

    expect(main.repo).toBe('github.com/owner/repo');
    expect(feature.repo).toBe(main.repo);
    expect(feature.branch).toBe('feature/test');
  });

  it.skipIf(!gitAvailable)('uses the short commit for a detached HEAD', async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'ten-x-chat-detached-'));
    execFileSync('git', ['init'], { cwd: dir, stdio: 'ignore' });
    execFileSync('git', ['symbolic-ref', 'HEAD', 'refs/heads/main'], {
      cwd: dir,
      stdio: 'ignore',
    });
    execFileSync(
      'git',
      [
        '-c',
        'user.name=Test',
        '-c',
        'user.email=test@example.com',
        'commit',
        '--allow-empty',
        '-m',
        'init',
      ],
      { cwd: dir, stdio: 'ignore' },
    );
    execFileSync('git', ['checkout', '--detach'], { cwd: dir, stdio: 'ignore' });
    const sha = execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
      cwd: dir,
      encoding: 'utf8',
    }).trim();

    const context = await resolveConversationContext(dir);
    expect(context.branch).toBe(sha);
  });
});

describe('isConversationGone', () => {
  const stored = conversation('abc', 'https://chatgpt.com/c/abc');

  it('keeps a reachable conversation', async () => {
    expect(
      await isConversationGone(fakePage('https://chatgpt.com/c/abc', 'Hello'), 'chatgpt', stored),
    ).toBe(false);
  });

  it('detects a conversation-not-found page', async () => {
    expect(
      await isConversationGone(
        fakePage('https://chatgpt.com/c/abc', 'Conversation not found'),
        'chatgpt',
        stored,
      ),
    ).toBe(true);
  });

  it('detects a redirect to the landing page', async () => {
    expect(await isConversationGone(fakePage('https://chatgpt.com/', ''), 'chatgpt', stored)).toBe(
      true,
    );
  });

  it('does not call a login redirect a gone conversation', async () => {
    expect(
      await isConversationGone(fakePage('https://chatgpt.com/auth/login', ''), 'chatgpt', stored),
    ).toBe(false);
  });
});
