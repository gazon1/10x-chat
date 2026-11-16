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
import { createFixtureServer, listen as listenFixture } from '../camoufox/fixtures.mjs';
import { createHttpProxy, createSocks5Proxy, listen as listenProxy } from '../camoufox/proxies.mjs';
import { ENGINE_NAMES, engines } from './engines.mjs';
import { createSocks5Relay } from './socks5-relay.mjs';
import { assert, createChecker, envInfo, writeReport } from './util.mjs';

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
    const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    const body = (await page.textContent('body').catch(() => '')) ?? '';
    return { status: response?.status() ?? 0, body: body.trim() };
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
        assert(
          proxy.log.some((e) => e.status === 200),
          `no authenticated tunnel, proxy log=${JSON.stringify(proxy.log)}`,
        );
        assert(!proxy.log.some((e) => e.status === 407), 'proxy rejected the credentials (407)');
        return `status=${res.status} tunnelled=${proxy.log.length}`;
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
          await page.goto(EGRESS_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 });
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

    perEngine[engineName] = results;
  }

  fixture.server.close();
  const payload = {
    matrix: 'proxy',
    env: envInfo(),
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
