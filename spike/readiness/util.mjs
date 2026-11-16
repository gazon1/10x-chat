/**
 * Shared helpers for the production-readiness harness (issue #13).
 *
 * Nothing here touches production code: the harness talks to the two browser
 * engines directly (Camoufox/Firefox and CloakBrowser/Chromium) through the
 * same adapter interface, so every scenario runs identically on both.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const HERE = path.dirname(fileURLToPath(import.meta.url));
export const RESULTS_DIR = path.join(HERE, 'results');
// The repository root: spike/readiness/ lives two levels below it.
export const REPO_ROOT = path.resolve(HERE, '..', '..');

export async function writeReport(name, payload) {
  await mkdir(RESULTS_DIR, { recursive: true });
  const file = path.join(RESULTS_DIR, `${name}.json`);
  await writeFile(file, `${JSON.stringify(payload, null, 2)}\n`);
  return file;
}

export async function readReport(name) {
  try {
    return JSON.parse(await readFile(path.join(RESULTS_DIR, `${name}.json`), 'utf8'));
  } catch {
    return null;
  }
}

export function assert(cond, message) {
  if (!cond) throw new Error(message);
}

/**
 * Where the versions of the packages the harness really uses are installed.
 *
 * `createRequire(import.meta.url)` resolves relative to `spike/readiness/`,
 * so it finds the repository's `node_modules` and nothing else: Camoufox and
 * its Playwright live in the nested sandbox `spike/camoufox/node_modules`.
 * The paths are therefore spelled out, and the resolved file is recorded in
 * the report (`env.versionSources`) so a wrong or missing version is visible
 * instead of silently `null`.
 */
const VERSION_SOURCES = {
  camoufoxPackage: path.join(REPO_ROOT, 'spike', 'camoufox', 'node_modules', 'camoufox'),
  playwrightCoreSpike: path.join(REPO_ROOT, 'spike', 'camoufox', 'node_modules', 'playwright-core'),
  playwrightCoreRepo: path.join(REPO_ROOT, 'node_modules', 'playwright-core'),
  cloakbrowser: path.join(REPO_ROOT, 'node_modules', 'cloakbrowser'),
};

function packageVersion(dir) {
  try {
    const pkg = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'));
    return pkg.version ?? null;
  } catch {
    return null;
  }
}

/**
 * The Camoufox browser build that is installed, read from the cache config
 * (`active_version` = `browsers/official/158.0.1-beta.41-3f2eb1d0`).
 */
function camoufoxBrowserBuild() {
  const installPath = path.join(os.homedir(), '.cache', 'camoufox');
  try {
    const config = JSON.parse(readFileSync(path.join(installPath, 'config.json'), 'utf8'));
    const active = String(config.active_version ?? '');
    if (!active) return null;
    // `active_version` is a path: `browsers/official/158.0.1-beta.41-3f2eb1d0`.
    const leaf = active.split('/').pop() ?? active;
    const cut = leaf.lastIndexOf('-');
    const tail = cut === -1 ? '' : leaf.slice(cut + 1);
    if (/^[0-9a-f]{8,}$/.test(tail)) {
      return { version: leaf.slice(0, cut), sha256: tail, installPath };
    }
    return { version: leaf, sha256: null, installPath };
  } catch {
    return null;
  }
}

