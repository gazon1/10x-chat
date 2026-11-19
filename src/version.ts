import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The root of the package: `src/` and `dist/` both live in it. */
const packageDir = dirname(dirname(fileURLToPath(import.meta.url)));

/**
 * The version of the installed package.
 *
 * The daemon writes it into its state file: the daemon runs the code of the
 * package it was started from, so a daemon of an older version cannot serve a
 * client of a newer one.
 */
export function getPackageVersion(): string {
  try {
    const raw = readFileSync(join(packageDir, 'package.json'), 'utf-8');
    const pkg = JSON.parse(raw) as { version?: unknown };
    return typeof pkg.version === 'string' ? pkg.version : 'unknown';
  } catch {
    return 'unknown';
  }
}
