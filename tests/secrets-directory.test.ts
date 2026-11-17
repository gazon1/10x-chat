import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The directory of the store that must not be chmod-able. The mock below
// refuses to change its mode.
const state = vi.hoisted(() => ({ protectedDir: '' }));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    default: actual,
    chmod: async (target: string, mode: number) => {
      if (state.protectedDir && target === state.protectedDir) {
        throw Object.assign(new Error('EPERM: operation not permitted, chmod'), {
          code: 'EPERM',
        });
      }
      return actual.chmod(target, mode);
    },
  };
});

const { getSecretStore } = await import('../src/secrets.js');

describe('a directory that cannot be made private', () => {
  const originalEnv = process.env;
  let tempHome = '';

  beforeEach(async () => {
    tempHome = await mkdtemp(path.join(os.tmpdir(), 'ten-x-chat-secrets-dir-'));
    process.env = { ...originalEnv, TEN_X_CHAT_HOME: tempHome };
    state.protectedDir = tempHome;
  });

  afterEach(async () => {
    state.protectedDir = '';
    process.env = originalEnv;
    if (tempHome) await rm(tempHome, { recursive: true, force: true });
  });

  it('refuses to write instead of continuing with unsafe permissions', async () => {
    if (process.platform === 'win32') return; // no POSIX modes on Windows

    await expect(getSecretStore().set('openai-key', 'value')).rejects.toThrow(
      /Cannot make the secrets directory .* private/,
    );
  });

  it('refuses to read instead of continuing with unsafe permissions', async () => {
    if (process.platform === 'win32') return; // no POSIX modes on Windows

    // The directory that holds the secrets is not private: the file may be
    // replaced under us — the read fails closed.
    await expect(getSecretStore().list()).rejects.toThrow(
      /Cannot make the secrets directory .* private/,
    );
  });
});
