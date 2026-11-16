/**
 * Runs every readiness matrix (issue #13) and writes a combined summary.
 *
 * Run: node spike/readiness/run-all.mjs
 *
 * Each matrix is a separate process, so a crash in one cannot hide the
 * results of the others. Results land in spike/readiness/results/.
 *
 * Exit code:
 *   0 — every matrix ran, every check passed, no criterion is unfinished
 *   1 — a check failed, a matrix crashed or a report is partial
 *   2 — no hard failure, but a criterion is unfinished (e.g. no credentials)
 * A validation gate must never look successful when it is not.
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { compatibilityIssues } from './report-compat.mjs';
import { HERE, RESULTS_DIR, readReport, writeReport } from './util.mjs';

const MATRICES = [
  ['proxy-matrix', 'proxy-matrix.mjs'],
  ['lifecycle-matrix', 'lifecycle-matrix.mjs'],
  ['ops-matrix', 'ops-matrix.mjs'],
  ['provider-matrix', 'provider-matrix.mjs'],
];

function run(script) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(HERE, script)], { stdio: 'inherit' });
    child.on('close', (code) => resolve(code));
  });
}

const outcomes = [];
for (const [name, script] of MATRICES) {
  console.log(`\n########## ${name} ##########`);
  // SPIKE_REUSE=1: reuse a finished report instead of re-running the matrix
  // (the provider matrix takes hours) — but only when it was produced with
  // the same versions, proxy and headless setting.
  let existing = process.env.SPIKE_REUSE === '1' ? await readReport(name) : null;
  if (existing) {
    const issues = compatibilityIssues(name, existing);
    if (issues.length > 0) {
      console.log(`not reusing the ${name} report:`);
      for (const issue of issues) console.log(`  - ${issue}`);
      existing = null;
    }
  }
  const code = existing ? 0 : await run(script);
  if (existing)
    console.log(`reused existing ${name} report (partial=${existing.partial ?? false})`);
  const report = await readReport(name);
  outcomes.push({
    matrix: name,
    exitCode: code,
    reused: Boolean(existing),
    passed: report?.passed ?? null,
    failed: report?.failed ?? null,
    // A combination that could not be measured (no credentials) is neither a
    // pass nor a failure — it is counted apart, never listed as a FAIL.
    skipped: report?.skipped ?? null,
    partial: report?.partial ?? false,
    failedChecks: (report?.results ?? [])
      .filter((r) => !r.ok && !r.skipped)
      .map((r) => ({ name: r.name, detail: r.detail })),
    skippedChecks: (report?.results ?? [])
      .filter((r) => !r.ok && r.skipped)
      .map((r) => ({ name: r.name, detail: r.detail })),
  });
}

const providerReport = await readReport('provider-matrix');
const roundTrip = providerReport?.authorizedRoundTrip ?? null;
const summary = {
  generatedAt: new Date().toISOString(),
  outcomes,
  authorizedRoundTrip: roundTrip,
};
await writeReport('summary', summary);

console.log('\n===== SUMMARY =====');
for (const outcome of outcomes) {
  console.log(
    `${outcome.matrix.padEnd(18)} exit=${outcome.exitCode} passed=${outcome.passed} failed=${outcome.failed} skipped=${outcome.skipped ?? 0}${outcome.partial ? ' PARTIAL' : ''}${outcome.reused ? ' (reused)' : ''}`,
  );
  for (const failure of outcome.failedChecks ?? []) {
    console.log(`  FAIL ${failure.name} - ${failure.detail}`);
  }
  for (const skipped of outcome.skippedChecks ?? []) {
    console.log(`  SKIP ${skipped.name} - ${skipped.detail}`);
  }
}

const crashed = outcomes.filter((o) => o.exitCode !== 0);
const withFailures = outcomes.filter((o) => (o.failed ?? 0) > 0);
const partial = outcomes.filter((o) => o.partial);
const unfinishedCriteria = [];
if (!roundTrip) {
  unfinishedCriteria.push('authorized round-trip: missing from the provider report');
} else if (roundTrip.status !== 'done') {
  unfinishedCriteria.push(`authorized round-trip: ${roundTrip.status}`);
}

if (crashed.length > 0) {
  console.log(`\nCRASHED: ${crashed.map((o) => o.matrix).join(', ')}`);
}
if (partial.length > 0) {
  console.log(`INCOMPLETE: ${partial.map((o) => o.matrix).join(', ')}`);
}
if (unfinishedCriteria.length > 0) {
  console.log(`UNFINISHED: ${unfinishedCriteria.join(', ')}`);
}

let exitCode = 0;
if (crashed.length > 0 || withFailures.length > 0 || partial.length > 0) {
  exitCode = 1;
} else if (unfinishedCriteria.length > 0) {
  exitCode = 2;
}
console.log(`\nresults dir: ${RESULTS_DIR}`);
console.log(`readiness gate: ${exitCode === 0 ? 'PASS' : exitCode === 2 ? 'INCOMPLETE' : 'FAIL'}`);
process.exitCode = exitCode;
