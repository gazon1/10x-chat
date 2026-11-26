#!/usr/bin/env node
// Summarize the latency of the review runs of a machine.
//
// The source is what a review already writes: ~/.10x-chat/reviews/<id>/review.json.
// No metrics service, no database — the runs are the measurements. The
// duration of every stage, its queue wait, its outcome and the backend of the
// run are read from there and reduced to a table.
//
// Usage:
//   node scripts/review-latency.mjs [--dir <reviews dir>] [--json]
//
// The size of a change is the number of files it touches, bucketed the way the
// benchmark of docs/review-pipeline.md names it:
//   small  — 1 to 5 changed files
//   medium — 6 to 20 changed files
//   large  — more than 20 changed files
import { readdir, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/** The buckets of the benchmark, by the number of changed files. */
const BUCKETS = [
  { name: 'small (1-5)', max: 5 },
  { name: 'medium (6-20)', max: 20 },
  { name: 'large (>20)', max: Number.POSITIVE_INFINITY },
];

function bucketOf(changedFiles) {
  return (BUCKETS.find((bucket) => changedFiles <= bucket.max) ?? BUCKETS.at(-1)).name;
}

/** The nearest-rank percentile of a sorted list — the pNN the report names. */
function percentile(sorted, fraction) {
  if (sorted.length === 0) return undefined;
  const rank = Math.ceil(fraction * sorted.length);
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))];
}

function summarize(values) {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  return {
    n: sorted.length,
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    min: sorted[0],
    max: sorted.at(-1),
  };
}

/** One run, reduced to what the benchmark measures. */
function measurementOf(run) {
  if (!Array.isArray(run.steps)) return undefined;
  const timed = run.steps.filter((step) => typeof step.durationMs === 'number');
  if (timed.length === 0) return undefined;
  // The advisory assessment is not a step, but its request costs time: a run
  // whose time does not add up reads as a slow review.
  const assessmentMs = run.improvements?.durationMs ?? 0;
  const total = timed.reduce((sum, step) => sum + step.durationMs, 0) + assessmentMs;
  // The waits of the steps and of the assessment are one list: a run that
  // measured a queue only in the assessment measured one, and the sum can
  // never disagree with the flag that guards it.
  const queueWaits = [
    ...timed.map((step) => step.queueWaitMs),
    run.improvements?.queueWaitMs,
  ].filter((value) => typeof value === 'number');
  const queueWait = queueWaits.reduce((sum, value) => sum + value, 0);
  const changedFiles = Array.isArray(run.context?.changedFiles)
    ? run.context.changedFiles.length
    : 0;
  return {
    id: run.id,
    bucket: bucketOf(changedFiles),
    changedFiles,
    total,
    queueWait,
    // Whether the run measured a queue at all: a stage of an older run has no
    // wait, and a sum of them is not a measurement of zero. The assessment
    // counts too — a bench that ignored its wait would still sum it.
    measured: queueWaits.length > 0,
    execution: total - queueWait,
    verdict: run.verdict,
    backend: run.backend?.name,
    provider: run.backend?.provider,
    model: run.backend?.model,
    // A stage that failed or was skipped is not the same a stage that ran: the
    // count of an incomplete run is not compared with a complete one. The
    // assessment never gates the verdict, so it does not decide completeness.
    complete: timed.every((step) => step.status === 'passed'),
    assessmentMs,
    stages: timed.map((step) => ({
      id: step.id,
      status: step.status,
      durationMs: step.durationMs,
      queueWaitMs: step.queueWaitMs,
      failureKind: step.failureKind,
      submission: step.submission,
    })),
  };
}

