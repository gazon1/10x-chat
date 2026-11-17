#!/usr/bin/env node
// Build entry point for the `prepare` lifecycle script.
//
// Why this exists: `npm install -g github:gazon1/10x-chat` runs `prepare`
// inside a bare git clone. npm installs the runtime dependencies into the
// *target* directory (the global prefix), not into the clone, so the clone
// has no `node_modules` while `tsc` is executed. Every module then fails to
// resolve (`TS2307: Cannot find module 'node:fs'`, `chalk`, `playwright`, …)
// and the whole install aborts.
//
// So the build has to bring its own toolchain: if the clone has no local
// `typescript` / `@types/node`, install the dependencies first and only then
// compile. `--ignore-scripts` is mandatory — it prevents the nested install
// from running this very script again.

import { spawnSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const nodeModules = join(root, 'node_modules');

/** Run a command, streaming its output, and exit with its status. */
function run(command, args, env = process.env) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', env });
  if (result.error) {
    console.error(`[prepare] ${command} failed to start: ${result.error.message}`);
    process.exit(1);
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

/** The npm executable: the one that started us, or the one on PATH. */
function npmCommand() {
  const npmCli = process.env.npm_execpath;
  if (npmCli) {
    return { command: process.execPath, prefix: [npmCli] };
  }
  return {
    command: process.platform === 'win32' ? 'npm.cmd' : 'npm',
    prefix: [],
  };
}

const toolchain = [
  join(nodeModules, 'typescript', 'bin', 'tsc'),
  join(nodeModules, '@types', 'node', 'package.json'),
];

let installedToolchain = false;

if (!toolchain.every((path) => existsSync(path))) {
  console.log('[prepare] no local toolchain found — installing dependencies first');
  const npm = npmCommand();
  // npm runs `prepare` with the settings of the outer install, and for a
  // global install that means `npm_config_global=true` — the nested install
  // would then write to the global prefix instead of the local
  // `node_modules` of this checkout. Force a project-local install.
  const env = {
    ...process.env,
    npm_config_global: 'false',
    npm_config_location: 'project',
    npm_config_prefix: root,
  };
  run(
    npm.command,
    [
      ...npm.prefix,
      'install',
      '--ignore-scripts',
      '--include=dev',
      '--no-audit',
      '--no-fund',
      '--no-package-lock',
      '--global=false',
      '--location=project',
      `--prefix=${root}`,
    ],
    env,
  );
  installedToolchain = true;
}

const tsc = join(nodeModules, 'typescript', 'bin', 'tsc');
if (!existsSync(tsc)) {
  console.error('[prepare] typescript is still missing — the build cannot continue');
  process.exit(1);
}

run(process.execPath, [tsc, '-p', 'tsconfig.build.json']);

if (installedToolchain) {
  // The dependencies were only needed to compile. Leaving them behind makes
  // npm reify the package on top of an existing `node_modules` and fail with
  // `ENOENT … chmod …/node_modules/<dep>/…` while linking the bins. Remove
  // them again so npm starts from a clean tree.
  console.log('[prepare] removing the temporary node_modules');
  rmSync(nodeModules, { recursive: true, force: true });
}
