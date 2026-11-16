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
import { mergeRoundTrip, roundTripState } from './round-trip.mjs';
import {
  assert,
  createChecker,
  envInfo,
  harnessSettings,
  readReport,
  sleep,
  writeReport,
} from './util.mjs';

const PROBE_PROMPT = 'Reply with the single word: READY';
// A page that means "the session is gone": the provider asked to log in again.
const LOGIN_URL = /\/login|\/signin|\/auth\/login|accounts\.google\.com/i;
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
    // The current ChatGPT UI has no #prompt-textarea: the composer is a
    // ProseMirror textbox, the send button is aria-label="Send" and the
    // assistant turn is marked with data-conversation-role="assistant".
    composer: 'div.ProseMirror[contenteditable="true"][role="textbox"], #prompt-textarea',
    send: 'button[aria-label="Send"], #composer-submit-button, [data-testid="send-button"]',
    response:
      '[data-conversation-role="assistant"], [data-message-author-role="assistant"], .agent-turn',
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
const CF_SELECTORS =
  '#challenge-running, #challenge-form, .cf-browser-verification, #cf-challenge-running';

// Smoke mode: SPIKE_PROVIDERS=grok,gemini and SPIKE_MAX_RUNS=1 shrink the
// matrix so the harness itself can be checked in minutes. A reduced run is
// marked in the report (`reduced: true`) and is never reused as a full result.
const PROVIDER_FILTER = (process.env.SPIKE_PROVIDERS ?? '')
  .split(',')
  .map((p) => p.trim())
  .filter(Boolean);
const RUNS_CAP = Number(process.env.SPIKE_MAX_RUNS ?? '') || null;
const REDUCED = PROVIDER_FILTER.length > 0 || RUNS_CAP !== null;
const SELECTED_PROVIDERS = PROVIDER_FILTER.length
  ? PROVIDERS.filter((p) => PROVIDER_FILTER.includes(p.name))
  : PROVIDERS;
// The criterion always covers the full matrix, even in a reduced run.
const MANDATORY_COMBOS = PROVIDERS.length * ENGINE_NAMES.length;

