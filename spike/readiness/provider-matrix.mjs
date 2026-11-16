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
 *
 * Two properties of the round-trip matter and are measured explicitly:
 *
 * - **A new answer.** A provider session can already contain history, so the
 *   number of answers is counted before the prompt is sent and only an answer
 *   that appeared afterwards counts. Every exchange also carries a unique
 *   marker in the prompt.
 * - **A reused profile.** The second exchange runs in a *new browser process*
 *   on the *same persistent profile* (userDataDir) — not on an exported
 *   storageState — and must answer without a new authorization.
 */
import { readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { answerSnapshot } from './answers.mjs';
import { ENGINE_NAMES, engines } from './engines.mjs';
import {
  classifyOutcome,
  containsMarker,
  LOGIN_URL,
  newAnswerIndex,
  newMarker,
  probePrompt,
  SIGNUP_WALL,
} from './probe.mjs';
import { PROVIDERS as PROVIDER_TABLE } from './providers.mjs';
import { mergeRoundTrip, roundTripState } from './round-trip.mjs';
import {
  assert,
  createChecker,
  envInfo,
  harnessSettings,
  publicPath,
  readReport,
  sanitizeProxyUrl,
  sleep,
  writeReport,
} from './util.mjs';

// Same proxy endpoint and geography for both engines (the 3/8 spike used it).
const PROXY = process.env.SPIKE_PROXY ?? 'http://127.0.0.1:3128';
const HEADLESS = process.env.SPIKE_HEADLESS === '1';
// SPIKE_ENGINES=cloakbrowser runs a single engine and merges it into the
// existing report — the full matrix takes hours.
const ENGINE_LIST = (process.env.SPIKE_ENGINES ?? ENGINE_NAMES.join(','))
  .split(',')
  .map((e) => e.trim())
  .filter(Boolean);

const PROVIDERS = PROVIDER_TABLE;

const CF_SELECTORS =
  '#challenge-running, #challenge-form, .cf-browser-verification, #cf-challenge-running';

// Smoke mode: SPIKE_PROVIDERS=gemini,claude and SPIKE_MAX_RUNS=1 shrink the
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

/**
 * Where would an authorized session live?
 *
 * Every provider has its own storage state: `storage-state-<provider>.json`
 * in the profile directory. The single-session file `storage-state.json` is
 * the legacy ChatGPT state and is only used as a fallback for ChatGPT — using
 * a ChatGPT session for another provider would measure nothing.
 */
async function storageStateFor(providerName) {
  const base = path.join(os.homedir(), '.10x-chat', 'profiles');
  const candidates = [
    path.join(base, 'default', `storage-state-${providerName}.json`),
    path.join(base, 'shared', `storage-state-${providerName}.json`),
  ];
  if (providerName === 'chatgpt') {
    candidates.push(
      path.join(base, 'default', 'storage-state.json'),
      path.join(base, 'shared', 'storage-state.json'),
    );
  }
  for (const candidate of candidates) {
    try {
      const raw = await readFile(candidate, 'utf8');
      return { path: candidate, state: JSON.parse(raw) };
    } catch {
      /* try next */
    }
  }
  return null;
}

/** The persistent profile of one engine/provider pair (outside the repository). */
function profileDir(engineName, providerName) {
  return path.join(
    os.homedir(),
    '.10x-chat',
    'profiles',
    'readiness',
    `${engineName}-${providerName}`,
  );
}

/**
 * Does the accumulated report cover the whole matrix?
 *
 * Every engine has to have every provider with the full run count — no
 * matter in how many runs the matrix was measured.
 */
function coverageComplete(perEngine) {
  return ENGINE_NAMES.every((engine) =>
    PROVIDERS.every((provider) => {
      const measured = perEngine?.[engine]?.[provider.name]?.runs ?? 0;
      return measured >= provider.runs;
    }),
  );
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
    // The session keeps living while the browser is open: the provider
    // rotates its session token. The cookies of this run are handed back so
    // that the *next* browser continues the same session instead of
    // replaying a stale cookie file (which the provider would reject with
    // "Your account changed").
    const liveCookies = async () => {
      try {
        return await context.cookies();
      } catch {
        return null;
      }
    };
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
      if (
        !/just a moment|attention required|checking your browser|verify you are human/i.test(title)
      ) {
        break;
      }
      await sleep(2000);
    }
    url = page.url();
    title = await page.title().catch(() => '');
    // The SPA needs a moment to render the composer or the login wall: the
    // state is read as soon as one of them shows up.
    let cfVisible = false;
    let loginVisible = false;
    let composerVisible = false;
    for (let i = 0; i < 30; i++) {
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
      // The loop waits for the *composer*: a login button in the header is
      // also shown for an authorized session, so it must not end the wait.
      // A login wall without a composer is accepted after 15 s.
      if (cfVisible || composerVisible) break;
      if (loginVisible && i >= 15) break;
      await sleep(1000);
    }
    return {
      status,
      title: title.slice(0, 80),
      url: url.slice(0, 120),
      cfVisible,
      loginVisible,
      composerVisible,
      // The cookies of this run: the next browser continues this session.
      cookies: await liveCookies(),
      // A redirect to a login page is an auth failure, not a provider error.
      authRedirect: LOGIN_URL.test(url),
      outcome: classifyOutcome({
        status,
        title,
        url,
        cfVisible,
        loginVisible,
        composerVisible,
      }),
    };
  } finally {
    await browser.close().catch(() => {});
  }
}

