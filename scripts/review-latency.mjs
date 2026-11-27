#!/usr/bin/env node
// Summarize the latency of the review runs of a machine.
//
// The source is what a review already writes: ~/.10x-chat/reviews/<id>/review.json.
// No metrics service, no database — the runs are the measurements. The
// duration of every stage, its queue wait, its outcome and the backend of the
// run are read from there and reduced to a table.
//
// Usage:
//   node scripts/review-latency.mjs [--dir <reviews dir>] [--baseline <dir>] [--json]
//
// Without `--baseline` the runs of `--dir` are summarized. With `--baseline <dir>`
// the runs of `<dir>` are the baseline and the runs of the store are the
// compared set, and the report is a before/after of the change that produced
// the newer runs.
//
// The size of a change is the number of files it touches, bucketed the way the
// benchmark of docs/review-pipeline.md names it:
//   small  — 1 to 5 changed files
//   medium — 6 to 20 changed files
//   large  — more than 20 changed files
import { readdir, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/** The profile of a run that names none — the full review it was. */
const DEFAULT_PROFILE = 'standard';

/** The buckets of the benchmark, by the number of changed files. */
const BUCKETS = [
  { name: 'small (1-5)', max: 5 },
  { name: 'medium (6-20)', max: 20 },
  { name: 'large (>20)', max: Number.POSITIVE_INFINITY },
];

/**
 * The sample size a p95 needs before it is a percentile.
 *
 * A percentile of twenty runs is not a baseline: the nearest-rank p95 is then
 * the maximum of the sample, and one slow run moves it. Below it the cell says
 * the size of the sample instead of a number that would be read as a bound.
 */
const P95_MIN_SAMPLE = 20;

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
    // Completeness is read on the steps of the record, not on the ones that
    // carry a duration: a step that did not run has no duration, and an approval
    // on such a run is an approval on a run that did not judge.
    complete: run.steps.every((step) => step.status === 'passed'),
    assessmentMs,
    stages: timed.map((step) => ({
      id: step.id,
      status: step.status,
      durationMs: step.durationMs,
      queueWaitMs: step.queueWaitMs,
      failureKind: step.failureKind,
      submission: step.submission,
      activeSlots: step.activeSlots,
    })),
    // A run of an older version has no profile, and it is the full review it
    // was — the same default the pipeline reads the record with.
    profile: run.profile ?? DEFAULT_PROFILE,
  };
}

/** Every run of a store; a run that cannot be read is not a measurement. */
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

/** The runs that finished every stage — the only ones the timings are about. */
function completeRuns(runs) {
  return runs.filter((run) => run.complete);
}

/**
 * The failure rate of a set of runs: the share that did not finish every stage.
 *
 * A run that did not finish did not do the work, so its duration is not the
 * cost of the work — the failure rate is what keeps a latency improvement from
 * being read on top of a measurement that never happened.
 */
function failureRate(runs) {
  const failed = runs.filter((run) => !run.complete);
  return {
    failed: failed.length,
    rate: runs.length === 0 ? undefined : failed.length / runs.length,
  };
}

/** The timings of one stage of a set of runs — the ones that passed. */
function stageStats(runs, id) {
  const stages = runs.flatMap((run) => run.stages.filter((stage) => stage.id === id));
  const passed = stages.filter((stage) => stage.status === 'passed');
  const durations = summarize(passed.map((stage) => stage.durationMs));
  const queue = summarize(
    passed
      .filter((stage) => typeof stage.queueWaitMs === 'number')
      .map((stage) => stage.queueWaitMs),
  );
  const failed = stages.filter((stage) => stage.status !== 'passed');
  // A stage that timed out did not reach its work: the failure rate names the
  // kind, and the submission says what can be done next.
  const timeouts = failed.filter((stage) => stage.failureKind === 'timeout').length;
  // The slots the backend held while the stage ran: a serialized backend says
  // one, a concurrent one more. Absent when the backend does not report slots.
  const slots = summarize(
    passed
      .filter((stage) => typeof stage.activeSlots === 'number')
      .map((stage) => stage.activeSlots),
  );
  return { stages, passed, durations, queue, failed, timeouts, slots };
}

/**
 * The number of backend slots busy when the outcome was reported — a
 * completion-time snapshot, not peak concurrency, and a dash when nobody
 * measured it. A benchmark reads it as what it is: the slots that were held when
 * the stage finished, not the ones it held in the middle of it.
 */
function fmtSlots(value) {
  return value === undefined ? '—' : `${Math.round(value)}`;
}

/** The verdicts of a set of runs, in a stable order. */
function verdictCounts(runs) {
  const counts = new Map();
  for (const run of runs) {
    counts.set(run.verdict, (counts.get(run.verdict) ?? 0) + 1);
  }
  return [...counts.entries()].sort(([a], [b]) => a.localeCompare(b));
}

