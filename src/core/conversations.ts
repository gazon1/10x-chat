import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Page } from 'playwright';
import { getAppDir, getConversationsPath } from '../paths.js';
import type { ProviderName } from '../types.js';
import { acquireLock } from './lock.js';

/**
 * Conversation reuse.
 *
 * A provider web app starts a new conversation on its landing page. This cache
 * remembers the conversation URL of the current git repository and branch, so
 * the next run appends to the same chat instead of starting over.
 *
 * The cache is best-effort: a missing or broken file is an empty cache, and a
 * failed write must never break a chat run.
 */

const LOCK_FILENAME = 'conversations.lock';
const LOCK_TIMEOUT_MS = 10_000;
const GIT_TIMEOUT_MS = 2_000;

/** The repository and branch a conversation belongs to. */
export interface ConversationContext {
  repo: string;
  branch: string;
}

/** A conversation URL stored for a provider. */
export interface StoredConversation {
  /** The full URL of the conversation. */
  url: string;
  /** The provider's conversation id, extracted from the URL. */
  id: string;
  /** When the conversation was last used (ISO 8601). */
  updatedAt: string;
}

interface ConversationFile {
  version: 1;
  repos: Record<string, Record<string, Partial<Record<ProviderName, StoredConversation>>>>;
}

/**
 * How to read the conversation id out of a provider URL.
 *
 * The id is the path segment after the marker. A landing page does not match,
 * so the base URL of a provider is never stored as a conversation.
 */
