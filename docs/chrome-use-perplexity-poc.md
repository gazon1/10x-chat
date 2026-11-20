# Proof of concept: Perplexity via `chrome-use` (issue #50)

Validates whether `chrome-use` can replace the browser ownership/low-level
automation layer for one non-ChatGPT provider without losing current product
capabilities. Scope: a narrow adapter behind the backend boundary
(`AiBackend`), site-specific workflow isolated in
`src/backend/chrome-use-perplexity.ts`, existing Playwright provider kept.

## Selected provider and rationale

**Provider: Perplexity** (`chrome-use-perplexity` backend, drives `perplexity`).

Chosen after checking the capability matrix (`docs/capability-matrix.md`) and
the documented `chrome-use` interface (`chrome-use skills get core`): smallest
capability surface and fewest special cases among non-ChatGPT providers.

| Provider | Attach | Model | Stream | Cancel | Conv. reuse | Images | Special cases |
| --- | --- | --- | --- | --- | --- | --- | --- |
| perplexity | no | no | poll | no | no (URL id only) | no | bot-protected/headed in Playwright; works signed out |
| deepseek | no | toggle | poll | no | no | no | DeepThink toggle (model selection) |
| claude | yes | picker | poll | no | no | no | headed-only, attachments, thinking strip |
| grok | yes | picker | poll | no | no | yes | attachments + image output |
| gemini | yes | modes | poll | no | no | yes | modes/tools, Deep Think waits, images |
| chatgpt | — | — | — | — | — | — | out of scope (use `chatgpt-use`) |

Perplexity needs only: open page, ensure composer, submit prompt, wait for a
new `.prose` answer to stabilize, read text. No file upload, no model picker,
no generated images, no app-level conversation continuation actions. Running in
the user's real Chrome (chrome-use relay) sidesteps Playwright headless/bot
constraints; auth is the user's Chrome profile (anonymous use is also allowed
by Perplexity).

## Required capability matrix (before implementation)

| Capability | Existing browser provider (`src/providers/perplexity.ts`) | chrome-use POC backend | Notes |
| --- | --- | --- | --- |
| attachments | no | **no** (rejected explicitly) | no silent loss |
| streaming (`onChunk`) | yes (poll chunks to terminal) | **no** (declared; full answer returned) | explicit difference vs browser path |
| cancellation | no | **no** (declared; `cancel` reports not cancelled) | explicit |
| conversation reuse | no app actions; orchestrator stores/reopens URL | **no** (declared; fresh open per ask) | explicit loss vs orchestrator reuse |
| model selection | no | **no** (rejected explicitly if requested) | no silent loss |
| image output | no | **no** | no silent loss |
| prompt submit + capture | yes | **yes** | core end-to-end path |
| login/session reuse | shared/isolated 10x-chat profiles | **yes** via user's Chrome profile/cookies | different ownership model (see below) |

Unsupported capabilities are declared in `BackendCapabilities` and rejected or
reported explicitly by the adapter/runner; the backend never silently drops a
requested capability.

## Implementation

- `src/backend/chrome-use-perplexity.ts`: `AiBackend` over `chrome-use --session …`
  commands with `--json`. Uses `open`, `wait`, `eval`, `fill --stdin`, `click`,
  `press`, `done`. Polls for a new `.prose` element at the pre-submit baseline
  until text is stable. Spawns without a shell.
- Registered as `chrome-use-perplexity` (drives `perplexity`) in
  `src/backend/registry.ts`, exported from `src/backend/index.ts`.
- CLI: `10x-chat chat -p "…" --backend chrome-use-perplexity` (provider inferred
  as perplexity). Browser flags/`--all`/`--transport`/`--new-chat`/`--dry-run`
  refused as with other backends.

## Behavior (explicit)

- **Authenticated profile/session ownership:** runs in the connected real
  Chrome profile (extension relay), not in `~/.10x-chat/profiles`. Login state
  is whatever that Chrome profile has; Perplexity works signed out for basic
  queries. If the composer is unavailable, the ask fails with a clear message
  (log in in Chrome if required).
- **Cleanup:** every ask uses a dedicated `chrome-use` session name and always
  attempts `chrome-use … done` in `finally` to close tabs it opened.
- **Timeout:** respects `request.timeoutMs`; if the prompt was confirmed sent,
  timeout is reported as `timeout/submitted`, otherwise as an unknown pre-submit
  timeout (never retried automatically).
- **Cancellation:** capability `false`; `cancel` returns `{cancelled:false}`.
- **Browser disconnect / chrome-use unavailable:** start/connect failures before
  submit → `unavailable/not_submitted`. Loss of connection after submit →
  `unknown_submission/unknown` with an explicit message (prompt may have been
  submitted; do not resend blindly).
- **Conversation reuse:** not implemented in this POC; each ask opens the
  landing page in a fresh chrome-use session (explicitly declared unsupported).

## Comparison with existing Playwright provider path

| Aspect | Playwright (`--provider perplexity`) | chrome-use backend (POC) |
| --- | --- | --- |
| Browser ownership | 10x-chat-managed CloakBrowser/Chromium daemon & profiles | User's real Chrome via chrome-use extension relay |
| Session/profile storage | `~/.10x-chat/profiles` (shared/isolated) | Chrome's own profile/cookies |
| Bot/Cloudflare handling | `requiresHeaded`/`botProtected` flows in app | Real browser; challenges are the user's browser state |
| Conversation reuse across runs | Yes (orchestrator stores/reopens URL per repo+branch) | No (declared unsupported) |
| Streaming chunks to terminal | Yes | No (full answer) |
| Attach/model/images/cancel | Unsupported by provider | Unsupported, explicitly declared/rejected |
| Raw DOM/page objects | Confined to provider/orchestrator (Playwright) | None; CLI JSON only (safe for backend boundary) |

## Verification

- Unit (fake runner, no browser): `bun run test -- tests/backend-chrome-use-perplexity.test.ts`
- Opt-in live smoke (needs chrome-use + connected Chrome + network):  
  `TEN_X_CHAT_E2E_CHROME_USE_PERPLEXITY=1 bun run test:e2e -- tests/e2e/chrome-use-perplexity.e2e.ts`

## Decision record

**Decision: retain existing Playwright path; do not migrate further providers to
chrome-use yet.**

- The POC proves a narrow, non-leaking backend-boundary adapter is feasible for
  a minimal-surface provider using chrome-use session/tab ops and structured
  output, with explicit capability reporting and cleanup.
- Gaps vs current product behavior remain material for broader migration:
  conversation reuse across runs, terminal streaming, and parity for providers
  with attachments/model selection/image output/cancellation need design and
  app-side backend-conversation support.
- chrome-use depends on the user's real Chrome + extension relay (different
  operational model from managed profiles/daemon) and its command/latency
  characteristics differ; parity must be demonstrated per provider before
  replacing Playwright/CloakBrowser.
- Therefore: keep `src/providers/perplexity.ts` and the Playwright runtime;
  treat this as a validated spike. Revisit migration provider-by-provider only
  when a concrete provider shows net benefit and the missing capabilities have a
  supported design.
