# The inventory of the Playwright/CloakBrowser consumers

The inventory that [#52](https://github.com/gazon1/10x-chat/issues/52) asks for
before any legacy browser code is deleted: every consumer of the browser
runtime, the decision per provider (migrate to a backend or retain the
browser), and the reason of every decision.

Read the source, not this document, when the two disagree — the code is the
truth.

## The state of the migration

| Provider   | Backend of today                      | Decision | Reason |
| ---------- | ------------------------------------- | -------- | ------ |
| chatgpt    | `chatgpt-use` ([docs/chatgpt-use-backend.md](chatgpt-use-backend.md)) | **retain the browser path as well** — the backend is opt-in (`chat --backend chatgpt-use`) | The browser provider is still the default of `chat`, `image`, `research`, `history` and `login`. The decision to retire it needs the migration of the CLI workflows of issue [#51](https://github.com/gazon1/10x-chat/issues/51) |
| perplexity | `chrome-use-perplexity` (POC) ([docs/chrome-use-perplexity-poc.md](chrome-use-perplexity-poc.md)) | **retain the browser path** | The decision record of the POC: "retain existing Playwright path; do not migrate further providers to chrome-use yet" |
| gemini     | none                                   | **retain** | No backend, no parity test, no approved migration ([#51](https://github.com/gazon1/10x-chat/issues/51)) |
| claude     | none                                   | **retain** | same |
| grok       | none                                   | **retain** | same |
| deepseek   | `deepseek` API transport ([docs/transports.md](transports.md)) | **retain the browser path** | The API transport is a transport, not a backend: the browser path stays the default |

No provider of the browser path is dead: every one of them is reachable
through a command of the CLI. The Playwright code can only go away per
provider, after the parity of its own workflows is proven — that is the work
of issue [#51](https://github.com/gazon1/10x-chat/issues/51), which is still
open.

## The consumers of the browser runtime

Every module of `src/browser/` has a consumer that a supported feature needs.
`server.ts` is the only exception: it is not imported, it is spawned by
`daemon.ts` as a detached process.

| Module                  | Consumers                                                                 | Decision |
| ----------------------- | ------------------------------------------------------------------------- | -------- |
| `engine.ts`             | `manager.ts`, `rpc-service.ts`, `server.ts`                               | keep |
| `manager.ts`            | `browser/index.ts` → `chat`, `delegate`, `history`, `login`, `image`, `research` | keep |
| `daemon.ts`             | `manager.ts`, `cli/daemon.ts`, `bin/cli.ts` (stop on exit)                | keep |
| `server.ts`             | spawned by `daemon.ts` (HTTP RPC: `/rpc`, `/health`, `/switch`, `/stop`)  | keep |
| `rpc-service.ts`        | `server.ts`                                                               | keep |
| `switch-gate.ts`        | `rpc-service.ts`, `server.ts`                                             | keep |
| `operation-timeout.ts`  | `daemon.ts`, `rpc-service.ts`                                             | keep |
| `process.ts`            | `daemon.ts`, `manager.ts`, `server.ts`                                     | keep |
| `lock.ts`               | `daemon.ts`, `manager.ts`                                                 | keep |
| `state.ts`              | `daemon.ts`, `manager.ts`, `core/failures.ts`                             | keep |
| `stealth.ts`            | `manager.ts`, `rpc-service.ts`, `server.ts`                                | keep |
| `mode.ts`               | the orchestrators, `login`, `history`, `delegate`                         | keep |
| `diagnostics.ts`        | the orchestrators, `manager.ts`, `rpc-service.ts`                          | keep |
| `page-utils.ts`         | `providers/grok.ts`, `providers/perplexity.ts`, `core/research-orchestrator.ts` | keep |
| `proxy.ts`              | the browser, the config, the API transport, `transport/http.ts`            | keep |

## The commands that need the browser

| Command             | Browser | Providers |
| ------------------- | ------- | --------- |
| `chat`              | yes (default; `--transport api` and `--backend` avoid it) | chatgpt, gemini, claude, grok, perplexity, deepseek |
| `delegate`          | yes     | every provider |
| `history`           | yes     | chatgpt, gemini, claude, grok, perplexity |
| `login`             | yes (persistent context) | every provider |
| `image`             | yes     | chatgpt, gemini, grok |
| `research`          | yes     | chatgpt, gemini, perplexity |
| `daemon status/stop`| yes (the daemon of the browser) | — |
| `review`            | **no**  | — (a backend of the contract answers) |
| `status`, `session` | no      | — (the session files) |
| `config`, `secrets`, `skill`, `migrate` | no | — |

The skill of the repository (`skills/10x-chat/scripts/chatgpt-files.mjs`) drives
CloakBrowser itself: it is a consumer too, and it stays as long as the skill
documents it.

## What was removed

Only code with no caller at all — no capability of the CLI changed.

| Removed                       | Where                     | Why |
| ----------------------------- | ------------------------- | --- |
| `redactPath()`                | `src/browser/diagnostics.ts` | No caller; `redactText()` does the same replacement inline |
| `isEngineLoaded()` and `_loaded` | `src/browser/engine.ts`  | No caller |
| `clientBoundMs()`             | `src/browser/operation-timeout.ts` | No caller; `timeoutPlan()` computes the same bound |
| the `stopDaemon` re-export    | `src/browser/index.ts`    | No caller imports it from there (`bin/cli.ts` imports it from `browser/daemon.ts`) |
| `scripts/debug-chatgpt-img.ts` | `scripts/`               | A one-off debug script with no caller: it drove ChatGPT with a raw `playwright` browser, bypassing CloakBrowser and every fix of the app |

`playwright` stays a dependency: the types of the public API are the types of
Playwright (`Page`, `BrowserContext`), so the published `.d.ts` files need it.
`playwright-core` stays as the peer of CloakBrowser.

## One fix outside the cleanup

The `chrome-use-perplexity` backend ran its cleanup command (`chrome-use … done`)
for a session it had never opened: a request whose deadline expired before the
first command still started a process. The cleanup of the POC now only runs
when the open command was issued. The test of the POC already encoded this
behavior and failed before the fix.

## What is not removed, and why

- **The providers of the browser path** (`src/providers/*.ts`) — the workflows
  that use them are not migrated yet ([#51](https://github.com/gazon1/10x-chat/issues/51)).
- **The browser runtime** (`src/browser/`) — every module has a consumer
  (the table above).
- **The shared helpers** `src/providers/submit.ts` (`clickSendButton`,
  `submitPromptToComposer`) and `src/core/polling.ts` (`pollUntilStable`) —
  all five browser providers use them.
- **The user data** — `~/.10x-chat/profiles/` and `~/.10x-chat/sessions/` are
  never migrated or deleted by this cleanup.

## The verification

```bash
bun run typecheck   # no caller of a removed symbol
bun run lint
bun run knip        # no unused file left in the browser runtime
bun run test
bun run test:e2e
bun run build
```