/** The groups of a key of a run — the backend, or the profile. */
function groupsOf(runs, keyOf) {
  const groups = new Map();
  for (const run of runs) {
    const key = keyOf(run);
    const group = groups.get(key) ?? { key, runs: [] };
    group.runs.push(run);
    groups.set(key, group);
  }
  return [...groups.values()].sort((a, b) => b.runs.length - a.runs.length);
}

function backendKey(run) {
  return `${run.backend ?? 'unknown'}${run.provider ? ` (${run.provider})` : ''}${
    run.model ? `, ${run.model}` : ''
  }`;
}

function backendGroups(runs) {
  return groupsOf(runs, backendKey).map((group) => ({
    ...group,
    total: summarize(group.runs.filter((run) => run.complete).map((run) => run.total)),
  }));
}

function profileGroups(runs) {
  return groupsOf(runs, (run) => run.profile).map((group) => ({
    ...group,
    failure: failureRate(group.runs),
  }));
}

/**
 * The timings of a set of runs — the complete ones, the only ones timed.
 */
function totals(runs) {
  const timed = completeRuns(runs);
  const total = summarize(timed.map((run) => run.total));
  const queue = summarize(timed.filter((run) => run.measured).map((run) => run.queueWait));
  const execution = summarize(
    timed
      .filter((run) => run.measured)
      .map((run) => (run.queueWait > 0 ? run.execution : run.total)),
  );
  return { timed, total, queue, execution, failure: failureRate(runs) };
}

/** A duration for a table cell — a dash when nobody measured it. */
function fmt(value) {
  return value === undefined ? '—' : `${Math.round(value)} ms`;
}

/** A p95 for a table cell — the sample size when it is too small to be one. */
function fmtP95(summary) {
  if (!summary) return '—';
  return summary.n < P95_MIN_SAMPLE ? `n=${summary.n}` : fmt(summary.p95);
}

/** The share of runs that did not finish every stage, as a percentage. */
function fmtRate(rate) {
  return rate === undefined ? '—' : `${Math.round(rate * 100)}%`;
}

/** One line per run set: how the set timed, and how it failed. */
function totalLine(runs) {
  const { timed, total, queue, execution, failure } = totals(runs);
  const failed = failure.failed;
  const rate = failure.rate;
  return (
    `${runs.length} run(s), ${timed.length} timed — ` +
    `total p50 ${fmt(total?.p50)}, total p95 ${fmtP95(total)}, ` +
    `queue p50 ${fmt(queue?.p50)}, execution p50 ${fmt(execution?.p50)}, ` +
    `failure ${failed}/${runs.length} (${fmtRate(rate)})`
  );
}

/** The ids of the stages that a set of runs measured, in the order of the record. */
function stageIdsOf(runs) {
  return [...new Set(runs.flatMap((run) => run.stages.map((stage) => stage.id)))];
}

/** The lines of the table of the latency of the stages, by the runs. */
function stageTable(runs) {
  const lines = [
    '| Stage | Runs | p50 | p95 | Queue p50 | Failed | Timeout | Active slots (at completion) |',
  ];
  lines.push('|---|---|---|---|---|---|---|---|');
  for (const id of stageIdsOf(runs)) {
    const stats = stageStats(runs, id);
    lines.push(
      `| ${id} | ${stats.passed.length} | ${fmt(stats.durations?.p50)} | ${fmtP95(stats.durations)} | ` +
        `${fmt(stats.queue?.p50)} | ${stats.failed.length} | ${stats.timeouts} | ${fmtSlots(stats.slots?.p50)} |`,
    );
  }
  return lines;
}

/** The lines of the table of the latency of the changes, by the size. */
function sizeTable(runs) {
  const lines = ['| Size | Runs | Total p50 | Total p95 | Queue p50 | Execution p50 |'];
  lines.push('|---|---|---|---|---|---|');
  const complete = completeRuns(runs);
  for (const bucket of BUCKETS) {
    const of = complete.filter((run) => run.bucket === bucket.name);
    const total = summarize(of.map((run) => run.total));
    const queue = summarize(of.filter((run) => run.measured).map((run) => run.queueWait));
    const execution = summarize(
      of
        .filter((run) => run.measured)
        .map((run) => (run.queueWait > 0 ? run.execution : run.total)),
    );
    lines.push(
      `| ${bucket.name} | ${of.length} | ${fmt(total?.p50)} | ${fmtP95(total)} | ${fmt(queue?.p50)} | ` +
        `${fmt(execution?.p50)} |`,
    );
  }
  return lines;
}

/** The lines of the section of the verdicts, and of its invariant. */
function verdictLines(runs) {
  const lines = ['## Verdicts', ''];
  for (const [verdict, count] of verdictCounts(runs)) {
    lines.push(`- ${verdict}: ${count} run(s)`);
  }
  // An approval on a run that did not finish every stage is a verdict that
  // cannot hold: the gate of the pipeline refuses it, and a report that prints
  // one reads a quality regression as a latency number.
  const approvalsOnIncomplete = runs.filter(
    (run) => run.verdict === 'APPROVE' && !run.complete,
  ).length;
  lines.push(`- Approvals on runs that did not finish every stage: ${approvalsOnIncomplete}`);
  lines.push('');
  return lines;
}

