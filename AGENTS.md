# AGENTS.md — 10x-chat

> Chat with web AI agents from the terminal via Playwright browser automation.

## Quick Orientation

| Path | What |
|------|------|
| `src/providers/` | One file per AI provider (chatgpt, gemini, claude, grok, perplexity, deepseek) |
| `src/providers/registry.ts` | Provider name → config + actions mapping |
| `src/providers/submit.ts` | Shared prompt submission helper (composer → type → send) |
| `src/core/orchestrator.ts` | Single + parallel chat execution (`runChat`, `runChatAll`) |
| `src/core/api-orchestrator.ts` | The same chat through the HTTP API of a provider (`runApiChat`) |
| `src/backend/contract.ts` | The provider-independent backend contract (`AiBackend`: `ask`/`status`/`resume`/`cancel`) |
| `src/backend/fake.ts` | The deterministic backend of the tests (`createFakeBackend`) |
| `src/backend/registry.ts` | Backend name → backend mapping, the injection point of the contract |
| `src/transport/http.ts` | The shared HTTP client of the API transports (honors the effective proxy) |
| `src/providers/api/` | The API transports of the providers (`registry.ts` maps a provider to its transport) |
| `src/core/failures.ts` | Bot-challenge detection, failure kinds (`antibot`/`unauthorized`/`unavailable`) |
| `src/core/polling.ts` | `pollUntilStable` — waits for streamed response to stop changing |
| `src/core/conversations.ts` | Conversation reuse per git repo + branch: URL extraction, git context, `~/.10x-chat/conversations.json` |
| `src/core/bundle.ts` | Assembles prompt + file context into a markdown bundle |
| `src/browser/manager.ts` | Browser launch: shared (daemon), shared-persistent (login), isolated modes |
| `src/browser/daemon.ts` | Long-running Chromium server for cross-invocation reuse |
| `src/browser/state.ts` | `saveStorageState` / `loadStorageState` for cookie persistence |
| `src/cli/` | Commander subcommands: chat, login, status, config, secrets, skill, migrate |
| `src/types.ts` | Core types: `ProviderName`, `ProviderConfig`, `ProviderActions`, `ChatOptions` |
| `src/secrets.ts` | The secrets store: named values in the system keyring or in the file (`0600` on Unix) |
| `src/keyring.ts` | The adapter of the system keyring (Linux: the Secret Service) |
| `src/core/credentials.ts` | The proxy and the provider keys of this run (store first, environment second) |
| `src/session/` | Session storage (metadata, bundles, responses) |
| `tests/` | Vitest unit tests |
| `tests/e2e/` | End-to-end scenarios: CLI flows (always) and live provider round trips (opt-in) |
| `docs/verification.md` | The result of the last full check run and the documented exceptions |
| `docs/secrets.md` | The secrets store: CLI, permissions, backup, rotation |
| `docs/usage.md` | Practical setup: proxy, models, headless/Xvfb, conversation reuse |

## Architecture

```text
CLI (Commander)
  └── orchestrator.ts
        ├── bundle.ts          ← assemble prompt + files
        ├── browser/manager.ts ← launch browser (shared daemon or persistent)
        ├── provider.isLoggedIn()
        ├── provider.submitPrompt()
        └── provider.captureResponse() ← pollUntilStable()
```

## Adding a New Provider

1. Create `src/providers/<name>.ts` with `ProviderConfig` + `ProviderActions`
2. Add the name to `ProviderName` union in `src/types.ts`
3. Register in `src/providers/registry.ts`
4. Export from `src/providers/index.ts`
5. If Cloudflare-protected: set `botProtected: true` in config; if the provider only
   works in a visible browser: set `requiresHeaded: true`

Provider actions implement:

- `isLoggedIn(page)` — detect auth state
- `selectModel?(page, model)` — optional; switch model/mode via the provider's UI picker before sending
- `submitPrompt(page, prompt)` — type and send
- `captureResponse(page, opts)` — poll until stable, return text + markdown

