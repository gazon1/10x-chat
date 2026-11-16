/**
 * Provider matrix — issue #13, §4.
 *
 * Same scenario for both engines: open the provider, wait for the Cloudflare
 * challenge to settle, classify the outcome (infra error / provider error /
 * auth wall / Cloudflare interstitial / reachable), and — when credentials
 * exist — run the authorized prompt/response round-trip.
 *
 * Run counts follow the issue: 10 runs per provider, 30 for the
 * Cloudflare-dependent ones (ChatGPT, Perplexity).
 */
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ENGINE_NAMES, engines } from './engines.mjs';
import { assert, createChecker, envInfo, readReport, sleep, writeReport } from './util.mjs';

const PROBE_PROMPT = 'Reply with the single word: READY';
// Same proxy endpoint and geography for both engines (the 3/8 spike used it).
const PROXY = process.env.SPIKE_PROXY ?? 'http://127.0.0.1:3128';
const HEADLESS = process.env.SPIKE_HEADLESS === '1';
// SPIKE_ENGINES=cloakbrowser runs a single engine and merges it into the
// existing report — the full matrix takes hours.
const ENGINE_LIST = (process.env.SPIKE_ENGINES ?? ENGINE_NAMES.join(','))
  .split(',')
  .map((e) => e.trim())
  .filter(Boolean);

const PROVIDERS = [
  {
    name: 'chatgpt',
    url: 'https://chatgpt.com',
    runs: 30,
    cloudflare: true,
    composer: '#prompt-textarea.ProseMirror[contenteditable="true"][role="textbox"], #prompt-textarea',
    send: '#composer-submit-button, button[aria-label="Send prompt"], [data-testid="send-button"]',
    response: '[data-message-author-role="assistant"], .agent-turn',
    login: 'button:has-text("Log in"), button:has-text("Sign up")',
  },
  {
    name: 'gemini',
    url: 'https://gemini.google.com/app',
    runs: 10,
    cloudflare: false,
    composer: '.ql-editor[contenteditable="true"], div[role="textbox"][aria-label*="Enter"]',
    send: 'button.send-button, button[aria-label="Send message"]',
    response: 'model-response .model-response-text, model-response message-content',
    login: 'a:has-text("Sign in")',
  },
  {
    name: 'claude',
    url: 'https://claude.ai/new',
    runs: 10,
    cloudflare: false,
    composer: '[contenteditable="true"].ProseMirror, div[enterkeyhint="enter"]',
    send: 'button[aria-label*="Send"], button[type="submit"]',
    response: '[data-testid="chat-message"], .font-claude-response',
    login: 'button:has-text("Log in")',
  },
  {
    name: 'grok',
    url: 'https://grok.com',
    runs: 10,
    cloudflare: false,
    composer: 'textarea, [contenteditable="true"], .chat-input textarea',
    send: 'button[aria-label*="Send"], button[type="submit"]',
    response: '.response-content, .message-content',
    login: 'button:has-text("Log in"), a:has-text("Sign in")',
  },
  {
    name: 'perplexity',
    url: 'https://www.perplexity.ai',
    runs: 30,
    cloudflare: true,
    composer: '#ask-input, textarea#ask-input, [contenteditable="true"]',
    send: 'button[aria-label="Submit"], button[data-testid="submit-button"]',
    response: '.prose, [data-testid="answer"]',
    login: 'button:has-text("Log in"), button:has-text("Sign up")',
  },
];

const CF_TITLE = /just a moment|attention required|checking your browser|verify you are human/i;
const CF_SELECTORS = '#challenge-running, #challenge-form, .cf-browser-verification, #cf-challenge-running';

function classify({ status, title, url, cfVisible, loginVisible, composerVisible }) {
  if (status === 0) return 'infra-error';
  if (cfVisible || CF_TITLE.test(title) || status === 403 || status === 503) return 'cloudflare';
  if (loginVisible && !composerVisible) return 'auth-wall';
  if (composerVisible) return 'composer-visible';
  return 'provider-error';
}

