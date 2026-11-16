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

Two further gaps keep this from being CONDITIONAL GO:

1. **The authorized prompt/response round-trip was never executed** — there are no provider
   credentials in this environment. The issue explicitly allows recording this as an *unfinished
   criterion*, not as a PASS; it is therefore unfinished, and §4 of the issue stays open.
2. **Firefox vs Chromium selector blast radius** is unmeasured for five providers (all provider
   selectors in `src/providers/*` were written against Chromium) — 3/8 already flagged this.

Everything else is neutral or positive: browser lifecycle, profile handling, `storageState`,
upload/download and cleanup behave **identically** on both engines (14/14 checks), and the
provider matrix shows **no engine-level advantage** worth acting on — the only divergence
(ChatGPT: Cloudflare 28/30 in headless Chromium versus an auth wall in Camoufox) is a headless
artefact that a 30-run sample cannot turn into a bypass claim ([§6](#6-provider-matrix-5-providers--2-engines)).

## 2. Version matrix and environment (verified, not quoted)

| Component | Version | Source |
|---|---|---|
| Node | `v22.22.2` | `node -v` |
| OS | Fedora 44, kernel 7.2.10, x86_64, glibc 2.43 | `uname -a` |
| camoufox (npm, spike sandbox) | `0.5.9` | `spike/camoufox/package.json` |
| fpgen | `1.3.0` | `npx camoufox version` |
| playwright-core (spike sandbox) | `1.62.0` | `spike/camoufox/node_modules` |
| playwright-core (repo) | `1.61.1` | `bun install` — satisfies the Camoufox peer constraint `< 1.63` |
| Camoufox browser build | `official/stable/158.0.1-beta.41` (SHA256 `3f2eb1d0451f`) | `npx camoufox version`, `npx camoufox list` |
| cloakbrowser (repo) | `0.4.10`, MIT | `node_modules/cloakbrowser/package.json` |
| CloakBrowser build used | Chromium `146.0.7680.177.5` (free tier) | `~/.cloakbrowser/` |
| CloakBrowser build installed but unusable | Chromium `156.0.8078.47.1-pro` | `binaryInfo()` — exits 76 on launch, see [§7](#7-operational-properties-and-cost) |
| Proxy endpoint (both engines) | `http://127.0.0.1:3128`, exit IP `88.218.94.56` | `curl --proxy … api.ipify.org` |
| Display | `DISPLAY=:0` (Xwayland) | headed mode, as in production |

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
| `util.mjs` | check runner, report writer, process/RSS helpers, version capture |
| `proxy-matrix.mjs` | HTTP(S) / SOCKS5 (no auth, RFC 1929 auth), bypass list, env precedence, credential leakage |
| `lifecycle-matrix.mjs` | persistent profile reuse, context isolation, `storageState`, upload/download, browser reuse, cleanup |
| `ops-matrix.mjs` | install footprint, cold/warm start, RSS, leftover processes, install path and failure modes, licensing |
| `provider-matrix.mjs` | 5 providers × 10 runs (30 for Cloudflare-dependent) × 2 engines + authorized round-trip |
| `socks5-relay.mjs` | **experiment only**: local SOCKS5 adapter that authenticates upstream |
| `run-all.mjs` | runs every matrix, writes `results/summary.json` |

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
`SPIKE_ENGINES=camoufox,cloakbrowser` (run one engine and merge it into the existing report),
`SPIKE_REUSE=1` (`run-all.mjs` reuses finished reports).

Results: `spike/readiness/results/*.json` (checked in). No credentials, cookies, tokens or
private answers are stored in the repository or in the ordinary logs.

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

### 4.2 Lifecycle matrix — 14 passed, 0 failed

Both engines behave identically: persistent profile reuse (cookie **and** localStorage survive a
restart), context isolation, `storageState` round-trip (1 cookie + 1 origin, both restored),
file upload through the composer input, download, one browser with several sequential contexts
(what the daemon does), and no leftover browser processes after `close()`.

### 4.3 Operational matrix — 11 passed, 0 failed

| Metric | Camoufox | CloakBrowser |
|---|---|---|
| Install footprint on disk | 2757 MB (browser + GeoIP DB) | 1276 MB (free **and** Pro builds) |
| Launch (cold / warm) | 2213 ms / 3662 ms | 535 ms / 158 ms |
| First paint after `goto` | 4188 ms / 5733 ms | 933 ms / 536 ms |
| Resident memory of the process tree | ~932 MB | ~787 MB |
| Missing browser build | clear error: `ENOENT … '/nonexistent/application.ini'` | clear error: `Pro binary unavailable … HTTP 404 for SHA256SUMS` |
| Supported install path | `npx camoufox fetch` / `sync` / `list` (no manual build downloads) | `npx cloakbrowser install` (postinstall), but the download endpoint is license-gated (`401` without a key) |
| Download throughput measured here | ~4 MB/s for the 1.3 GB asset (≈ 5–6 min per build) | not measurable anonymously (`401`) |

### 4.4 Provider matrix — 2 passed, 8 failed

Both engines ran the same 90-run scenario through the same proxy (exit IP `88.218.94.56` for
both). The detailed table is in [§6](#6-provider-matrix-5-providers--2-engines); the raw runs
are in `spike/readiness/results/provider-matrix.json`. The authorized round-trip is recorded as
**unfinished** (no credentials in this environment), never as a pass.

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

## 6. Provider matrix (5 providers × 2 engines)

`spike/readiness/results/provider-matrix.json` holds every run (90 runs per engine).
Same scenario for both engines: open the provider through the **same** proxy
(`http://127.0.0.1:3128`; the exit IP was `88.218.94.56` for **both** engines in this run —
verified before the comparison), wait for the Cloudflare challenge to settle, then classify the
outcome.

Classification (`classify()` in `spike/readiness/provider-matrix.mjs`): `infra-error` (navigation
failed), `cloudflare` (interstitial / 403 / 503), `auth-wall` (login form, no composer),
`composer-visible` (the composer is on the page), `provider-error` (200, but neither a login wall
nor the composer — a shell/consent page or a selector mismatch).

| Provider | Runs | Camoufox | CloakBrowser (current production runtime) |
|---|---|---|---|
| ChatGPT | 30 | auth-wall 30/30 | **cloudflare 28/30**, auth-wall 2/30 |
| Gemini | 10 | provider-error 10/10 | provider-error 10/10 |
| Claude | 10 | provider-error 10/10 | provider-error 9/10, cloudflare 1/10 |
| Grok | 10 | **composer-visible 10/10** | **composer-visible 10/10** |
| Perplexity | 30 | provider-error 30/30 | provider-error 30/30 |

Checks: 10 total — 2 passed, 8 failed (both engines reach the same verdict on every provider).

What this does and does not show:

- **Engine parity.** Both engines behave the same on 4 of 5 providers; the only divergence is
  ChatGPT, where headless Chromium is caught by a Cloudflare interstitial 28/30 times while
  Camoufox consistently lands on the login wall. That is a **headless** observation: the
  production runtime runs headed, and headed Chromium is a different Cloudflare profile.
  A 10/30-sample difference is not evidence that either engine "bypasses" Cloudflare better.
- **The reachability ceiling is not the engine.** Gemini, Claude and Perplexity return
  `provider-error` on *both* engines — the page loads with status 200, but without credentials
  there is no composer. This is an auth-wall/selector issue, not a Firefox incompatibility, and
  it means the harness cannot rank the engines on those three providers at all.
- **Grok is the only provider that can be compared without credentials**, and there the two
  engines are equal (10/10).
- **The authorized round-trip (§4 of the issue) is UNFINISHED**, not passed: no storage state
  exists in this environment (`~/.10x-chat/` does not exist), so the harness prints
  `SKIP … UNFINISHED` and never reports a PASS. The per-provider selectors under Firefox are
  therefore also unverified.

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
  production runtime, independent of the Camoufox decision.

## 8. Not verified / unfinished criteria

| Criterion | Status |
|---|---|
| Authorized prompt/response round-trip for the 5 providers | **UNFINISHED** — no credentials in this environment (`~/.10x-chat/` does not exist); the harness implements it and marks it unfinished, never a PASS |
| Login/session reuse with a real account | **UNFINISHED** — same reason |
| Provider selectors under Firefox | **UNFINISHED** — needs an authenticated session; the provider matrix only measures reachability, the login wall and Cloudflare behaviour |
| Provider matrix in **headed** (production-like) mode | **NOT RUN** — the recorded run was headless (`SPIKE_HEADLESS=1`), because the desktop must not be taken over by browser windows; no Xvfb is installed. Cloudflare behaviour differs between headed and headless, so the ChatGPT column is not directly transferable to production |
| GeoIP coherence / a different exit geography | **NOT TESTED** — the local proxy's exit IP is not stable (it was `46.138.35.132` during the proxy-matrix run and equal to the host's direct IP `88.218.94.56` during the provider run and now), and no GeoIP coherence check was performed |
| `launchServer()` / remote server with a persistent profile | **NOT APPLICABLE** — Camoufox cannot serve a persistent context remotely; the daemon is in-process (`src/browser/daemon.ts`), so the production shape does not need it |
| HTTP-proxy Basic auth on Camoufox with another Playwright version | **NOT TESTED** — 1.63+ is out of scope per the issue |
| Crash recovery (browser killed mid-session) | **NOT TESTED** — only clean `close()` and orphan checks were run |

## 9. Conditions for re-checking (what would turn this into GO / CONDITIONAL GO)

1. **Install the upstream SOCKS5-auth support through the supported path only:**
   `camoufox@0.5.10-beta.1` + browser build `v159.0-beta.42` via `npx camoufox fetch`, then
   re-run `spike/readiness/proxy-matrix.mjs`. Required outcome: the SOCKS5 scenario must show an
   authenticated tunnel in the proxy log (not only a 200), and the HTTP Basic-auth scenario must
   not answer `407`. No hand-written proxy-auth shim in production code.
2. **Repeat the provider matrix with credentials and in headed mode** (production-like) for
   ChatGPT, Gemini, Claude, Grok and Perplexity: ≥ 10 independent runs per provider and engine,
   30 for the Cloudflare-dependent ones, each run doing open → authorize → send a unique prompt →
   check a non-empty answer → rerun with the same profile without re-login → close → restart. The
   probe prompt is a fixed string and only emptiness/length of the answer is recorded.
3. **Re-validate the provider selectors under Firefox**, separating selectors (DOM) from browser
   mechanics (network, downloads, clipboard) — and drop the Chromium-only stealth layer
   (`src/browser/stealth.ts`, `src/browser/process.ts`) for the Firefox path instead of porting it.
4. **Re-check the operational numbers** on the upgraded build (disk, start-up, RSS) and confirm
   the licence situation of the exact build that would be shipped.

Until then: **NO-GO, production stays on CloakBrowser, issue #5 (migration) does not start.**