/**
 * The answers on the page right now: how many and what they say.
 *
 * The selector of a provider may match the answer container *and* the text
 * inside it. Every matched element is therefore reduced to the outermost one,
 * so that one answer is counted once (see `answers.mjs`).
 */
async function snapshotAnswers(page, provider) {
  const entries = await page.evaluate((selector) => {
    // The path of an element from the document root: it shows whether one
    // matched element is inside another one.
    const pathOf = (element) => {
      const parts = [];
      let node = element;
      while (node && node !== document.documentElement) {
        const parent = node.parentNode;
        if (!parent) break;
        parts.unshift(Array.prototype.indexOf.call(parent.children, node));
        node = parent;
      }
      return parts.join('.');
    };
    return Array.from(document.querySelectorAll(selector)).map((element) => ({
      path: pathOf(element),
      text: element.textContent ?? '',
    }));
  }, provider.response);
  return answerSnapshot(entries);
}

/**
 * Wait for an answer that appeared *after* the prompt was sent.
 *
 * An answer counts only when it is new (the count grew), non-empty and not a
 * copy of an answer that was already there.
 *
 * @param {number} timeoutMs how long the answer may take
 */
async function waitForNewAnswer(page, provider, before, timeoutMs = 45_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const now = await snapshotAnswers(page, provider);
    if (now.count > before.count) {
      // Throws when the count did not grow — the explicit "new answer" check.
      newAnswerIndex(before.count, now.count);
      for (let i = before.count; i < now.count; i++) {
        const text = now.texts[i];
        if (!text) continue;
        if (before.texts.includes(text)) continue;
        return { text, index: i, before: before.count, after: now.count };
      }
    }
    await sleep(1000);
  }
  const now = await snapshotAnswers(page, provider);
  throw new Error(
    `no new answer appeared within ${timeoutMs}ms (answers before=${before.count}, now=${now.count})`,
  );
}

/**
 * A combination that could not be measured at all: the provider sent the
 * browser to its login page because no authorized session was available.
 * That is not a failure of the engine — it is a missing precondition.
 */
class NotMeasuredError extends Error {}

/**
 * The paywall text of the page, if the provider keeps its answer behind an
 * account ("Sign up and repeat your request").
 */
async function signupWallOnPage(page) {
  const body = await page.evaluate(() => document.body.innerText.slice(0, 4000)).catch(() => '');
  return body.match(SIGNUP_WALL)?.[0] ?? null;
}

/**
 * Was the prompt really submitted?
 *
 * The marker has to leave the composer and appear in the conversation: a
 * click on a still-disabled send button does nothing, and a filled composer
 * that was never sent would otherwise look like a submitted prompt.
 */
async function promptSubmitted(page, provider, marker) {
  const composerText = await page
    .locator(provider.composer)
    .first()
    .innerText()
    .catch(() => '');
  if (composerText.includes(marker)) return false;
  return page.evaluate((m) => document.body.innerText.includes(m), marker).catch(() => false);
}