## Key Patterns

- **requiresHeaded**: A provider that only works in a visible browser runs headed — the
  decision comes from `ProviderConfig`, not from a list of provider names
- **botProtected**: A Cloudflare challenge is a state of its own (`src/core/failures.ts`),
  not "not logged in": the user is asked to solve it in the window that is already open
  (one attempt, 120 s), and the clearance cookie is saved for the next run
- **One session check**: `checkProviderSession()` — chat, research, image, delegate and
  history all go through it, so a challenge is solved and the session is saved everywhere;
  only a shared run writes `storage-state.json` (`BrowserSession.sharedState`) — an isolated
  or named profile keeps its cookies in its own directory
- **A challenge that appears during the check**: `checkSession()` asks the page for a challenge
  again after `isLoggedIn()` answered "not logged in" — most providers report a late interstitial
  as a lost session, and it must stay an antibot failure, not an `unauthorized` one
- **Failure kinds**: `antibot` / `unauthorized` / `unavailable` — `failureKind()` and
  `failureHint()` turn them into a message the user can act on; `printFailureHint()` prints
  it in every command
- **Shared profile mode** (default): All providers share `~/.10x-chat/profiles/default/storage-state.json`
- **Browser daemon**: `chromium.launchServer` persisted to disk for cross-CLI reuse
- **Tab ref-counting**: Multiple CLI invocations share one Chromium; last tab stops the daemon
- **Force-click**: Some providers need `click({ force: true })` to bypass overlay interception
- **Secrets**: credentials live in the secrets store — the system keyring (the Secret Service of the
  desktop session) or, as a fallback, `~/.10x-chat/secrets.json` (`0600` on Unix), a map of names
  to values. The config file refers to a secret by name (`providerKeys`); the credentials of the
  proxy are the two secrets `proxy.username` and `proxy.password`. The value is never an
  argument of a command, never in a log and never in the config file — see `docs/secrets.md`
- **The backend of the secrets store**: `credentialStorage` in the config file (`auto` — the
  keyring when it is reachable, the file otherwise; `keyring` — the keyring only; `file` — the
  file only), the environment variable `TEN_X_CHAT_CREDENTIAL_STORAGE` overrides it. Only a
  **missing** config file falls back to the default: a config file that cannot be read or parsed
  is an error, so a broken file never switches the run to the plaintext file behind the back of
  the user. The secrets of an old file store are migrated into the keyring on the first use —
  compared with the keyring first, written, read back, compared, and only then the file is
  deleted. The keyring is never overwritten by the file: a secret with another value in the
  keyring refuses the migration
- **The lock of the secrets store**: the read-modify-write cycle and the whole migration into the
  keyring (read the file, write the keyring, verify, delete the file) run under the lock of the
  store — the file is read again inside the lock
- **The lock itself** (`src/core/lock.ts`): an **abstract unix socket** (Linux only) — the kernel
  gives the name to exactly one process and takes it away when the holder dies. A file-based lock
  cannot hold it: taking a dead lock over means replacing the file at the path, and there is no
  atomic "replace it, but only if the dead lock is still there" — two processes would both enter
  the critical section. The lock has no protocol: an incoming connection is destroyed at once, so
  a stranger cannot delay the release of the lock
- **The privacy of the store**: the mode of the directory (`0700`) is enforced before every read
  and every write — a directory that cannot be made private refuses the read and the write
- **The input of a secret**: a piped stdin is read as is, a terminal asks with the echo switched
  off (`@inquirer/prompts`, `password()`) — no patching of the private fields of `readline`
