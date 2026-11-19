import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = path.join(import.meta.dirname, '..');

function packageJson(): Record<string, unknown> {
  return JSON.parse(readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
}

/**
 * Runs scripts/prepare.mjs in a scratch directory with a fake npm on the PATH.
 * The fake npm records its arguments and creates the files that the real one
 * would create, so the script can be checked without a network install.
 */
function runPrepare(): { calls: string[]; dir: string } {
  const dir = mkdtempSync(path.join(tmpdir(), '10x-chat-prepare-'));
  const bin = path.join(dir, 'bin');
  mkdirSync(bin);
  const log = path.join(dir, 'npm-calls.log');

  writeFileSync(
    path.join(bin, 'npm'),
    `#!/bin/sh
echo "$@" >> "${log}"
case "$1" in
  install)
    mkdir -p node_modules/typescript/bin
    ;;
  run)
    mkdir -p dist/bin
    echo "// built" > dist/bin/cli.js
    ;;
esac
`,
    { mode: 0o755 },
  );

  mkdirSync(path.join(dir, 'scripts'));
  execFileSync('cp', [
    path.join(REPO_ROOT, 'scripts', 'prepare.mjs'),
    path.join(dir, 'scripts', 'prepare.mjs'),
  ]);

  execFileSync(process.execPath, [path.join(dir, 'scripts', 'prepare.mjs')], {
    env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}` },
  });

  return { calls: readFileSync(log, 'utf8').trim().split('\n'), dir };
}

describe('the packaging of a git install', () => {
  it('builds the distribution in prepare, so the binary exists after the install', () => {
    const scripts = packageJson().scripts as Record<string, string>;
    expect(scripts.prepare).toBe('node scripts/prepare.mjs');
    expect(scripts.build).toBe('tsc -p tsconfig.build.json');
    // A git install has no dist/ in the repository: without prepare the binary
    // target does not exist and npm links no command.
    const ignored = readFileSync(path.join(REPO_ROOT, '.gitignore'), 'utf8').split('\n');
    expect(ignored).toContain('dist/');
  });

  it('installs the dependencies into the clone itself, not into the global prefix', () => {
    const { calls } = runPrepare();
    const install = calls.find((call) => call.startsWith('install'));
    expect(install).toBeDefined();
    // A global install inherits npm_config_global=true into the inner install,
    // which then puts the dependencies into the global prefix and leaves the
    // clone without them — the compiler cannot resolve the types.
    expect(install).toContain('--global=false');
    expect(install).toContain('--include=dev');
  });

  it('builds the distribution after the dependencies are in place', () => {
    const { calls, dir } = runPrepare();
    expect(calls.at(-1)).toBe('run build');
    expect(existsSync(path.join(dir, 'dist', 'bin', 'cli.js'))).toBe(true);
  });
});
