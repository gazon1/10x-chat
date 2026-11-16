# Refactor 3/8 — Camoufox compatibility spike

Spike for [#4](https://github.com/gazon1/10x-chat/issues/4). **No production browser runtime was
replaced.** The browser engine stays CloakBrowser (Chromium); the only production change is that
the engine now forwards `HTTPS_PROXY` / `HTTP_PROXY` / `NO_PROXY` to the browser launch
(see [§8](#8-production-change-env-proxy-support)).

- Branch / commit: `gazon1/refactor-3-8-camoufox` @ `cc32992`
- Date: 2026-11-16
- Environment: Linux 7.2.10 (Fedora 44), x86_64, Node `v22.22.2`, npm
- Local proxy used for the provider checks: `http://127.0.0.1:3128`

## 1. Verdict

**NO-GO for replacing the browser runtime with Camoufox.** CloakBrowser is kept.

Camoufox is technically capable of everything the runtime needs (persistent profiles, storage-state
round-trip, HTTP proxy, upload/download, remote server, headed mode) — the spike passed 22 of 23
checks. It is rejected as the *production* runtime for reasons of blast radius, not capability:

| Reason | Detail |
|---|---|
| Firefox vs Chromium | Camoufox is a patched Firefox. Every provider selector in `src/providers/*` was written against Chromium; a Firefox migration means re-validating all of them against a different DOM and a different anti-bot surface. |
| The stealth script fights the engine | `STEALTH_INIT_SCRIPT` (`src/browser/stealth.ts`) fakes `window.chrome.runtime`, `navigator.plugins` and `navigator.mimeTypes` — Chromium tells-tales. A Firefox identity carrying a Chrome runtime stub is *more* suspicious than no stub at all. It would have to be disabled for a Firefox engine. |
| Chromium launch flags | `CHROMIUM_ARGS` (`src/browser/process.ts`) is meaningless for Firefox. |
| Persistent contexts cannot be served remotely | `launchServer()` explicitly cannot serve a persistent context, so the daemon shape (`src/browser/server.ts`, `src/browser/daemon.ts`) and the `login` / isolated-profile flows need a redesign, not a swap. |
| SOCKS5 with authentication is unavailable in the Node launcher | The Python launcher strips SOCKS credentials and hands them to Juggler (`socks5_auth` / `CAMOU_PROXY_AUTH` in `python/src/camoufox/ip.py`); the TypeScript launcher (`camoufox@0.5.9`) has no equivalent, so Playwright rejects the launch outright. |
| Camoufox's own warning | Upstream README: "This project is under development. It may not be suitable for stable production use." |

**But Camoufox scored better than the incumbent against Cloudflare** ([§7](#7-provider-smoke)), which
is worth keeping in mind for a later, provider-scoped experiment rather than a repo-wide switch.

## 2. Version matrix (verified, not quoted)

| Component | Version | Source |
|---|---|---|
| Node | `v22.22.2` | `node -v` |
| camoufox (npm) | `0.5.9` | `npx camoufox version` |
| fpgen | `1.3.0` | `npx camoufox version` |
| Playwright (camoufox's peer) | `1.62.0` | `npx camoufox version` — `playwright-core` must be **< 1.63** |
| Camoufox browser build | `official/stable/158.0.1-beta.41 (3f2eb1d0)` | `npx camoufox active` — *paired with camoufox 0.5.9* |
| GeoIP DB | `GeoIP AIO by daijro` (117 MB) | downloads on first `geoip: true` launch |
| Repo runtime (kept) | cloakbrowser `0.4.10`, Chromium `146.0.7680.177.5` | `~/.cloakbrowser/` |
| Repo `playwright-core` | `1.61.1` | `bun install` — satisfies camoufox's `< 1.63` peer constraint |

Upstream requirements that hold for this repo: Node ≥ 22.15 (repo declares `>=22`),
`playwright-core` < 1.63 (repo resolves to 1.61.1 — OK), Linux x86_64 with glibc 2.43 (OK).

## 3. The spike

```
spike/
  camoufox/          isolated sandbox: own package.json, own node_modules
    spike.mjs        the checks
    fixtures.mjs     local HTTP server (upload / download / cookie / storage)
    proxies.mjs      local HTTP CONNECT proxy + SOCKS5 proxy (RFC 1929 user/pass)
    report.json      result of the last run
  compare-runtime.mjs  Camoufox vs the current CloakBrowser runtime, same proxy
  verify-proxy.ts      checks that the production engine honours HTTPS_PROXY
```

Run it:

```bash
cd spike/camoufox && npm install && npx camoufox fetch
export HTTPS_PROXY=http://127.0.0.1:3128 HTTP_PROXY=http://127.0.0.1:3128
export NO_PROXY=localhost,127.0.0.1,::1
node spike.mjs
```

The local proxies exist so that "the browser used the proxy" is proven by the proxy's own log
(the tunnelled target), not inferred from an exit IP.

## 4. Check results

22 passed / 1 failed (`spike/camoufox/report.json`).

| # | Check | Result | Note |
|---|---|---|---|
| 1 | headless launch, page load | **PASS** | UA `Firefox 158`, `navigator.webdriver === false` |
| 2 | navigation + waits | **PASS** | `goto` / `waitForSelector` / `waitForFunction` / `waitForURL` / `waitForLoadState` |
| 3 | upload | **PASS** | `setInputFiles` fires a trusted change event; POST body reached the server |
| 4 | download | **PASS** | `waitForEvent('download')` + `saveAs`, content verified |
| 5 | persistent context | **PASS** | `persistent_context: true` + `user_data_dir` |
| 6 | profile reuse | **PASS** | cookie *and* localStorage survived a restart |
| 7 | storage-state round-trip | **PASS** | export from a persistent context → import into a fresh context: cookies + 1 origin |
| 8 | HTTP proxy with basic auth | **PASS** | tunnelled `api.ipify.org:443` (proxy log) |
| 9 | SOCKS5 with auth, TS launcher API | **PASS** (rejects as designed) | Playwright: `Browser does not support socks5 proxy authentication` |
| 10 | SOCKS5 with auth, `CAMOU_PROXY_AUTH` | **FAIL** | the env var is not honoured by this build — see [§6](#6-findings) |
| 11 | remote server | **PASS** | `launchServer()` + `firefox.connect()` works; persistent contexts cannot be served |
| 12 | shutdown / cleanup | **PASS** | ~2.3 s to close, no leftover browser processes |
| 13 | headed mode | **PASS** | a real window on `DISPLAY=:0` |
| 14 | provider smoke, direct | **PASS** ×5 | chatgpt, gemini, claude, grok, perplexity — all HTTP 200 |
| 15 | provider smoke, via `127.0.0.1:3128` + `geoip: true` | **PASS** ×5 | claude returned a Cloudflare interstitial once — see [§7](#7-provider-smoke) |

## 5. What a Camoufox swap would have to change

| Production piece | Needed for Camoufox |
|---|---|
| `src/browser/engine.ts` | a Firefox engine adapter (`Camoufox()` instead of `cloakbrowser.launch()`); `launchPersistentContext` returns a `BrowserContext`, `launch` a `Browser` — the shape fits, but the `BrowserType` shim does not. |
| `src/browser/stealth.ts` | disable for Firefox: the `window.chrome` / `navigator.plugins` stubs are Chromium tells. |
| `src/browser/process.ts` | `CHROMIUM_ARGS` is Chromium-only. |
| `src/browser/server.ts` + `daemon.ts` | the daemon launches a browser in-process; a persistent context cannot be served by `launchServer()`, so `login` and isolated-profile mode would need a separate path. |
| `src/providers/*` | re-validate every selector against Firefox. |
| `src/browser/state.ts` | works as-is (`storageState` round-trip verified). |

## 6. Findings

1. **SOCKS5 with authentication is not available in the Node launcher.** `camoufox@0.5.9` passes
   `proxy` straight to Playwright, and Playwright's client-side validation rejects
   `socks5://` with credentials before the browser starts. The Python launcher has
   `socks5_auth()` for this; the TypeScript port does not. Handing the credentials over
   manually through `CAMOU_PROXY_AUTH` (the Python mechanism) did **not** work with the paired
   build `158.0.1-beta.41`: the browser tunnelled the connection but never sent the RFC 1929
   handshake. Plain SOCKS5 *without* credentials works.
   The current runtime is better here: CloakBrowser supports SOCKS5 with inline credentials.
2. **Canvas readback is randomised by default.** Camoufox warns (`LeakWarning`) when the identity
   claims an OS other than the host's: canvas/WebGL readback then returns random data, which
   makes the browser look like LibreWolf/Tor rather than stock Firefox. On this Linux host the
   default identity claims Windows, so the warning fires on every launch. A `linux` identity (or
   `os: 'linux'`) avoids it.
3. **The geoip option changes what the site sees, and it is not free.** With `geoip: true` the
   timezone, locale, geolocation and WebRTC IP are taken from the proxy's exit IP. That makes
   the fingerprint coherent with the exit IP — and it is what the project's proxy setup wants —
   but it also changed the Cloudflare outcome in one run ([§7](#7-provider-smoke)).
4. **Storage state needs a visited origin.** `context.storageState()` collects `localStorage` per
   visited origin, not from the profile on disk: exporting from a persistent context that never
   opened a page yields `origins: []`. The repo's `state.ts` is unaffected (it exports from a live
   context), but any scripted export must visit the origin first.
5. **`playwright-core` must stay `< 1.63`.** The repo resolves `1.61.1`, so this holds today; a
   `playwright-core` bump to 1.63+ would break the camoufox peer constraint.

## 7. Provider smoke

Headed mode, same proxy (`http://127.0.0.1:3128`), 3 runs per provider per engine.
"Blocked" = HTTP ≥ 400 or a Cloudflare interstitial page.

| Engine | Provider | Blocked | HTTP | Title observed |
| --- | --- | --- | --- | --- |
| CloakBrowser | chatgpt | 2/3 | 403, 403, 200 | `""` (empty) on the 403s |
| CloakBrowser | claude | 3/3 | 403, 403, 403 | `Just a moment...` |
| Camoufox | chatgpt | 0/3 | 200, 200, 200 | `ChatGPT: Chat, Work, Create & Code with AI` |
| Camoufox | claude | 0/3 | 200, 200, 200 | `Sign in or create an account \| Claude.ai` |

Reading: the Cloudflare-protected providers are the interesting ones. Through the same proxy,
Camoufox cleared both, while the current Chromium runtime was challenged on most runs. The
sample is small (3 runs) and Cloudflare's verdict is not deterministic — an earlier Camoufox run
returned a Claude interstitial, and a `geoip: true` launch was challenged once while an
identical non-geoip launch was not. The signal is "Camoufox is at least as good, probably
better, on Cloudflare-protected providers", not a proof.

The smoke is anonymous (page load only). No credentials were available in this environment, so
**the authenticated flows — a real prompt/response round-trip, per provider — were not verified**
for either engine. The repo's provider logic is also untested against Firefox.

## 8. Production change: env proxy support

The project needs a proxy for ChatGPT/Claude (`HTTPS_PROXY=http://127.0.0.1:3128`), but the
runtime never passed one: Chromium ignores the standard proxy environment variables, and
`src/browser/*` had no `proxy` option at all. `src/browser/engine.ts` now turns
`HTTPS_PROXY` / `HTTP_PROXY` (and `NO_PROXY` → Playwright's `bypass`) into a launch option for
both `launch` and `launchPersistentContext`, so the daemon, the isolated-profile mode and the
login flow all inherit it.

Verified with `spike/verify-proxy.ts`: with `HTTPS_PROXY` pointed at a local proxy, the browser
tunnelled `api.ipify.org:443` through it.

No other production behaviour changed.

## 9. Not verified

- Authenticated provider flows (prompt → response) for either engine — no credentials available.
- Firefox behaviour of the repo's provider selectors — Camoufox was never wired into `src/providers`.
- `geoip: true` against a non-local proxy (the local proxy exits from the same IP, so the geoip
  lookup resolves to the host's own country).
- Windows / macOS hosts: Camoufox ships builds for them, but only Linux was exercised.
- `headless: 'virtual'` (Xvfb) — Xvfb is not installed on this host, so only `headless: true` and
  `headless: false` on `DISPLAY=:0` were tested.

## 10. Follow-up: the production-readiness gate (4/9)

The spike above (22/23 checks, 3 runs per provider/engine, no credentials) was not sufficient to
switch the production runtime. [#13](https://github.com/gazon1/10x-chat/issues/13) asked for a
reproducible gate, and it was executed in `spike/readiness/` — full report, version matrix,
per-check results and re-verification conditions:
**[docs/refactor-4-9-camoufox-production-readiness.md](refactor-4-9-camoufox-production-readiness.md)**.

Outcome: **NO-GO**, production stays on CloakBrowser. The 3/8 finding about SOCKS5 with
authentication turned out to be deeper than "the Node launcher has no equivalent": on the pinned
matrix (`camoufox@0.5.9` + browser build `158.0.1-beta.41`) **neither** the TS launcher **nor**
the browser build can carry SOCKS5 credentials, and HTTP proxies with Basic auth fail the same
way (`407`). The upstream fix exists but needs a Camoufox beta plus a newer browser build, which
this gate is not allowed to apply on the side. The authorized prompt/response round-trip remains
**unfinished** (no credentials in the environment), and a proxy-credential leak in the current
CloakBrowser runtime (credentials on the browser command line) was measured as well.

The 3/8 spike files (`spike/camoufox/`) are untouched except for one fixture change: the
`/storage` endpoint now seeds `localStorage`, so that the 4/9 lifecycle matrix can prove that
localStorage — not only cookies — survives a profile restart.