/**
 * Put the prompt into the composer.
 *
 * `fill()` does not reach every editor: under Firefox the ProseMirror of
 * Claude keeps the text out of the DOM, so the prompt would silently stay
 * empty. The text is therefore verified in the composer and, if it did not
 * arrive, typed with real key events.
 *
 * @returns {'fill'|'type'|'unknown'} how the prompt reached the composer
 */
async function fillComposer(page, provider, text) {
  const composer = page.locator(provider.composer).first();
  const needle = text.slice(-16);
  await composer.fill(text).catch(() => {});
  if ((await composer.innerText().catch(() => '')).includes(needle)) return 'fill';
  // The editor did not take the text: clear it and type instead.
  await composer.click().catch(() => {});
  await composer.press('ControlOrMeta+A').catch(() => {});
  await composer.press('Backspace').catch(() => {});
  await composer.pressSequentially(text, { delay: 10 }).catch(() => {});
  if ((await composer.innerText().catch(() => '')).includes(needle)) return 'type';
  // The composer cannot be read (a half-loaded page, a replaced editor).
  // Whether the prompt was really sent is decided by `promptSubmitted`.
  return 'unknown';
}

/**
 * A send button that can be clicked.
 *
 * The first element that matches the selector is not necessarily usable: the
 * page can hold a hidden copy of the button, and the button stays `disabled`
 * while the framework processes the filled composer. A click on such a button
 * is swallowed — the prompt stays in the composer and nothing is sent.
 *
 * @param {import('playwright-core').Page} page the page
 * @param {object} provider the provider (its `send` selector)
 * @param {number} timeoutMs how long to wait for a usable button
 * @returns {Promise<import('playwright-core').Locator|null>} the button, if any
 */
async function usableSendButton(page, provider, timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const buttons = await page.locator(provider.send).all();
    for (const button of buttons) {
      const visible = await button.isVisible().catch(() => false);
      const enabled = await button.isEnabled().catch(() => false);
      if (visible && enabled) return button;
    }
    await sleep(500);
  }
  return null;
}

/**
 * Send the probe prompt and make sure it was submitted.
 *
 * A click on the send button is not enough: the button can still be disabled
 * while the framework processes the filled composer, and the click is then
 * swallowed. The marker in the prompt is the proof that the prompt reached
 * the conversation.
 */
async function submitPrompt(page, provider, marker) {
  const composer = page.locator(provider.composer).first();
  const methods = [];
  for (let attempt = 1; attempt <= 3; attempt++) {
    methods.push(await fillComposer(page, provider, probePrompt(marker)));
    // Give the framework a moment to enable the send button.
    await sleep(500);
    if (attempt === 2) {
      // Second attempt: send with the keyboard.
      await composer.press('Enter').catch(() => {});
    } else {
      // Only a button that is really usable is clicked: a disabled button
      // swallows the click and the prompt is never sent.
      const send = await usableSendButton(page, provider);
      if (send) {
        await send.click({ force: true }).catch(() => {});
      } else {
        // No usable button: the keyboard is the only way left.
        await composer.press('Enter').catch(() => {});
      }
    }
    for (let i = 0; i < 10; i++) {
      if (await promptSubmitted(page, provider, marker)) {
        return { attempts: attempt, methods };
      }
      await sleep(1000);
    }
  }
  throw new Error(
    `the prompt was not submitted (the marker never left the composer, methods=${methods.join(',')})`,
  );
}

/**
 * One authorized exchange in a persistent profile.
 *
 * @param {object} options
 * @param {string} options.userDataDir the profile directory of this pair
 * @param {object|null} options.seedCookies storage state to seed the profile
 *   with (only for the first launch — the second launch must find the
 *   session on disk)
 */
