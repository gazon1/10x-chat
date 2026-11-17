import { spawn } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { acquireLock } from '../src/core/lock.js';

const LOCK_FILENAME = 'test.lock';

describe('the lock', () => {
  let tempDir = '';
  const children: ReturnType<typeof spawn>[] = [];

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'ten-x-chat-lock-'));
  });

  afterEach(async () => {
    for (const child of children.splice(0)) child.kill();
    if (tempDir) await rm(tempDir, { recursive: true, force: true });
  });

  const logFile = () => path.join(tempDir, 'log.txt');

  /** The script of a child process that takes the lock. */
  async function writeHolderScript(): Promise<string> {
    const lockModule = path
      .resolve(import.meta.dirname, '..', 'src', 'core', 'lock.ts')
      .replaceAll(path.sep, '/');
    const script = path.join(tempDir, 'holder.mjs');
    await rm(script, { force: true });
    const { writeFile } = await import('node:fs/promises');
    await writeFile(
      script,
      `const { appendFile } = await import('node:fs/promises');\n` +
        `const { acquireLock } = await import('file://${lockModule}');\n` +
        `const [dir, logFile, name, mode] = process.argv.slice(2);\n` +
        `const sleep = (ms) => new Promise((r) => setTimeout(r, ms));\n` +
        `const lock = await acquireLock(dir, '${LOCK_FILENAME}', { timeoutMs: 30_000, pollMs: 50 });\n` +
        `await appendFile(logFile, 'enter ' + name + ' ' + process.pid + ' ' + Date.now() + '\\n');\n` +
        `if (mode === 'hold') { await sleep(600_000); }\n` +
        `await sleep(300);\n` +
        `await appendFile(logFile, 'exit ' + name + ' ' + process.pid + ' ' + Date.now() + '\\n');\n` +
        `await lock.release();\n`,
      'utf8',
    );
    return script;
  }

  const spawnHolder = (script: string, name: string, mode = 'run') => {
    const child = spawn(
      process.execPath,
      ['--import', 'tsx', script, tempDir, logFile(), name, mode],
      {
        cwd: path.resolve(import.meta.dirname, '..'),
        stdio: 'ignore',
      },
    );
    children.push(child);
    // The listener is attached right away: a child that is quick can be gone
    // before the test waits for it.
    const exited = new Promise<void>((resolve) => child.on('exit', () => resolve()));
    return { child, exited };
  };

  /** Wait until the log of the processes contains the given line. */
  async function waitForLog(needle: string, timeoutMs = 20_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let raw = '';
    while (Date.now() < deadline) {
      raw = await readFile(logFile(), 'utf-8').catch(() => '');
      if (raw.includes(needle)) return;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(`The log has no "${needle}" in ${timeoutMs}ms. Log: ${raw}`);
  }

  /** Wait until the log of the processes has the given number of lines. */
  async function waitForCount(needle: string, count: number, timeoutMs = 30_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let raw = '';
    while (Date.now() < deadline) {
      raw = await readFile(logFile(), 'utf-8').catch(() => '');
      const lines = raw.split('\n').filter((line) => line.startsWith(needle));
      if (lines.length >= count) return;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(`The log has less than ${count} "${needle}" lines. Log: ${raw}`);
  }

  it('gives the lock to one holder at a time', async () => {
    const first = await acquireLock(tempDir, LOCK_FILENAME);
    let secondAcquired = false;
    const second = acquireLock(tempDir, LOCK_FILENAME).then((lock) => {
      secondAcquired = true;
      return lock;
    });

    // The second caller waits for the first one.
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(secondAcquired).toBe(false);

    await first.release();
    const lock = await second;
    expect(secondAcquired).toBe(true);
    await lock.release();
  });

  it('leaves nothing behind in the directory', async () => {
    const lock = await acquireLock(tempDir, LOCK_FILENAME);
    await lock.release();

    expect(await readdir(tempDir)).toEqual([]);
  });

  it('does not take the lock from a living process', async () => {
    const script = await writeHolderScript();
    spawnHolder(script, 'holder', 'hold');
    await waitForLog('enter holder');

    await expect(
      acquireLock(tempDir, LOCK_FILENAME, { timeoutMs: 1_000, pollMs: 50 }),
    ).rejects.toThrow(/Failed to acquire the lock/);
  });

  it('takes the lock when the holder is dead', async () => {
    // The kernel takes the name of the socket away when the process dies:
    // there is no stale lock that has to be cleaned up.
    const script = await writeHolderScript();
    const { child: holder, exited } = spawnHolder(script, 'holder', 'hold');
    await waitForLog('enter holder');

    holder.kill('SIGKILL');
    await exited;

    const lock = await acquireLock(tempDir, LOCK_FILENAME, { timeoutMs: 5_000 });
    await lock.release();
  });

  it('keeps the critical sections of three processes apart', async () => {
    // Three processes take the same lock: the kernel gives it to one of them
    // at a time — the others wait for it.
    const script = await writeHolderScript();
    const holders = ['first', 'second', 'third'].map((name) => spawnHolder(script, name));

    await waitForCount('exit', 3);

    for (const holder of holders) await holder.exited;

    const events = (await readFile(logFile(), 'utf-8'))
      .split('\n')
      .filter(Boolean)
      .map((line) => line.split(' '))
      .filter(([kind]) => kind === 'enter' || kind === 'exit')
      .sort((a, b) => Number(a[3]) - Number(b[3]));

    // Every process has been inside, and never two of them at the same time.
    expect(events.filter(([kind]) => kind === 'enter')).toHaveLength(3);
    let inside = 0;
    for (const [kind] of events) {
      inside += kind === 'enter' ? 1 : -1;
      expect(inside).toBeLessThanOrEqual(1);
    }
  }, 90_000);
});
