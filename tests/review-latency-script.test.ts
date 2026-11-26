import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const SCRIPT = path.join(import.meta.dirname, '..', 'scripts', 'review-latency.mjs');

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), '10x-chat-latency-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Write one run into the store, the way the pipeline writes it. */
function writeRun(
  id: string,
  steps: Array<Record<string, unknown>>,
  options: {
    changedFiles?: string[];
    verdict?: string;
    backend?: Record<string, unknown>;
  } = {},
): void {
  const runDir = path.join(dir, id);
  mkdirSync(runDir, { recursive: true });
  writeFileSync(
    path.join(runDir, 'review.json'),
    JSON.stringify({
      id,
      verdict: options.verdict ?? 'APPROVE',
      ...(options.backend ? { backend: options.backend } : {}),
      context: { changedFiles: options.changedFiles ?? ['src/a.ts'] },
      steps,
    }),
  );
}

function run(args: string[] = []): string {
  return execFileSync(process.execPath, [SCRIPT, '--dir', dir, ...args], { encoding: 'utf-8' });
}

describe('the latency benchmark of the review runs', () => {
  it('buckets the runs by the size of the change and keeps the stages apart', () => {
    writeRun('small-run', [
      { id: 'collect-context', status: 'passed', durationMs: 10 },
      { id: 'review-correctness', status: 'passed', durationMs: 100 },
    ]);
    writeRun(
      'large-run',
      [
        { id: 'collect-context', status: 'passed', durationMs: 30 },
        { id: 'review-correctness', status: 'passed', durationMs: 300 },
      ],
      { changedFiles: Array.from({ length: 40 }, (_, index) => `src/${index}.ts`) },
    );

    const output = run();

    // Each bucket carries its own runs, and the stage table keeps every stage.
    expect(output).toContain('| small (1-5) | 1 |');
    expect(output).toContain('| large (>20) | 1 |');
    expect(output).toContain('| review-correctness | 2 |');
    expect(output).toContain('| collect-context | 2 |');
  });

  it('keeps the queue wait apart from the time the provider worked', () => {
    writeRun('queued', [
      { id: 'review-correctness', status: 'passed', durationMs: 4_060, queueWaitMs: 4_000 },
    ]);

    const output = run();

    // The wait is a column of its own: 4 s of queue and 60 ms of work are not
    // the speed of the provider.
    expect(output).toContain('4000 ms');
    expect(output).toContain('60 ms');
  });

  it('does not report a queue of zero for a run that never measured one', () => {
    // A run of an older version has no queue wait at all: a sum of absences is
    // not a measurement of zero, and the cell says so.
    writeRun('old', [{ id: 'review-correctness', status: 'passed', durationMs: 100 }]);

    const output = run();

    expect(output).toContain('| small (1-5) | 1 | 100 ms | n=1 | — | — |');
  });

  it('timed only the runs that finished every stage', () => {
    writeRun('complete', [{ id: 'review-correctness', status: 'passed', durationMs: 100 }]);
    writeRun('incomplete', [{ id: 'review-correctness', status: 'failed', durationMs: 900_000 }]);

    const output = run();

    // A stage that failed is not the time the work takes: it is reported in
    // its own table and kept out of the percentiles of the stages.
    expect(output).toContain('1 of 2 run(s) finished every stage');
    expect(output).toContain('| review-correctness | 1 | 100 ms |');
    expect(output).toContain('| incomplete | review-correctness | failed |');
  });

  it('names the backend of the runs and the kind of every failure', () => {
    writeRun(
      'failed',
      [
        {
          id: 'review-correctness',
          status: 'failed',
          durationMs: 5,
          failureKind: 'timeout',
          submission: 'submitted',
        },
      ],
      { backend: { name: 'chatgpt-use', provider: 'chatgpt', model: 'Thinking' } },
    );

    const output = run();

    expect(output).toContain('| failed | review-correctness | failed | timeout | submitted |');
    expect(output).toContain('chatgpt-use (chatgpt), Thinking: 1 run(s)');
  });

  it('prints the raw measurements for a caller that computes its own percentiles', () => {
    writeRun('one', [{ id: 'review-correctness', status: 'passed', durationMs: 100 }]);

    const parsed = JSON.parse(run(['--json']));

    expect(parsed.runs).toHaveLength(1);
    expect(parsed.runs[0].stages).toEqual([
      {
        id: 'review-correctness',
        status: 'passed',
        durationMs: 100,
        queueWaitMs: undefined,
        failureKind: undefined,
        submission: undefined,
      },
    ]);
  });

  it('says nothing instead of failing when the store has no run', () => {
    const empty = mkdtempSync(path.join(tmpdir(), '10x-chat-latency-empty-'));
    try {
      const output = execFileSync(process.execPath, [SCRIPT, '--dir', empty], {
        encoding: 'utf-8',
      });
      // An empty store is a store with no measurement — never an error.
      expect(output).toContain('0 run(s)');
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});