/** Where would an authorized session live? */
async function authStatePath() {
  const base = path.join(os.homedir(), '.10x-chat', 'profiles');
  const candidates = [
    path.join(base, 'default', 'storage-state.json'),
    path.join(base, 'shared', 'storage-state.json'),
  ];
  for (const candidate of candidates) {
    try {
      await readFile(candidate, 'utf8');
      return candidate;
    } catch {
      /* try next */
    }
  }
  return null;
}

/** The exit IP of one engine, to prove both engines use the same egress. */
async function egressIp(engine) {
  const browser = await engine.launch({ headless: HEADLESS, proxy: { server: PROXY } });
  try {
    const page = await browser.newPage();
    const response = await page.goto('https://api.ipify.org', {
      waitUntil: 'domcontentloaded',
      timeout: 30_000,
    });
    return { status: response?.status() ?? 0, ip: (await page.textContent('body').catch(() => ''))?.trim() };
  } finally {
    await browser.close().catch(() => {});
  }
}

async function classifyRun(engine, provider, storageState) {
  const browser = await engine.launch({ headless: HEADLESS, proxy: { server: PROXY } });
  try {
    const context = storageState
      ? await browser.newContext({ storageState })
      : await browser.newContext();
    const page = await context.newPage();
    let status = 0;
    let title = '';
    let url = '';
    try {
      const response = await page.goto(provider.url, {
        waitUntil: 'domcontentloaded',
        timeout: 60_000,
      });
      status = response?.status() ?? 0;
    } catch (err) {
      return {
        status: 0,
        title: `ERR ${String(err.message).split('\n')[0]}`,
        url: provider.url,
        cfVisible: false,
        loginVisible: false,
        composerVisible: false,
        outcome: 'infra-error',
      };
    }
    // Give the Cloudflare challenge a chance to settle.
    for (let i = 0; i < 6; i++) {
      title = await page.title().catch(() => '');
      if (!CF_TITLE.test(title)) break;
      await sleep(2000);
    }
    url = page.url();
    title = await page.title().catch(() => '');
    const cfVisible = await page
      .locator(CF_SELECTORS)
      .first()
      .isVisible()
      .catch(() => false);
    const loginVisible = await page
      .locator(provider.login)
      .first()
      .isVisible()
      .catch(() => false);
    const composerVisible = await page
      .locator(provider.composer)
      .first()
      .isVisible()
      .catch(() => false);
    return {
      status,
      title: title.slice(0, 80),
      url: url.slice(0, 120),
      cfVisible,
      loginVisible,
      composerVisible,
      outcome: classify({ status, title, url, cfVisible, loginVisible, composerVisible }),
    };
  } finally {
    await browser.close().catch(() => {});
  }
}

