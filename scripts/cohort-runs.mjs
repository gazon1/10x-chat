#!/usr/bin/env node
// Copy the runs of one cohort out of the store into a directory of its own.
//
// The store is one directory of every run this machine made, and each round
// adds its runs to it. A before/after needs the rounds apart, so a round is
// copied out and named by what it measured:
//
//   node scripts/cohort-runs.mjs <dir> <profile> <started-at> [<ended-at>]
//
// `--baseline` and `--dir` of review-latency.mjs then point at the copies and
// the store of one round can never be rewritten by the next.
import { cp, mkdir, readdir, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const [dir, profile, from, to] = process.argv.slice(2);
if (!dir || !profile || !from) {
  console.error('usage: cohort-runs.mjs <dir> <profile> <started-at> [<ended-at>]');
  process.exit(1);
}

// The window is parsed before the store is read: `Date.parse` answers NaN for a
// timestamp it cannot read, every comparison against NaN is false, and a bound
// that silently stops filtering is worse than one that refuses to run. A
// mistyped round would otherwise be measured as a cohort of the whole store.
const fromMs = Date.parse(from);
const toMs = to === undefined ? undefined : Date.parse(to);
if (Number.isNaN(fromMs)) {
  console.error(`cohort-runs: <started-at> is not a timestamp: ${from}`);
  process.exit(1);
}
if (toMs !== undefined && Number.isNaN(toMs)) {
  console.error(`cohort-runs: <ended-at> is not a timestamp: ${to}`);
  process.exit(1);
}
if (toMs !== undefined && toMs < fromMs) {
  console.error(`cohort-runs: <ended-at> ${to} is earlier than <started-at> ${from}`);
  process.exit(1);
}

const store = process.env.TEN_X_CHAT_HOME
  ? path.join(process.env.TEN_X_CHAT_HOME, 'reviews')
  : path.join(os.homedir(), '.10x-chat', 'reviews');

let entries;
try {
  entries = await readdir(store);
} catch (error) {
  if (error.code === 'ENOENT') {
    console.error(`cohort-runs: no store at ${store}`);
    process.exit(1);
  }
  throw error;
}

// A frozen cohort is written once. Extraction copies into the directory and
// never deletes from it, so a second extraction with a narrower window would
// leave the runs of the first one behind — a directory that holds more than its
// window says, and a benchmark that reads them as samples of this round. The
// directory is therefore refused when it already holds something, and the
// caller removes it on purpose.
try {
  const existing = await readdir(dir);
  if (existing.length > 0) {
    console.error(
      `cohort-runs: ${dir} already holds ${existing.length} entr(ies) — a cohort is written once. ` +
        'Remove it to extract again.',
    );
    process.exit(1);
  }
} catch (error) {
  // A directory that is not there yet is the normal first extraction.
  if (error.code !== 'ENOENT') throw error;
}

await mkdir(dir, { recursive: true });
let copied = 0;
for (const entry of entries) {
  const source = path.join(store, entry, 'review.json');
  let run;
  try {
    run = JSON.parse(await readFile(source, 'utf-8'));
  } catch {
    // A run that is not there or cannot be read is not a measurement.
    continue;
  }
  // A run of an older version names no profile, and it is the full review it
  // was — the same default the pipeline and the benchmark read it with.
  if ((run.profile ?? 'standard') !== profile) continue;
  const started = run.startedAt;
  if (typeof started !== 'string') continue;
  const startedMs = Date.parse(started);
  // A record whose own timestamp cannot be read is not placed in a window: it
  // would compare false against both bounds and join whatever cohort ran.
  if (Number.isNaN(startedMs)) continue;
  if (startedMs < fromMs) continue;
  if (toMs !== undefined && startedMs >= toMs) continue;
  await mkdir(path.join(dir, entry), { recursive: true });
  await cp(source, path.join(dir, entry, 'review.json'));
  copied += 1;
}

console.log(
  `cohort-runs: ${copied} ${profile} run(s) from ${from}${to ? ` to ${to}` : ''} into ${dir}`,
);
