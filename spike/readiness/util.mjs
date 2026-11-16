/**
 * Shared helpers for the production-readiness harness (issue #13).
 *
 * Nothing here touches production code: the harness talks to the two browser
 * engines directly (Camoufox/Firefox and CloakBrowser/Chromium) through the
 * same adapter interface, so every scenario runs identically on both.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const HERE = path.dirname(fileURLToPath(import.meta.url));
export const RESULTS_DIR = path.join(HERE, 'results');
export const require = createRequire(import.meta.url);

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

/** Versions + host facts every matrix report repeats. */
export function envInfo() {
  const pkg = (spec) => {
    try {
      return require(`${spec}/package.json`).version;
    } catch {
      return null;
    }
  };
  let camoufoxBrowser = null;
  try {
    camoufoxBrowser = require('camoufox/package.json').version;
  } catch {}
  return {
    node: process.version,
    platform: `${os.type()} ${os.release()} ${os.arch()}`,
    host: os.hostname(),
    camoufoxPackage: camoufoxBrowser,
    playwrightCoreSpike: pkg('playwright-core'),
    cloakbrowser: pkg('cloakbrowser'),
    proxyEnv: {
      HTTPS_PROXY: process.env.HTTPS_PROXY ?? null,
      HTTP_PROXY: process.env.HTTP_PROXY ?? null,
      NO_PROXY: process.env.NO_PROXY ?? null,
    },
  };
}

/** A check runner that never aborts the matrix: failures are data. */
export function createChecker() {
  const results = [];
  return {
    results,
    async check(name, fn) {
      const started = Date.now();
      try {
        const detail = await fn();
        results.push({ name, ok: true, ms: Date.now() - started, detail: detail ?? null });
        console.log(`PASS  ${name} (${Date.now() - started}ms) ${detail ? `- ${detail}` : ''}`);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        results.push({ name, ok: false, ms: Date.now() - started, detail: message });
        console.log(`FAIL  ${name} (${Date.now() - started}ms) - ${message}`);
      }
      return results.at(-1);
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

/** Total RSS (kB) of every process matching `pattern`. */
export function rssKb(pattern) {
  let total = 0;
  for (const pid of pids(pattern)) {
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