- **Conversation reuse**: `runChat` opens the conversation stored for the current git repo + branch + provider (`~/.10x-chat/conversations.json`), or a new chat when the provider no longer serves it. The repository is identified by its origin URL, so worktrees and clones of one repo share the chat; without a remote the git common dir is used. `--new-chat` forces a new conversation. Every provider baselines its existing turns in `submitPrompt` so the capture does not return the previous answer
- **Model selection**: Orchestrator calls `selectModel()` before `submitPrompt()` if the provider implements it. Model resolved from `--model` flag → `defaultModel` of the config file → `provider.config.defaultModel` (chat commands only). Gemini supports modes: Fast, Thinking (default), Pro. ChatGPT's current UI has no picker; `selectModel` probes briefly and keeps the current model
- **The transport**: `--transport browser|api` (the browser is the default). The API transport (`src/core/api-orchestrator.ts`) sends the prompt to the HTTP API of the provider with the key of `providerKeys.<provider>` — no browser, no login check, no profile. A capability the transport does not have (attachments, streaming, cancellation) is **rejected**, never ignored. The key never reaches an error message (`redactSecretValues`) — see `docs/transports.md`
- **The backend contract**: `src/backend/contract.ts` is the provider-independent seam — `ask`, `status`, `resume`, `cancel` over typed requests, responses and failures, without a page, a selector or a session. A failure is never an empty answer: the submission state (`not_submitted`/`submitted`/`unknown`) and the failure kind (`busy`/`unavailable`/`timeout`/`invalid_output`/`cancelled`/`unknown_submission`) say what happened. `runChat(options, { backend })` runs a chat through it instead of a browser; the providers are **not** migrated yet — the capabilities of every provider are in `docs/capability-matrix.md`

## Pre-Commit Checklist

Run all steps before every commit. CI will fail if any step fails.

```bash
bun run typecheck                          # 1. TypeScript type check (tsc --noEmit)
bun run lint                               # 2. Lint + format (biome)
bun run knip                               # 3. Unused dependencies (knip)
bun run test                               # 4. Unit tests (vitest)
bun run build                              # 5. Production build (tsc)
```

The end-to-end scenarios of the CLI flows run in CI as well:

```bash
bun run test:e2e                           # CLI flows; the live provider scenarios are opt-in
TEN_X_CHAT_E2E_PROVIDERS=1 bun run test:e2e   # live provider scenarios (needs a logged-in profile)
```

If biome reports fixable issues:

```bash
bun run lint:fix                            # auto-fix lint + format
```

## Release Flow

```bash
# 1. Bump version in package.json
# 2. Commit with descriptive message
git add -A && git commit -m "feat: ..."
# 3. Tag and push — CI publishes to npm on tag
git tag v<version>
git push origin main --tags
```

CI pipeline (GitHub Actions): checkout → install → typecheck → lint → **test** → end-to-end → build → publish to npm → GitHub Release. The live provider scenarios are a separate, opt-in workflow (`.github/workflows/e2e.yml`) that needs a runner with a logged-in profile.

## Browser runtime

CloakBrowser (a patched Chromium) is the only supported engine — see `src/browser/engine.ts`. The Camoufox/Firefox migration was measured and rejected ([docs/refactor-3-8-camoufox.md](docs/refactor-3-8-camoufox.md), [docs/refactor-4-9-camoufox-production-readiness.md](docs/refactor-4-9-camoufox-production-readiness.md)).

## Config

`~/.10x-chat/config.json` — user preferences (default provider, headless, profile mode, timeout, proxy).

The order of the settings (CLI flag > config file > built-in default), the
rules of the profiles and sessions and the proxy contract live in
[docs/config-contract.md](docs/config-contract.md). A broken config file is an
error, not a fallback — only a *missing* file falls back to the defaults.

## Data

`~/.10x-chat/sessions/<uuid>/` — per-session metadata, prompt bundle, captured response.
`~/.10x-chat/profiles/` — browser profiles (shared default + per-provider isolated).
`~/.10x-chat/secrets.json` — the credentials of the proxy (mode 600, never in the config file); the file store is the fallback of the system keyring.
