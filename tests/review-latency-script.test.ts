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

/** Write one run into a store, the way the pipeline writes it. */
function writeRun(
  id: string,
  steps: Array<Record<string, unknown>>,
  options: {
    changedFiles?: string[];
    verdict?: string;
    backend?: Record<string, unknown>;
    improvements?: Record<string, unknown>;
    profile?: string;
    pr?: number;
  } = {},
  target: string = dir,
): void {
  const runDir = path.join(target, id);
  mkdirSync(runDir, { recursive: true });
  writeFileSync(
    path.join(runDir, 'review.json'),
    JSON.stringify({
      id,
      verdict: options.verdict ?? 'APPROVE',
      ...(options.profile ? { profile: options.profile } : {}),
      ...(options.backend ? { backend: options.backend } : {}),
      ...(options.improvements ? { improvements: options.improvements } : {}),
      context: {
        changedFiles: options.changedFiles ?? ['src/a.ts'],
        ...(options.pr !== undefined ? { pr: options.pr } : {}),
      },
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

    // The range of a one-run bucket is the run itself, and the queue stays a
    // dash: a sum of absences is not a measurement of zero.
    expect(output).toContain('| small (1-5) | 1 | 100 ms | n=1 | 100 ms – 100 ms | — | — |');
  });

  it('counts a queue wait measured only by the advisory assessment', () => {
    // Every step of the pipeline predates the measurement, but the assessment
    // waited behind another request and reported it. A benchmark that sums the
    // wait and then calls the run unmeasured reports a dash for a run whose
    // queue it just counted — and drops the run from the execution percentiles.
    writeRun(
      'assessment-only-queue',
      [
        { id: 'collect-context', status: 'passed', durationMs: 10 },
        { id: 'review-correctness', status: 'passed', durationMs: 100 },
      ],
      { improvements: { status: 'completed', durationMs: 4_000, queueWaitMs: 3_000 } },
    );

    const parsed = JSON.parse(run(['--json']));
    const measured = parsed.runs[0];

    // The wait is counted, so the run is a measurement.
    expect(measured.measured).toBe(true);
    expect(measured.queueWait).toBe(3_000);
    // The execution is what was left of the total after the wait.
    expect(measured.total).toBe(4_110);
    expect(measured.execution).toBe(1_110);
    // And the table shows the number instead of a dash.
    const table = run();
    expect(table).toContain(
      '| small (1-5) | 1 | 4110 ms | n=1 | 4110 ms – 4110 ms | 3000 ms | 1110 ms |',
    );
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

  it('reads the concurrency of the backend slots of a stage', () => {
    writeRun('concurrent', [
      { id: 'review-correctness', status: 'passed', durationMs: 100, activeSlots: 2 },
    ]);

    const parsed = JSON.parse(run(['--json']));
    const stage = parsed.runs[0].stages[0];

    // The slots are the concurrency the backend held while the stage ran — a
    // serialized backend says one, a concurrent one more. They are part of the
    // measurement, so a before/after can see a change of the capacity.
    expect(stage.activeSlots).toBe(2);
  });

  it('segments the runs by the profile and keeps the backends apart', () => {
    writeRun(
      'quick-run',
      [
        { id: 'collect-context', status: 'passed', durationMs: 10 },
        { id: 'review-correctness', status: 'skipped', durationMs: 5 },
      ],
      { profile: 'quick' },
    );
    writeRun(
      'deep-run',
      [
        { id: 'collect-context', status: 'passed', durationMs: 10 },
        { id: 'review-correctness', status: 'passed', durationMs: 100 },
      ],
      { backend: { name: 'chatgpt-use', provider: 'chatgpt', model: 'Pro' } },
    );

    const output = run();

    // The benchmark segments the runs by the profile they ran under, and the
    // failure of a skipped stage is the failure of the set it belongs to.
    expect(output).toContain('## Profiles');
    expect(output).toContain('- quick: 1 run(s), failure 1/1 (100%)');
    expect(output).toContain('## Backends');
    expect(output).toContain('- chatgpt-use (chatgpt), Pro: 1 run(s)');
  });

  it('times a run whose profile omitted a stage by design', () => {
    // `quick` runs one reviewer and no verification on purpose. Counting that
    // as an incomplete run left the one profile a cohort most needs to price
    // as the one whose latency was never timed.
    writeRun(
      'quick-omitted',
      [
        { id: 'collect-context', status: 'passed', durationMs: 10 },
        { id: 'review-correctness', status: 'passed', durationMs: 90 },
        { id: 'review-architecture', status: 'skipped', omittedByProfile: true },
        { id: 'verify-findings', status: 'skipped', omittedByProfile: true },
      ],
      { profile: 'quick' },
    );

    const parsed = JSON.parse(run(['--json']));
    expect(parsed.runs[0].complete).toBe(true);
    // And the table prices the profile instead of leaving it empty.
    expect(run()).toContain('| small (1-5) | 1 | 100 ms |');
  });

  it('still counts a step that could not run against the run', () => {
    // A skip that is *not* the profile's choice is a step that did not do the
    // work, and its duration is not the cost of the work.
    writeRun(
      'broken',
      [
        { id: 'collect-context', status: 'passed', durationMs: 10 },
        { id: 'review-correctness', status: 'skipped' },
      ],
      { profile: 'quick' },
    );

    const parsed = JSON.parse(run(['--json']));
    expect(parsed.runs[0].complete).toBe(false);
  });

  it('keeps the verdict honest with the completeness of the run', () => {
    // An approval on a run that did not finish every stage is a verdict that
    // cannot hold: the pipeline refuses it, and the benchmark must not let a
    // latency number hide a quality regression. A step that did not run has no
    // duration, and it still decides that the run did not finish every stage.
    writeRun(
      'lying',
      [
        { id: 'collect-context', status: 'passed', durationMs: 10 },
        { id: 'review-correctness', status: 'skipped' },
      ],
      { verdict: 'APPROVE' },
    );

    const output = run();

    expect(output).toContain('## Verdicts');
    expect(output).toContain('- APPROVE: 1 run(s)');
    expect(output).toContain('- Approvals on runs that did not finish every stage: 1');
  });

  it('compares the runs of a change against the baseline that ran before it', () => {
    const beforeDir = mkdtempSync(path.join(tmpdir(), '10x-chat-latency-before-'));
    try {
      writeRun(
        'before-run',
        [{ id: 'review-correctness', status: 'passed', durationMs: 200_000 }],
        { backend: { name: 'chatgpt-use', provider: 'chatgpt', model: 'Thinking' } },
        beforeDir,
      );
      writeRun('after-run', [{ id: 'review-correctness', status: 'passed', durationMs: 100_000 }]);

      const output = execFileSync(
        process.execPath,
        [SCRIPT, '--dir', dir, '--baseline', beforeDir],
        { encoding: 'utf-8' },
      );

      // The before/after is the report the tuning needs: the totals of the two
      // sets, the latency of the stages of the change, the verdicts and the
      // failure rate of both.
      expect(output).toContain('# Review latency — before/after');
      expect(output).toContain('## Total — standard');
      expect(output).toContain('## Stages — standard');
      expect(output).toContain('## Verdicts — standard');
      expect(output).toContain('## Failures — standard');
      expect(output).toContain('did not finish every stage');
    } finally {
      rmSync(beforeDir, { recursive: true, force: true });
    }
  });

  it('never compares one profile against another', () => {
    // A cheaper profile omits model work, so its total is shorter by
    // construction. Comparing it with Standard would report the coverage it
    // did not do as a speedup — the one number the benchmark must not produce.
    const beforeDir = mkdtempSync(path.join(tmpdir(), '10x-chat-latency-before-'));
    try {
      writeRun(
        'standard-before',
        [{ id: 'review-correctness', status: 'passed', durationMs: 200_000 }],
        { profile: 'standard' },
        beforeDir,
      );
      writeRun(
        'quick-after',
        [{ id: 'review-correctness', status: 'passed', durationMs: 40_000 }],
        { profile: 'quick' },
      );

      const output = execFileSync(
        process.execPath,
        [SCRIPT, '--dir', dir, '--baseline', beforeDir],
        { encoding: 'utf-8' },
      );

      // Quick has no baseline of its own, and the report says so instead of
      // printing 200 s against 40 s as a 5x speedup.
      expect(output).toContain('## Total — quick');
      expect(output).toContain('Not a comparison');
      expect(output).toContain('the baseline has no quick run');
      expect(output).toContain('## Total — standard');
      expect(output).toContain('the compared set has no standard run');
    } finally {
      rmSync(beforeDir, { recursive: true, force: true });
    }
  });

  it('pairs a replayed fixture and leaves an unmatched one unpaired', () => {
    // The same pull request reviewed before and after is a matched pair; a
    // fixture on one side only is a sample that happens to sit in the same
    // table. Only the pair is a before/after of the change to the pipeline.
    const beforeDir = mkdtempSync(path.join(tmpdir(), '10x-chat-latency-before-'));
    try {
      writeRun(
        'b-60',
        [{ id: 'review-correctness', status: 'passed', durationMs: 100_000 }],
        { pr: 60 },
        beforeDir,
      );
      writeRun(
        'b-83',
        [{ id: 'review-correctness', status: 'passed', durationMs: 300_000 }],
        { pr: 83 },
        beforeDir,
      );
      writeRun('a-60', [{ id: 'review-correctness', status: 'passed', durationMs: 50_000 }], {
        pr: 60,
      });

      const output = execFileSync(
        process.execPath,
        [SCRIPT, '--dir', dir, '--baseline', beforeDir],
        { encoding: 'utf-8' },
      );

      expect(output).toContain('## Fixtures — standard');
      expect(output).toContain('| #60 |');
      expect(output).toContain('| #83 |');
      expect(output).toContain('1 of 2 fixture(s) replayed');
    } finally {
      rmSync(beforeDir, { recursive: true, force: true });
    }
  });
});
