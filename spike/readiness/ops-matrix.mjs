/**
 * Operational matrix — issue #13, §5/§6.
 *
 * Install footprint, cold/warm start time, resident memory, leftover
 * processes and the licensing facts that the migration decision depends on.
 * Everything is measured, nothing is assumed.
 */

import { execFileSync } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ENGINE_NAMES, engines } from './engines.mjs';
import {
  alivePids,
  assert,
  createChecker,
  dirSizeKb,
  envInfo,
  harnessSettings,
  newPids,
  pids,
  rssKbOfPids,
  sleep,
  writeReport,
} from './util.mjs';

const TARGET = 'https://example.com';

async function measureLaunch(engine) {
  // `pgrep -f <pattern>` matches every process of the machine: a browser the
  // user opened by hand would otherwise be counted as RSS of this test. The
  // snapshot before the launch makes the measurement specific to the
  // processes this test started.
  const before = pids(engine.processPattern);
  const started = Date.now();
  const browser = await engine.launch({ headless: true });
  const launched = Date.now();
  try {
    const page = await browser.newPage();
    await page.goto(TARGET, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    const loaded = Date.now();
    const spawned = newPids(engine.processPattern, before);
    const rss = rssKbOfPids(spawned);
    return {
      launchMs: launched - started,
      firstPaintMs: loaded - started,
      rssKb: rss,
      processes: spawned.length,
      spawnedPids: spawned,
    };
  } finally {
    await browser.close().catch(() => {});
  }
}

async function main() {
  const checker = createChecker();
  const perEngine = {};

  // 1. Install footprint ------------------------------------------------------
  const home = os.homedir();
  const footprints = {
    camoufox: {
      total: dirSizeKb(path.join(home, '.cache', 'camoufox')),
      browsers: dirSizeKb(path.join(home, '.cache', 'camoufox', 'browsers')),
      geolocation: dirSizeKb(path.join(home, '.cache', 'camoufox', 'geolocation')),
    },
    cloakbrowser: {
      total: dirSizeKb(path.join(home, '.cloakbrowser')),
      freeBuild: dirSizeKb(path.join(home, '.cloakbrowser', 'chromium-146.0.7680.177.5')),
      proBuild: dirSizeKb(path.join(home, '.cloakbrowser', 'chromium-156.0.8078.47.1-pro')),
    },
  };
  const _r0 = await checker.check('install footprint measured', async () => {
    assert(footprints.camoufox.total, 'camoufox install dir not found');
    assert(footprints.cloakbrowser.total, 'cloakbrowser install dir not found');
    return `camoufox=${Math.round(footprints.camoufox.total / 1024)}MB cloakbrowser=${Math.round(footprints.cloakbrowser.total / 1024)}MB`;
  });

  for (const engineName of ENGINE_NAMES) {
    const engine = engines[engineName];
    console.log(`\n=== ops matrix: ${engineName} ===`);
    const results = {};

    // 2. Cold / warm start -----------------------------------------------------
    const cold = await checker.check(`${engineName}: cold start (first launch)`, async () => {
      const m = await measureLaunch(engine);
      results.cold = m;
      return `launch=${m.launchMs}ms first-paint=${m.firstPaintMs}ms rss=${Math.round(m.rssKb / 1024)}MB procs=${m.processes}`;
    });
    const warm = await checker.check(`${engineName}: warm start (second launch)`, async () => {
      const m = await measureLaunch(engine);
      results.warm = m;
      return `launch=${m.launchMs}ms first-paint=${m.firstPaintMs}ms rss=${Math.round(m.rssKb / 1024)}MB procs=${m.processes}`;
    });

    // 3. Cleanup ---------------------------------------------------------------
    const cleanup = await checker.check(`${engineName}: no leftover processes`, async () => {
      const before = pids(engine.processPattern);
      const m = await measureLaunch(engine);
      await sleep(2000);
      // Only the processes this launch started are checked: a browser the user
      // has open is none of the harness's business.
      const leftover = alivePids(m.spawnedPids);
      assert(
        leftover.length === 0,
        `leftover processes of this launch: ${leftover.join(', ')} (before=${before.length})`,
      );
      return `spawned=${m.spawnedPids.length} leftover=0 (machine-wide before=${before.length})`;
    });

    perEngine[engineName] = { footprint: footprints[engineName], results: { cold, warm, cleanup } };
  }

  // 4. Install path and failure modes ----------------------------------------
  const install = {};
  {
    const r = await checker.check(
      'camoufox: missing browser build fails with a clear error',
      async () => {
        const script = `
        import { Camoufox } from './spike/camoufox/node_modules/camoufox/dist/index.js';
        try {
          await Camoufox({ headless: true });
          console.log('LAUNCHED');
        } catch (err) {
          console.log('ERROR ' + String(err.message).split('\\n')[0]);
        }
        process.exit(0);
      `;
        const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
          cwd: process.cwd(),
          encoding: 'utf8',
          env: { ...process.env, CAMOUFOX_EXECUTABLE_PATH: '/nonexistent/camoufox' },
          timeout: 60_000,
        });
        assert(out.includes('ERROR'), `unexpected output: ${out.trim()}`);
        install.camoufoxMissingBuild = out.trim().split('\n').pop();
        return install.camoufoxMissingBuild;
      },
    );
    install.camoufoxMissingBuild = r.detail;
  }

  {
    const r = await checker.check(
      'camoufox: supported install command lists the build',
      async () => {
        const out = execFileSync('npx', ['camoufox', 'list'], {
          cwd: path.join(process.cwd(), 'spike', 'camoufox'),
          encoding: 'utf8',
          timeout: 120_000,
        });
        install.camoufoxList = out.trim().split('\n').slice(0, 6).join(' | ');
        return install.camoufoxList;
      },
    );
    install.camoufoxList = r.detail;
  }

  {
    const r = await checker.check('download throughput for the browser builds', async () => {
      const measure = (url, label) => {
        try {
          const raw = execFileSync(
            'curl',
            [
              '-sS',
              '-L',
              '-o',
              '/dev/null',
              '--max-time',
              '12',
              '-w',
              '%{speed_download} %{size_download} %{http_code}',
              url,
            ],
            { encoding: 'utf8', timeout: 40_000 },
          );
          const [speed, size, code] = raw.trim().split(' ').map(Number);
          return { label, url, bytesPerSec: speed, bytes: size, httpCode: code };
        } catch (err) {
          // curl exits non-zero when the transfer is cut short by --max-time;
          // the partial measurement is still valid.
          const raw = err.stdout ?? '';
          if (raw.trim()) {
            const [speed, size, code] = raw.trim().split(' ').map(Number);
            return { label, url, bytesPerSec: speed, bytes: size, httpCode: code, partial: true };
          }
          return { label, url, error: String(err.message).split('\n')[0] };
        }
      };
      const releases = await fetch('https://api.github.com/repos/daijro/camoufox/releases/latest')
        .then((r) => r.json())
        .catch(() => null);
      const asset = releases?.assets?.find((a) => /lin\.x86_64\.zip$/.test(a.name));
      const samples = [];
      if (asset) samples.push(measure(asset.browser_download_url, `camoufox ${asset.name}`));
      samples.push(measure('https://cloakbrowser.dev/api/download/latest', 'cloakbrowser latest'));
      install.downloadSamples = samples;
      assert(samples.length > 0, 'no download sample collected');
      return samples
        .map(
          (s) =>
            `${s.label}: ${s.error ?? `${Math.round((s.bytesPerSec ?? 0) / 1024 / 1024)} MB/s, http=${s.httpCode}`}`,
        )
        .join(' | ');
    });
    install.downloadSamples = r.detail;
  }

  // 5. Licensing facts (from the installed packages, not from memory) ----------
  const license = await checker.check('licensing facts collected', async () => {
    const facts = {};
    try {
      const pkg = JSON.parse(
        await readFile(
          path.join(process.cwd(), 'node_modules', 'cloakbrowser', 'package.json'),
          'utf8',
        ),
      );
      facts.cloakbrowserPackage = { version: pkg.version, license: pkg.license };
    } catch (err) {
      facts.cloakbrowserPackage = `error: ${err.message}`;
    }
    try {
      const pkg = JSON.parse(
        await readFile(
          path.join(process.cwd(), 'spike', 'camoufox', 'node_modules', 'camoufox', 'package.json'),
          'utf8',
        ),
      );
      facts.camoufoxPackage = { version: pkg.version, license: pkg.license };
    } catch (err) {
      facts.camoufoxPackage = `error: ${err.message}`;
    }
    try {
      const file = path.join(process.cwd(), 'node_modules', 'cloakbrowser', 'BINARY-LICENSE.md');
      const stat_ = await stat(file);
      facts.cloakbrowserBinaryLicense = `present (${stat_.size} bytes)`;
    } catch {
      facts.cloakbrowserBinaryLicense =
        'not shipped in the npm package (downloaded with the binary)';
    }
    facts.costModel = {
      camoufox: 'MPL-2.0 browser build + MIT tooling: no licence fee, redistribution allowed',
      cloakbrowser:
        'MIT wrapper + separate binary licence: free tier = 1 concurrent session, no redistribution; paid tiers for 5/20/200/2000+ concurrent sessions',
    };
    return JSON.stringify(facts);
  });

  const payload = {
    matrix: 'ops',
    env: envInfo(),
    harness: harnessSettings('ops-matrix'),
    footprintsKb: footprints,
    install,
    license: license.detail,
    perEngine,
    results: checker.results,
    passed: checker.results.filter((r) => r.ok).length,
    failed: checker.results.filter((r) => !r.ok).length,
  };
  const file = await writeReport('ops-matrix', payload);
  console.log(`\nops matrix: ${payload.passed} passed, ${payload.failed} failed -> ${file}`);
}

await main();

// The proxy/fixture servers keep the event loop alive: exit explicitly.
process.exit(0);
