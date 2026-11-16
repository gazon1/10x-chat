# Refactor 4/9 — Camoufox production-readiness gate

Validation gate for [#13](https://github.com/gazon1/10x-chat/issues/13): is Camoufox ready to
replace CloakBrowser as the production browser runtime of 10x-chat?

**No production code was touched.** The production runtime stays CloakBrowser (Chromium). The
harness lives in [`spike/readiness/`](../spike/readiness) and talks to both engines through the
same adapter, so every scenario runs identically on both.

- Branch / commit: `gazon1/refactor-4-9-production-readiness-camoufox`
- Date: 2026-11-16
- Predecessor: [docs/refactor-3-8-camoufox.md](refactor-3-8-camoufox.md) (spike 3/8)

## 1. Verdict

**NO-GO.** Camoufox stays out of production; CloakBrowser remains the production engine.

Two mandatory scenarios have no supported path on the pinned version matrix:

| Blocker | Camoufox 0.5.9 + build 158.0.1-beta.41 | CloakBrowser 0.4.10 + Chromium 146 |
|---|---|---|
| **SOCKS5 + auth** | Playwright rejects the launch: `Browser does not support socks5 proxy authentication`. No TS-side support in `camoufox@0.5.9`, no Juggler-side support in the paired browser build. | **works** — Chromium authenticates with inline credentials (`--proxy-server=socks5://user:pass@host:port`) |
| **HTTP(S) proxy + Basic auth** | proxy answers `407`; the engine never authenticates | **works** — inline credentials in `--proxy-server` (supported on linux-x64 ≥ 146.0.7680.177.5) |

Per §2 of the issue, a mandatory scenario without a safe solution means NO-GO, not a production
workaround. The upstream fix exists (see [§5](#5-upstream-blocker-socks5--auth)) but it requires
a Camoufox beta + a newer browser build, i.e. an upgrade that this gate is explicitly not allowed
to make "while we are at it".

One further gap keeps this from being CONDITIONAL GO:

1. **Firefox vs Chromium selector blast radius** is unmeasured for the providers in production
   (all provider selectors in `src/providers/*` were written against Chromium) — 3/8 already
   flagged this. The harness did find concrete instances: the current ChatGPT UI no longer has
   `#prompt-textarea` and marks the assistant turn with `data-conversation-role="assistant"`, and
   the Claude answer lives in `[data-testid="assistant-message"]` / `[data-cds="AssistantMessage"]`
   ([§6](#6-provider-matrix-3-providers--2-engines)).

The authorized prompt/response round-trip is **measured and closed** for the providers of the
matrix: with a real session per provider (cookies → Playwright `storageState`) all 6 mandatory
combinations (3 providers × 2 engines) produced a new, non-empty answer and a successful session
reuse after a browser restart on the same persistent profile ([§6](#6-provider-matrix-3-providers--2-engines)).

Everything else is neutral or positive: browser lifecycle, profile handling, `storageState`,
upload/download and cleanup behave **identically** on both engines (14/14 checks), and the
provider matrix shows **no engine-level advantage** worth acting on — in the headed run with a
valid session per provider both engines reach the composer on the same **3 of 3** providers
(50 runs each).

**Correction of the earlier headless conclusion.** The first (headless, unauthenticated) run
reported ChatGPT as `auth-wall 30/30` on Camoufox and `cloudflare 28/30` on CloakBrowser, which
looked like an engine difference. The headed run with a valid session shows `composer-visible
30/30` on **both** engines: the earlier result was an artefact of headless mode plus the missing
session, not a Camoufox defect. The "Cloudflare is worse on Camoufox" claim is withdrawn.

## 2. Version matrix and environment (verified, not quoted)

| Component | Version | Source |
|---|---|---|
| Node | `v22.22.2` | `node -v` |
| OS | Fedora 44, kernel 7.2.10, x86_64, glibc 2.43 | `uname -a` |
| camoufox (npm, spike sandbox) | `0.5.9` | `spike/camoufox/node_modules/camoufox/package.json` |
| fpgen | `1.3.0` | `npx camoufox version` |
| playwright-core (spike sandbox) | `1.62.0` | `spike/camoufox/node_modules/playwright-core/package.json` |
| playwright-core (repo) | `1.61.1` | `node_modules/playwright-core/package.json` — satisfies the Camoufox peer constraint `< 1.63` |
| Camoufox browser build | `official/stable/158.0.1-beta.41` (build SHA256 `3f2eb1d0451fa58e45e43e55f5e6181565069791ae60c0574f0ceb1f01341c33`, install id `3f2eb1d0`) | `~/.cache/camoufox/config.json` (`active_version`) + `…/158.0.1-beta.41-3f2eb1d0/version.json` (`sha256`) |
| cloakbrowser (repo) | `0.4.10`, MIT | `node_modules/cloakbrowser/package.json` |
| CloakBrowser build used | Chromium `146.0.7680.177.5` (free tier) | `~/.cloakbrowser/` |
| CloakBrowser build installed but unusable | Chromium `156.0.8078.47.1-pro` | `binaryInfo()` — exits 76 on launch, see [§7](#7-operational-properties-and-cost) |
| Proxy endpoint (both engines) | `http://127.0.0.1:3128` | `curl --proxy … api.ipify.org` |
| Display | `DISPLAY=:99` (Xvfb, установлен без root из rpm в `~/.cache/xvfb-root`) | headed-режим матрицы, окна браузера не забирают фокус десктопа |

> **Версии читаются из фактически используемых путей.** Camoufox и его Playwright живут в
> `spike/camoufox/node_modules`, поэтому `createRequire(import.meta.url)` из `spike/readiness`
> их не находит: прежняя версия отчёта записывала `camoufoxPackage: null` и `cloakbrowser: null`,
> и проверка совместимости (`report-compat.mjs`) при `null` не видела расхождения версий.
> Теперь каждая зависимость читается по своему пути, а версия **browser build** Camoufox
> (не только npm-пакета) берётся из `~/.cache/camoufox/config.json` и фиксируется вместе с
> идентификатором сборки (`camoufoxBrowser`, `camoufoxBrowserSha256` — префикс install id).
> Пути, откуда взята каждая версия, записываются в отчёт (`env.versionSources`), так что
> «`null`» или «версия из не того места» видно сразу, а не после сравнения. Расхождение любой
> из версий (включая смену browser build) блокирует переиспользование старого отчёта — это
> покрыто тестами (`tests/readiness-versions.test.ts`, `tests/readiness-report-compat.test.ts`).

> **Отчёт публикуется — значит, в нём не должно быть секретов и сведений о машине.**
> Все URL прокси (`HTTPS_PROXY`, `HTTP_PROXY`, `NO_PROXY`, `SPIKE_PROXY`) проходят через одну
> функцию `sanitizeProxyUrl()` (`spike/readiness/util.mjs`): userinfo вида `user:password@host`
> заменяется на `***@host`. Секретов в `results/*.json` и в обычных логах нет — это теперь
> проверено тестом, который собирает JSON отчёта с URL, содержащим логин и пароль, и ищет в
> нём эти строки (`tests/readiness-sanitize.test.ts`).
> Имя хоста и абсолютные пути тоже не публикуются: `env.host` убран, пути внутри репозитория
> записываются относительными (`spike/camoufox/node_modules/camoufox/package.json`), а пути
> вне репозитория — только «хвостом» (`~/.10x-chat/profiles/default/storage-state-gemini.json`).
> Версии и факт их источника при этом остаются в отчёте.

The proxy's exit IP is identical to the host's direct exit IP, so this run cannot validate
GeoIP coherence or a different exit geography. Camoufox runs with `geoip: false` (the upstream
recommendation for proxied setups would be `geoip: true`; 3/8 noted that this flag changes the
Cloudflare verdict, so it is kept off for engine parity).

## 3. The harness

`spike/readiness/` — isolated from production code, no multi-engine abstraction, no stealth
layer, no provider rewrite:

| File | Purpose |
|---|---|
| `engines.mjs` | one adapter for both engines (`launch`, `launchPersistent`) |
| `display.mjs` | the virtual display the browsers are allowed to use + the X11/Wayland cut (no desktop focus) |
| `util.mjs` | check runner, report writer, process/RSS helpers, version capture, sanitization of the published fields |
| `probe.mjs` | pure helpers: outcome classification (URL vs DOM) and the bookkeeping that proves a **new** answer was received |
| `answers.mjs` | pure helpers: the answers of a page — one answer per DOM container, not per matched element |
| `providers.mjs` | the provider table with the selectors (one DOM level per provider) |
| `proxy-matrix.mjs` | HTTP(S) / SOCKS5 (no auth, RFC 1929 auth), bypass list, env precedence, credential leakage |
| `lifecycle-matrix.mjs` | persistent profile reuse, context isolation, `storageState`, upload/download, browser reuse, cleanup |
| `ops-matrix.mjs` | install footprint, cold/warm start, RSS, leftover processes, install path and failure modes, licensing |
| `provider-matrix.mjs` | 3 providers × 10 runs (30 for Cloudflare-dependent) × 2 engines + authorized round-trip (3 providers × 2 engines, with a session-reuse check) |
| `round-trip.mjs` | state of the §4 criterion: which engine/provider combinations passed, were skipped or failed |
| `report-compat.mjs` | when a saved report may be reused (`SPIKE_REUSE=1`): versions, proxy, headless, partial/reduced |
| `socks5-relay.mjs` | **experiment only**: local SOCKS5 adapter that authenticates upstream |
| `run-all.mjs` | runs every matrix, writes `results/summary.json`, sets the gate exit code |

The proxy and fixture servers are reused from the 3/8 spike (`spike/camoufox/proxies.mjs`,
`spike/camoufox/fixtures.mjs`) so both spikes measure with the same instruments. Synthetic proxy
credentials are used on purpose: they prove whether credentials reach the page, the process table
or the report.

```bash
cd spike/camoufox && npm install --no-audit --no-fund
cd ../.. && bun install
TMPDIR=~/.cache/10x-chat-tmp node spike/readiness/run-all.mjs
```

Knobs: `SPIKE_HEADLESS=1` (headless), `SPIKE_PROXY=<url>` (endpoint for both engines),
`SPIKE_DISPLAY=:99` (the virtual display a headed run is bound to — the run **refuses to start**
when it does not exist instead of falling back to the desktop display),
`SPIKE_ENGINES=camoufox,cloakbrowser` (run one engine and merge it into the existing report),
`SPIKE_PROVIDERS=<list>` + `SPIKE_MAX_RUNS=<n>` (smoke run of the harness itself; such a report is
marked `reduced: true` and is never reused as a full result),
`SPIKE_REUSE=1` (`run-all.mjs` reuses finished reports — but only when the saved report was produced
with the same versions, the same proxy and the same headless setting; otherwise the matrix is
re-run and the reasons are printed).

### 3.0 The browsers never take the desktop focus

A headed browser connects to the **compositor of the desktop session**, not to the `DISPLAY`
variable alone: on a Wayland desktop a Chromium/Firefox started with `DISPLAY=:99` still opens its
window on the real screen and steals the user's focus. `display.mjs` therefore cuts the Wayland
connection before any browser is started (`WAYLAND_DISPLAY` is removed, `OZONE_PLATFORM=x11`,
`MOZ_ENABLE_WAYLAND=0`, `GDK_BACKEND=x11` are set) and forces `DISPLAY` to the virtual display;
`engines.mjs` refuses to launch a headed browser when that display is not available — there is no
fallback to the desktop. This is covered by `tests/readiness-display.test.ts`.

### 3.1 The gate never looks successful when it is not

`run-all.mjs` ends with an exit code that a CI job or an automated run can rely on:

| Exit code | Meaning |
|---|---|
| `0` | every matrix ran, every check passed, no criterion is unfinished |
| `1` | a check failed, a matrix crashed, or a report is partial/incomplete |
| `2` | no hard failure, but a criterion is unfinished (e.g. no credentials) |

The authorized round-trip is a **matrix criterion**: it covers 3 providers × 2 engines = 6
mandatory combinations, every combination keeps its own result, and the criterion is `done` only
when all 6 passed. A single successful combination never reports the criterion as done — the
status is `failed` / `partial` / `unfinished` otherwise. Each round-trip performs two exchanges:
the first one seeds the **persistent profile** of that engine/provider pair (`userDataDir`,
outside the repository), the browser is closed, and the second exchange runs in a **new browser
process on the same profile** — it must not be redirected to a login page. That is the
session-reuse check: the session has to survive a restart *without* a re-login.

A combination that cannot be measured at all (no credentials → the browser lands on the login page,
or the provider answers a guest with a paywall/upsell text) is recorded as `skipped`, not as a
failure of the engine: it keeps the criterion from being `done` and is counted separately. An
answer counts only when it is **new** — the number of answers is counted before the prompt is
sent, and the new answer must be non-empty and not a copy of an earlier one. Every prompt carries
a unique marker; the marker leaving the composer proves that the prompt was submitted
(`submitAttempts` and `markerEchoed` are recorded).

Results: `spike/readiness/results/*.json` (checked in). No credentials, cookies, tokens or
private answers are stored in the repository or in the ordinary logs.

**Two providers are not part of the matrix.** Grok has no authorized session in this environment —
its combinations could only ever be `skipped` and would say nothing about either engine. Perplexity
does not submit the prompt through its web UI here: the send button appears in the DOM without a
click handler, so neither a mouse click nor `Enter` sends anything (measured — see
[§6.1](#61-authorized-round-trip-3-providers--2-engines--6-mandatory-combinations)). Both were
dropped from the matrix by decision of the repository owner; the production providers in
`src/providers/` are untouched.

### 3.2 One answer is counted once

The number of answers on the page is the metric the round-trip relies on, so it must not be
inflated. A provider selector that spans **two DOM levels of the same answer** — the container
of the answer and the text inside it — matches both and counts every answer twice. This was
the case for Gemini (`model-response .model-response-text, model-response message-content`):
one exchange produced `answersBefore: 0, answersAfter: 2`.

Two things prevent it now:

- **one DOM level per provider** — the answer selector of a provider lives in
  `spike/readiness/providers.mjs` and must not contain two alternatives that share their
  container (`tests/readiness-answers.test.ts` fails when it does). Gemini now addresses the
  text of the answer: `model-response .model-response-text`;
- **the outermost element wins** — `snapshotAnswers()` collects the path of every matched
  element from the document root and `answers.mjs` reduces them to the outermost ones, so a
  nested match is part of the same answer (`topLevelAnswers()`).

Measured against the live Gemini UI: one answer → `model-response` 1, `model-response
.model-response-text` 1, `model-response message-content` 1, the old combined selector 2. Two
answers in one conversation → 2, 2, 2 and 4. The round-trip now reports
`answersAfter [1, 1]` for Gemini instead of `[2, 2]`.

## 4. Results

### 4.1 Proxy matrix — 12 passed, 3 failed

| Scenario | Camoufox | CloakBrowser |
|---|---|---|
| HTTP proxy, no auth | PASS | PASS |
| HTTP proxy, Basic auth | **FAIL** — `407`, the engine never authenticates | PASS |
| SOCKS5, no auth | PASS | PASS |
| SOCKS5, RFC 1929 auth | **FAIL** — `Browser does not support socks5 proxy authentication` (launch refused) | PASS (proxy log shows the authenticated user) |
| Proxy bypass list honoured | PASS | PASS |
| `HTTPS_PROXY` env behaviour | uses the env proxy on its own (Firefox system-proxy settings) | ignores env vars — the repo `proxyFromEnv()` layer is mandatory |
| Credentials do not leak (page / argv / environ) | PASS | **FAIL** — password visible in `/proc/<pid>/cmdline` of 3 processes |
| *Experiment*: SOCKS5 auth through a local relay adapter | PASS — works, but it is a workaround | n/a — the engine authenticates natively |

> **Infrastructure errors are retried, not recorded as engine results.** The local proxy rotates
> its exit IP and drops connections under load (`ERR_NETWORK_CHANGED`); the proxy and provider
> matrices therefore retry a navigation before they call it a failure. Without that, a proxy hiccup
> was indistinguishable from a broken engine — it is exactly how a false "CloakBrowser cannot
> authenticate" verdict appeared in an intermediate run of this matrix.

### 4.2 Lifecycle matrix — 14 passed, 0 failed

Both engines behave identically: persistent profile reuse (cookie **and** localStorage survive a
restart), context isolation, `storageState` round-trip (1 cookie + 1 origin, both restored),
file upload through the composer input, download, one browser with several sequential contexts
(what the daemon does), and no leftover browser processes after `close()`.

### 4.3 Operational matrix — 11 passed, 0 failed

| Metric | Camoufox | CloakBrowser |
|---|---|---|
| Install footprint on disk | 2757 MB (browser + GeoIP DB) | 1276 MB (free **and** Pro builds) |
| Launch (cold / warm) | 2834 ms / 708 ms | 476 ms / 135 ms |
| First paint after `goto` | 6053 ms / 3892 ms | 838 ms / 466 ms |
| Resident memory of the process tree | ~1090 MB (7 processes) | ~790 MB (10 processes) |
| Processes left after `close()` | **0** (7 spawned by the test, 0 left) | **0** (10 spawned by the test, 0 left) |
| Missing browser build | clear error: `ENOENT … '/nonexistent/application.ini'` | clear error: `Pro binary unavailable … HTTP 404 for SHA256SUMS` |
| Supported install path | `npx camoufox fetch` / `sync` / `list` (no manual build downloads) | `npx cloakbrowser install` (postinstall), but the download endpoint is license-gated (`401` without a key) |
| Download throughput measured here | `http=200` for `camoufox-158.0.1-beta.41-lin.x86_64.zip` (1.3 GB) | not measurable anonymously (`401`) |

> **The process measurements only count what the test itself started.** The RSS and the
> "no leftover processes" figures are computed from a PID snapshot taken **before** the launch:
> a browser the user has open by hand must not be counted as the test's child. Before this fix the
> numbers were machine-wide (`pgrep -f`), so they mixed the test's processes with the ones of the
> desktop session.

### 4.4 Provider matrix — 12 passed, 0 failed, 0 skipped

Both engines ran the same 50-run scenario through the same proxy (exit IP `88.218.94.56` for
both), **headed** under a virtual display (`Xvfb :99`) and with a real session per provider
(Playwright `storageState` for chatgpt, gemini and claude). The
detailed table is in [§6](#6-provider-matrix-3-providers--2-engines); the raw runs are in
`spike/readiness/results/provider-matrix.json`.

Checks: 6 reachability checks (all passed) + 6 authorized round-trip combinations (all passed) —
**12 passed, 0 failed, 0 skipped**. The authorized round-trip criterion is `done`: all 6 mandatory
combinations of the matrix are measured and pass.

The report is marked `partial: false` — the matrix was measured completely (3 providers × full run
count on both engines). A run that covers only part of the matrix is marked `partial` and can
never be read as the canonical result.

## 5. Upstream blocker: SOCKS5 + auth

The failure is not a configuration mistake, it is a missing capability on both sides of the
pinned matrix. Evidence (all reproducible):

1. **Playwright refuses the launch client-side.**
   `spike/camoufox/node_modules/playwright-core/lib/coreBundle.js:51191`:
   `throw new Error('Browser does not support socks5 proxy authentication')`
   (`normalizeProxySettings()` at `:51178`, reached from the launch path at `:39450`).
2. **The TypeScript launcher has no credential path.**
   `grep -rn "socks5_auth\|CAMOU_PROXY_AUTH\|proxyAuth" spike/camoufox/node_modules/camoufox/dist/`
   → no hits in `camoufox@0.5.9`.
3. **The paired browser build has no Juggler-side support.**
   The `omni.ja` of build `158.0.1-beta.41` was extracted and searched:
   `grep -rn "CAMOU_PROXY_AUTH\|camoufoxProxyAuth"` → no hits. `modules/juggler/TargetRegistry.js`
   only carries the stock Chromium-style `proxyAuthCacheKeyAndProxy`;
   `modules/ProxyChannelFilter.sys.mjs` only carries the stock HTTP-style
   `proxyAuthorizationHeader`. Firefox itself speaks SOCKS5 auth natively
   (`libxul.so` contains `socks5: sending username and password`), but neither Playwright's
   Firefox path nor Camoufox can inject the credentials into it.

**The upstream fix** (identified, not applied — it is an upgrade, and this gate must not change
versions on the side):

| Piece | Where |
|---|---|
| `socks5Auth()`, `PROXY_AUTH_ENV = "CAMOU_PROXY_AUTH"`, `proxyAuthEnv()`, `proxyAuthInitScript()` | `camoufox@0.5.10-beta.1` → `dist/ip.js:53,82,84,94` |
| `attachSocks5Auth()` wired into the launch | `camoufox@0.5.10-beta.1` → `dist/utils.js:962-995,1791-1797` |
| Browser-side handling (`PROXY_AUTH_ENV`, `readLaunchProxyAuth()`, `takeProxyAuth()`, `withProxyAuth()`) | browser build `v159.0-beta.42` → `browser/additions/juggler/TargetRegistry.js` (the `v158.0.1-beta.41` tag has 0 occurrences) |
| The beta pins that newer build | `camoufox@0.5.10-beta.1` → `dist/data-files/browser-pin.json` → `v159.0-beta.42` |

`camoufox@0.5.10-beta.1` keeps the peer constraint `playwright-core < 1.63`, so the repo's
`playwright-core` 1.61.1 / spike's 1.62.0 remain admissible — but the release is a **beta** and
the browser build is **newer than the one 3/8 validated**, so it needs its own compatibility
confirmation (see the re-verification list).

**The local adapter experiment** (`spike/readiness/socks5-relay.mjs`) proves the missing piece is
*only* the credential injection: the browser talks plain SOCKS5 to a local relay, the relay
authenticates upstream with RFC 1929, and the request succeeds. It is **not** acceptable for
production, because of its operational cost:

- an extra always-on process per CLI invocation (the repo already has a daemon — this would be a
  second one, with its own lifecycle, ports and lock semantics);
- proxy credentials leave the browser's own configuration and live in a separate process;
- failure modes multiply (adapter crash = all traffic dead, and the CLI would have to supervise it);
- it is not an upstream-supported API, so every Camoufox update can break it silently;
- `NO_PROXY` / bypass semantics would have to be re-implemented for the adapter.

Per §2 of the issue, this is an experiment for the cost assessment, not a production workaround.

## 6. Provider matrix (3 providers × 2 engines)

`spike/readiness/results/provider-matrix.json` holds every run (50 runs per engine).
Same scenario for both engines: open the provider through the **same** proxy
(`http://127.0.0.1:3128`; the exit IP was `88.218.94.56` for **both** engines in this run —
verified before the comparison), wait for the Cloudflare challenge to settle, then classify the
outcome.

**Run conditions:** headed mode under `Xvfb :99` — the harness cuts the Wayland connection of
the desktop session and refuses to start without that virtual display, so no browser window ever
touches the desktop (see [§3.0](#30-the-browsers-never-take-the-desktop-focus)); a Playwright
`storageState` **per provider**
(`~/.10x-chat/profiles/default/storage-state-<provider>.json`, outside the repository), the same
proxy for both engines. Headless mode is *not* comparable with this table: in the earlier headless
run ChatGPT was `auth-wall 30/30` / `cloudflare 28/30`, in the headed run with a session it is
`composer-visible` on both engines.

Classification (`classifyOutcome()` in `spike/readiness/probe.mjs`): `infra-error` (navigation
failed), `cloudflare` (interstitial / 403 / 503), `auth-wall` (redirect to a login URL, or a login
form without a composer), `composer-visible` (the composer is on the page), `provider-error` (200,
but neither a login wall nor the composer — a shell/consent page or a selector mismatch).

| Provider | Runs | Camoufox | CloakBrowser (current production runtime) |
|---|---|---|---|
| ChatGPT | 30 | **composer-visible 30/30** | composer-visible 30/30 |
| Gemini | 10 | composer-visible 10/10 | composer-visible 10/10 |
| Claude | 10 | composer-visible 10/10 | composer-visible 10/10 |

Reachability checks: 6 total — **6 passed, 0 failed**. An earlier run of the same matrix saw three
Cloudflare interstitials on CloakBrowser/ChatGPT (27/30); the canonical run has none. That is an
incidental observation of a single run and **not** a verdict about the engines: the samples are far
too small to rank them, and the earlier headless divergence disappeared as soon as the run was
made comparable.

### 6.1 Authorized round-trip (3 providers × 2 engines = 6 mandatory combinations)

Each combination sends a fixed probe prompt twice on the **same persistent profile**
(`userDataDir` per engine/provider pair, outside the repository):

1. the first exchange opens the provider in a persistent context, seeds it with the storage
   state of that provider (when there is one) and sends the prompt;
2. the browser is **closed** — the session only lives on disk;
3. the second exchange starts a **new browser process on the same profile** — it must not be
   redirected to a login page, and it must produce a new answer. That is the session-reuse check:
   the session survives a restart without a re-login.

What counts as an answer (this was the weakest point of the first revision of this report):

- the number of answers on the page is counted **before** the prompt is sent, and only an answer
  that appeared **after** that moment counts (`answersBefore` → `answersAfter`);
- the new answer must be non-empty and must not be a copy of an earlier one — a previously rendered
  answer can never be read as "the response";
- every prompt carries a **unique marker**; the marker leaving the composer proves that the prompt
  was submitted (`submitAttempts`, `markerEchoed`) — a click on a disabled send button is not a
  submission, so the harness clicks only a button that is **visible and enabled** and falls back to
  the keyboard (`Enter`) when no such button exists;
- an answer that is a paywall/upsell text ("Sign up and repeat your request") is **not** an
  answer: such a combination is recorded as `skipped` (not measurable without credentials), not as
  a failure of the engine;
- the waiting window is 45 s for every provider of the matrix.

Only the **length** of the answer is recorded (`answerChars`); the answer itself is never stored.
`markerEchoed` is a diagnostic, not an assertion: the model is asked to answer with the single
word `READY`, so it does not repeat the marker — the proof of submission is that the marker left
the composer and appeared in the conversation.

| Combination | Result | Detail |
|---|---|---|
| camoufox / chatgpt | **PASS** | `answerChars [20, 20]`, `answersBefore [0, 0]` → `answersAfter [1, 1]`, `submitAttempts [1, 1]`, `sessionReused true` |
| cloakbrowser / chatgpt | **PASS** | `answerChars [20, 20]`, `answersBefore [0, 0]` → `answersAfter [1, 1]`, `submitAttempts [1, 1]`, `sessionReused true` |
| camoufox / gemini | **PASS** | `answerChars [5, 5]`, `answersBefore [0, 0]` → `answersAfter [1, 1]`, `submitAttempts [1, 1]`, `sessionReused true` |
| cloakbrowser / gemini | **PASS** | `answerChars [5, 5]`, `answersBefore [0, 0]` → `answersAfter [1, 1]`, `submitAttempts [1, 2]`, `sessionReused true` |
| camoufox / claude | **PASS** | `answerChars [41, 41]`, `answersBefore [0, 0]` → `answersAfter [1, 1]`, `submitAttempts [1, 1]`, `sessionReused true` |
| cloakbrowser / claude | **PASS** | `answerChars [41, 41]`, `answersBefore [0, 0]` → `answersAfter [1, 1]`, `submitAttempts [1, 1]`, `sessionReused true` |

Criterion status: **done** — 6 of 6 combinations measured, **6 passed, 0 failed, 0 skipped**
(`mandatory: 6`). The criterion is closed for the providers of the matrix; the two providers that
are not in it (see below) never entered it, so no combination of the matrix is left open.

What this does and does not show:

- **The round-trip mechanism works end-to-end** on both engines: with a session, a *new* answer
  arrives and the session is reusable after a browser restart on the same profile. The criterion
  is a real measurement, not an `unfinished` placeholder.
- **Every combination of the matrix passed on both engines** — the engines are in parity here. The
  matrix still cannot rank them: the sample is one run per combination.
- **Two providers are outside the matrix and say nothing about the engines.** Grok has no
  authorized session in this environment: the browser is sent to the login page and the guest
  attempt gets no answer. Perplexity does not submit the prompt through its web UI here — the
  send button (`button[aria-label="Submit"]`) appears in the DOM without a click handler, so a
  mouse click, a forced click and `Enter` all leave the prompt in the composer and no request is
  made. Both were dropped from the matrix by decision of the repository owner; the production
  providers in `src/providers/` are untouched by that decision.
- **The answer selectors had to be corrected against the live UI** — the earlier revision of this
  report used selectors that never matched (Claude: `[data-testid="chat-message"]`,
  `.font-claude-response`). The working ones are:
  ChatGPT `[data-conversation-role="assistant"]`, Claude
  `[data-testid="assistant-message"]` / `[data-cds="AssistantMessage"]` (text in
  `[data-perf-reply-text]`), Gemini `model-response .model-response-text`. The production selectors
  in `src/providers/*` were written against Chromium and have to be re-checked before any migration
  ([#16](https://github.com/gazon1/10x-chat/issues/16)).
- **A selector that matches two DOM levels of one answer counts it twice.** The Gemini selector
  `model-response .model-response-text, model-response message-content` matched the container of
  the answer *and* the text inside it, so one exchange reported `answersAfter: 2`. The selector
  now addresses one level (`model-response .model-response-text`), and the counting itself keeps
  only the outermost matched element (see [§3.2](#32-one-answer-is-counted-once)).
- **One concrete selector finding for the migration**: the current ChatGPT UI has no
  `#prompt-textarea`; the composer is `div.ProseMirror[contenteditable="true"][role="textbox"]`,
  the send button is `button[aria-label="Send"]` and the assistant turn is marked with
  `data-conversation-role="assistant"`.
- **Firefox needs real key events.** `fill()` does not reach the ProseMirror of Claude under
  Firefox — the prompt silently stays empty. The harness therefore verifies the text in the
  composer and falls back to `pressSequentially` (`submitMethods`).
- **Engine parity.** With identical conditions both engines give the same verdict on every
  provider. A 10/30-run sample still cannot turn into a "this engine bypasses Cloudflare better"
  claim — the earlier headless divergence disappeared once the run was made comparable.

## 7. Operational properties and cost

**Camoufox** — the browser build is **MPL-2.0** (Firefox's licence); the npm package (TypeScript
tooling) is MIT; the vendored Cursory trajectories are LGPLv3-or-later. There is **no licence fee**,
and redistribution alongside 10x-chat is allowed (MPL-2.0 is file-level copyleft and does not
infect the rest of the project). Cost is disk (2.7 GB), RAM (~0.9 GB per browser) and slower
start-up (~4–6 s to first paint versus ~0.5–1 s for the current engine).

**CloakBrowser** — the npm wrapper is MIT, but the **binary has its own licence**
(`BINARY-LICENSE.md`, not shipped in the npm package; it comes with the downloaded build):

- the free tier covers this repository's usage: the latest build with an email, **one concurrent
  session**, usable for personal and commercial work;
- paid tiers are needed for **concurrency** (5 / 20 / 200 / 2000+ sessions) and for
  **redistribution** (serving third parties as an OEM/SaaS needs a separate licence);
- the free tier is therefore **not** the blocker for 10x-chat today — the earlier assumption that
  "CloakBrowser is fully paid" is wrong.

Two operational facts measured here:

- the installed **Pro build 156.0.8078.47.1 does not start** (exit code 76) even though a license
  key is present in the environment; the free build 146 works. The harness therefore runs the free
  build by default (`CLOAKBROWSER_USE_PRO=1` switches back).
- CloakBrowser passes the proxy credentials **on the command line**
  (`--proxy-server=http://user:pass@host:port`), so they are world-readable through
  `/proc/<pid>/cmdline` for as long as the browser runs. This is a finding about the current
  production runtime, independent of the Camoufox decision. Tracked separately in
  [#15](https://github.com/gazon1/10x-chat/issues/15) — production stays on CloakBrowser until that
  issue is closed.

## 8. Not verified / unfinished criteria

| Criterion | Status |
|---|---|
| Authorized prompt/response round-trip for the providers of the matrix | **DONE** — the criterion was executed as a matrix of 3 providers × 2 engines = 6 mandatory combinations, each with its own result and a session-reuse check on a persistent profile: **6 measured and passed** (`chatgpt`, `gemini`, `claude` on both engines). Two providers are **outside** the matrix (Grok — no credentials; Perplexity — its web UI does not submit the prompt under automation here), so no combination of the matrix is left open |
| Login/session reuse with a real account | **DONE** — verified for ChatGPT, Gemini and Claude on both engines: a *new* answer (`answersBefore` → `answersAfter`) plus a successful session reuse in a freshly launched browser on the same profile (`sessionReused: true`) |
| Provider selectors under Firefox | **PARTIAL** — the harness selectors were found by probing the live UI and fixed: ChatGPT `[data-conversation-role="assistant"]`, Claude `[data-testid="assistant-message"]` / `[data-cds="AssistantMessage"]`, Gemini `model-response .model-response-text`; the current ChatGPT UI no longer has `#prompt-textarea`. The **production** selectors in `src/providers/*` are still written against Chromium and were not changed (production code is out of scope here) — they have to be re-validated before any migration ([#16](https://github.com/gazon1/10x-chat/issues/16)) |
| Provider matrix in **headed** (production-like) mode | **DONE** — the canonical run was executed headed under Xvfb `:99` with a real session per provider: 12 passed / 0 failed / 0 skipped, 50 runs per engine. Browser windows render on a virtual display and never take desktop focus (the harness cuts the Wayland connection and refuses to start without the virtual display) |
| GeoIP coherence / a different exit geography | **NOT TESTED** — the local proxy's exit IP is not stable (it was `46.138.35.132` during the proxy-matrix run and `88.218.94.56` during the provider run — for **both** engines, which is what the comparison needs), and no GeoIP coherence check was performed |
| `launchServer()` / remote server with a persistent profile | **NOT APPLICABLE** — Camoufox cannot serve a persistent context remotely; the daemon is in-process (`src/browser/daemon.ts`), so the production shape does not need it |
| HTTP-proxy Basic auth on Camoufox with another Playwright version | **NOT TESTED** — 1.63+ is out of scope per the issue |
| Crash recovery (browser killed mid-session) | **NOT TESTED** — only clean `close()` and orphan checks were run |

## 9. Conditions for re-checking (what would turn this into GO / CONDITIONAL GO)

1. **Install the upstream SOCKS5-auth support through the supported path only:**
   `camoufox@0.5.10-beta.1` + browser build `v159.0-beta.42` via `npx camoufox fetch`, then
   re-run `spike/readiness/proxy-matrix.mjs`. Required outcome: the SOCKS5 scenario must show an
   authenticated tunnel in the proxy log (not only a 200), and the HTTP Basic-auth scenario must
   not answer `407`. No hand-written proxy-auth shim in production code.
2. **Keep the round-trip criterion closed when the matrix changes.** It is a matrix of 6 mandatory
   combinations (3 providers × 2 engines) and all of them are measured and pass. Every provider
   that is added to the matrix has to be measured the same way: open → authorize → send a unique
   prompt → check a **new**, non-empty answer → rerun on the same profile without re-login → close →
   restart. A provider that cannot be measured this way (no authorized session, or a web UI that
   does not submit the prompt under automation) does not belong in the matrix — it would keep the
   criterion open with a combination that says nothing about the engines. The probe prompt is a
   fixed string and only emptiness/length of the answer is recorded.
3. **Re-validate the provider selectors under Firefox**, separating selectors (DOM) from browser
   mechanics (network, downloads, clipboard) — and drop the Chromium-only stealth layer
   (`src/browser/stealth.ts`, `src/browser/process.ts`) for the Firefox path instead of porting it.
   The first concrete instances are already recorded: the ChatGPT selectors in the current UI and
   the Claude answer element (`[data-testid="assistant-message"]` /
   `[data-cds="AssistantMessage"]`), plus the fact that `fill()` does not reach the ProseMirror
   under Firefox (real key events are needed).
4. **Re-check the operational numbers** on the upgraded build (disk, start-up, RSS) and confirm
   the licence situation of the exact build that would be shipped.
5. **Re-run the canonical matrix under the same conditions** (headed, Xvfb, real sessions) after the
   upstream upgrade in point 1, so the two runs are comparable; the current canonical results are
   stored in `spike/readiness/results/` together with the harness settings and the resolved
   versions, and `SPIKE_REUSE=1` refuses to reuse a report whose versions, proxy or headless
   setting differ (a version that cannot be resolved counts as a mismatch, not as "equal").
6. **Do not run the matrices in parallel with each other.** The proxy rotates its exit IP and
   drops connections under load (`ERR_NETWORK_CHANGED`), and a provider session that is used by
   two browsers at once is rejected ("Your account changed"). Every measurement in this report was
   taken strictly sequentially.

Until then: **NO-GO, production stays on CloakBrowser, issue #5 (migration) does not start.**

Follow-ups that do not change this verdict: [#15 — утечка proxy-credentials в CloakBrowser](https://github.com/gazon1/10x-chat/issues/15)
(security, production runtime is affected today) and [#16 — заимствования из `alexandrutodor/10x-chat`](https://github.com/gazon1/10x-chat/issues/16)
(роадмап: per-provider headed, детект Cloudflare, ручное прохождение challenge, persistent-профили,
отказ от лишнего stealth, классификация ошибок). Both are separate stages and are not implemented in
PR #14.