function classify({ status, title, cfVisible, loginVisible, composerVisible }) {
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
    return {
      status: response?.status() ?? 0,
      ip: (await page.textContent('body').catch(() => ''))?.trim(),
    };
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
    // The SPA needs a moment to render the composer or the login wall: the
    // state is read as soon as one of them shows up.
    let cfVisible = false;
    let loginVisible = false;
    let composerVisible = false;
    for (let i = 0; i < 15; i++) {
      cfVisible = await page
        .locator(CF_SELECTORS)
        .first()
        .isVisible()
        .catch(() => false);
      loginVisible = await page
        .locator(provider.login)
        .first()
        .isVisible()
        .catch(() => false);
      composerVisible = await page
        .locator(provider.composer)
        .first()
        .isVisible()
        .catch(() => false);
      if (cfVisible || loginVisible || composerVisible) break;
      await sleep(1000);
    }
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

/**
 * One authorized exchange: open the provider with a stored session, send the
 * probe prompt and require a non-empty answer.
 */
async function exchange(engine, provider, storageState) {
  const browser = await engine.launch({ headless: HEADLESS, proxy: { server: PROXY } });
  try {
    const context = await browser.newContext({ storageState });
    const page = await context.newPage();
    await page.goto(provider.url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    const url = page.url();
    // A session that is not authorized ends up on a login page: that is the
    // proof that the stored state was not reused.
    assert(!LOGIN_URL.test(url), `the session was not authorized, landed on ${url}`);
    const composer = page.locator(provider.composer).first();
    await composer.waitFor({ state: 'visible', timeout: 20_000 });
    // Diagnostic only: some providers keep a login button in the header even
    // for an authorized session, so this is recorded but never asserted.
    const loginWall = await page
      .locator(provider.login)
      .first()
      .isVisible()
      .catch(() => false);
    await composer.fill(PROBE_PROMPT);
    await page.locator(provider.send).first().click({ force: true });
    const answer = page.locator(provider.response).first();
    await answer.waitFor({ state: 'visible', timeout: 45_000 });
    // The turn container appears before the answer is written into it.
    let text = '';
    for (let i = 0; i < 20; i++) {
      text = (await answer.textContent().catch(() => '')) ?? '';
      if (text.trim().length > 0) break;
      await sleep(1000);
    }
    assert(text.trim().length > 0, 'the provider answered with an empty bubble');
    return {
      answerChars: text.trim().length,
      loginWall,
      // The session as it looks after the exchange — the second run reuses it.
      storageState: await context.storageState(),
    };
  } finally {
    await browser.close().catch(() => {});
  }
}

/**
 * The §4 criterion for one engine/provider pair: an authorized round-trip and
 * a repeated exchange on the same session after a browser restart, without a
 * re-login.
 */
async function roundTrip(engine, provider, storageState) {
  const first = await exchange(engine, provider, storageState);
  // Restart the browser and continue with the session the first exchange left
  // behind: the provider must answer again without a new authorization.
  const second = await exchange(engine, provider, first.storageState);
  return {
    answerChars: [first.answerChars, second.answerChars],
    loginWall: first.loginWall || second.loginWall,
    // The second exchange ran in a fresh browser on the session state the
    // first exchange returned and was not redirected to a login page.
    sessionReused: true,
  };
}

/**
 * Merge the authorized round-trip state of two runs and derive the status of
 * the §4 criterion: only a full set of passing combinations is "done".
 */

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
  // The authorized round-trip state; merged into the report on every write.
  let authorizedRoundTrip = { status: 'unfinished', reason: 'no storage state found' };
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
      harness: harnessSettings('provider-matrix'),
      authorizedRoundTrip: mergeRoundTrip(
        existing.authorizedRoundTrip,
        authorizedRoundTrip,
        MANDATORY_COMBOS,
      ),
      reduced: REDUCED,
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
    for (const provider of SELECTED_PROVIDERS) {
      const runCount = RUNS_CAP ? Math.min(provider.runs, RUNS_CAP) : provider.runs;
      const runs = [];
      for (let i = 0; i < runCount; i++) {
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
      engineResults[provider.name] = { runs: runCount, counts, records: runs };

      const reachable = counts['composer-visible'] ?? 0;
      const r = await checker.check(
        `${engineName}: ${provider.name} reachable in ${runCount} runs`,
        async () => {
          assert((counts['infra-error'] ?? 0) === 0, `${counts['infra-error']} infra errors`);
          assert(reachable > 0, `never reached the composer, outcomes=${JSON.stringify(counts)}`);
          return `composer-visible ${reachable}/${runCount}, outcomes=${JSON.stringify(counts)}`;
        },
      );
      engineResults[provider.name].summary = r;
      await persist(true);
      console.log(`[checkpoint] ${engineName}/${provider.name}`);
    }
  }

  // The authorized round-trip only exists when credentials exist. The §4
  // criterion covers every provider on every engine, so a single successful
  // combination must never report the criterion as done.
  const roundTripCombos = {};

  if (storageStatePath) {
    for (const engineName of ENGINE_LIST) {
      for (const provider of SELECTED_PROVIDERS) {
        const key = `${engineName}/${provider.name}`;
        const r = await checker.check(
          `${engineName}: ${provider.name} authorized round-trip + session reuse`,
          async () => roundTrip(engines[engineName], provider, storageState),
        );
        roundTripCombos[key] = { ok: r.ok, detail: r.detail };
        authorizedRoundTrip = roundTripState(roundTripCombos, MANDATORY_COMBOS);
        await persist(true);
        console.log(`[checkpoint] round-trip ${key}`);
      }
    }
    authorizedRoundTrip = roundTripState(roundTripCombos, MANDATORY_COMBOS);
  } else {
    console.log(
      'SKIP  authorized prompt/response round-trip — UNFINISHED (no credentials in this environment)',
    );
  }

  const payload = await persist(false);
  payload.partial = false;
  const file = await writeReport('provider-matrix', payload);
  console.log(`\nprovider matrix: ${payload.passed} passed, ${payload.failed} failed -> ${file}`);
}

await main();

// The proxy/fixture servers keep the event loop alive: exit explicitly.
process.exit(0);
