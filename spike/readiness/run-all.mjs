/**
 * Runs every readiness matrix (issue #13) and writes a combined summary.
 *
 * Run: node spike/readiness/run-all.mjs
 *
 * Each matrix is a separate process, so a crash in one cannot hide the
 * results of the others. Results land in spike/readiness/results/.
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
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
  // (the provider matrix takes hours).
  const existing = process.env.SPIKE_REUSE === '1' ? await readReport(name) : null;
  const code = existing ? 0 : await run(script);
  if (existing) console.log(`reused existing ${name} report (partial=${existing.partial ?? false})`);
  const report = await readReport(name);
  outcomes.push({
    matrix: name,
    exitCode: code,
    reused: Boolean(existing),
    passed: report?.passed ?? null,
    failed: report?.failed ?? null,
    failedChecks: (report?.results ?? [])
      .filter((r) => !r.ok)
      .map((r) => ({ name: r.name, detail: r.detail })),
  });
}

const summary = {
  generatedAt: new Date().toISOString(),
  outcomes,
  authorizedRoundTrip: (await readReport('provider-matrix'))?.authorizedRoundTrip ?? null,
};
await writeReport('summary', summary);

console.log('\n===== SUMMARY =====');
for (const outcome of outcomes) {
  console.log(
    `${outcome.matrix.padEnd(18)} exit=${outcome.exitCode} passed=${outcome.passed} failed=${outcome.failed}`,
  );
  for (const failure of outcome.failedChecks ?? []) {
    console.log(`  FAIL ${failure.name} - ${failure.detail}`);
  }
}
console.log(`\nresults dir: ${RESULTS_DIR}`);
