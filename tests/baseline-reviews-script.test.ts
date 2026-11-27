import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const REPO_ROOT = path.join(import.meta.dirname, '..');
const SCRIPT = path.join(REPO_ROOT, 'scripts', 'baseline-reviews.sh');

let dir: string;
let home: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), '10x-chat-baseline-'));
  home = mkdtempSync(path.join(tmpdir(), '10x-chat-baseline-home-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

/**
 * A copy of the script whose workspace and store are the temporary ones.
 *
 * The script reads the record of the run it made to state the verdict, so the
 * store of the run is the temporary home and not the real one.
 */
function prepareScript(options: { verdict?: string; exitCode?: number } = {}): string {
  const workspace = path.join(dir, 'workspace');
  mkdirSync(path.join(workspace, 'scripts'), { recursive: true });
  mkdirSync(path.join(workspace, 'build', 'diagnostics'), { recursive: true });
  mkdirSync(path.join(workspace, 'dist', 'bin'), { recursive: true });

  // A fake CLI: it writes one run into the store and prints its verdict, the
  // way the command does.
  const cli = path.join(workspace, 'dist', 'bin', 'cli.js');
  writeFileSync(
    cli,
    [
      '#!/usr/bin/env node',
      "const fs=require('node:fs'),path=require('node:path');",
      "const id='run-'+(process.env.PR||'x');",
      "const dir=path.join(process.env.HOME,'.10x-chat','reviews',id);",
      'fs.mkdirSync(dir,{recursive:true});',
      `fs.writeFileSync(path.join(dir,'review.json'),JSON.stringify({id,verdict:${JSON.stringify(
        options.verdict ?? 'APPROVE',
      )},steps:[{id:'render-report',status:'passed',durationMs:1}]}));`,
      `console.log('Run: '+id);`,
      `process.exit(${options.exitCode ?? 0});`,
    ].join('\n'),
  );
  chmodSync(cli, 0o755);

  // A fake git and gh: the checkout always succeeds and the head is a sha.
  for (const [name, body] of [
    // The checkout is what the script asks for: a fake git creates the
    // directory it is told to, the way `git worktree add` does.
    ['git', '#!/bin/sh\ncase "$*" in *"worktree add"*) mkdir -p "$6";; esac\nexit 0\n'],
    ['gh', '#!/bin/sh\nprintf "abc123\\n"\n'],
  ]) {
    const file = path.join(dir, 'bin', name);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, body);
    chmodSync(file, 0o755);
  }

  const script = path.join(workspace, 'scripts', 'baseline-reviews.sh');
  const source = readFileSync(SCRIPT, 'utf8')
    // The copy measures nothing real: one run per bucket is enough to check
    // what the script writes down.
    .replace(/^WORKSPACE=.*$/m, `WORKSPACE="${workspace}"`)
    .replace(/^SMALL=.*$/m, 'SMALL=82')
    .replace(/^MEDIUM=.*$/m, 'MEDIUM=')
    .replace(/^LARGE=.*$/m, 'LARGE=');
  writeFileSync(script, source);
  chmodSync(script, 0o755);
  return script;
}

/** Run the prepared script with the temporary home and the fake tools. */
function run(script: string): string {
  execFileSync('bash', [script], {
    env: { ...process.env, HOME: home, PATH: `${path.join(dir, 'bin')}:${process.env.PATH ?? ''}` },
  });
  const logs = execFileSync(
    'bash',
    ['-c', `ls ${path.join(dir, 'workspace', 'build', 'diagnostics')}`],
    {
      encoding: 'utf-8',
    },
  )
    .trim()
    .split('\n');
  return readFileSync(
    path.join(dir, 'workspace', 'build', 'diagnostics', logs.at(-1) as string),
    'utf8',
  );
}

describe('the baseline runner', () => {
  it('records the verdict of the run, not the word that appears first in the report', () => {
    // The report carries the verdict of the run and the text of its findings,
    // and a line of a finding can hold the word of the other verdict. The
    // record of the run is the one place that settles it.
    const log = run(prepareScript({ verdict: 'REQUEST CHANGES', exitCode: 1 }));

    // The profile of the round is part of the line: the two profiles are
    // separate cohorts, and a log that dropped it would merge them.
    expect(log).toContain(
      'DONE profile=standard pr=82 bucket=small exit=1 verdict=REQUEST CHANGES',
    );
    expect(log).toContain('COMPLETE');
  });

  it('leaves the verdict unknown when no record of the run can be read', () => {
    // The CLI prints a run id but writes nothing: guessing the verdict from
    // the exit code would hide exactly the case the benchmark must not lose.
    const script = prepareScript({ exitCode: 0 });
    const cli = path.join(dir, 'workspace', 'dist', 'bin', 'cli.js');
    writeFileSync(cli, "#!/bin/sh\necho 'Run: missing-run'\nexit 0\n");
    chmodSync(cli, 0o755);

    const log = run(script);

    expect(log).toContain('verdict=UNKNOWN');
  });
});