/** Versions + host facts every matrix report repeats. */
export function envInfo() {
  const versions = {};
  const versionSources = {};
  for (const [key, dir] of Object.entries(VERSION_SOURCES)) {
    const version = packageVersion(dir);
    versions[key] = version;
    versionSources[key] = version ? path.join(dir, 'package.json') : null;
  }
  const build = camoufoxBrowserBuild();
  versions.camoufoxBrowser = build?.version ?? null;
  versions.camoufoxBrowserSha256 = build?.sha256 ?? null;
  versionSources.camoufoxBrowser = build ? path.join(build.installPath, 'config.json') : null;
  return {
    node: process.version,
    platform: `${os.type()} ${os.release()} ${os.arch()}`,
    host: os.hostname(),
    ...versions,
    versionSources,
    // The display the browsers were opened on: a headed browser on the
    // desktop would steal the focus, so the harness only uses a virtual one.
    display: process.env.DISPLAY ?? null,
    proxyEnv: {
      HTTPS_PROXY: process.env.HTTPS_PROXY ?? null,
      HTTP_PROXY: process.env.HTTP_PROXY ?? null,
      NO_PROXY: process.env.NO_PROXY ?? null,
    },
  };
}

/**
 * The settings a matrix depends on. `run-all.mjs` compares them before it
 * reuses a saved report, so results from a different experiment are never
 * reused silently.
 */
export function harnessSettings(matrix) {
  return {
    proxy:
      matrix === 'provider-matrix' ? (process.env.SPIKE_PROXY ?? 'http://127.0.0.1:3128') : null,
    headless: matrix === 'provider-matrix' ? process.env.SPIKE_HEADLESS === '1' : true,
  };
}

/** A check runner that never aborts the matrix: failures are data. */
export function createChecker() {
  const results = [];
  const record = (name, ok, detail, extra = {}) => {
    results.push({ name, ok, detail: detail ?? null, ...extra });
    const shown =
      typeof detail === 'object' && detail !== null ? JSON.stringify(detail) : (detail ?? '');
    const tag = extra.skipped ? 'SKIP' : ok ? 'PASS' : 'FAIL';
    console.log(`${tag}  ${name}${shown ? ` - ${shown}` : ''}`);
    return results.at(-1);
  };
  return {
    results,
    record,
    async check(name, fn) {
      const started = Date.now();
      try {
        const detail = await fn();
        const result = record(name, true, detail);
        result.ms = Date.now() - started;
        console.log(`  (${result.ms}ms)`);
        return result;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const result = record(name, false, message);
        result.ms = Date.now() - started;
        return result;
      }
    },
  };
}

export function pids(pattern) {
  try {
    const out = execFileSync('pgrep', ['-f', pattern], { encoding: 'utf8' });
    return out
      .split('\n')
      .map((line) => Number(line.trim()))
      .filter((pid) => Number.isInteger(pid) && pid > 0);
  } catch {
    return [];
  }
}

/**
 * The processes that appeared since a snapshot was taken.
 *
 * `pgrep -f <pattern>` matches every process of the machine — a browser the
 * user opened by hand would end up in the RSS of the test. Comparing with a
 * snapshot taken before the launch keeps the measurement to the processes the
 * test itself started.
 */
export function newPids(pattern, before = []) {
  const known = new Set(before);
  return pids(pattern).filter((pid) => !known.has(pid));
}

/** Are the given processes still alive? */
export function alivePids(pidList) {
  return pidList.filter((pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  });
}

/** Total RSS (kB) of the given processes. */
export function rssKbOfPids(pidList) {
  let total = 0;
  for (const pid of pidList) {
    try {
      const status = execFileSync('cat', [`/proc/${pid}/status`], { encoding: 'utf8' });
      const match = status.match(/VmRSS:\s+(\d+) kB/);
      if (match) total += Number(match[1]);
    } catch {
      /* process died between pgrep and read */
    }
  }
  return total;
}

/** Total RSS (kB) of every process matching `pattern`. */
export function rssKb(pattern) {
  return rssKbOfPids(pids(pattern));
}

export function dirSizeKb(dir) {
  // `du` exits with 1 when files change while it scans (the browser dir does
  // exactly that), so the size is taken from stdout even on a non-zero exit.
  const result = spawnSync('du', ['-sk', dir], { encoding: 'utf8' });
  const stdout = result.stdout ?? '';
  const size = Number(stdout.trim().split(/\s+/)[0]);
  return Number.isFinite(size) ? size : null;
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
