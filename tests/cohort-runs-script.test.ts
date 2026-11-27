import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const SCRIPT = path.join(import.meta.dirname, '..', 'scripts', 'cohort-runs.mjs');

let dir: string;
let home: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), '10x-chat-cohort-'));
  home = mkdtempSync(path.join(tmpdir(), '10x-chat-cohort-home-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

/** Write one run into the store, under the temporary home. */
function writeRun(id: string, startedAt: string, profile?: string): void {
  const runDir = path.join(home, '.10x-chat', 'reviews', id);
  mkdirSync(runDir, { recursive: true });
  writeFileSync(
    path.join(runDir, 'review.json'),
    JSON.stringify({ id, startedAt, ...(profile ? { profile } : {}), steps: [] }),
  );
}

function run(args: string[]): string {
  return execFileSync(process.execPath, [SCRIPT, ...args], {
    encoding: 'utf-8',
    env: { ...process.env, TEN_X_CHAT_HOME: path.join(home, '.10x-chat') },
  });
}

describe('the cohort extraction', () => {
  it('takes only the runs of the round it names', () => {
    writeRun('outside-window', '2026-11-26T10:00:00.000Z');
    writeRun('in-window', '2026-11-27T19:00:00.000Z');

    const out = path.join(dir, 'after');
    const output = run([out, 'standard', '2026-11-27T00:00:00Z']);

    // A round is its window: a run of another round is not a sample of this one.
    expect(output).toContain('1 standard run(s)');
    expect(readdirSync(out)).toEqual(['in-window']);
  });

  it('keeps the profiles apart', () => {
    writeRun('standard-run', '2026-11-27T19:00:00.000Z', 'standard');
    writeRun('quick-run', '2026-11-27T19:01:00.000Z', 'quick');

    const out = path.join(dir, 'after-quick');
    const output = run([out, 'quick', '2026-11-27T00:00:00Z']);

    // The profiles are separate cohorts: a quick run in the window is not a
    // standard sample, and copying it into one would compare them as peers.
    expect(output).toContain('1 quick run(s)');
    expect(readdirSync(out)).toEqual(['quick-run']);
  });

  it('reads a run that names no profile as the full review it was', () => {
    writeRun('old-run', '2026-11-27T19:00:00.000Z');

    const out = path.join(dir, 'after');
    const output = run([out, 'standard', '2026-11-27T00:00:00Z']);

    // An older record has no profile and is `standard` — the same default the
    // pipeline and the benchmark read it with.
    expect(output).toContain('1 standard run(s)');
    expect(readdirSync(out)).toEqual(['old-run']);
  });

  it('stops at the end of a closed round', () => {
    writeRun('first', '2026-11-27T19:00:00.000Z');
    writeRun('later', '2026-11-27T21:00:00.000Z');

    const out = path.join(dir, 'after');
    run([out, 'standard', '2026-11-27T18:00:00Z', '2026-11-27T20:00:00Z']);

    // A closed round does not grow when the next one adds its runs to the store.
    expect(readdirSync(out)).toEqual(['first']);
  });

  it('refuses to write a cohort into a directory that already holds one', () => {
    // Extraction copies and never deletes, so a second run with a narrower
    // window would leave the runs of the first behind — a directory holding
    // more than its window says, read by the benchmark as samples of this
    // round. The stale run must not survive a re-extraction silently.
    writeRun('A', '2026-11-27T19:00:00.000Z');
    writeRun('B', '2026-11-27T21:00:00.000Z');

    const out = path.join(dir, 'after');
    run([out, 'standard', '2026-11-27T00:00:00Z']);
    expect(readdirSync(out).sort()).toEqual(['A', 'B']);

    // The narrower window would copy A only; the directory already holds B.
    expect(() => run([out, 'standard', '2026-11-27T00:00:00Z', '2026-11-27T20:00:00Z'])).toThrow();
    // Nothing was written by the refused run, and nothing was lost.
    expect(readdirSync(out).sort()).toEqual(['A', 'B']);
  });

  it('refuses a window it cannot read instead of filtering nothing', () => {
    // `Date.parse` answers NaN for a timestamp it cannot read and every
    // comparison against NaN is false, so a mistyped bound would silently stop
    // filtering and measure the whole store as this round.
    writeRun('A', '2026-11-27T19:00:00.000Z');

    const out = path.join(dir, 'after');

    expect(() => run([out, 'standard', 'not-a-date'])).toThrow();
    expect(() => run([out, 'standard', '2026-11-27T00:00:00Z', 'nope'])).toThrow();
    expect(() => run([out, 'standard', '2026-11-27T00:00:00Z', '2026-11-26T00:00:00Z'])).toThrow();

    // A refused window writes nothing at all.
    expect(() => readdirSync(out)).toThrow();
  });
});
