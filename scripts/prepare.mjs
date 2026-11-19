#!/usr/bin/env node
// Builds dist/ for an install from a git remote (`npm i -g github:gazon1/10x-chat`).
//
// npm clones the repo and installs its dependencies before it runs "prepare",
// but a global install inherits npm_config_global=true, so that inner install
// puts the dependencies into the global prefix instead of the clone. The
// compiler then cannot resolve them. Install them into the clone itself
// (locally, without scripts) and build afterwards.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The package root: the directory that holds package.json.
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

if (!existsSync(path.join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc'))) {
  const install = spawnSync(
    'npm',
    [
      'install',
      '--include=dev',
      '--no-save',
      '--no-package-lock',
      '--ignore-scripts',
      '--global=false',
    ],
    { cwd: ROOT, stdio: 'inherit' },
  );
  if (install.status !== 0) {
    process.exit(install.status ?? 1);
  }
}

const build = spawnSync('npm', ['run', 'build'], { cwd: ROOT, stdio: 'inherit' });
process.exit(build.status ?? 0);
