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

```text
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

## 12. Issue #59 — the Orca-backed Issue-to-PR workflow

The change of [#59](https://github.com/gazon1/10x-chat/issues/59) (branch
`gazon1/add-orca-backed-issue-to-pr-development-workflow`) adds the opt-in command
`10x-chat workflow start|status|resume|stop|report`: a GitHub Issue becomes an isolated
Orca worktree, a coding agent works in it, the review pipeline of `src/pipeline/` looks at the
local change, the findings go back to the agent, and the loop repeats until the review approves
the change or the workflow blocks. The state of the workflow lives in
`~/.10x-chat/workflows/<id>/` and can be inspected and resumed.

The workflow never pushes, never opens a pull request, never merges and never deletes the
worktree — the change stays for a human, and the approval of the model is not the approval of a
human. Orca is not required for any other command.

| Item | State | Notes |
|---|---|---|
| The happy path | **verified (unit)** | `tests/workflow.test.ts` — Issue → worktree → agent → review → `completed` |
| The fix loop | **verified (unit)** | `REQUEST CHANGES` sends the findings to the agent, the second iteration approves, the workflow ends in `completed` |
| The gates | **verified (unit)** | the iteration limit, a HEAD that changed during the review, a changed Issue and a failed review step each end in `blocked` — never in a success |
| The agent | **verified (unit)** | a pending agent leaves the workflow resumable, a failed worker and an unknown worker outcome end in `blocked`, a second `start` does not start a second agent |
| The stop | **verified (unit)** | `stop` ends the workflow in `cancelled` — but only when the state of the worker confirms that it stopped; a worker that cannot be stopped leaves the workflow `blocked` with the reason |
| The lock of the workflow | **verified (unit)** | `start` and `resume` hold the lock of the workflow; two processes that resume the same workflow do not start two agents, and a run that finds a different state on the disk stops instead of overwriting it |
| The worktree | **verified (unit)** | a worktree of the same Issue that is already there is adopted, never created a second time; the ref of the worktree is the one the user named (`--base`) |
| The ownership of the worktree | **verified (unit)** | a worktree is adopted only when its ownership is proved — the branch of the workflow, the comment of the workflow, or an empty comment and a head that is still the base; the checkout of the user, a worktree of another branch, a worktree of another workflow, a worktree with uncommitted changes and a worktree with a foreign comment are refused with an actionable reason |
| The base ref | **verified (unit)** | the base is never guessed: several branches on `origin` and no `origin/HEAD` is a refusal to name `--base`; a single branch of `origin` is the only case where the base is known |
| One workflow per Issue | **verified (unit)** | a second workflow of the same Issue is refused while the first one is active |
| The success of the agent | **verified (unit)** | only a structural result counts (`outcome` of the Task, or a `worker_done` in the mail); a terminal state without a result is `unknown` and blocks the workflow |
| The checkpoints | **verified (unit)** | every iteration writes a checkpoint comment into the Orca worktree; the comment of the user is read first and kept, and a failed comment is an event of the run, not a broken workflow |
| The report of the workflow | **verified (unit)** | the report carries the worktree, the base ref, the full SHAs, the report of the agent, the remaining risks and the checks that were not available |
| The base of the review | **verified (unit)** | the change is compared with the commit the worktree started from, not with a ref that may have moved; a review that judged another base blocks the workflow |
| The mandatory steps of the review | **verified (unit)** | a review that did not run a mandatory step blocks the workflow — the absence of a failure is not the evidence of a judgment |
| The lost answer of the start command | **verified (unit)** | the Run is asked when the answer is lost: the worker that is already there is adopted and no second agent is started |
| The registration of the repository | **verified (unit)** | when the checkout is registered in Orca twice, the registration that is the checkout wins; the ambiguity without one is refused and never guessed |
| The privacy of the store | **verified (unit)** | the privacy is enforced before every read, a link in the store is refused and the record is opened without following a link |
| The preflight | **verified (unit)** | an unauthenticated `gh`, a checkout without a repository, a runtime that is not ready, a runtime that cannot orchestrate and a repository that is not registered in Orca each end the workflow before a worktree is created |
| The store | **verified (unit)** | `tests/workflow.test.ts` — the record survives a round trip, the directory is `0700` and the file `0600`, a foreign version is refused, `listWorkflows` finds the workflows |
| The transitions | **verified (unit)** | an illegal transition is refused; `blocked` and `cancelled` are terminal |
| The Orca adapter | **verified (unit)** | `tests/orca-client.test.ts` — a ready and a not-ready runtime, an answer that is not JSON, an `ok:false` answer, a non-zero exit code with a valid JSON answer, the repo list, the worktree list, the worker list, a missing dispatch id; the body is passed as an argument, never through a shell |
| The CLI | **verified (unit + e2e)** | `tests/workflow-cli.test.ts` and `tests/e2e/cli.e2e.ts` — the help lists the steps, an unknown workflow fails with exit 1, a stored workflow is shown by `status` and `report`, an Issue that is not a number is refused, the `stop` of a workflow that waits for its agent cancels it, the `resume` of a workflow that is not there fails and the `start` of a checkout that is not a repository is refused |
| The review of a local change | **verified (unit)** | `src/pipeline/` — the worktree branch is never pushed, so the review falls back to the diff of the local change (`target.local = true`) instead of the page of a pull request |
| A real Orca runtime | **not verified against a site** | the adapter was exercised against the real `orca` CLI of the machine during the development (status, repo list, worktree list, orchestration), but no workflow was run end to end against a real coding agent |
| A real GitHub Issue | **not verified against a site** | the Issue is read through `gh`; the flow was not run against a live Issue |

The check set of that change: typecheck, lint, knip, test (63 files / **1201 tests**), e2e (22
CLI scenarios, the 10 live provider scenarios skipped) and build — all pass.

## 13. The review of pull request #74

The pull request [#74](https://github.com/gazon1/10x-chat/pull/74) of the change of
[#59](https://github.com/gazon1/10x-chat/issues/59) was reviewed by the review pipeline of the
repository itself (`10x-chat review --pr 74 --issue 59 --backend chatgpt-use`, the provider is
ChatGPT). The first round returned **REQUEST CHANGES** with nine findings.

The findings that the verification confirmed were fixed in the change:

| Finding | The fix |
|---|---|
| `stopWorkflow` reported `cancelled` even when the agent could not be stopped | the state of the worker is checked; a worker that cannot be stopped leaves the workflow `blocked` with the reason |
| `--base` was ignored — the worktree was always created from the default branch | the ref is kept in the record of the workflow and applied when the worktree is created |
| two processes could work on the same workflow and start two agents | `start` and `resume` hold the lock of the workflow; every write of the record checks the state on the disk first |
| a non-zero exit code of `orca` with a valid JSON answer was taken for a result | the exit code is checked: a failed command is a failed command, whatever its answer says |
| a lost answer of Orca could lead to a second worktree of the same Issue | the worktrees of the repository are read first — an existing worktree is adopted |
| the preflight refusals and the interruptions of the loop were not covered by tests | thirteen tests were added: the five preflight refusals, the adoption of the worktree, the two concurrent processes, the lost update, the interruption between the review and the save, the non-zero exit code of the adapter and the reading of the worktree list |

The findings that the verification did not confirm are not claims of this document: they were the
reading of the reviewers, and they are checked by the tests above.

The check set of that round: typecheck, lint, knip, test (63 files / **1130 tests**), e2e (22 CLI
scenarios, the 10 live provider scenarios skipped) and build — all pass.

### The second round

The second round of the same pipeline returned **REQUEST CHANGES** again — five blocking findings
and three minor ones. The round was also **incomplete**: the step `review-tests` failed with a
malformed answer of the model, so the run had no verdict and the step `update-requirements` was
skipped. The findings of that round are the reading of the reviewers, not confirmed defects; they
were checked against the source and answered one by one:

| Finding of the second round | The answer |
|---|---|
| the adoption of a worktree did not check that it belongs to no other workflow | the ownership is now proved: the comment of the workflow, or an empty comment and a head that is still the base; a worktree of another workflow, the checkout of the user and a worktree with uncommitted changes are refused with an actionable reason |
| the success of the worker was read from the words of the state | the success is a structural result only (`outcome` of the Task, or a `worker_done` in the mail); a terminal state without a result is `unknown` and blocks the workflow |
| the default branch was guessed when `origin/HEAD` was missing | several branches on `origin` and no `origin/HEAD` is a refusal to name `--base`; a single branch of `origin` is the only case where the base is known |
| the report did not carry the report of the agent | the report carries it, together with the worktree, the base ref, the full SHAs, the remaining risks and the checks that were not available |
| the write of the record was a read and a write, not an atomic compare-and-set | the write happens under the lock of the state, and it compares the state on the disk with the state the process holds |
| the adoption was by name and branch, without a proof of the ownership | the proof of the ownership is the base of the adoption, see the first row |
| the report had no summary of the implementation, no verification commands and no remaining risks | the report has all of them |
| the comment of the worktree was never written, and the comment of the user was never read before the update | every iteration writes a checkpoint comment into the Orca worktree: the comment of the user is read first and kept, and a failed comment is an event of the run, not a broken workflow |

The check set of that round: typecheck, lint, knip, test (63 files / **1141 tests**), e2e (22 CLI
scenarios, the 10 live provider scenarios skipped) and build — all pass.

### The third round

The third round of the same pipeline ran completely — every step of it passed — and returned
**REQUEST CHANGES** with eight findings: six of the severity MAJOR and two MINOR. The verification
confirmed none of them: they are the reading of the reviewers, and each of them was answered
against the source:

| Finding of the third round | The answer |
|---|---|
| the review compared the change with the ref of the base, which may have moved | the review is compared with the commit the worktree started from (`worktree.baseSha`), and the workflow blocks when the review judged another base |
| the adoption of a worktree did not check the branch | the branch is part of the proof of the ownership: a worktree of another branch is refused, and a worktree of the name of the Issue on another branch is refused too |
| the comparison of the record was the state alone, so two processes in the same state could both write | the record carries the revision of its write: the comparison is the revision and the state, and a run that finds a record another process wrote stops instead of overwriting it |
| the registration of the repository in Orca was the first of the list | the registration that is the checkout of the user wins; when there is none, the ambiguity is refused and never guessed |
| the store of the workflows was not checked before a read | the privacy is enforced before every read, a link in the store is refused, and the file is opened without following a link |
| there was no test for a lost answer of the start command of the worker | the Run is asked when the answer is lost: the worker that is already there is adopted, and the test says that no second agent is started |
| the review was accepted when a mandatory step was missing | every mandatory step must have run: a step that is missing blocks the workflow — the absence of a failure is not the evidence of a judgment |
| the CLI tests did not run `start`, `resume` and `stop` | the command of the workflow is driven end to end now: the Issue that is not a number, the checkout that is not a repository, the `stop` of a workflow that waits for its agent and the `resume` of a workflow that is not there |

The check set of that round: typecheck, lint, knip, test (63 files / **1154 tests**), e2e (22 CLI
scenarios, the 10 live provider scenarios skipped) and build — all pass.

### The fourth round

The fourth round of the same pipeline ran completely — every step of it passed — and returned
**REQUEST CHANGES** with four findings of the severity BLOCKING or MAJOR and two MINOR ones. The
verification confirmed one of them; the rest are the reading of the reviewers and were checked
against the source one by one.

| Finding of the fourth round | The answer |
|---|---|
| the outcome of the worker was read from the words of its state, so a worker that only looks successful was accepted | the fallback on the state is gone: the success is the structural result only (`outcome` of the Task, or a `worker_done` in the mail). A terminal state without a result is `unknown` and blocks the workflow — the confirmation of the verification |
| the worktree was never checked for cleanliness before the review, so a change that was not committed was not reviewed | the workflow asks the git for the state of the worktree before the review and blocks the workflow when the tree is not clean — the review reads the committed state only |
| `stop` could not reach a worker that was starting at that moment, because the Dispatch of the record was not written yet | `stop` does not trust the record alone: it collects the workers of the Run of the workflow and stops every one of them; a worker that cannot be stopped leaves the workflow `blocked` |
| the corrections were sent as a message into the finished Dispatch, so the next iteration read the result of the previous worker | every iteration is a supervised work item of its own: a new Dispatch in the same Run, with a new brief. The verb `send` of the adapter is gone — the adapter speaks only the language the workflow needs |
| the tests replaced the reading of the Issue and the check of the authentication, so the real integration was never exercised | the test reads the Issue through the `gh` CLI of the machine, with the real environment of the process |
| the tests of the adapter did not cover the protocol of the worktree, the Run and the stop of a worker | the adapter has protocol tests of its own: the worktree, the Run, the start and the stop of a worker, including the answers that carry no name |

The check set of that round: typecheck, lint, knip, test (63 files / **1163 tests**), e2e (22 CLI
scenarios, the 10 live provider scenarios skipped) and build — all pass.

### The fifth round

The fifth round of the same pipeline was **incomplete**: the steps
`review-architecture` and `verify-findings` failed with a timeout of the
backend — the ChatGPT page was replaced while the turn was still running, and
the answer never came. The run had a verdict of **REQUEST CHANGES** with two
findings of the severity MAJOR, and the verification of the findings could not
settle them. The findings were checked against the source instead, and both of
them were real:

| Finding of the fifth round | The answer |
|---|---|
| the Issue was read only after the review, so a requirement that changed while the agent worked was not noticed until the change was judged | the Issue is read while the agent works: a hash that is not the one the workflow started with stops the workflow with `blocked` and the reason — the change is never judged against a version of the Issue that the workflow does not know |
| the gate of the completion did not ask for the step that renders the report of the review, so a review that approved the change without writing its report could complete the workflow | the step `render-report` is one of the mandatory steps of the review, and the fixture of the tests carries it too — a review that never wrote its report does not complete the workflow |

The check set of that round: typecheck, lint, knip, test (63 files / **1165
tests**), e2e (22 CLI scenarios, the 10 live provider scenarios skipped) and
build — all pass.

### The sixth round

The sixth round of the same pipeline ran completely — every step of it passed —
and returned **REQUEST CHANGES** with four findings of the severity MAJOR and
three MINOR ones. The verification confirmed none of them: they are the reading
of the reviewers, and each of them was checked against the source.

| Finding of the sixth round | The answer |
|---|---|
| `stop` did not take the lock of the run, so a `resume` could start an agent between the reading of the workers and the cancellation of the workflow | the state `stopping` closes the window: the stop writes it down before it looks for the workers, and the process that starts an agent reads the state of the record on the disk before the start and after it — an agent that was started in a workflow that is on its way out is stopped again |
| the worktree that Orca had just created was trusted: its path, its repository and its branch were never checked | the answer of Orca is not the proof of the worktree: the common directory of the git of the worktree must be the git of the repository of the Issue, the path must not be the checkout of the user, and the branch must be the branch of the Issue — a worktree that does not pass the check is refused before the agent may work in it |
| a `stop` between the creation of the Run and the start of the worker could cancel the workflow and still leave an agent in the worktree | the same mark closes this window: the state of the record is read before the agent starts, and the worker that was started all the same is stopped again |
| `resume` chose the backend and the model on its own, so the review of the next iteration could be another one than the review of the previous iteration | the record carries the name of the backend and the model: `resume` restores them, the command line still wins, and a backend of the record that is not available is a refusal and not a silent fallback |
| the test of the brief of the agent checked the title of the Issue and one rule, not the whole content of the brief | the brief is checked now: the text of the Issue with its acceptance criteria, the path and the branch of the worktree, the instructions of the repository and the checks it defines, and the rule that the worktree stays for a human |
| the lost answer of the creation of the Run was not covered: a Run that Orca created all the same would be left behind | the Runs are asked before anything else: the Run of the objective of the workflow is adopted, and a second Run would be a second home of the mailbox. The adapter speaks the verb `run-list` now |
| the tests of the command line never ran a successful `start` or `resume` | the command is driven end to end now: `start` reads the Issue, creates the worktree and starts the agent (with the Orca and the `gh` of the test and a real worktree of the repository), `resume` continues a workflow, and the translation of the options of the command line is a function of its own |

The check set of that round: typecheck, lint, knip, test (63 files / **1180
tests**), e2e (22 CLI scenarios, the 10 live provider scenarios skipped) and
build — all pass.

### The seventh round

The seventh round of the same pipeline ran completely — every step of it passed —
and returned **REQUEST CHANGES** with five findings of the severity MAJOR and
two MINOR ones. The verification settled five of them: four MAJOR and one MINOR.
The two that stayed unsettled are the reading of the reviewers, and each of them
was checked against the source.

| Finding of the seventh round | The answer |
|---|---|
| every failure of the read of the record was treated as an absent record, so a broken record, a record behind a link and a record that the owner may not read were answered with a fresh write | a record that is not there and a record that cannot be read are two failures now: the first one is `WorkflowNotFoundError`, the second one is refused by every write — the evidence of the run is never replaced by a fresh one, and `saveWorkflow` refuses the links of the store before it writes |
| the recovery of a lost answer of the start command adopted the worker without asking whether the workflow was on its way out — a stop in that window saw no worker and cancelled the workflow | the recovery of a lost answer asks the state of the record on the disk like the answer that came does: a worker of a lost answer in a workflow that is being stopped is stopped again |
| the default base of the workflow named a local branch that the checkout may not have — a detached checkout with only `refs/remotes/origin/main` failed before Orca was asked | the base is resolved like the pipeline resolves it: when the local branch is absent, the ref of origin is used (`origin/main`), and a worktree is created from the commit it names |
| the registration of the repository in Orca was matched by `owner/name` alone, so a registration of another host was accepted | the host of the remote is a part of the identity of the repository: a registration whose host is not the host of the checkout is refused, and the agent never works in a repository of another host |
| a worktree whose branch could not be read was accepted, because an empty branch was not a difference | an empty branch is not the branch of the Issue: the worktree is refused, and the agent never works in a checkout whose branch cannot be proved |
| the test of the command line resumed a record that had already ended, so the resume of an interrupted workflow was never driven through the command | the command is driven end to end for the resume too: a real worktree of the repository, the Orca and the `gh` of the test, the agent of the interrupted run adopted and no second agent started |
| the recovery of a lost answer of the creation of the Run took the first Run of the listing that carried the objective | the objective is not a unique name: two Runs of Orca that carry it are an ambiguity that is refused, never guessed |

The check set of that round: typecheck, lint, knip, test (63 files / **1187
tests**), e2e (22 CLI scenarios, the 10 live provider scenarios skipped) and
build — all pass.

A self-review of the same round found one more place where the rule of the
broken record was not carried through: the listing of the workflows swallowed
the failure of the read, so a broken record of the Issue looked like no record
at all and a second workflow of the Issue was started next to it. The read of
the record is now refused everywhere, and a broken record of the Issue stops
the second workflow with the reason instead of letting a second agent into the
same worktree. The check set after it: typecheck, lint, knip, test (63 files /
**1188 tests**), e2e and build — all pass.

### The eighth round

The eighth round of the same pipeline ran completely — every step of it passed —
and returned **REQUEST CHANGES** with nine findings: five of the severity MAJOR
and four MINOR ones. The verification settled the five MAJOR ones: they were
real. The four that stayed unsettled are the reading of the reviewers, and each
of them was checked against the source — two of them were real as well and are
fixed in the same round.

| Finding of the eighth round | The answer |
|---|---|
| a worktree that was adopted was not checked for changes that are not committed, so the agent carried the work of somebody else into the change of the Issue | the check of the cleanliness is part of the proof of the ownership now: a worktree with uncommitted changes is refused with the paths that are dirty, and the agent is never started in a dirty checkout |
| the commit the worktree started at was not compared with the base the workflow asked for, so the review compared the change with another commit | the commit of the worktree is read and compared with the base: a worktree at another commit is refused, and the base of the review is the commit that was proved |
| a worker that had already finished was ignored when the workflow was recovered, so a second agent was started in the same worktree | a terminal worker is adopted too: the agent of an interrupted start may have ended before its Dispatch was written down, and its result is read by the wait — a result that nobody confirmed blocks the workflow instead of starting a second agent |
| the approval of the review was bound to the version of the Issue that the workflow remembered, and not to the version that the review really read | the record of the review carries the hash of the requirements of the run: the approval is bound to the version that was read |
| the preflight checked the prefixes `orchestration.` and `worktree.`, which say nothing about the operations the workflow needs | the check is a contract and not a prefix: the aggregate contract `orchestration.contract.v1`, or every verb of it, and the family of the worktrees. The workflow refuses to start before it creates anything |
| `resume` did not compare the worktree of the record with the worktrees of Orca | the worktree of the record is compared with the runtime once per run: a worktree that is not there anymore, and a worktree that is on another branch, are a refusal |
| there was no test that the agent receives the instructions of the repository — the brief only said "read AGENTS.md" | the brief carries the instructions of the repository now (`AGENTS.md` of the worktree), and the brief of the corrections carries them too |
| there was no test of a concurrent start | two processes that start the same Issue at the same time: one of them is refused, and only one agent is started |
| there were no tests of the recovery of the creation of the Run | the Run of the objective is adopted, no Run is an error, two Runs are an ambiguity that is refused, and a listing of the Runs that cannot be read is the error of the lost answer |

The check set of that round: typecheck, lint, knip, test (63 files / **1201
tests**), e2e (22 CLI scenarios, the 10 live provider scenarios skipped) and
build — all pass.

### The check set of the CI of the eighth round

The run of the eighth round on the CI failed on one test — the one that reads
the Issue through the `gh` CLI of the machine. The CLI of the CI is installed
and not authenticated, and the test replaced it with a CLI of its own through
the PATH of the process: the child processes of the test did not inherit that
PATH — the PATH of the process and the PATH of its environment are not the same
thing — so the real CLI answered and the test failed.

The environment of the `gh` CLI is a seam now (`ghEnv` of the context of the
workflow, `runGh` of `src/pipeline/requirements.ts`): the CLI of the PATH that
the workflow was given is the one that answers. The test names the PATH of its
own CLI, and it does not depend on the machine it runs on any more. The
environment of the process is also changed in place in the tests of the
workflow: a copy of it is not the environment that the child processes
inherit.

### The ninth round

The ninth round of the same pipeline ran completely — every step of it passed —
and returned **REQUEST CHANGES** with seven findings: five of the severity MAJOR
and two MINOR ones. The verification settled six of them: four MAJOR and both
MINOR ones were real. The one that stayed unsettled is the reading of the
reviewers, and it was checked against the source — it was real as well and is
fixed in the same round.

| Finding of the ninth round | The answer |
|---|---|
| the preflight accepted any capability of the family `worktree.*`, so a runtime that can create a worktree but cannot list or comment in one was accepted | the verbs of the worktrees are required one by one: a runtime that names one of them (`worktree.list`, `worktree.create`, `worktree.comment`) must name all of them, and a runtime that names none of them — the real Orca names none — is judged by the family `worktree.*`. The family alone still says nothing about the operations the workflow needs |
| `verifyWorktree` accepted a worktree by its id alone, without comparing the path, and skipped the branch when Orca did not name it | the identity of the worktree is proved and not assumed: the id, the path, the branch of Orca (a branch that is not named is a refusal, not a pass) and the repository of the git (`commonDir` and `repository` against the repository of the record) |
| `listWorkflows` swallowed every error of the read of the directory and answered an empty store, so a store that cannot be read looked like a store without workflows and a second workflow of the same Issue was allowed | a directory that does not exist is an empty store, every other failure is an error: the workflow refuses to start when the workflows of the store cannot be listed |
| the instructions of the repository were read into an empty brief when `AGENTS.md` could not be read | an `AGENTS.md` that does not exist is no instructions, and an `AGENTS.md` that cannot be read is a refusal: the agent never starts with a brief that silently lost the rules of the repository |
| the file of the events was appended without the protections of the store: a link in the store was followed and the mode of an existing file was not set | the file of the events is a file of the store now: the directory is made private before the write, a link is refused, the file is opened without following a link (`O_NOFOLLOW`) and it keeps the mode `0600` |
| the verdict of the review was not compared with the version of the requirements the workflow started with, so an approval of another version of the Issue completed the workflow | the review carries the hash of the requirements it really read (`review.requirementsHash`), and the settlement refuses the run when that hash is empty or differs from the hash of the Issue the workflow started with — an approval of another version of the requirements blocks the workflow |

The check set of that round: typecheck, lint, knip, test (63 files / **1209
tests**), e2e (22 CLI scenarios, the 10 live provider scenarios skipped) and
build — all pass.

### The tenth round

The tenth round of the same pipeline ran completely — every step of it passed —
and returned **REQUEST CHANGES** with five findings: four of the severity MAJOR
and one MINOR. The verification settled four of them: three MAJOR and the MINOR
one were real. The one that stayed unsettled is the reading of the reviewers, and
it was checked against the source — it was real as well and is fixed in the same
round.

| Finding of the tenth round | The answer |
|---|---|
| a worktree that was already there was adopted when its comment was empty — an empty comment is not a proof that the worktree belongs to this workflow | the ownership is a proof now: the worktree carries the mark of the workflow (the workflow writes it when it creates the worktree), or the record of the workflow already knows the worktree, or Orca links the worktree to the Issue of the workflow (`linkedIssue`) and it carries the name and the branch of the Issue. A worktree without such a proof is refused, and a worktree of a run that died is taken over only when the record of that run is a run of the same Issue |
| the resume compared the common directory of the worktree with nothing — a worktree of another repository passed the check | the common directory of the worktree is compared with the common directory of the repository that is registered in Orca: two checkouts of one repository share it, and a checkout of another repository does not |
| the identity of the repository of the worktree was allowed to be empty, so an unreadable identity passed the check | an identity that cannot be read is a refusal: the workflow cannot prove that the agent works in the repository of the Issue |
| two workers of the Run of the workflow were candidates at once — the first one was taken and the second one was ignored | two candidates are an ambiguity that is refused: the workflow does not guess which one is its own and starts no agent next to them. The same rule holds for the answer of a lost start command |
| there were no tests of the partial support of the worktree capabilities | the tests name the verbs now: a runtime that names two of the three verbs of the worktrees is refused with the name of the missing one, and a runtime that names all of them creates the worktree |

The check set of that round: typecheck, lint, knip, test (63 files / **1218
tests**), e2e (22 CLI scenarios, the 10 live provider scenarios skipped) and
build — all pass.

### The eleventh round

The eleventh round of the same pipeline was **incomplete**: the step
`review-correctness` failed with a timeout of the backend — the page of
ChatGPT was replaced while the first turn was still running, and the run has no
conversation to reattach to. The round still returned **REQUEST CHANGES**, with
two findings: one of the severity MAJOR and one MINOR. Neither of them was
confirmed by the verification — they are the reading of the reviewers — and both
were checked against the source and fixed in the same round.

| Finding of the eleventh round | The answer |
|---|---|
| the checks that tell the checkout of the user from a worktree of the workflow compared the paths lexically (`path.resolve`), so a symbolic link to the checkout of the user could pass the comparison, while `commonDir` confirms only that both paths belong to one repository | the identity of a checkout is the directory it really is: the git of the checkout resolves the symbolic links (`rev-parse --show-toplevel`), and the main worktree of the repository (`git worktree list`) is refused as well. The check is applied where a worktree is created, where one is adopted and on every run of the record |
| the workflow tests proved only that an unauthenticated `gh` CLI prevents the creation of a worktree — the failures of the reading of the Issue itself were not covered | the failures of the reading of the Issue are covered now: the CLI that answers with a failure, with no JSON, with another Issue and with an Issue without a body stops the workflow before it creates a worktree, a Run or an agent |

The check set of that round: typecheck, lint, knip, test (63 files / **1224
tests**), e2e (22 CLI scenarios, the 10 live provider scenarios skipped) and
build — all pass.

### The twelfth round

The twelfth round of the same pipeline ran completely — every step of it passed —
and returned **REQUEST CHANGES** with five findings: four of the severity MAJOR
and one MINOR. The verification settled three of them: two MAJOR were real, and
two MAJOR stayed unsettled — they are the reading of the reviewers. All of them
were checked against the source and fixed in the same round; the MINOR one was
rejected, and the source shows why.

| Finding of the twelfth round | The answer |
|---|---|
| a message of the mailbox without a Dispatch was accepted as the result of the current worker — the Run is shared between the iterations, so a message of another iteration could close the wrong one | the message belongs to the Dispatch that names it: a message with a Dispatch is accepted only when it is the Dispatch of the worker, a message without one belongs to the worker that still works, and a Run with several workers leaves it ambiguous — an ambiguous message never settles an iteration, the workflow reconciles against the state of its own worker |
| the stop of a workflow returned immediately for every terminal state — a workflow that was blocked could keep its agent in the worktree | the stop reaches a workflow that is over: the workers of its Run are stopped all the same, the state of the workflow does not move, and the reason of the stop is written into the history of the run and into the reason of the block. A worker that cannot be stopped leaves the workflow `blocked` with the reason |
| the preflight accepted any capability of the family `worktree.*` as a proof of the worktree lifecycle | the family has to promise the **creation** of a worktree (`worktree.create…`) — a family that promises nothing about the creation cannot create one — and the operations are not taken from the names at all: the workflow reads the worktrees of the repository before it creates anything, and a runtime whose worktrees cannot be read is a refusal, not a promise |
| the workflow tests replaced the review pipeline with a fake, so the real integration between the workflow and the local target of the review was never exercised | the integration is covered now: a temporary git repository with a real worktree, a real `runReviewPipeline`, a fake `gh` and a fake backend — the test asserts that the change of the worktree is collected, that the diff of the change reaches the backend and that the report of the run names the changed files |
| the `resume --wait` was silently ignored | rejected: the option is parsed, validated and passed into the context of the resume (`waitTimeoutMs`), and the source of the command shows it |

The check set of that round: typecheck, lint, knip, test (63 files / **1232
tests**), e2e (22 CLI scenarios, the 10 live provider scenarios skipped) and
build — all pass.

### The thirteenth round

The thirteenth round of the same pipeline ran completely — every step of it
passed — and returned **REQUEST CHANGES** with three findings: two of the
severity MAJOR and one MINOR. The verification settled two of them: the MINOR
one and the MAJOR one of the tests were real, and the MAJOR one of the
adoption stayed unsettled — it is the reading of the reviewers. Both were
checked against the source and fixed in the same round.

| Finding of the thirteenth round | The answer |
|---|---|
| the workflow adopted the worker of the Run without checking the checkout it works in — the Run is shared between the iterations, and a worker of another checkout would be judged on the change of the worktree of the workflow | the identity of the worker is proved: the checkout it names must be the worktree of the workflow — the same directory it really is, the symbolic links of it resolved — and the branch must be the branch of the workflow. A worker that the workflow **found** and that names neither its checkout nor its branch cannot be identified at all: the workflow does not adopt it and blocks instead of guessing. A worker of an **own** start names the worktree in the command itself, so it only has to be free of a contradiction |
| the history of a workflow was read without the privacy of the store: a history that was restored with wide permissions stayed readable for everybody, and the read followed a link | the privacy is enforced on the way in, not only on the way out: the read makes the file private again (`0600`), and the file is opened without following a link (`O_NOFOLLOW`), like the record of the workflow |
| the test of the history proved the mode of the file after the write, and not after the read — a regression that removed the privacy of the read would pass it | the scenario of the read is covered now: a history whose mode was widened to `0644` becomes private again after `readEvents` |

The check set of that round: typecheck, lint, knip, test (63 files / **1236
tests**), e2e (22 CLI scenarios, the 10 live provider scenarios skipped) and
build — all pass.