async function exchangeInProfile(engine, provider, { userDataDir, seedCookies, marker }) {
  const context = await engine.launchPersistent({
    headless: HEADLESS,
    proxy: { server: PROXY },
    userDataDir,
  });
  try {
    if (seedCookies?.cookies?.length) {
      await context.addCookies(seedCookies.cookies);
    }
    const page = await context.newPage();
    // The proxy occasionally drops a connection (ERR_NETWORK_CHANGED). That is
    // an infrastructure hiccup, not a result of the provider — a second try
    // keeps the measurement honest.
    let lastError;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        await page.goto(provider.url, {
          waitUntil: 'domcontentloaded',
          timeout: 60_000,
        });
        lastError = null;
        break;
      } catch (err) {
        lastError = err;
        await sleep(2000);
      }
    }
    if (lastError) throw lastError;
    const url = page.url();
    // A session that is not authorized ends up on a login page: that is the
    // proof that the stored state was not reused.
    if (LOGIN_URL.test(url)) {
      throw new NotMeasuredError(`the session was not authorized, landed on ${url}`);
    }
    const composer = page.locator(provider.composer).first();
    await composer.waitFor({ state: 'visible', timeout: 20_000 });
    // Diagnostic only: some providers keep a login button in the header even
    // for an authorized session, so this is recorded but never asserted.
    const loginWall = await page
      .locator(provider.login)
      .first()
      .isVisible()
      .catch(() => false);
    // What is on the page *before* the prompt is sent: an old answer must not
    // be mistaken for the answer to this prompt.
    const before = await snapshotAnswers(page, provider);
    let attempts;
    let submitMethods = [];
    let answer;
    try {
      const submit = await submitPrompt(page, provider, marker);
      attempts = submit.attempts;
      submitMethods = submit.methods;
      answer = await waitForNewAnswer(page, provider, before);
    } catch (err) {
      // The provider can accept the request and still keep the answer behind
      // an account ("Sign up and repeat your request"). Such a combination is
      // not measurable without credentials — it says nothing about the engine
      // — so it is reported apart from a real failure.
      const wall = await signupWallOnPage(page);
      if (wall) {
        throw new NotMeasuredError(`the provider requires an authorized session ("${wall}")`);
      }
      throw err;
    }
    // The answer itself can be the paywall text: Perplexity answers a guest
    // with "Sign up and repeat your request." — a non-empty answer that is
    // not an answer at all. The check looks at the answer first, so a banner
    // of an authorized session cannot turn a real answer into a skip.
    const answerWall = answer.text.match(SIGNUP_WALL);
    if (answerWall) {
      throw new NotMeasuredError(
        `the provider requires an authorized session ("${answerWall[0]}")`,
      );
    }
    return {
      answerChars: answer.text.length,
      // How many answers the page had before and after: proof that the
      // measured answer is a new one.
      answersBefore: answer.before,
      answersAfter: answer.after,
      answerIndex: answer.index,
      submitAttempts: attempts,
      // How the prompt reached the composer: `fill` (the DOM was set) or
      // `type` (real key events — Firefox/ProseMirror needs that).
      submitMethods,
      // The model did not have to echo the marker; it is recorded, not asserted.
      markerEchoed: containsMarker(answer.text, marker),
      loginWall,
    };
  } finally {
    await context.close().catch(() => {});
  }
}

/**
 * The §4 criterion for one engine/provider pair: an authorized round-trip in a
 * persistent profile and a repeated exchange on the same profile after the
 * browser was closed and started again — without a new authorization.
 */
async function roundTrip(engine, provider, storageState, engineName) {
  const userDataDir = profileDir(engineName, provider.name);
  await rm(userDataDir, { recursive: true, force: true });
  const first = await exchangeInProfile(engine, provider, {
    userDataDir,
    seedCookies: storageState,
    marker: newMarker('first'),
  });
  // The browser is closed. The same profile is opened again — a new process,
  // no cookies are seeded: the session has to come from the profile itself.
  const second = await exchangeInProfile(engine, provider, {
    userDataDir,
    seedCookies: null,
    marker: newMarker('second'),
  });
  return {
    answerChars: [first.answerChars, second.answerChars],
    answersBefore: [first.answersBefore, second.answersBefore],
    answersAfter: [first.answersAfter, second.answersAfter],
    submitAttempts: [first.submitAttempts, second.submitAttempts],
    markerEchoed: [first.markerEchoed, second.markerEchoed],
    loginWall: first.loginWall || second.loginWall,
    // The second exchange ran in a new browser process on the same profile
    // and was not redirected to a login page.
    sessionReused: true,
    profile: { userDataDir: publicPath(userDataDir), reseeded: false },
  };
}

/**
 * Merge the authorized round-trip state of two runs and derive the status of
 * the §4 criterion: only a full set of passing combinations is "done".
 */