/** The §4 criterion: an authorized prompt/response round-trip. */
async function roundTrip(engine, provider, storageState) {
  const browser = await engine.launch({ headless: HEADLESS, proxy: { server: PROXY } });
  try {
    const context = await browser.newContext({ storageState });
    const page = await context.newPage();
    await page.goto(provider.url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    const composer = page.locator(provider.composer).first();
    await composer.waitFor({ state: 'visible', timeout: 20_000 });
    await composer.fill(PROBE_PROMPT);
    await page.locator(provider.send).first().click({ force: true });
    const answer = page.locator(provider.response).first();
    await answer.waitFor({ state: 'visible', timeout: 45_000 });
    const text = (await answer.textContent().catch(() => '')) ?? '';
    assert(text.trim().length > 0, 'the provider answered with an empty bubble');
    return { ok: true, answerChars: text.trim().length };
  } finally {
    await browser.close().catch(() => {});
  }
}

async function main() {
  const checker = createChecker();
  const storageStatePath = await authStatePath();
  const storageState = storageStatePath
    ? JSON.parse(await readFile(storageStatePath, 'utf8'))
    : null;

  console.log(
    `storage state: ${storageStatePath ?? 'NOT FOUND — authorized round-trip is UNFINISHED, not PASS'}`,
  );

  const perEngine = {};
  const egress = {};
  // The matrix runs for hours: persist after every provider so an interruption
  // never costs more than one provider block.
  const persist = async (partial) => {
    // Merge with a previous report: a per-engine run (SPIKE_ENGINES) must not
    // erase the other engine's data.
    const existing = (await readReport('provider-matrix')) ?? {};
    const mergedPerEngine = { ...(existing.perEngine ?? {}) };
    for (const [engine, providers] of Object.entries(perEngine)) {
      mergedPerEngine[engine] = { ...(mergedPerEngine[engine] ?? {}), ...providers };
    }
    const mergedEgress = { ...(existing.egressIp ?? {}), ...egress };
    // Deduplicate by check name: a checkpoint must not multiply the results.
    const byName = new Map();
    for (const r of existing.results ?? []) byName.set(r.name, r);
    for (const r of checker.results) byName.set(r.name, r);
    const mergedResults = [...byName.values()];
    const payload = {
      matrix: 'provider',
      env: envInfo(),
      proxy: PROXY,
      headless: HEADLESS,
      egressIp: mergedEgress,
      storageStatePath,
      partial,
      perEngine: mergedPerEngine,
      results: mergedResults,
      passed: mergedResults.filter((r) => r.ok).length,
      failed: mergedResults.filter((r) => !r.ok).length,
    };
    await writeReport('provider-matrix', payload);
    return payload;
  };
  for (const engineName of ENGINE_LIST) {
    // Prove both engines leave through the same endpoint before comparing.
    egress[engineName] = await egressIp(engines[engineName]);
    const engine = engines[engineName];
    console.log(`\n=== provider matrix: ${engineName} ===`);
    const engineResults = {};
    perEngine[engineName] = engineResults;
    for (const provider of PROVIDERS) {
      const runs = [];
      for (let i = 0; i < provider.runs; i++) {
        let result;
        try {
          result = await classifyRun(engine, provider, storageState);
        } catch (err) {
          result = {
            status: 0,
            title: `ERR ${String(err.message).split('\n')[0]}`,
            url: provider.url,
            outcome: 'infra-error',
          };
        }
        runs.push(result);
        console.log(
          `${engineName.padEnd(13)} ${provider.name.padEnd(11)} run${String(i + 1).padStart(2)}: ${String(result.status).padStart(3)} ${result.outcome.padEnd(16)} "${result.title}"`,
        );
      }
      const counts = {};
      for (const run of runs) counts[run.outcome] = (counts[run.outcome] ?? 0) + 1;
      engineResults[provider.name] = { runs: provider.runs, counts, records: runs };

      const reachable = counts['composer-visible'] ?? 0;
      const r = await checker.check(
        `${engineName}: ${provider.name} reachable in ${provider.runs} runs`,
        async () => {
          assert(
            (counts['infra-error'] ?? 0) === 0,
            `${counts['infra-error']} infra errors`,
          );
          assert(
            reachable > 0,
            `never reached the composer, outcomes=${JSON.stringify(counts)}`,
          );
          return `composer-visible ${reachable}/${provider.runs}, outcomes=${JSON.stringify(counts)}`;
        },
      );
      engineResults[provider.name].summary = r;
      await persist(true);
      console.log(`[checkpoint] ${engineName}/${provider.name}`);
    }
  }

  // The authorized round-trip only exists when credentials exist.
  let roundTripResult = { status: 'unfinished', reason: 'no storage state found' };
  if (storageStatePath) {
    const probe = { name: 'chatgpt', ...PROVIDERS[0] };
    const r = await checker.check('camoufox: authorized prompt/response round-trip', async () =>
      roundTrip(engines.camoufox, probe, storageState),
    );
    roundTripResult = { status: r.ok ? 'done' : 'failed', detail: r };
  } else {
    console.log(
      'SKIP  authorized prompt/response round-trip — UNFINISHED (no credentials in this environment)',
    );
  }

  const payload = await persist(false);
  payload.authorizedRoundTrip = roundTripResult;
  payload.partial = false;
  const file = await writeReport('provider-matrix', payload);
  console.log(`\nprovider matrix: ${payload.passed} passed, ${payload.failed} failed -> ${file}`);
}

await main();

// The proxy/fixture servers keep the event loop alive: exit explicitly.
process.exit(0);
