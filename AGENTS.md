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
| `src/backend/chatgpt-use.ts` | The ChatGPT backend, driven by the `chatgpt-use` CLI (see [docs/chatgpt-use-backend.md](docs/chatgpt-use-backend.md)) |
| `src/backend/registry.ts` | Backend name → backend mapping, the injection point of the contract |
| `src/transport/http.ts` | The shared HTTP client of the API transports (honors the effective proxy) |
| `src/providers/api/` | The API transports of the providers (`registry.ts` maps a provider to its transport) |
| `src/core/failures.ts` | Bot-challenge detection, failure kinds (`antibot`/`unauthorized`/`unavailable`) |
| `src/core/polling.ts` | `pollUntilStable` — waits for streamed response to stop changing |
| `src/core/conversations.ts` | Conversation reuse per git repo + branch: URL extraction, git context, `~/.10x-chat/conversations.json` |
| `src/core/bundle.ts` | Assembles prompt + file context into a markdown bundle |
| `src/pipeline/` | The review pipeline: context, findings, verification, report — no Playwright, no provider modules ([docs/review-pipeline.md](docs/review-pipeline.md)) |
| `src/browser/manager.ts` | Browser launch: shared (daemon), shared-persistent (login), isolated modes |
| `src/browser/daemon.ts` | Long-running Chromium server for cross-invocation reuse |
| `src/browser/state.ts` | `saveStorageState` / `loadStorageState` for cookie persistence |
| `src/cli/` | Commander subcommands: chat, login, status, config, secrets, skill, migrate, review |
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
| `docs/playwright-inventory.md` | The consumers of the browser runtime and the migrate/retain decision per provider |

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
- **The `--backend` option**: `chat --backend <name>` runs a chat through a backend of the registry (`src/backend/registry.ts`) instead of a browser — `chatgpt-use` and the `chrome-use-perplexity` POC today. A backend is not a provider and not a transport: `--all`, `--transport`, `--new-chat` and the browser flags are refused with it
- **The ChatGPT backend**: `src/backend/chatgpt-use.ts` drives the `chatgpt-use` CLI instead of a browser: the CLI owns the window of ChatGPT, its JSON envelope is validated, and the receipt of the CLI (`--request-id`) is the record of a request — an unknown submission state is never a retry. The busy policy: the asks of one process run one after the other, another process is refused by the CLI (`--busy fail`) and becomes a `busy` failure. See [docs/chatgpt-use-backend.md](docs/chatgpt-use-backend.md)
- **The backend contract**: `src/backend/contract.ts` is the provider-independent seam — `ask`, `status`, `resume`, `cancel` over typed requests, responses and failures, without a page, a selector or a session. A failure is never an empty answer: the submission state (`not_submitted`/`submitted`/`unknown`) and the failure kind (`busy`/`unavailable`/`timeout`/`invalid_output`/`cancelled`/`unknown_submission`) say what happened. An empty answer is not a success either — it is `invalid_output`. `runChat(options, { backend })` runs a chat through it instead of a browser; the providers are **not** migrated yet — the capabilities of every provider are in `docs/capability-matrix.md`
- **The review pipeline** (`src/pipeline/`): the owner of a review — it collects the context, asks three isolated reviewers for findings, verifies every finding against the source and writes the report of `skills/10x-chat/workflows/report-format.md`. The reviewers get the **page of the change on GitHub** (the pull request or the comparison of the commits) and never the diff: a pasted diff is a snapshot that also has to fit into the window of the model, a change that is too long is refused by the chat UI. A change that is not on `origin` is refused (`collect-context`), and a repository whose remote is not a URL is the only case that sends a diff. It depends on the backend contract and on the repository only: no Playwright, no provider module. A finding is **not** confirmed because its JSON validates — only the verification pass with evidence confirms it. The verdict is a field of the run (`verdict` of `review.json`) and the exit code of the command: `REQUEST CHANGES` is not a clean exit. The steps have stable ids and their outcomes are persisted in `~/.10x-chat/reviews/<id>/`. The pipeline never publishes to GitHub. See [docs/review-pipeline.md](docs/review-pipeline.md)
- **The decisions of a review** (`src/pipeline/`): the architecture pass answers a second question — what did you decide that I did not tell you to decide? Its answer carries a list of decisions beside the findings: the kind (a confirmed behavioral change, an intended decision, an implicit decision or an unverified assumption), the decision, the behavior of the base revision or the alternative, the evidence, the consequence, the failure scenario and whether a human has to confirm it. A decision is **not** a finding: it carries no severity, it is never verified as a defect, it is never repeated in the table of the findings and it never changes the verdict — a trade-off is not a reason to ask for changes. The decisions live in their own section of the report (*Implicit decisions and trade-offs*) and in their own field of `review.json`. The architecture pass answers two questions, and its answer must carry both keys: an answer with the decisions and no findings has answered one of them, and it fails the pass like a missing list of decisions does — the findings of that pass must not be lost in an approval. The decisions are read out of the payload of the answer — the last payload of the text, even when it carries no decisions: an example of the format that precedes it is never read as the answer, and a decision that the model did not make is not a decision of the change.
- **The requirements of a review** (`src/pipeline/requirements.ts`): `review --pr <n> --issue <m>` reads the governing Issue through `gh`, hashes its title and its body (SHA-256), and gives the complete current description to the three reviewers and to the verification. The version is compared with the baseline of the last completed review (`~/.10x-chat/requirements/<owner>/<name>/<issue>.json`, owner-only): a changed Issue is named as changed, the Issue is read again after the reviewers ran (`check-requirements`), and a stale run is incomplete and never approves. The baseline moves only when the whole review passed, and a run that observed the Issue earlier never overwrites a newer snapshot — a tie of two observations of the same millisecond keeps the stored one. The read of the Issue has a timeout of its own: a `gh` that never answers must not hang the review. A stored snapshot is read as a baseline only when it agrees with itself: its hash is the hash of its own title and its own body, its moment of observation is a timestamp, and it is the snapshot of the Issue it is stored at. The store is private before every read as well as before every write: the directories are `0700` and the snapshot is `0600`, and it holds no symbolic link — `chmod()` and `readFile()` follow a link, and a link in the store would take the run outside of it. The baseline moves only after the run was written: a review that could not be recorded did not happen, and its Issue was not reviewed.

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
TEN_X_CHAT_E2E_CHATGPT_USE=1 bun run test:e2e   # live scenario of the ChatGPT backend of chatgpt-use
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