/** The lines of the section of the backends, with their timings. */
function backendLines(runs) {
  const lines = ['## Backends', ''];
  for (const group of backendGroups(runs)) {
    lines.push(`- ${group.key}: ${group.runs.length} run(s), total p50 ${fmt(group.total?.p50)}`);
  }
  lines.push('');
  return lines;
}

/** The lines of the section of the profiles, with their timings. */
function profileLines(runs) {
  const lines = ['## Profiles', ''];
  for (const group of profileGroups(runs)) {
    lines.push(
      `- ${group.key}: ${group.runs.length} run(s), failure ${group.failure.failed}/${group.runs.length} (${fmtRate(group.failure.rate)})`,
    );
  }
  lines.push('');
  return lines;
}

/** The lines of the report of a store: the table of the benchmark. */
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
  lines.push('## By size');
  lines.push('');
  lines.push(...sizeTable(runs));
  lines.push('');
  lines.push('## By stage');
  lines.push('');
  lines.push(...stageTable(runs));
  lines.push('');
  lines.push(...verdictLines(runs));
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
  lines.push(...backendLines(runs));
  lines.push(...profileLines(runs));
  return lines.join('\n');
}

/** The lines of the before/after of two sets of runs. */
function beforeAfter(before, after) {
  const beforeTotals = totals(before);
  const afterTotals = totals(after);
  const lines = [];
  lines.push('# Review latency — before/after');
  lines.push('');
  lines.push('## Total');
  lines.push('');
  lines.push(`- Before: ${totalLine(before)}`);
  lines.push(`- After: ${totalLine(after)}`);
  lines.push('');
  lines.push('## Stages');
  lines.push('');
  lines.push('| Stage | Before p50 | After p50 | Change p50 |');
  lines.push('|---|---:|---:|---:|');
  const stageIds = [
    ...new Set([...before, ...after].flatMap((run) => run.stages.map((s) => s.id))),
  ];
  for (const id of stageIds) {
    const beforeStats = stageStats(before, id);
    const afterStats = stageStats(after, id);
    const beforeP50 = beforeStats.durations?.p50;
    const afterP50 = afterStats.durations?.p50;
    lines.push(
      `| ${id} | ${fmt(beforeP50)} | ${fmt(afterP50)} | ${
        beforeP50 === undefined || afterP50 === undefined ? '—' : fmt(afterP50 - beforeP50)
      } |`,
    );
  }
  lines.push('');
  lines.push('## Verdicts');
  lines.push('');
  lines.push(`- Before: ${verdictText(before)}`);
  lines.push(`- After: ${verdictText(after)}`);
  lines.push('');
  lines.push('## Failures');
  lines.push('');
  lines.push(
    `- Before: ${beforeTotals.failure.failed} of ${before.length} run(s) did not finish every stage; ` +
      `${timedOutStages(before)} stage(s) timed out`,
  );
  lines.push(
    `- After: ${afterTotals.failure.failed} of ${after.length} run(s) did not finish every stage; ` +
      `${timedOutStages(after)} stage(s) timed out`,
  );
  return lines.join('\n');
}

/** The stages of a set of runs that failed with a timeout. */
function timedOutStages(runs) {
  return runs
    .flatMap((run) => run.stages)
    .filter((stage) => stage.status !== 'passed' && stage.failureKind === 'timeout').length;
}

/** The verdicts of a set of runs, as one line. */
function verdictText(runs) {
  const verdicts = verdictCounts(runs)
    .map(([verdict, count]) => `${verdict} ${count}`)
    .join(', ');
  return verdicts === '' ? 'no run' : verdicts;
}

const args = process.argv.slice(2);
const dirIndex = args.indexOf('--dir');
const baselineIndex = args.indexOf('--baseline');
const dir = dirIndex >= 0 ? args[dirIndex + 1] : path.join(os.homedir(), '.10x-chat', 'reviews');
if (dirIndex >= 0 && !dir) {
  console.error('review-latency: --dir needs a directory');
  process.exit(1);
}
const baseline = baselineIndex >= 0 ? args[baselineIndex + 1] : undefined;
if (baselineIndex >= 0 && !baseline) {
  console.error('review-latency: --baseline needs a directory');
  process.exit(1);
}
const runs = await readRuns(dir);
if (args.includes('--json')) {
  // The raw measurements, for a caller that computes its own percentiles.
  console.log(JSON.stringify({ dir, ...(baseline ? { baseline } : {}), runs }, null, 2));
} else if (baseline) {
  const before = await readRuns(baseline);
  console.log(beforeAfter(before, runs));
} else {
  console.log(report(runs));
}
