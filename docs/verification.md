# Verification — refactor 9/9

The check run for [#9](https://github.com/gazon1/10x-chat/issues/9): the state of the
repository after the refactoring, what was checked, and what is **not** covered on purpose.

- Branch: `gazon1/refactor-9-9-ci`
- Date: 2026-11-17
- Environment: Fedora 44, kernel 7.2.10, x86_64; Bun 1.4.4; Node v26.13.0; npm 11.20.0
- Browser runtime: CloakBrowser 0.4.10, Chromium `146.0.7680.177.5` (free build) in `~/.cloakbrowser/`

The historical baseline of the first refactoring step is
[docs/refactor-baseline.md](refactor-baseline.md); the numbers below are compared against it.

> **Update (issue [#16](https://github.com/gazon1/10x-chat/issues/16))** — the check run of
> 2026-11-17 on branch `gazon1/hogfish` is the current one: 33 files / **329 tests**, everything
> green. What changed since the run above is listed in §7, and the P2 review fix in §9.

## 1. The check set

| # | Command | Result | Notes |
|---|---------|--------|-------|
| 1 | `bun install --frozen-lockfile` | **PASS** | 116 packages, lockfile unchanged; `postinstall` downloads the CloakBrowser build |
| 2 | `bun run typecheck` | **PASS** | `tsc --noEmit` |
| 3 | `bun run lint` | **PASS** | `biome check .` — Biome 2.4.4 (the version the lockfile pins) |
| 4 | `bun run test` | **PASS** | 33 files, **326 tests**, ~2.6 s |
| 5 | `bun run test:e2e` | **PASS** | 7 CLI scenarios; the 7 live provider scenarios are skipped (see §4) |
| 6 | `bun run build` | **PASS** | `tsc -p tsconfig.build.json` |

Compared with the baseline: 18 files / 153 tests → **33 files / 326 tests**. The lint caveat of
the baseline still holds — a plain `npm install` resolves Biome 2.6.8, which reports formatter
findings in Markdown; the lockfile-pinned 2.4.4 is clean. Use `bun install --frozen-lockfile`.

## 2. Clean install

`bun install --frozen-lockfile` in an empty checkout:

- installs the 116 packages of the lockfile without changing it,
- runs `postinstall` → `npx cloakbrowser install` → Chromium `146.0.7680.177.5` in `~/.cloakbrowser/`.

The browser build is downloaded per machine, not per package — a second install reuses it. The compiled CLI (`dist/`) is produced by `bun run build`; the published package carries it, so a consumer install compiles nothing.

## 3. The runtime decision

**CloakBrowser (patched Chromium) is the only supported runtime.** Camoufox/Firefox is a NO-GO
([#13](https://github.com/gazon1/10x-chat/issues/13) / [#5](https://github.com/gazon1/10x-chat/issues/5)),
measured in [docs/refactor-3-8-camoufox.md](refactor-3-8-camoufox.md) and
[docs/refactor-4-9-camoufox-production-readiness.md](refactor-4-9-camoufox-production-readiness.md):

- every provider selector was written against Chromium — a Firefox migration invalidates all of them,
- the stealth script fakes Chromium-only APIs and would have to be disabled for Firefox,
- Camoufox can neither carry SOCKS credentials nor serve a persistent context to the daemon.

Supported platform: **Linux x86_64/arm64** — the lock of the browser profiles and of the secrets store
is an abstract unix socket, and only the kernel of Linux provides one. The CloakBrowser build also
ships for macOS arm64/x86_64 and Windows x86_64, but the project does not run there. Node ≥ 22 (or
Bun ≥ 1.3).

The proxy contract is documented in [docs/config-contract.md](config-contract.md): HTTP(S) with and
without Basic auth, SOCKS5 without credentials; **SOCKS with credentials is rejected** — Chromium
would have to authenticate through the URL in its command line.

## 4. What is not covered, on purpose

| Item | State | Why |
|---|---|---|
| Live provider round trips | **skipped** | they need a browser and an authorized session; the CI job must not need secrets, so the scenarios are opt-in (`TEN_X_CHAT_E2E_PROVIDERS=1`, workflow `.github/workflows/e2e.yml`) |
| Grok, Perplexity in the readiness matrix | **unverified** | they are not part of the matrix of PR #14 (no authorized Grok session; Perplexity does not submit through its web UI in that environment) — no claim is made about them |
| DeepSeek | **new, unmeasured** | DeepSeek was added in [#7](https://github.com/gazon1/10x-chat/issues/7) and has an end-to-end scenario, but no authorized session was available for the run |
| Windows / macOS hosts | **not supported** | the checks ran on Linux, and the lock of the browser profiles and of the secrets store is an abstract unix socket — Linux only. The browser build supports those hosts; the project does not |
| npm registry name | **`@gazon1/10x-chat`** | **chosen** — the scoped name is free on the registry; the fork is published under it because the unscoped `10x-chat` belongs to the upstream project. The `npm publish` step of `.github/workflows/release.yml` is enabled and runs after the build of the package |
| `SPEC.md` | **historical** | it is the original design document and still describes the removed NotebookLM/Flow/Dreamina integrations and the per-provider profiles of the first version; the current contract lives in `README.md` and `docs/config-contract.md` |
| `docs/refactor-baseline.md`, `spike/` | **historical** | they describe the state before the refactoring, including the removed integrations |

## 5. The CI pipeline

`.github/workflows/ci.yml` — on every push and pull request:

```
checkout → bun install --frozen-lockfile → typecheck → lint → test → e2e (CLI flows) → build
```

The Bun version is pinned (`1.3.14`, the version of the lockfile) and Node 22 is installed for the
end-to-end scenarios, which start the CLI as a subprocess.

`.github/workflows/e2e.yml` — the live provider scenarios. They are started by hand
(`workflow_dispatch`), run on a runner that holds the logged-in profiles, and use no repository
secret.

`.github/workflows/release.yml` — on a `v*` tag: the same checks, then `npm publish`, then the
GitHub Release. The publish step runs under the scoped name `@gazon1/10x-chat`. See the table in
§4.

## 6. Reproducing the run

```bash
bun install --frozen-lockfile
bun run typecheck
bun run lint
bun run test
bun run test:e2e
bun run build

# the live provider scenarios (need a logged-in profile and a display)
TEN_X_CHAT_E2E_PROVIDERS=1 bun run test:e2e
```

## 7. Issue #16 — the bot challenge as a state of its own

The change of [#16](https://github.com/gazon1/10x-chat/issues/16) (branch `gazon1/hogfish`)
moves the headed/headless decision into the provider config, makes a bot challenge a state the
run recognizes, and lets the user solve it in the window that is already open.

| Item | State | Notes |
|---|---|---|
| Headed/headless per provider | **verified (unit)** | `tests/browser-mode.test.ts` — the decision comes from `ProviderConfig`, not from a provider name list; `--headed` / `--headless` override it |
| Challenge detection and the bounded wait | **verified (unit)** | `tests/failures.test.ts` — the challenge is detected, the user gets 120 s, the run then fails with an antibot error, and the page is not probed while the challenge is unsolved |
| Failure classification | **verified (unit)** | antibot / unauthorized / unavailable, with the kind kept through the `browserError` wrapper |
| Session reuse | **verified (unit)** | `tests/storage-state.test.ts` — a saved `storage-state.json` is found by the next run; a missing or broken file falls back |
| The challenge flow on a real site | **verified (live, 2026-11-17)** | see §8 — the challenge is detected, solved and the cleared session is saved; the shared state is written, the isolated profile is not |
| Perplexity in headed mode | **new behavior, unverified against the site** | Perplexity now runs headed (its config always claimed that, the hardcoded list overrode it). `--headless` still forces headless on a host without a display |
| The stealth init script | **unchanged** | it was already skipped for CloakBrowser (`getEngineName() !== 'cloakbrowser'`), so nothing had to be done for that item of the issue |

The check set of that change is the one in §1 — typecheck, lint, test (33 files / 329 tests),
e2e (7 CLI scenarios) and build all pass.

The review of the change added three more things:

| Item | State | Notes |
|---|---|---|
| One session check for every command | **verified (unit)** | `checkProviderSession()` — chat, research, image, delegate and history use it; `delegate` keeps `--no-login-check` as an opt-out, `history` reports the classified error per provider |
| The hint of a failure | **verified (unit)** | `printFailureHint()` — chat, research, delegate and history print the same hint for the same kind of failure |
| The temp file of a save | **verified (unit)** | every save gets its own temp file (`tempStatePath`), so parallel saves of one process (`chat --all`) cannot delete each other's file |
| The boundary of the profiles | **verified (unit)** | `BrowserSession.sharedState` — only a shared run writes `storage-state.json`; an isolated or named profile keeps its cookies in its own directory |
| The hint of every command | **verified (unit)** | `chat`, `research`, `image`, `delegate` and `history` print it; a parallel run keeps the kind of the failure in its result (`failedChatAllResult`) |

## 8. The live run of 2026-11-17 — the challenge and the boundary of the profiles

The unit tests of §7 were followed by a live run with authorized sessions (the cookies exported
from a real browser for ChatGPT and Claude). Two runs: the real sites, and a local Cloudflare-like
interstitial that clears itself after a few seconds — the same code path (detect → wait → save),
without a human in the loop.

### 8.1 The real sites

No interstitial was shown on the real sites — the exported cookies carried the clearance, and the
site issued a fresh one during the run. The runs show where those cookies end up.

| Run | Result |
|---|---|
| `claude.ai`, shared mode | the answer came (`OK`), and the shared state was rewritten after the run — 25 cookies, including the refreshed `cf_clearance` (`.claude.ai`) and the origin `https://claude.ai` |
| `claude.ai`, `--isolated-profile` | the answer came (`OK`), the clearance and the probe stayed in `profiles/claude/`, and the shared state was **byte-identical** before and after the run (`sha256` prefix `56a96c3b9fa76d5c`) |
| `chatgpt.com`, shared mode | the prompt was submitted, the site issued a fresh `cf_clearance` during the run, and it landed in the shared state (27 cookies) |
| `chatgpt.com`, `--isolated-profile` | the site issued `cf_clearance` inside the isolated profile (19 cookies in `profiles/chatgpt/`), and the shared state stayed **byte-identical** (`sha256` prefix `56a96c3b9fa76d5c`) — no `cf_clearance`, no probe cookie |

The challenge flow itself (detect → wait → save) was exercised by the local interstitial, in all
three phases:

| Run | Result |
|---|---|
| shared mode | the challenge was detected, the wait ran, the cleared session was saved — the clearance landed in the shared state |
| control: the old behaviour (a save that does not know about the profile) | the isolated cookies were written into the shared state — `LEAK in the old behaviour: true` |
| fixed: `checkProviderSession` with `sharedState: false` | the shared state stayed at the baseline — `LEAK in the fixed behaviour: false`; the clearance stayed in the isolated profile |

### 8.2 What the live run does not prove

| Item | State | Why |
|---|---|---|
| A challenge solved by a human | **not exercised** | the real sites did not show an interstitial — the exported cookies were accepted, so nobody had to solve one. The path is covered by the local interstitial and by `tests/failures.test.ts` |
| The answer of `chatgpt.com` | **not captured** | the prompt was sent, but the assistant answer did not arrive within the 5-minute timeout (`Timed out waiting for ChatGPT assistant response`). This is the response capture, not the session check — the run got past the check and submitted the prompt |
| The 21 cookies of the ChatGPT export | **partly expired** | four of them (`__oailb`, `__cflb`, `_uasid`, `_umsid`) were already past their expiry; the session cookies of the export do not survive the close of a persistent context, so the seeding of an isolated profile has to give them an expiry |
| A run from the sources with `tsx` | **broken, unrelated to the change** | `page.evaluate: ReferenceError: __name is not defined` — esbuild wraps the inner functions of a `page.evaluate` callback with `__name`, and the helper does not exist in the browser. The built CLI (`dist/`) is unaffected; the live runs above used `dist/` |

## 9. The P2 review fix — a challenge that appears during the login check

The review of issue #16 found a hole in the session check: the challenge was looked for **before**
the provider's own check and in the exception it throws, but not after it. The provider checks wait
up to 8 s, and a Cloudflare interstitial that appears during that wait is answered by most
providers (Claude, Gemini, Grok, DeepSeek, Perplexity) with "not logged in" — the run was then
classified as `unauthorized` and the user was told to log in instead of being asked to solve the
challenge in the window that was already open.

The fix is one extra question to the page in `checkSession()`: after `isLoggedIn()` answered
`false`, ask the page again whether a challenge is up. If it is, use the existing `recover()` —
one bounded attempt, the same 120 s in the open window — and check the session once more.

| Item | State | Notes |
|---|---|---|
| The re-check after `isLoggedIn()` | **verified (unit)** | `tests/failures.test.ts` — a challenge that appears during the provider's check is solved, the session is saved and the run continues (`isLoggedIn` is called twice, `saveSession` once) |
| The classification | **verified (unit)** | the same scenario without a window fails with `AntibotChallengeError` (antibot), not `UnauthorizedError` — the check happens before `classifySessionFailure()` |
| The behaviour in a real browser | **verified (live, 2026-11-17)** | the local interstitial of §8, triggered during the provider's check |

The live run (`build/diagnostics/challenge-during-check.ts`, the same local interstitial as §8 —
the provider's check navigates into the challenge and answers "not logged in"):

| Run | Result |
|---|---|
| the classification of a challenge page | `classifySessionFailure()` on the interstitial returns `unauthorized` — the kind the old code reported |
| the same scenario **without** the fix (the pre-fix `checkSession()`) | headed run → `UnauthorizedError` ("Not logged in to ChatGPT"), headless run → `UnauthorizedError` as well |
| the same scenario **with** the fix | headed run → the challenge is detected, solved, and the session is saved (the `cf_clearance` landed in the shared state); headless run → `AntibotChallengeError`, kind `antibot` |

So the regression is closed in both directions: the challenge is now solved instead of being
reported as a lost session, and a headless run reports the right kind instead of sending the user
after a login that would not help.

The check set after the fix: typecheck, lint, test (33 files / 329 tests), e2e (7 CLI scenarios) and
build all pass.

## 10. Issue #24 — the secrets store

The change of [#24](https://github.com/gazon1/10x-chat/issues/24) (branch
`add-secure-persistent-storage-for-provider-and-p`) adds the store for the credentials: the
**system keyring** (the Secret Service of the desktop session) with the file
`~/.10x-chat/secrets.json` (`0600` on Unix, the directory `0700`) as the fallback, atomic writes,
a CLI (`10x-chat secrets set|remove|list`) that never prints a value, and references in the
config file (`providerKeys`) instead of the values themselves.

The backend is chosen by `credentialStorage` in the config file (`auto` — the keyring when it is
reachable, the file otherwise; `keyring` — the keyring only; `file` — the file only); the
environment variable `TEN_X_CHAT_CREDENTIAL_STORAGE` overrides it. Only a **missing** config file
falls back to the default: a config file that cannot be read, cannot be parsed or does not hold an
object is an error — otherwise a broken config file would switch the run to `auto`, and `auto`
writes the secret to a plaintext file when the Secret Service is not reachable. The secrets of a
store that was created before the keyring existed are migrated on the first use: they are compared
with the keyring first — a secret that the keyring already holds is **never** overwritten, and a
secret with a different value refuses the migration — the missing ones are written into the keyring,
read back and compared; only then the file is deleted.

The store and the proxy settings of [#34](https://github.com/gazon1/10x-chat/pull/34) share one
store: the proxy itself is configured in the config file (the section `proxy`), its credentials
are the two secrets `proxy.username` and `proxy.password`. The file format of #34
(`{ "proxy": { "username": …, "password": … } }`) is still read.

The lock of the store protects the read-modify-write cycle. A file-based lock cannot hold it: a
lock whose owner died must be taken away, and that step has a race of its own — two processes can
read the same stale lock, and the second one removes the lock that the first one has already
created; both enter the critical section and one update is lost. Taking a dead lock over means
replacing the file at the path, and no filesystem offers "replace it, but only if the dead lock is
still there" as one step. The lock is therefore an **abstract unix socket** (Linux): the kernel
gives the name to exactly one process, takes it away when the holder dies, and leaves no file
behind.

| Item | State | Notes |
|---|---|---|
| Set / get / remove / list | **verified (unit)** | `tests/secrets.test.ts` — the secret survives a new store instance (a later invocation), a name is replaced, an unknown name is reported |
| The permissions | **verified (unit)** | the file is `0600`, the directory `0700` (Unix; the test skips itself on Windows and for root) — an already existing directory is tightened to `0700` as well; a directory that cannot be tightened **refuses the write** (`tests/secrets-directory.test.ts`) |
| The atomic write | **verified (unit)** | no temp file is left behind, the file is complete JSON |
| Parallel writes | **verified (unit)** | two writes at the same time keep both secrets — in one process and in two separate processes (the read-modify-write cycle is guarded by the lock of the store) |
| A broken store | **verified (unit)** | a corrupt file is an error that names the file — never an empty value |
| The redaction | **verified (unit)** | `redactSecretValues()` replaces every known value (the longest first); `config show` uses it |
| The missing reference | **verified (unit)** | the error names the secret and the config key (`providerKeys.chatgpt`), never a value |
| The CLI flow | **verified (e2e)** | `tests/e2e/cli.e2e.ts` — the value is written through stdin, `secrets list` prints the name only, `config show` prints no value, the secret is removed again |
| The proxy from the store | **verified (unit)** | `tests/secrets.test.ts` — the credentials of the config file come from the store (`proxy.username`, `proxy.password`), the environment is the fallback without a `proxy` section |
| The old file format | **verified (unit)** | `tests/secrets.test.ts` — the format of #34 is read and mapped onto the two secrets |
| The names of the secrets | **verified (unit)** | `tests/secrets.test.ts` — `__proto__` is stored and read back as a secret, an inherited property (`toString`, `constructor`) reads as missing |
| The validation of the names | **verified (unit)** | `assertSecretName()` runs on **every** operation of the store — `get`, `set`, `remove` of the file and of the keyring — and on the names that are read from `secrets.json`; a file with a name that is not allowed is a corrupt store (`tests/secrets.test.ts`, `tests/keyring.test.ts`); `__proto__`, `constructor` and `toString` stay ordinary secrets |
| The name before the value | **verified (unit)** | `tests/secrets-cli.test.ts` — the CLI checks the name **before** it asks for the value: a password that could not be stored is not typed in |
| The name and a line terminator | **verified (unit)** | every character of a name is checked, so a trailing `\n`, `\r` or `\r\n` is refused — by the input of the user and by the listing of the keyring (`tests/secrets.test.ts`, `tests/keyring.test.ts`) |
| A broken config file | **verified (unit + e2e)** | only a **missing** config file falls back to the default; a config file that cannot be read, cannot be parsed, carries an unknown key or an invalid setting is an error — also when `TEN_X_CHAT_CREDENTIAL_STORAGE` chooses the backend. `secrets set` refuses to run instead of switching the store to the plaintext file (`tests/secrets.test.ts`, `tests/e2e/cli.e2e.ts`) |
| The proxy in a real browser | **not verified against a site** | the daemon and the isolated browser read the same store, but no run against a real proxy was made |
| The permissions on Windows | **not applicable** | NTFS ignores the POSIX modes — the protection comes from the rights of the user profile (documented in [docs/secrets.md](secrets.md)) |
| The system keyring | **verified (unit)** | `tests/keyring.test.ts` — the store keeps the names and the values in the keyring, the entries of another program are ignored, an invalid name is refused (`src/keyring.ts` pins the entries to the Secret Service — the kernel keyring is not used: it cannot enumerate its entries) |
| The real Secret Service | **verified (unit, on a machine with a keyring)** | the same test writes, reads and deletes an entry in the Secret Service of the desktop session; the test skips itself on a machine without one (a CI runner) |
| The choice of the backend | **verified (unit)** | `auto` falls back to the file when the keyring is not reachable, `keyring` fails instead of falling back, `file` never touches the keyring; the environment overrides the config file; an unknown value is an error |
| The migration into the keyring | **verified (unit)** | the secrets of the file are written into the keyring, read back and compared — the file is deleted only then; a migration that cannot be verified keeps the file and fails |
| The migration and a secret that the keyring already holds | **verified (unit)** | the keyring is **never** overwritten by the file: a secret that the keyring does not hold is written, a secret with the same value is left alone, and a secret with a **different** value **refuses the migration** — every conflict is found before the first write, so the keyring stays untouched and the file is kept (`tests/keyring.test.ts`) |
| The migration under the lock | **verified (unit, two processes)** | the whole cycle — read the file, write the keyring, verify, delete — runs under the lock of the store; two processes that migrate at the same time write the secret **once** (the second one reads the file again inside the lock and finds it gone) — `tests/keyring.test.ts` runs two real processes |
| The privacy of the directory on a read | **verified (unit)** | the mode of the directory is enforced before every read as well: a directory that cannot be made private refuses the read (`tests/secrets-directory.test.ts`), a wide directory is tightened before the secrets are read (`tests/secrets.test.ts`) |
| The input of the value | **verified (unit + e2e)** | a piped stdin is read as is (only the trailing newline is dropped) — `tests/secrets-cli.test.ts` and `tests/e2e/cli.e2e.ts`; a terminal asks with the echo switched off (`@inquirer/prompts`, the same call is asserted in `tests/secrets-cli.test.ts`); in a real pty the value is stored and never appears in the output |
| The lock of the store | **verified (unit, three processes)** | the lock is an abstract unix socket: three processes that take the same lock enter their critical sections one after the other (`tests/lock.test.ts`); a lock of a living process is not taken, and the lock of a killed holder is free at once — the kernel gives the name back |
| A foreign connection to the lock | **verified (unit)** | the lock has no protocol: an incoming connection is destroyed at once, so a stranger that connects and keeps the connection open cannot delay the release of the lock (`tests/lock.test.ts` connects to the socket of the lock and proves that the release does not hang) |

The check set of that change: typecheck, lint, test (39 files / **431 tests**), e2e (10 CLI
scenarios, the 7 live provider scenarios skipped) and build — all pass.

## 11. Issue #25 — the API transport

The transport is chosen explicitly: `--transport browser|api`. The browser stays the
default, so an existing run is not changed by the flag. The API path
(`src/core/api-orchestrator.ts`) sends the prompt to the HTTP API of the provider with
the key of `providerKeys.<provider>` — no browser, no login check, no profile. The
session, the bundle and the response are the same files as in the browser run.

The credential comes from the secrets store, the proxy from the effective proxy
(`resolveEffectiveProxy()`) — the same one the browser uses. The key never reaches an
error message: the value of the secret is replaced with `***` in the message of a
failed run, and the headers of the request are never part of a message.

A capability that the transport does not have is rejected, never ignored: an
attachment in an API run fails the run instead of being dropped.

| Item | State | Notes |
|---|---|---|
| The default | **verified (unit)** | `resolveTransport()` returns `browser` without the flag — the browser path of `runChat()` is untouched (`tests/api-transport.test.ts`) |
| The selection | **verified (unit)** | `runChat({transport: 'api'})` runs the API path — no browser is started |
| A fake transport | **verified (unit)** | the transport is an interface (`ApiTransport`) and the HTTP client is an interface (`ApiHttpClient`) — the test answers without a network and without a browser (`tests/api-transport.test.ts`) |
| The credential | **verified (unit)** | the transport receives the key of the secrets store; the request of the DeepSeek transport carries it as `Authorization: Bearer …` (`tests/api-transport.test.ts`) |
| A missing key | **verified (unit)** | the failure is a `missing-credential` — it names the config key (`providerKeys.deepseek`), never a value |
| A non-2xx answer | **verified (unit)** | HTTP 401/403 is an `unauthorized`, HTTP 5xx an `unavailable`; the status is in the message |
| A timeout | **verified (unit)** | the message names the timeout and the session is marked `timeout` |
| A malformed answer | **verified (unit)** | a body that is not the expected JSON is an error, not an empty answer |
| The redaction | **verified (unit)** | a key in the message of a failed run becomes `***` |
| The proxy | **verified (unit)** | the client hands the effective proxy (server, user, password) to the request context of Playwright (`tests/api-http.test.ts`) |
| The DeepSeek transport | **verified (unit)** | the model, the prompt and the credential are sent; an answer that the API cut off is marked as truncated (`tests/api-transport.test.ts`) |
| A real API call | **not verified against a site** | no run against the API of a provider was made — a key of a provider is needed |
| The browser transport | **verified (unit + e2e)** | the browser path is unchanged: the whole test suite and the CLI scenarios pass as before |

The check set of that change: typecheck, lint, test (41 files / **451 tests**), e2e (10
CLI scenarios, the 7 live provider scenarios skipped) and build — all pass.
