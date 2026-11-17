import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..');
const CLI_ENTRY = path.join(REPO_ROOT, 'src', 'bin', 'cli.ts');

export interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
  /** stdout and stderr together — the CLI writes some errors to stderr. */
  output: string;
}

/** Colors would break the assertions on the output of the CLI. */
const ANSI_PATTERN = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');

export function stripAnsi(value: string): string {
  return value.replace(ANSI_PATTERN, '');
}

/**
 * Run the CLI from the sources.
 *
 * The CLI is started with `node --import tsx`, so the suite exercises the real
 * entry point (the same code the built `dist/` runs) without needing a build
 * step first.
 */
export function runCli(args: string[], env: NodeJS.ProcessEnv = {}): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.env.NODE_BINARY ?? 'node',
      ['--import', 'tsx', CLI_ENTRY, ...args],
      {
        cwd: REPO_ROOT,
        env: { ...process.env, ...env },
      },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => {
      const clean = (value: string) => stripAnsi(value);
      const out = clean(stdout);
      const err = clean(stderr);
      resolve({ code: code ?? -1, stdout: out, stderr: err, output: out + err });
    });
  });
}

/** A throwaway data directory, so a test run never touches the real profile. */
export async function withTempHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
  const home = await mkdtemp(path.join(os.tmpdir(), '10x-chat-e2e-'));
  try {
    return await fn(home);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}
