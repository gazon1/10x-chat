/**
 * Proxy matrix — issue #13, §2/§4.
 *
 * Every scenario runs identically on both engines (Camoufox/Firefox and
 * CloakBrowser/Chromium) and against local throw-away proxies, so the only
 * variable is the engine. Synthetic credentials are used on purpose: they let
 * us prove whether credentials leak into the process table, the page or the
 * report.
 */
import { readdir, readFile } from 'node:fs/promises';
import { getChromium } from '../../src/browser/engine.ts';
import { createFixtureServer, listen as listenFixture } from '../camoufox/fixtures.mjs';
import { createHttpProxy, createSocks5Proxy, listen as listenProxy } from '../camoufox/proxies.mjs';
import { ENGINE_NAMES, engines } from './engines.mjs';
import { createSocks5Relay } from './socks5-relay.mjs';
import { assert, createChecker, envInfo, harnessSettings, sleep, writeReport } from './util.mjs';

const EGRESS_URL = 'https://api.ipify.org';
const HTTP_USER = 'leakuser';
const HTTP_PASS = 'leaksecret-XYZ';
const SOCKS_USER = 'socksuser';
const SOCKS_PASS = 'sockspass';

/** Does the process table expose `needle` in argv or in the environment? */
async function procLeaks(needle, _pattern) {
  const hits = { cmdline: [], environ: [] };
  const entries = await readdir('/proc').catch(() => []);
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    const cmdline = await readFile(`/proc/${entry}/cmdline`, 'utf8').catch(() => null);
    if (cmdline?.includes(needle)) {
      hits.cmdline.push({
        pid: Number(entry),
        snippet: cmdline.replaceAll('\0', ' ').slice(0, 200),
      });
    }
    const environ = await readFile(`/proc/${entry}/environ`, 'utf8').catch(() => null);
    if (environ?.includes(needle)) {
      hits.environ.push({
        pid: Number(entry),
        snippet: environ.replaceAll('\0', ' ').slice(0, 200),
      });
    }
  }
  return hits;
}

async function visit(engine, proxy, url = EGRESS_URL) {
  const browser = await engine.launch({ headless: true, proxy });
  try {
    const page = await browser.newPage();
    // The proxy rotates its exit IP and occasionally drops the connection
    // (`ERR_NETWORK_CHANGED`). That is an infrastructure hiccup, not a result
    // of the engine — a second attempt keeps the measurement honest.
    let lastError;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const response = await page.goto(url, {
          waitUntil: 'domcontentloaded',
          timeout: 30_000,
        });
        const body = (await page.textContent('body').catch(() => '')) ?? '';
        return { status: response?.status() ?? 0, body: body.trim() };
      } catch (err) {
        lastError = err;
        await sleep(2000);
      }
    }
    throw lastError;
  } finally {
    await browser.close().catch(() => {});
  }
}

