/**
 * Like-for-like comparison of the current browser runtime (CloakBrowser /
 * Chromium) against Camoufox (Firefox), through the project's local proxy.
 *
 * Both engines are driven the same way: same proxy, same headed mode, same
 * targets, same number of runs. Cloudflare interstitials are counted, because
 * a single 403 says nothing.
 *
 * Run: node spike/compare-runtime.mjs
 */
import { launch as cloakLaunch } from 'cloakbrowser';
import { Camoufox } from './camoufox/node_modules/camoufox/dist/index.js';

const PROXY = process.env.SPIKE_PROXY ?? 'http://127.0.0.1:3128';
const HEADLESS = process.env.SPIKE_HEADLESS === '1';
const RUNS = Number(process.env.SPIKE_RUNS ?? 3);
const TARGETS = [
  ['chatgpt', 'https://chatgpt.com/'],
  ['claude', 'https://claude.ai/'],
];

const engines = {
  cloakbrowser: () => cloakLaunch({ headless: HEADLESS, proxy: { server: PROXY } }),
  camoufox: () =>
    Camoufox({
      headless: HEADLESS,
      proxy: { server: PROXY },
      geoip: true,
    }),
};

async function probe(engineName, url) {
  const browser = await engines[engineName]();
  try {
    const page = await browser.newPage();
    const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    const status = resp?.status() ?? 0;
    let title = await page.title();
    // Cloudflare's JS challenge needs a few seconds; give it a chance.
    for (let i = 0; i < 6; i++) {
      if (!/just a moment|attention required|checking your browser/i.test(title)) break;
      await new Promise((r) => setTimeout(r, 2000));
      title = await page.title();
    }
    // A 403 is a block even when the challenge page never rendered a title.
    const blocked =
      status >= 400 || /just a moment|attention required|checking your browser/i.test(title);
    return { status, title: title.slice(0, 60), blocked };
  } catch (err) {
    return { status: 0, title: `ERR ${err.message.split('\n')[0]}`, blocked: true };
  } finally {
    await browser.close().catch(() => {});
  }
}

const summary = {};
for (const [engineName] of Object.entries(engines)) {
  summary[engineName] = {};
  for (const [name, url] of TARGETS) {
    const runs = [];
    for (let i = 0; i < RUNS; i++) {
      const r = await probe(engineName, url);
      runs.push(r);
      console.log(
        `${engineName.padEnd(13)} ${name.padEnd(8)} run${i + 1}: status=${r.status} title="${r.title}" blocked=${r.blocked}`,
      );
    }
    summary[engineName][name] = {
      runs,
      blocked: runs.filter((r) => r.blocked).length,
      total: runs.length,
    };
  }
}

console.log('\nSUMMARY (blocked / runs)');
for (const [engine, targets] of Object.entries(summary)) {
  for (const [name, s] of Object.entries(targets)) {
    console.log(`  ${engine.padEnd(13)} ${name.padEnd(8)} ${s.blocked}/${s.total}`);
  }
}
process.exit(0);
