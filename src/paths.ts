import os from 'node:os';
import path from 'node:path';

const APP_DIR_NAME = '.10x-chat';

/** Root directory for all 10x-chat data: ~/.10x-chat */
export function getAppDir(): string {
  return process.env.TEN_X_CHAT_HOME ?? path.join(os.homedir(), APP_DIR_NAME);
}

/** Shared profile directory: ~/.10x-chat/profiles/default */
export function getSharedProfileDir(): string {
  return path.join(getAppDir(), 'profiles', 'default');
}

function assertProfileName(name: string): void {
  if (!/^[A-Za-z0-9._-]+$/.test(name) || name === '.' || name === '..') {
    throw new Error(
      'Profile name must contain only letters, numbers, dots, dashes, or underscores',
    );
  }
}

/** Isolated/named profile directory: ~/.10x-chat/profiles/<name> */
export function getIsolatedProfileDir(name: string): string {
  assertProfileName(name);
  return path.join(getAppDir(), 'profiles', name);
}

/** Sessions root: ~/.10x-chat/sessions */
export function getSessionsDir(): string {
  return path.join(getAppDir(), 'sessions');
}

/** Reviews root: ~/.10x-chat/reviews */
export function getReviewsDir(): string {
  return path.join(getAppDir(), 'reviews');
}

/**
 * The identifier of a run — a single name, not a path.
 *
 * The identifier names the directory of the run under the reviews root. A
 * name that carries a separator or a `..` would write the run outside of
 * that root, so it is refused the way a name of a profile is refused.
 */
function assertReviewId(runId: string): void {
  if (!/^[A-Za-z0-9._-]+$/.test(runId) || runId === '.' || runId === '..') {
    throw new Error('Review id must contain only letters, numbers, dots, dashes, or underscores');
  }
}

/** Review directory of a run: ~/.10x-chat/reviews/<id> */
export function getReviewDir(runId: string): string {
  assertReviewId(runId);
  return path.join(getReviewsDir(), runId);
}

/** Session directory for a specific session: ~/.10x-chat/sessions/<id> */
export function getSessionDir(sessionId: string): string {
  return path.join(getSessionsDir(), sessionId);
}

/** Config file path: ~/.10x-chat/config.json */
export function getConfigPath(): string {
  return path.join(getAppDir(), 'config.json');
}

/** Secrets file path: ~/.10x-chat/secrets.json */
export function getSecretsPath(): string {
  return path.join(getAppDir(), 'secrets.json');
}

/** Conversation cache path: ~/.10x-chat/conversations.json */
export function getConversationsPath(): string {
  return path.join(getAppDir(), 'conversations.json');
}
