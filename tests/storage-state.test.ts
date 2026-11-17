import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { BrowserContext } from 'playwright';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  getStorageStatePath,
  loadStorageState,
  saveStorageState,
  tempStatePath,
} from '../src/browser/state.js';

/**
 * The session reuse of the shared profile: the storage state that the browser
 * has after a run (a manual challenge, a login) is written to disk and found
 * again by the next run.
 */
describe('storage state', () => {
  const originalEnv = process.env;
  let home: string;

  beforeEach(async () => {
    process.env = { ...originalEnv };
    home = await mkdtemp(path.join(os.tmpdir(), '10x-chat-state-'));
    process.env.TEN_X_CHAT_HOME = home;
  });

  afterEach(async () => {
    process.env = originalEnv;
    await rm(home, { recursive: true, force: true });
  });

  it('saves the state of a session and finds it again', async () => {
    const context = {
      storageState: async ({ path: file }: { path: string }) => {
        await writeFile(file, JSON.stringify({ cookies: [{ name: 'cf_clearance' }], origins: [] }));
      },
    } as unknown as BrowserContext;

    await saveStorageState(context);

    const statePath = getStorageStatePath();
    expect(await loadStorageState()).toBe(statePath);
  });

  it('has no state when nothing was saved yet', async () => {
    expect(await loadStorageState()).toBeUndefined();
  });

  it('ignores a broken state file', async () => {
    const statePath = getStorageStatePath();
    await mkdir(path.dirname(statePath), { recursive: true });
    await writeFile(statePath, 'not json');
    expect(await loadStorageState()).toBeUndefined();
  });

  it('gives every save its own temp file', () => {
    const statePath = getStorageStatePath();
    // Parallel saves of one process (chat --all) must not share a temp file.
    expect(tempStatePath(statePath)).not.toBe(tempStatePath(statePath));
  });

  it('keeps the state when two saves run in parallel', async () => {
    const context = {
      storageState: async ({ path: file }: { path: string }) => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        await writeFile(file, JSON.stringify({ cookies: [], origins: [] }));
      },
    } as unknown as BrowserContext;

    await Promise.all([saveStorageState(context), saveStorageState(context)]);

    const statePath = getStorageStatePath();
    expect(await loadStorageState()).toBe(statePath);
    const leftovers = (await readdir(path.dirname(statePath))).filter((name) =>
      name.endsWith('.tmp'),
    );
    expect(leftovers).toEqual([]);
  });
});
