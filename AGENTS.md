# AGENTS.md — 10x-chat

> Chat with web AI agents from the terminal via Playwright browser automation.

## Quick Orientation

| Path | What |
|------|------|
| `src/providers/` | One file per AI provider (chatgpt, gemini, claude, grok, perplexity, deepseek) |
| `src/providers/registry.ts` | Provider name → config + actions mapping |
| `src/providers/submit.ts` | Shared prompt submission helper (composer → type → send) |
| `src/core/orchestrator.ts` | Single + parallel chat execution (`runChat`, `runChatAll`) |
| `src/core/polling.ts` | `pollUntilStable` — waits for streamed response to stop changing |
| `src/core/bundle.ts` | Assembles prompt + file context into a markdown bundle |
| `src/browser/manager.ts` | Browser launch: shared (daemon), shared-persistent (login), isolated modes |
| `src/browser/daemon.ts` | Long-running Chromium server for cross-invocation reuse |
| `src/browser/state.ts` | `saveStorageState` / `loadStorageState` for cookie persistence |
| `src/cli/` | Commander subcommands: chat, login, status, config, skill, migrate |
| `src/types.ts` | Core types: `ProviderName`, `ProviderConfig`, `ProviderActions`, `ChatOptions` |
| `src/session/` | Session storage (metadata, bundles, responses) |
| `tests/` | Vitest unit tests |
| `tests/e2e/` | End-to-end scenarios: CLI flows (always) and live provider round trips (opt-in) |
| `docs/verification.md` | The result of the last full check run and the documented exceptions |

## Architecture

```
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
5. If Cloudflare-protected: set `headlessBlocked: true` in config

Provider actions implement:
- `isLoggedIn(page)` — detect auth state
- `selectModel?(page, model)` — optional; switch model/mode via the provider's UI picker before sending
- `submitPrompt(page, prompt)` — type and send
- `captureResponse(page, opts)` — poll until stable, return text + markdown

## Key Patterns

- **headlessBlocked**: Providers using Cloudflare (ChatGPT, Perplexity) auto-force headed mode
- **Shared profile mode** (default): All providers share `~/.10x-chat/profiles/default/storage-state.json`
- **Browser daemon**: `chromium.launchServer` persisted to disk for cross-CLI reuse
- **Tab ref-counting**: Multiple CLI invocations share one Chromium; last tab stops the daemon
- **Force-click**: Some providers need `click({ force: true })` to bypass overlay interception
- **Model selection**: Orchestrator calls `selectModel()` before `submitPrompt()` if the provider implements it. Model resolved from `--model` flag → `defaultModel` of the config file → `provider.config.defaultModel` (chat commands only). Gemini supports modes: Fast, Thinking (default), Pro

## Pre-Commit Checklist

Run all four steps before every commit. CI will fail if any step fails.

```bash
bun run typecheck                          # 1. TypeScript type check (tsc --noEmit)
bun run lint                               # 2. Lint + format (biome)
bun run test                               # 3. Unit tests (vitest)
bun run build                              # 4. Production build (tsc)
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

`~/.10x-chat/config.json` — user preferences (default provider, headless, profile mode, timeout).

The order of the settings (CLI flag > config file > built-in default), the
rules of the profiles and sessions and the proxy contract live in
[docs/config-contract.md](docs/config-contract.md). A broken config file is an
error, not a fallback — only a *missing* file falls back to the defaults.

## Data

`~/.10x-chat/sessions/<uuid>/` — per-session metadata, prompt bundle, captured response.
`~/.10x-chat/profiles/` — browser profiles (shared default + per-provider isolated).