const CONVERSATION_PATTERNS: Partial<Record<ProviderName, RegExp[]>> = {
  chatgpt: [/\/c\/([^/?#]+)/],
  gemini: [/\/app\/([^/?#]+)/],
  claude: [/\/chat\/([^/?#]+)/],
  grok: [/\/c\/([^/?#]+)/, /\/chat\/([^/?#]+)/],
  perplexity: [/\/search\/([^/?#]+)/, /\/thread\/([^/?#]+)/],
  // DeepSeek uses /a/chat/s/<id>; keep the "s/" prefix with the id.
  deepseek: [/\/a\/chat\/([^?#]+)/],
};

/**
 * A transient id of a chat the provider has not stored on its server yet.
 *
 * ChatGPT gives a fresh chat a local id ("local-chatgpt:<uuid>") and replaces
 * it with the permanent one when the first message is sent. Opening the local
 * URL later lands on the landing page — it is not a conversation that can be
 * reopened.
 */
const TRANSIENT_ID = /^local-[a-z0-9]+:/i;

/** Can a conversation with this id be opened again? */
export function isReopenableConversationId(id: string | undefined): boolean {
  return typeof id === 'string' && id.length > 0 && !TRANSIENT_ID.test(id);
}

/**
 * The conversation id of a provider URL, or `undefined` when the URL is not a
 * conversation (the landing page, a share link, a login page, …).
 */
export function conversationIdFromUrl(provider: ProviderName, rawUrl: string): string | undefined {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return undefined;
  }

  for (const pattern of CONVERSATION_PATTERNS[provider] ?? []) {
    const match = url.pathname.match(pattern);
    if (match?.[1]) return decodeURIComponent(match[1]).replace(/\/+$/, '');
  }
  return undefined;
}

/** Run a git command and return its trimmed stdout. */
function git(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, timeout: GIT_TIMEOUT_MS, encoding: 'utf8' }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout.trim());
    });
  });
}

/**
 * The identity of a repository from its remote URL.
 *
 * The same repository is cloned or checked out at different paths (a worktree
 * per task, a second clone, a fork brought in over ssh). The identity must not
 * depend on the path, so the origin URL is used: `git@github.com:o/r.git` and
 * `https://github.com/o/r` are the same repository.
 */
export function repoIdentityFromRemote(remote: string): string | undefined {
  let value = remote.trim();
  if (!value) return undefined;
  // scp-style `user@host:owner/repo` → `host/owner/repo`
  value = value.replace(/^[^@/:]+@([^:/]+):/, '$1/');
  value = value.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').replace(/^[^/@]+@/, '');
  value = value.replace(/\/+$/, '').replace(/\.git$/i, '');
  return value ? value.toLowerCase() : undefined;
}

/**
 * The stable identity of the repository this run belongs to.
 *
 * The origin URL is used first, so every worktree and clone of the same
 * repository shares its conversations. Without a remote, the git common
 * directory is used — it is shared by the worktrees of one clone.
 */
async function resolveRepoIdentity(cwd: string, root: string): Promise<string> {
  try {
    const identity = repoIdentityFromRemote(
      await git(['config', '--get', 'remote.origin.url'], cwd),
    );
    if (identity) return identity;
  } catch {
    // No origin remote — fall through to the common directory.
  }

  try {
    // `--git-common-dir` is relative to the current directory.
    const common = await git(['rev-parse', '--git-common-dir'], cwd);
    if (common) return path.resolve(cwd, common);
  } catch {
    // Fall through to the working tree root.
  }

  return root;
}

/**
 * The repository identity and branch of this run.
 *
 * The repository identity does not depend on the working tree path, so a run
 * from a subdirectory, another worktree or another clone of the same
 * repository finds the same conversation. A detached HEAD uses the short
 * commit, and a directory outside git uses the working directory — the cache
 * still works, it just cannot follow a branch.
 */
export async function resolveConversationContext(
  cwd = process.cwd(),
): Promise<ConversationContext> {
  try {
    const root = await git(['rev-parse', '--show-toplevel'], cwd);
    if (!root) throw new Error('The git repository root is empty');

    let branch = '';
    try {
      branch = await git(['symbolic-ref', '--short', '-q', 'HEAD'], cwd);
    } catch {
      // Detached HEAD — use the commit instead of the branch name.
      branch = await git(['rev-parse', '--short', 'HEAD'], cwd);
    }

    return { repo: await resolveRepoIdentity(cwd, root), branch: branch || '(detached)' };
  } catch {
    return { repo: path.resolve(cwd), branch: '(no-git)' };
  }
}

function emptyStore(): ConversationFile {
  return { version: 1, repos: {} };
}

async function readStore(): Promise<ConversationFile> {
  let raw: string;
  try {
    raw = await readFile(getConversationsPath(), 'utf8');
  } catch {
    return emptyStore();
  }

  try {
    const parsed = JSON.parse(raw) as Partial<ConversationFile>;
    if (!parsed || typeof parsed !== 'object' || typeof parsed.repos !== 'object') {
      return emptyStore();
    }
    return { version: 1, repos: parsed.repos ?? {} };
  } catch {
    // The cache is a convenience: a broken file must not stop a chat.
    return emptyStore();
  }
}

async function writeStore(store: ConversationFile): Promise<void> {
  const filePath = getConversationsPath();
  await mkdir(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(tmpPath, `${JSON.stringify(store, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
    await rename(tmpPath, filePath);
  } catch (error) {
    await import('node:fs/promises').then(({ rm }) => rm(tmpPath, { force: true })).catch(() => {});
    throw error;
  }
}

/** Read-modify-write under the cross-process lock of the cache. */
async function withStoreLock<T>(fn: () => Promise<T>): Promise<T> {
  const dir = getAppDir();
  await mkdir(dir, { recursive: true });
  const lock = await acquireLock(dir, LOCK_FILENAME, { timeoutMs: LOCK_TIMEOUT_MS });
  try {
    return await fn();
  } finally {
    await lock.release();
  }
}

/** The stored conversation of a repository, branch and provider. */
export async function getStoredConversation(
  context: ConversationContext,
  provider: ProviderName,
): Promise<StoredConversation | undefined> {
  const store = await readStore();
  const entry = store.repos[context.repo]?.[context.branch]?.[provider];
  if (!entry || typeof entry.url !== 'string' || typeof entry.id !== 'string') {
    return undefined;
  }
  // A chat without a permanent URL lands on the landing page when it is
  // opened again — it is not a conversation that can be reused.
  if (!isReopenableConversationId(entry.id)) return undefined;
  return entry;
}

/** Store (or replace) the conversation of a repository, branch and provider. */
export async function saveStoredConversation(
  context: ConversationContext,
  provider: ProviderName,
  conversation: StoredConversation,
): Promise<void> {
  // A transient chat has no permanent URL yet: storing it would send the next
  // run to the landing page instead of back into the conversation.
  if (!isReopenableConversationId(conversation.id)) return;
  await withStoreLock(async () => {
    const store = await readStore();
    const branches = store.repos[context.repo] ?? {};
    store.repos[context.repo] = branches;
    const providers = branches[context.branch] ?? {};
    branches[context.branch] = providers;
    providers[provider] = conversation;
    await writeStore(store);
  });
}

/** Forget the conversation of a repository, branch and provider. */
export async function clearStoredConversation(
  context: ConversationContext,
  provider: ProviderName,
): Promise<void> {
  await withStoreLock(async () => {
    const store = await readStore();
    const branches = store.repos[context.repo];
    const providers = branches?.[context.branch];
    if (!branches || !providers || !Object.hasOwn(providers, provider)) return;

    delete providers[provider];
    if (Object.keys(providers).length === 0) delete branches[context.branch];
    if (Object.keys(branches).length === 0) delete store.repos[context.repo];
    await writeStore(store);
  });
}

/** The text a provider renders when the conversation is gone. */
const CONVERSATION_GONE_TEXT =
  /(?:conversation|chat)(?:\s+(?:was|has been|is))?\s+(?:not found|deleted|no longer available|does not exist|doesn't exist)|could(?: not|n't) find (?:that|the|this) (?:conversation|chat)|no (?:conversation|chat) found/i;

/** The URL of a login page — an auth problem, not a gone conversation. */
const LOGIN_URL = /\/(?:login|sign[_-]?in|auth)(?:[/?#]|$)|accounts\.google\.com/i;

/**
 * Is the stored conversation no longer served by the provider?
 *
 * A redirect to the landing page, to a new chat, or a "conversation not found"
 * page means the conversation was deleted or expired. A redirect to a login
 * page is left to the session check — the conversation itself may still exist
 * after the user logs in again.
 */
export async function isConversationGone(
  page: Page,
  provider: ProviderName,
  stored: StoredConversation,
): Promise<boolean> {
  const currentUrl = page.url();
  if (conversationIdFromUrl(provider, currentUrl) === stored.id) {
    const text = await page.evaluate(() => document.body?.innerText ?? '').catch(() => '');
    return CONVERSATION_GONE_TEXT.test(text);
  }

  if (LOGIN_URL.test(currentUrl)) return false;
  return true;
}
