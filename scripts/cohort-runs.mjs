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
  // ISO 8601 in UTC compares correctly as a string, and Date.parse on a
  // timestamp a record wrote is the same ordering without the trap of a
  // locally parsed value.
  if (Date.parse(started) < Date.parse(from)) continue;
  if (to && Date.parse(started) >= Date.parse(to)) continue;
  await mkdir(path.join(dir, entry), { recursive: true });
  await cp(source, path.join(dir, entry, 'review.json'));
  copied += 1;
}

console.log(
  `cohort-runs: ${copied} ${profile} run(s) from ${from}${to ? ` to ${to}` : ''} into ${dir}`,
);
