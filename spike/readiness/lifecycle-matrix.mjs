/**
 * Lifecycle / profile matrix — issue #13, §4.
 *
 * Persistent profiles, context isolation, storageState round-trip, file
 * upload/download, browser reuse (the daemon does exactly this) and process
 * cleanup after close. Same code for both engines.
 */
import { readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createFixtureServer, listen as listenFixture } from '../camoufox/fixtures.mjs';
import { ENGINE_NAMES, engines } from './engines.mjs';
import {
  alivePids,
  assert,
  createChecker,
  envInfo,
  harnessSettings,
  newPids,
  pids,
  sleep,
  writeReport,
} from './util.mjs';

const WORK = path.join(tmpdir(), '10x-chat-readiness-lifecycle');

async function newPage(context) {
  return context.pages()[0] ?? context.newPage();
}

async function main() {
  await rm(WORK, { recursive: true, force: true });
  const checker = createChecker();
  const perEngine = {};

  const fixture = createFixtureServer();
  const fixturePort = await listenFixture(fixture.server);
  const base = `http://127.0.0.1:${fixturePort}`;

  for (const engineName of ENGINE_NAMES) {
    const engine = engines[engineName];
    console.log(`\n=== lifecycle matrix: ${engineName} ===`);
    const results = {};

    // 1. persistent profile survives a restart --------------------------------
    {
      const userDataDir = path.join(WORK, engineName, 'profile');
      const token = `token-${Date.now()}-${Math.round(Math.random() * 1e6)}`;
      const r = await checker.check(
        `${engineName}: persistent profile reused across restarts`,
        async () => {
          let context = await engine.launchPersistent({ headless: true, userDataDir });
          try {
            const page = await newPage(context);
            await page.goto(`${base}/setcookie`, {
              waitUntil: 'domcontentloaded',
              timeout: 30_000,
            });
            await page.goto(`${base}/storage`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
            await page.evaluate((value) => localStorage.setItem('spike_probe', value), token);
          } finally {
            await context.close().catch(() => {});
          }
          await sleep(500);
          context = await engine.launchPersistent({ headless: true, userDataDir });
          try {
            const cookies = await context.cookies();
            const hit = cookies.find((c) => c.name === 'spike_session');
            assert(
              hit,
              `cookie missing after restart, cookies=${JSON.stringify(cookies.map((c) => c.name))}`,
            );
            const page = await newPage(context);
            await page.goto(`${base}/storage`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
            const stored = await page.evaluate(() => localStorage.getItem('spike_probe'));
            assert(stored === token, `localStorage lost after restart, value=${stored}`);
            return `cookie survived (${hit.value}), localStorage survived (${stored})`;
          } finally {
            await context.close().catch(() => {});
          }
        },
      );
      results['persistent-profile-reuse'] = r;
    }

    // 2. context isolation ---------------------------------------------------
    {
      const r = await checker.check(`${engineName}: contexts are isolated`, async () => {
        const browser = await engine.launch({ headless: true });
        try {
          const a = await browser.newContext();
          const b = await browser.newContext();
          const pageA = await a.newPage();
          await pageA.goto(`${base}/setcookie`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
          const cookiesB = await b.cookies();
          assert(
            !cookiesB.some((c) => c.name === 'spike_session'),
            'cookie leaked into the second context',
          );
          const pageB = await b.newPage();
          await pageB.goto(`${base}/`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
          return 'cookie stayed in context A';
        } finally {
          await browser.close().catch(() => {});
        }
      });
      results['context-isolation'] = r;
    }

    // 3. storageState round-trip ---------------------------------------------
    {
      const r = await checker.check(`${engineName}: storageState round-trip`, async () => {
        const browser = await engine.launch({ headless: true });
        let state;
        try {
          const context = await browser.newContext();
          const page = await context.newPage();
          await page.goto(`${base}/setcookie`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
          await page.goto(`${base}/storage`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
          state = await context.storageState();
        } finally {
          await browser.close().catch(() => {});
        }
        assert(state.cookies.length > 0, 'storageState carried no cookies');
        assert(
          state.origins.length > 0,
          `storageState carried no origins, state=${JSON.stringify(state).slice(0, 200)}`,
        );
        const browser2 = await engine.launch({ headless: true });
        try {
          const context = await browser2.newContext({ storageState: state });
          const cookies = await context.cookies();
          assert(
            cookies.some((c) => c.name === 'spike_session'),
            `cookie not restored, cookies=${JSON.stringify(cookies.map((c) => c.name))}`,
          );
          const page = await context.newPage();
          await page.goto(`${base}/storage`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
          const stored = await page.evaluate(() => localStorage.getItem('spike_probe'));
          assert(stored === 'seeded', `localStorage not restored, value=${stored}`);
          return `cookies=${state.cookies.length} origins=${state.origins.length}, both restored`;
        } finally {
          await browser2.close().catch(() => {});
        }
      });
      results['storage-state-roundtrip'] = r;
    }

    // 4. file upload ----------------------------------------------------------
    {
      const r = await checker.check(
        `${engineName}: file upload through the composer input`,
        async () => {
          const browser = await engine.launch({ headless: true });
          try {
            const page = await browser.newPage();
            await page.goto(`${base}/`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
            await page.setInputFiles('#file', {
              name: 'probe.txt',
              mimeType: 'text/plain',
              buffer: Buffer.from('readiness-upload-probe'),
            });
            const status = await page.textContent('#status');
            assert(status.includes('probe.txt'), `input did not pick the file, status=${status}`);
            const posted = await page.evaluate(async () => {
              const input = document.getElementById('file');
              const file = input.files[0];
              const res = await fetch('/upload', { method: 'POST', body: await file.text() });
              return res.json();
            });
            assert(posted.ok, 'upload endpoint failed');
            assert(
              fixture.uploads.some((body) => body.includes('readiness-upload-probe')),
              'the fixture server never received the file',
            );
            return `uploaded ${posted.bytes} bytes`;
          } finally {
            await browser.close().catch(() => {});
          }
        },
      );
      results['file-upload'] = r;
    }

    // 5. download --------------------------------------------------------------
    {
      const r = await checker.check(`${engineName}: download completes`, async () => {
        const browser = await engine.launch({ headless: true });
        try {
          const page = await browser.newPage();
          await page.goto(`${base}/`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
          const [download] = await Promise.all([
            page.waitForEvent('download', { timeout: 30_000 }),
            page.click('#dl'),
          ]);
          const file = await download.path();
          const content = await readFile(file, 'utf8');
          assert(content.includes('camoufox-download-payload'), `unexpected payload: ${content}`);
          return `suggested=${download.suggestedFilename()} bytes=${content.length}`;
        } finally {
          await browser.close().catch(() => {});
        }
      });
      results.download = r;
    }

    // 6. browser reuse (what the daemon does) ---------------------------------
    {
      const r = await checker.check(
        `${engineName}: one browser, several sequential contexts`,
        async () => {
          const browser = await engine.launch({ headless: true });
          try {
            const seen = [];
            for (let i = 0; i < 3; i++) {
              const context = await browser.newContext();
              const page = await context.newPage();
              const response = await page.goto(`${base}/`, {
                waitUntil: 'domcontentloaded',
                timeout: 30_000,
              });
              seen.push(response?.status());
              await context.close();
            }
            assert(
              seen.every((s) => s === 200),
              `statuses=${JSON.stringify(seen)}`,
            );
            return `statuses=${JSON.stringify(seen)}`;
          } finally {
            await browser.close().catch(() => {});
          }
        },
      );
      results['browser-reuse'] = r;
    }

    // 7. cleanup after close ---------------------------------------------------
    {
      const r = await checker.check(
        `${engineName}: no browser processes left after close`,
        async () => {
          // Only the processes of this launch count: a browser the user has
          // open by hand must not be counted as a leftover of the test.
          const before = pids(engine.processPattern);
          const browser = await engine.launch({ headless: true });
          const page = await browser.newPage();
          await page.goto(`${base}/`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
          const spawned = newPids(engine.processPattern, before);
          await browser.close().catch(() => {});
          await sleep(2000);
          const leftover = alivePids(spawned);
          assert(
            leftover.length === 0,
            `processes left behind: ${leftover.join(', ')} (machine-wide before=${before.length})`,
          );
          return `spawned=${spawned.length} leftover=0 (machine-wide before=${before.length})`;
        },
      );
      results.cleanup = r;
    }

    perEngine[engineName] = results;
  }

  fixture.server.close();
  const payload = {
    matrix: 'lifecycle',
    env: envInfo(),
    harness: harnessSettings('lifecycle-matrix'),
    results: checker.results,
    perEngine,
    passed: checker.results.filter((r) => r.ok).length,
    failed: checker.results.filter((r) => !r.ok).length,
  };
  const file = await writeReport('lifecycle-matrix', payload);
  console.log(`\nlifecycle matrix: ${payload.passed} passed, ${payload.failed} failed -> ${file}`);
}

await main();

// The proxy/fixture servers keep the event loop alive: exit explicitly.
process.exit(0);
