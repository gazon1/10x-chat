import { acquireLock, type Lock } from '../core/lock.js';

const LOCK_NAME = '10x-chat.lock';

export type ProfileLock = Lock;

/**
 * Acquire the lock of a provider profile directory.
 * Prevents concurrent browser sessions on the same profile.
 *
 * The implementation is shared with the other locks of the project
 * (`src/core/lock.ts`).
 */
export async function acquireProfileLock(
  profileDir: string,
  opts: { timeoutMs?: number; pollMs?: number } = {},
): Promise<ProfileLock> {
  return acquireLock(profileDir, LOCK_NAME, {
    timeoutMs: opts.timeoutMs,
    pollMs: opts.pollMs,
    hint: 'Another 10x-chat session may be using this profile.',
  });
}