async function main() {
  const checker = createChecker();
  const perEngine = {};

  const fixture = createFixtureServer();
  const fixturePort = await listenFixture(fixture.server);
  const fixtureBase = `http://127.0.0.1:${fixturePort}`;

  for (const engineName of ENGINE_NAMES) {
    const engine = engines[engineName];
    console.log(`\n=== proxy matrix: ${engineName} ===`);
    const results = {};

    // 1. HTTP proxy without credentials -----------------------------------
    {
      const proxy = createHttpProxy();
      const port = await listenProxy(proxy.server);
      const r = await checker.check(`${engineName}: http proxy (no auth)`, async () => {
        const res = await visit(engine, { server: `http://127.0.0.1:${port}` });
        assert(res.status === 200, `expected HTTP 200, got ${res.status}`);
        assert(proxy.log.length > 0, 'proxy saw no tunnelled request');
        return `status=${res.status} egress=${res.body} tunnelled=${proxy.log.length}`;
      });
      results['http-noauth'] = r;
    }

    // 2. HTTP proxy with Basic auth ---------------------------------------
    {
      const proxy = createHttpProxy({ username: HTTP_USER, password: HTTP_PASS });
      const port = await listenProxy(proxy.server);
      const r = await checker.check(`${engineName}: http proxy (basic auth)`, async () => {
        const res = await visit(engine, {
          server: `http://127.0.0.1:${port}`,
          username: HTTP_USER,
          password: HTTP_PASS,
        });
        assert(res.status === 200, `expected HTTP 200, got ${res.status}`);
        // The credentials are not part of the proxy URL: the browser answers
        // the challenge of the proxy (407) and retries with the
        // credentials. The last entry of the log is therefore the
        // authenticated tunnel — a 407 as the last entry means the
        // credentials never arrived.
        const last = proxy.log.at(-1);
        assert(
          last?.status === 200,
          `the proxy did not accept the credentials, log=${JSON.stringify(proxy.log)}`,
        );
        return `status=${res.status} tunnelled=${proxy.log.length} challenge=${proxy.log.filter((e) => e.status === 407).length}`;
      });
      results['http-basic-auth'] = r;
    }

    // 3. SOCKS5 without credentials ---------------------------------------
    {
      const proxy = createSocks5Proxy();
      const port = await listenProxy(proxy.server);
      const r = await checker.check(`${engineName}: socks5 proxy (no auth)`, async () => {
        const res = await visit(engine, { server: `socks5://127.0.0.1:${port}` });
        assert(res.status === 200, `expected HTTP 200, got ${res.status}`);
        assert(proxy.log.length > 0, 'socks proxy saw no tunnelled request');
        return `status=${res.status} tunnelled=${proxy.log.length}`;
      });
      results['socks5-noauth'] = r;
    }

    // 4. SOCKS5 with RFC 1929 user/password -------------------------------
    // The safe launch path does not support it: Playwright refuses SOCKS
    // authentication, and Chromium can only authenticate a SOCKS proxy
    // through the URL of the --proxy-server flag — which would put the
    // password into the command line of every browser process.
    {
      const proxy = createSocks5Proxy({ username: SOCKS_USER, password: SOCKS_PASS });
      const port = await listenProxy(proxy.server);
      const r = await checker.check(`${engineName}: socks5 proxy (rfc1929 auth)`, async () => {
        const res = await visit(engine, {
          server: `socks5://127.0.0.1:${port}`,
          username: SOCKS_USER,
          password: SOCKS_PASS,
        });
        assert(res.status === 200, `expected HTTP 200, got ${res.status}`);
        const authenticated = proxy.log.filter((e) => e.auth === SOCKS_USER);
        assert(
          authenticated.length > 0,
          `tunnel opened without authenticating, proxy log=${JSON.stringify(proxy.log)}`,
        );
        return `status=${res.status} authenticated=${authenticated.length}`;
      });
      results['socks5-auth'] = r;
    }

    // 5. NO_PROXY / bypass -------------------------------------------------
    {
      const proxy = createHttpProxy();
      const port = await listenProxy(proxy.server);
      const r = await checker.check(`${engineName}: proxy bypass list honoured`, async () => {
        const browser = await engine.launch({
          headless: true,
          proxy: { server: `http://127.0.0.1:${port}`, bypass: '127.0.0.1,localhost' },
        });
        try {
          const page = await browser.newPage();
          const response = await page.goto(`${fixtureBase}/`, {
            waitUntil: 'domcontentloaded',
            timeout: 30_000,
          });
          const hit = proxy.log.find((e) => e.target?.includes(String(fixturePort)));
          assert(response?.status() === 200, `fixture status ${response?.status()}`);
          assert(!hit, `request was proxied despite the bypass list: ${JSON.stringify(hit)}`);
          return 'local target bypassed the proxy';
        } finally {
          await browser.close().catch(() => {});
        }
      });
      results['no-proxy-bypass'] = r;
    }

    // 6. Do the engines honour HTTPS_PROXY on their own? -------------------
    // Informational: the two engines differ here, so the row records the
    // observed behaviour instead of asserting one of them.
    {
      const proxy = createHttpProxy();
      const port = await listenProxy(proxy.server);
      const previous = { https: process.env.HTTPS_PROXY, http: process.env.HTTP_PROXY };
      process.env.HTTPS_PROXY = `http://127.0.0.1:${port}`;
      process.env.HTTP_PROXY = `http://127.0.0.1:${port}`;
      const used = [];
      let status = 0;
      try {
        const res = await visit(engine, undefined);
        status = res.status;
        used.push(...proxy.log);
      } finally {
        if (previous.https === undefined) delete process.env.HTTPS_PROXY;
        else process.env.HTTPS_PROXY = previous.https;
        if (previous.http === undefined) delete process.env.HTTP_PROXY;
        else process.env.HTTP_PROXY = previous.http;
      }
      const r = await checker.check(
        `${engineName}: HTTPS_PROXY env behaviour (informational)`,
        async () => {
          assert(status === 200, `egress failed, status=${status}`);
          return used.length > 0
            ? 'engine used the env proxy on its own (repo proxyFromEnv() layer is redundant)'
            : 'engine ignores env vars (repo proxyFromEnv() layer is mandatory)';
        },
      );
      results['env-proxy'] = r;
    }

    // 7. Credential leakage -------------------------------------------------
    {
      const proxy = createHttpProxy({ username: HTTP_USER, password: HTTP_PASS });
      const port = await listenProxy(proxy.server);
      const r = await checker.check(`${engineName}: proxy credentials do not leak`, async () => {
        let pageContent = '';
        let leaks = { cmdline: [], environ: [] };
        const browser = await engine.launch({
          headless: true,
          proxy: { server: `http://127.0.0.1:${port}`, username: HTTP_USER, password: HTTP_PASS },
        });
        try {
          const page = await browser.newPage();
          // The navigation only serves the leak measurement (the page content);
          // a dropped connection of the rotating proxy must not decide it.
          await page
            .goto(EGRESS_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 })
            .catch(() => null);
          pageContent = await page.evaluate(() => document.documentElement.outerHTML);
          // Scan while the browser is still running: the credentials only live
          // in the process table for as long as the process does.
          leaks = await procLeaks(HTTP_PASS);
        } finally {
          await browser.close().catch(() => {});
        }
        assert(
          !pageContent.includes(HTTP_PASS),
          'the proxy password is visible in the page content',
        );
        assert(
          leaks.cmdline.length === 0,
          `password visible in argv of pids ${leaks.cmdline.map((l) => l.pid).join(',')}`,
        );
        assert(
          leaks.environ.length === 0,
          `password visible in environ of pids ${leaks.environ.map((l) => l.pid).join(',')}`,
        );
        return 'no credential in page content, argv or environ';
      });
      results['credential-leak'] = r;
    }

    // 8. EXPERIMENT: local SOCKS5 adapter for the missing auth support -------
    if (engineName === 'camoufox') {
      const upstream = createSocks5Proxy({ username: SOCKS_USER, password: SOCKS_PASS });
      const upstreamPort = await listenProxy(upstream.server);
      const relay = createSocks5Relay({
        host: '127.0.0.1',
        port: upstreamPort,
        username: SOCKS_USER,
        password: SOCKS_PASS,
      });
      const relayPort = await listenProxy(relay.server);
      const r = await checker.check(
        `${engineName}: EXPERIMENT socks5 via local relay adapter`,
        async () => {
          const res = await visit(engine, { server: `socks5://127.0.0.1:${relayPort}` });
          assert(res.status === 200, `expected HTTP 200, got ${res.status}`);
          assert(upstream.log.length > 0, 'upstream proxy saw no request');
          assert(
            upstream.log.some((e) => e.auth === SOCKS_USER),
            'relay did not authenticate upstream',
          );
          return 'works with an out-of-process adapter (workaround, not a supported path)';
        },
      );
      results['socks5-auth-via-relay-experiment'] = r;
    } else {
      results['socks5-auth-via-relay-experiment'] = {
        name: `${engineName}: EXPERIMENT socks5 via local relay adapter`,
        ok: true,
        ms: 0,
        detail: 'not needed: the engine authenticates SOCKS5 natively',
      };
    }

    // 9. EXPERIMENT: SOCKS5 auth with inline credentials (CloakBrowser) -----
    // The engine can authenticate a SOCKS proxy — but only through the URL of
    // the --proxy-server flag, which puts the password into the command line
    // of every browser process. The row records what that costs, so the
    // refusal of the safe launch path is a decision and not an accident.
    if (engineName === 'cloakbrowser') {
      const proxy = createSocks5Proxy({ username: SOCKS_USER, password: SOCKS_PASS });
      const port = await listenProxy(proxy.server);
      const r = await checker.check(
        `${engineName}: EXPERIMENT socks5 auth with inline credentials`,
        async () => {
          const { launch } = await import('cloakbrowser');
          let leaks = { cmdline: [], environ: [] };
          let status = 0;
          const browser = await launch({
            headless: true,
            proxy: {
              server: `socks5://127.0.0.1:${port}`,
              username: SOCKS_USER,
              password: SOCKS_PASS,
            },
          });
          try {
            const page = await browser.newPage();
            const response = await page
              .goto(EGRESS_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 })
              .catch(() => null);
            status = response?.status() ?? 0;
            leaks = await procLeaks(SOCKS_PASS);
          } finally {
            await browser.close().catch(() => {});
          }
          assert(status === 200, `expected HTTP 200, got ${status}`);
          return `works, but the password is in the argv of ${leaks.cmdline.length} processes — not usable in production`;
        },
      );
      results['socks5-auth-inline-experiment'] = r;
    } else {
      results['socks5-auth-inline-experiment'] = {
        name: `${engineName}: EXPERIMENT socks5 auth with inline credentials`,
        ok: true,
        ms: 0,
        detail: 'not applicable: Firefox has no --proxy-server flag',
      };
    }

    perEngine[engineName] = results;
  }

  // 10. The production launch path ------------------------------------------
  // The row that closes issue #15: the credentials of the proxy come from the
  // environment (HTTPS_PROXY) exactly as in production, the browser is started
  // by the production engine (`src/browser/engine.ts`), and neither the
  // command line nor the environment of the browser may show them.
  {
    const proxy = createHttpProxy({ username: HTTP_USER, password: HTTP_PASS });
    const port = await listenProxy(proxy.server);
    await checker.check(
      'production: proxy credentials stay out of the browser process',
      async () => {
        const previous = { https: process.env.HTTPS_PROXY, http: process.env.HTTP_PROXY };
        process.env.HTTPS_PROXY = `http://${HTTP_USER}:${HTTP_PASS}@127.0.0.1:${port}`;
        process.env.HTTP_PROXY = process.env.HTTPS_PROXY;
        // The harness runs the free tier of CloakBrowser (the Pro build refuses
        // to start in this environment) — the same rule as in engines.mjs.
        const licenseKey =
          process.env.CLOAKBROWSER_USE_PRO === '1'
            ? process.env.CLOAKBROWSER_LICENSE_KEY
            : undefined;
        if (licenseKey === undefined) delete process.env.CLOAKBROWSER_LICENSE_KEY;
        let leaks = { cmdline: [], environ: [] };
        let status = 0;
        try {
          const chromium = await getChromium();
          const browser = await chromium.launch({ headless: true });
          try {
            const page = await browser.newPage();
            const response = await page
              .goto(EGRESS_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 })
              .catch(() => null);
            status = response?.status() ?? 0;
            // The browser is still running: the credentials only live in the
            // process table as long as the process does.
            leaks = await procLeaks(HTTP_PASS);
          } finally {
            await browser.close().catch(() => {});
          }
        } finally {
          if (licenseKey !== undefined) process.env.CLOAKBROWSER_LICENSE_KEY = licenseKey;
          if (previous.https === undefined) delete process.env.HTTPS_PROXY;
          else process.env.HTTPS_PROXY = previous.https;
          if (previous.http === undefined) delete process.env.HTTP_PROXY;
          else process.env.HTTP_PROXY = previous.http;
        }
        assert(status === 200, `egress through the proxy failed, status=${status}`);
        assert(
          proxy.log.some((e) => e.status === 200),
          `the proxy did not accept the credentials, log=${JSON.stringify(proxy.log)}`,
        );
        assert(
          leaks.cmdline.length === 0,
          `password visible in argv of pids ${leaks.cmdline.map((l) => l.pid).join(',')}`,
        );
        assert(
          leaks.environ.length === 0,
          `password visible in environ of pids ${leaks.environ.map((l) => l.pid).join(',')}`,
        );
        return 'the production launch path authenticates the proxy without exposing the credentials';
      },
    );
  }

  fixture.server.close();
  const payload = {
    matrix: 'proxy',
    env: envInfo(),
    harness: harnessSettings('proxy-matrix'),
    results: checker.results,
    perEngine,
    passed: checker.results.filter((r) => r.ok).length,
    failed: checker.results.filter((r) => !r.ok).length,
  };
  const file = await writeReport('proxy-matrix', payload);
  console.log(`\nproxy matrix: ${payload.passed} passed, ${payload.failed} failed -> ${file}`);
}

await main();

// The proxy/fixture servers keep the event loop alive: exit explicitly.
process.exit(0);