/** Every run of a store, oldest first; a run that cannot be read is skipped. */
async function readRuns(dir) {
  let entries;
  try {
    entries = await readdir(dir);
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  const runs = [];
  for (const entry of entries) {
    try {
      const raw = await readFile(path.join(dir, entry, 'review.json'), 'utf-8');
      const parsed = JSON.parse(raw);
      const measurement = measurementOf(parsed);
      if (measurement) runs.push(measurement);
    } catch {
      // A run that is not there, or not readable, is not a measurement.
    }
  }
  return runs;
}

/** The table of the benchmark — a bucket per row, the stages per cell. */
function report(runs) {
  const lines = [];
  lines.push(`# Review latency — ${runs.length} run(s)`);
  lines.push('');
  const complete = runs.filter((run) => run.complete);
  lines.push(
    `${complete.length} of ${runs.length} run(s) finished every stage — only those are timed: ` +
      'a stage that failed or was skipped is not the time the work takes.',
  );
  lines.push('');

  lines.push(
    `A p95 is shown only from ${P95_MIN_SAMPLE} samples; below it the cell gives the sample size.`,
  );
  lines.push('');
  lines.push('| Size | Runs | Total p50 | Total p95 | Queue p50 | Execution p50 |');
  lines.push('|---|---|---|---|---|---|');
  for (const bucket of BUCKETS) {
    const of = complete.filter((run) => run.bucket === bucket.name);
    const total = summarize(of.map((run) => run.total));
    // A run that never measured its queue wait did not wait zero: the column
    // says a dash unless at least one run of the bucket measured one.
    const queue = summarize(of.filter((run) => run.measured).map((run) => run.queueWait));
    const execution = summarize(
      of
        .filter((run) => run.measured)
        .map((run) => (run.queueWait > 0 ? run.execution : run.total)),
    );
    lines.push(
      `| ${bucket.name} | ${of.length} | ${fmt(total?.p50)} | ${fmtP95(total)} | ${fmt(queue?.p50)} | ${fmt(execution?.p50)} |`,
    );
  }
  lines.push('');

  lines.push('| Stage | Runs | p50 | p95 | Queue p50 | Failed |');
  lines.push('|---|---|---|---|---|---|');
  const stageIds = [...new Set(runs.flatMap((run) => run.stages.map((stage) => stage.id)))];
  for (const id of stageIds) {
    const stages = runs.flatMap((run) => run.stages.filter((stage) => stage.id === id));
    const passed = stages.filter((stage) => stage.status === 'passed');
    const durations = summarize(passed.map((stage) => stage.durationMs));
    const queue = summarize(
      passed
        .filter((stage) => typeof stage.queueWaitMs === 'number')
        .map((stage) => stage.queueWaitMs),
    );
    const failed = stages.filter((stage) => stage.status !== 'passed').length;
    lines.push(
      `| ${id} | ${passed.length} | ${fmt(durations?.p50)} | ${fmtP95(durations)} | ${fmt(queue?.p50)} | ${failed} |`,
    );
  }
  lines.push('');

  const failed = runs.flatMap((run) =>
    run.stages.filter((stage) => stage.status !== 'passed').map((stage) => ({ run, stage })),
  );
  if (failed.length > 0) {
    lines.push('## Stages that did not pass');
    lines.push('| Run | Stage | Result | Kind | Submission |');
    lines.push('|---|---|---|---|---|');
    for (const { run, stage } of failed.slice(0, 40)) {
      lines.push(
        `| ${run.id} | ${stage.id} | ${stage.status} | ${stage.failureKind ?? '—'} | ${stage.submission ?? '—'} |`,
      );
    }
    if (failed.length > 40) lines.push(`| … | ${failed.length - 40} more | | | |`);
    lines.push('');
  }

  const backends = new Map();
  for (const run of runs) {
    const key = `${run.backend ?? 'unknown'}${run.provider ? ` (${run.provider})` : ''}${run.model ? `, ${run.model}` : ''}`;
    backends.set(key, (backends.get(key) ?? 0) + 1);
  }
  lines.push('## Backends');
  for (const [key, count] of [...backends].sort((a, b) => b[1] - a[1])) {
    lines.push(`- ${key}: ${count} run(s)`);
  }
  return lines.join('\n');
}

/**
 * The sample size a p95 needs to mean anything.
 *
 * A percentile of twenty runs is not a baseline: the nearest-rank p95 is then
 * the maximum of the sample, and one slow run moves it. Below it the cell says
 * the size of the sample instead of a number that would be read as a bound.
 */
const P95_MIN_SAMPLE = 20;

/** A duration for a table cell — a dash when nobody measured it. */
function fmt(value) {
  return value === undefined ? '—' : `${Math.round(value)} ms`;
}

/** A p95 for a table cell — the sample size when it is too small to be one. */
function fmtP95(summary) {
  if (!summary) return '—';
  return summary.n < P95_MIN_SAMPLE ? `n=${summary.n}` : fmt(summary.p95);
}

const args = process.argv.slice(2);
const dirIndex = args.indexOf('--dir');
const dir = dirIndex >= 0 ? args[dirIndex + 1] : path.join(os.homedir(), '.10x-chat', 'reviews');
if (dirIndex >= 0 && !dir) {
  console.error('review-latency: --dir needs a directory');
  process.exit(1);
}
const runs = await readRuns(dir);
if (args.includes('--json')) {
  // The raw measurements, for a caller that computes its own percentiles.
  console.log(JSON.stringify({ dir, runs }, null, 2));
} else {
  console.log(report(runs));
}