async function main() {
  const checker = createChecker();
  // One storage state per provider: a ChatGPT session says nothing about
  // Claude, Gemini or Grok.
  const sessions = {};
  for (const provider of PROVIDERS) {
    const found = await storageStateFor(provider.name);
    sessions[provider.name] = found;
  }
  const sessionPaths = Object.fromEntries(
    Object.entries(sessions).map(([name, found]) => [name, publicPath(found?.path ?? null)]),
  );

  console.log(
    `storage states: ${Object.entries(sessionPaths)
      .map(([name, p]) => `${name}=${p ? 'found' : 'NOT FOUND'}`)
      .join(', ')}`,
  );

  const perEngine = {};
  const egress = {};
  // The authorized round-trip state; merged into the report on every write.
  let authorizedRoundTrip = {
    status: 'unfinished',
    reason: 'no storage state found for any provider',
  };
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
      // The proxy may carry credentials: the report must not.
      proxy: sanitizeProxyUrl(PROXY),
      headless: HEADLESS,
      egressIp: mergedEgress,
      storageStatePaths: sessionPaths,
      harness: harnessSettings('provider-matrix'),
      authorizedRoundTrip: mergeRoundTrip(
        existing.authorizedRoundTrip,
        authorizedRoundTrip,
        MANDATORY_COMBOS,
      ),
      reduced: REDUCED,
      // The report is complete when *every* engine has every provider with
      // the full run count — no matter in how many runs that was measured.
      partial: partial || !coverageComplete(mergedPerEngine),
      perEngine: mergedPerEngine,
      results: mergedResults,
      passed: mergedResults.filter((r) => r.ok).length,
      // A combination that could not be measured (no credentials) is neither
      // a pass nor a failure — it is counted apart.
      failed: mergedResults.filter((r) => !r.ok && !r.skipped).length,
      skipped: mergedResults.filter((r) => r.skipped).length,
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
          result = await classifyRun(engine, provider, sessions[provider.name]?.state ?? null);
        } catch (err) {
          result = {
            status: 0,
            title: `ERR ${String(err.message).split('\n')[0]}`,
            url: provider.url,
            outcome: 'infra-error',
          };
        }
        runs.push(result);
        // The session lives on: the next browser of this provider continues
        // the rotated session instead of replaying the original cookie file.
        if (result.cookies?.length && sessions[provider.name]?.state) {
          sessions[provider.name].state = {
            ...sessions[provider.name].state,
            cookies: result.cookies,
          };
        }
        delete result.cookies;
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

  for (const engineName of ENGINE_LIST) {
    for (const provider of SELECTED_PROVIDERS) {
      const key = `${engineName}/${provider.name}`;
      const session = sessions[provider.name];
      const name = `${engineName}: ${provider.name} authorized round-trip + session reuse`;
      let ok = false;
      let skipped = false;
      let detail;
      try {
        detail = await roundTrip(engines[engineName], provider, session?.state ?? null, engineName);
        ok = true;
      } catch (err) {
        // Without an authorized session the combination cannot be measured:
        // a guest answer (or the absence of one) says nothing about the
        // engine. It is recorded as `skipped`, not as a failure.
        const noSession = !session?.state?.cookies?.length;
        skipped = err instanceof NotMeasuredError || noSession;
        detail = skipped
          ? `not measurable: ${noSession && !(err instanceof NotMeasuredError) ? `no authorized session for ${provider.name}; the guest attempt did not answer (${err.message})` : err.message}`
          : err instanceof Error
            ? err.message
            : String(err);
      }
      checker.record(name, ok, detail, { skipped });
      roundTripCombos[key] = { ok, skipped, detail };
      authorizedRoundTrip = roundTripState(roundTripCombos, MANDATORY_COMBOS);
      await persist(true);
      console.log(`[checkpoint] round-trip ${key}`);
    }
  }
  authorizedRoundTrip = roundTripState(roundTripCombos, MANDATORY_COMBOS);

  // persist(false) writes the report with the merged data of every engine it
  // knows about and marks it `partial` when the matrix is not fully covered.
  const payload = await persist(false);
  const file = await writeReport('provider-matrix', payload);
  console.log(`\nprovider matrix: ${payload.passed} passed, ${payload.failed} failed -> ${file}`);
}

await main();

// The proxy/fixture servers keep the event loop alive: exit explicitly.
process.exit(0);
