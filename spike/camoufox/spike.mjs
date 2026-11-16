/**
 * Camoufox spike — isolated from the production browser runtime.
 *
 * Run: node spike.mjs        (from spike/camoufox, after `npm install`)
 *
 * Covers: launch (headless/headed), persistent profile reuse, storage-state
 * round-trip, HTTP + SOCKS5 proxies (with auth), upload/download, navigation
 * and waits, shutdown cleanup, remote server, and anonymous provider smoke.
 */
import { execSync } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Camoufox, launchServer } from 'camoufox';
import { firefox } from 'playwright-core';
import { createFixtureServer, listen as listenFixture } from './fixtures.mjs';
import { createHttpProxy, createSocks5Proxy, listen as listenProxy } from './proxies.mjs';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(HERE, '.data');

const results = [];
let failures = 0;

async function check(name, fn) {
  const started = Date.now();
  try {
    const detail = await fn();
    results.push({ name, ok: true, ms: Date.now() - started, detail });
    console.log(`PASS  ${name} (${Date.now() - started}ms) ${detail ? `- ${detail}` : ''}`);
  } catch (err) {
    failures++;
    const message = err instanceof Error ? err.message : String(err);
    results.push({ name, ok: false, ms: Date.now() - started, detail: message });
    console.log(`FAIL  ${name} (${Date.now() - started}ms) - ${message}`);
  }
}

function assert(cond, message) {
  if (!cond) throw new Error(message);
}

function camoufoxProcesses() {
  try {
    return execSync('pgrep -fa "camoufox|Camoufox" | wc -l', { encoding: 'utf8' }).trim();
  } catch {
    return '0';
  }
}

async function main() {
  await rm(DATA_DIR, { recursive: true, force: true });
  await mkdir(DATA_DIR, { recursive: true });

  const fixture = createFixtureServer();
  const fixturePort = await listenFixture(fixture.server);
  const base = `http://127.0.0.1:${fixturePort}`;

  const httpProxy = createHttpProxy({ username: 'spikeuser', password: 'spikepass' });
  const httpProxyPort = await listenProxy(httpProxy.server);
  const socksProxy = createSocks5Proxy({ username: 'socksuser', password: 'sockspass' });
  const socksPort = await listenProxy(socksProxy.server);

  const versions = {
    node: process.version,
    platform: `${os.type()} ${os.release()} ${os.arch()}`,
    camoufox: require('camoufox/package.json').version,
    playwrightCore: require('playwright-core/package.json').version,
  };
  console.log('ENV', JSON.stringify(versions));

  // --- 1. plain launch + fingerprint sanity -------------------------------
  let browser;
  await check('launch: headless browser opens a page', async () => {
    browser = await Camoufox({ headless: true });
    const page = await browser.newPage();
    await page.goto('https://example.com', { waitUntil: 'domcontentloaded' });
    const title = await page.title();
    assert(title.length > 0, 'empty title');
    const ua = await page.evaluate(() => navigator.userAgent);
    const webdriver = await page.evaluate(() => navigator.webdriver);
    assert(/Firefox/.test(ua), `UA is not Firefox: ${ua}`);
    assert(webdriver === false, `navigator.webdriver = ${webdriver}`);
    assert(!/Chrome|Chromium/.test(ua), `UA mentions Chrome: ${ua}`);
    return `title="${title}" ua="${ua.slice(0, 60)}..." webdriver=${webdriver}`;
  });

  // --- 2. navigation + waits ------------------------------------------------
  await check('navigation: goto/waitForSelector/waitForFunction/waitForURL', async () => {
    const page = await browser.newPage();
    await page.goto(base, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#title');
    await page.waitForFunction(() => document.getElementById('status')?.textContent === 'ready');
    await Promise.all([page.waitForURL('**/storage'), page.click('#storage-link')]);
    await page.waitForLoadState('networkidle');
    await page.close();
    return 'waits ok';
  });

  // --- 3. upload ------------------------------------------------------------
  await check('upload: setInputFiles + POST body reaches server', async () => {
    const tmp = path.join(DATA_DIR, 'upload.txt');
    await writeFile(tmp, 'camoufox-upload-payload');
    const page = await browser.newPage();
    await page.goto(base, { waitUntil: 'domcontentloaded' });
    await page.setInputFiles('#file', tmp);
    const status = await page.textContent('#status');
    assert(status?.includes('upload.txt'), `input event status = ${status}`);
    const posted = await page.evaluate(async () => {
      const input = document.getElementById('file');
      const res = await fetch('/upload', { method: 'POST', body: input.files[0] });
      return res.json();
    });
    assert(posted.content === 'camoufox-upload-payload', `server got "${posted.content}"`);
    await page.close();
    return `server received ${posted.bytes} bytes`;
  });

  // --- 4. download ----------------------------------------------------------
  await check('download: waitForEvent("download") + save', async () => {
    const page = await browser.newPage();
    await page.goto(base, { waitUntil: 'domcontentloaded' });
    const [download] = await Promise.all([page.waitForEvent('download'), page.click('#dl')]);
    const target = path.join(DATA_DIR, 'downloaded.txt');
    await download.saveAs(target);
    const { readFile } = await import('node:fs/promises');
    const content = await readFile(target, 'utf8');
    assert(content === 'camoufox-download-payload', `downloaded "${content}"`);
    await page.close();
    return `saved ${download.suggestedFilename()} (${content.length} bytes)`;
  });

  await browser.close();
  browser = null;

  // --- 5. persistent context + profile reuse --------------------------------
  const profileDir = path.join(DATA_DIR, 'profile');
  await check('persistent: launchPersistentContext via user_data_dir', async () => {
    const context = await Camoufox({
      headless: true,
      persistent_context: true,
      user_data_dir: profileDir,
    });
    const page = await context.newPage();
    await page.goto(`${base}/setcookie`, { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => localStorage.setItem('spike-key', 'spike-value'));
    await context.close();
    return `profile dir created at ${profileDir}`;
  });

  await check('persistent: profile reuse keeps cookies and localStorage', async () => {
    const context = await Camoufox({
      headless: true,
      persistent_context: true,
      user_data_dir: profileDir,
    });
    const page = await context.newPage();
    await page.goto(base, { waitUntil: 'domcontentloaded' });
    const cookies = await context.cookies();
    const session = cookies.find((c) => c.name === 'spike_session');
    assert(session?.value === 'abc123', `cookie missing: ${JSON.stringify(cookies)}`);
    const stored = await page.evaluate(() => localStorage.getItem('spike-key'));
    assert(stored === 'spike-value', `localStorage = ${stored}`);
    await context.close();
    return 'cookie + localStorage survived restart';
  });

  // --- 6. storage-state round-trip (repo shared-mode flow) ------------------
  await check('storageState: export from persistent -> import into new context', async () => {
    const statePath = path.join(DATA_DIR, 'storage-state.json');
    const context = await Camoufox({
      headless: true,
      persistent_context: true,
      user_data_dir: profileDir,
    });
    // A page must have visited the origin: Playwright collects localStorage
    // per visited origin, not from the profile on disk.
    const page = await context.newPage();
    await page.goto(base, { waitUntil: 'domcontentloaded' });
    await context.storageState({ path: statePath });
    await context.close();

    const exported = JSON.parse(await readFile(statePath, 'utf8'));
    assert(exported.origins?.length > 0, `no origins exported: ${JSON.stringify(exported)}`);

    const b = await Camoufox({ headless: true });
    const ctx = await b.newContext({ storageState: statePath });
    const p2 = await ctx.newPage();
    await p2.goto(base, { waitUntil: 'domcontentloaded' });
    const cookies = await ctx.cookies();
    const session = cookies.find((c) => c.name === 'spike_session');
    assert(session?.value === 'abc123', `session cookie not restored: ${JSON.stringify(cookies)}`);
    const stored = await p2.evaluate(() => localStorage.getItem('spike-key'));
    assert(stored === 'spike-value', `localStorage = ${stored}`);
    await b.close();
    return `cookies + ${exported.origins.length} origin(s) restored`;
  });

  // --- 7. HTTP proxy --------------------------------------------------------
  await check('proxy: HTTP CONNECT with basic auth', async () => {
    const b = await Camoufox({
      headless: true,
      proxy: {
        server: `http://127.0.0.1:${httpProxyPort}`,
        username: 'spikeuser',
        password: 'spikepass',
      },
    });
    const page = await b.newPage();
    await page.goto('https://api.ipify.org', { waitUntil: 'domcontentloaded' });
    const body = (await page.textContent('body'))?.trim();
    assert(
      httpProxy.log.some((e) => e.target?.includes('api.ipify.org')),
      `proxy log: ${JSON.stringify(httpProxy.log)}`,
    );
    await b.close();
    return `tunnelled api.ipify.org, exit ip ${body}`;
  });

  // --- 8. SOCKS5 proxy ------------------------------------------------------
  await check('proxy: SOCKS5 with username/password via the TS launcher API', async () => {
    // Expected to be rejected: Playwright refuses socks5 credentials, and the
    // TypeScript launcher (0.5.9) does not strip them the way the Python
    // launcher does.
    let error = null;
    try {
      const b = await Camoufox({
        headless: true,
        proxy: {
          server: `socks5://127.0.0.1:${socksPort}`,
          username: 'socksuser',
          password: 'sockspass',
        },
      });
      await b.close();
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
    assert(error !== null, 'Playwright accepted socks5 credentials (unexpected)');
    assert(/socks5 proxy authentication/.test(error), `unexpected error: ${error}`);
    return `rejected by Playwright: ${error}`;
  });

  await check(
    'proxy: SOCKS5 with auth via CAMOU_PROXY_AUTH (python-launcher mechanism)',
    async () => {
      const auth = {
        host: '127.0.0.1',
        port: socksPort,
        username: 'socksuser',
        password: 'sockspass',
      };
      const b = await Camoufox({
        headless: true,
        proxy: { server: `socks5://127.0.0.1:${socksPort}` },
        env: { CAMOU_PROXY_AUTH: JSON.stringify(auth) },
      });
      const page = await b.newPage();
      await page.goto('https://api.ipify.org', { waitUntil: 'domcontentloaded' });
      const body = (await page.textContent('body'))?.trim();
      assert(
        socksProxy.log.some((e) => e.target?.includes('api.ipify.org') && e.auth === 'socksuser'),
        `socks log: ${JSON.stringify(socksProxy.log)}`,
      );
      await b.close();
      return `tunnelled via socks5 with auth, exit ip ${body}`;
    },
  );

  // --- 9. remote server (daemon analogue) ----------------------------------
  await check('remote: launchServer + firefox.connect', async () => {
    const server = await launchServer({ headless: true, port: 0, ws_path: 'camoufox' });
    const ws = server.wsEndpoint();
    const b = await firefox.connect(ws);
    const page = await b.newPage();
    await page.goto('https://example.com', { waitUntil: 'domcontentloaded' });
    const title = await page.title();
    await b.close();
    await server.close();
    return `connected and loaded "${title}"`;
  });

  // --- 10. cleanup ----------------------------------------------------------
  await check('cleanup: no camoufox processes left after close', async () => {
    const before = camoufoxProcesses();
    const b = await Camoufox({ headless: true });
    const page = await b.newPage();
    await page.goto('https://example.com', { waitUntil: 'domcontentloaded' });
    const during = camoufoxProcesses();
    const t0 = Date.now();
    await b.close();
    await new Promise((r) => setTimeout(r, 1500));
    const after = camoufoxProcesses();
    assert(Number(during) > Number(before), `no camoufox process seen while running (${before})`);
    assert(Number(after) <= Number(before), `processes left after close: ${before} -> ${after}`);
    return `close took ${Date.now() - t0}ms, processes ${before}/${during}/${after}`;
  });

  // --- 11. headed mode (ChatGPT/Claude are forced headed in this repo) ------
  await check('headed: launches a real window on DISPLAY', async () => {
    const b = await Camoufox({ headless: false });
    const page = await b.newPage();
    await page.goto('https://example.com', { waitUntil: 'domcontentloaded' });
    const ua = await page.evaluate(() => navigator.userAgent);
    await b.close();
    return `headed window ok (DISPLAY=${process.env.DISPLAY ?? 'unset'}), ua="${ua.slice(0, 50)}..."`;
  });

  // --- 12. provider smoke (anonymous) ---------------------------------------
  const providers = [
    ['chatgpt', 'https://chatgpt.com/'],
    ['gemini', 'https://gemini.google.com/app'],
    ['claude', 'https://claude.ai/'],
    ['grok', 'https://grok.com/'],
    ['perplexity', 'https://www.perplexity.ai/'],
  ];
  // The local proxy the project's providers need (HTTPS_PROXY=http://127.0.0.1:3128).
  const PROXY = process.env.SPIKE_PROXY ?? 'http://127.0.0.1:3128';
  const useGeoip = process.env.SPIKE_GEOIP === '1';

  async function smoke(url, opts) {
    const b = await Camoufox({ headless: true, ...opts });
    const page = await b.newPage();
    let status = 0;
    try {
      const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
      status = resp?.status() ?? 0;
    } catch (err) {
      await b.close();
      throw err;
    }
    const title = await page.title().catch(() => '');
    const html = await page.content().catch(() => '');
    const blocked =
      /Just a moment|Checking your browser|Attention Required|cf-chl|unusual traffic/i.test(
        `${title} ${html.slice(0, 4000)}`,
      );
    await b.close();
    return `status=${status} title="${title.slice(0, 70)}" interstitial=${blocked}`;
  }

  for (const [name, url] of providers) {
    await check(`provider smoke (direct): ${name}`, async () => smoke(url, {}));
  }

  for (const [name, url] of providers) {
    await check(`provider smoke (proxy ${PROXY}): ${name}`, async () =>
      smoke(url, {
        proxy: { server: PROXY },
        ...(useGeoip ? { geoip: true } : {}),
      }),
    );
  }

  fixture.server.close();
  httpProxy.server.close();
  socksProxy.server.close();

  const report = {
    generatedAt: new Date().toISOString(),
    versions,
    camoufoxProcessesAfter: camoufoxProcesses(),
    failures,
    results,
  };
  await writeFile(path.join(HERE, 'report.json'), JSON.stringify(report, null, 2));
  console.log(`\n${results.length - failures}/${results.length} checks passed`);
  process.exit(failures > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('spike crashed:', err);
  process.exit(2);
});
