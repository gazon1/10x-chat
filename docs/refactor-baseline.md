# Refactor 1/8 — Baseline & Audit

Snapshot for [#2](https://github.com/gazon1/10x-chat/issues/2). No production code was changed.

- Branch / commit: `gazon1/refactor-1-8-baseline` @ `3fda497`
- Date: 2026-11-16
- Environment: Linux, Node `v22.22.2`, npm. `bun` is **not installed** here (repo declares `bun@1.3.14`).

## 1. Baseline commands

Install used as a substitute for `bun install`:

```bash
npm install --include=dev --no-package-lock --ignore-scripts
```

`NODE_ENV=production` was set in the environment, so the first plain `npm install` silently
skipped all devDependencies (`tsc`, `biome`, `vitest` were missing). `--include=dev` is required.
`--ignore-scripts` skips `postinstall` (`npx cloakbrowser install`), so no browser binary was
installed and no browser/E2E flow was exercised.

| # | Command | Result | Notes |
|---|---------|--------|-------|
| 1 | `bun install --frozen-lockfile` | not run | `bun` unavailable; npm substitute succeeded |
| 2 | `bun run typecheck` → `npm run typecheck` | **PASS** (exit 0) | `tsc --noEmit` |
| 3 | `bun run lint` → `npm run lint` | **PASS** locally with locked Biome (exit 0) | CI verification pending; see version caveat below |
| 4 | `bun run test` → `npm run test` | **PASS** (exit 0) | 18 files, **153 tests**, ~2.7 s |
| 5 | `bun run build` → `npm run build` | **PASS** (exit 0) | `tsc -p tsconfig.build.json`, `dist/` is gitignored |
| 6 | `bun run dev` | not run | needs `bun` |
| 7 | `npm start` | not run | needs build + Node; same as 5 |

### Lint version caveat (important)

`package.json` declares `"@biomejs/biome": "^2.0.0"`, while `bun.lock` pins `2.4.4`.
Installing via npm resolved **2.6.8**, which reports 9 formatter errors in Markdown files
(`AGENTS.md`, `SPEC.md`, `README*.md`, `.agents/workflows/pre-push.md`,
`.github/ISSUE_TEMPLATE/{bug_report,feature_request,provider_broken}.md`,
`skills/10x-chat/SKILL.md`) and exits 1.

With the lockfile-pinned version the same command is clean:

```
npx -y @biomejs/biome@2.4.4 check .
→ Checked 99 files. No fixes applied. Found 3 infos. exit=0
```

The lockfile pins Biome 2.4.4, and that version passes the local lint check.
CI verification is pending. Local npm installs can see a false lint failure when they resolve
the newer 2.6.8.
Warnings and infos under 2.4.4 never fail the build. (The newer 2.6.8 additionally reports
`lint/performance/useDomNodeTextContent` 23× and `lint/suspicious/noDuplicateEnumValues` 2×
in `src/notebooklm/rpc/types.ts`; those are version-specific, not baseline state.)

Also note: CI (`ci.yml`) runs typecheck → lint → test but **not build**; `release.yml` adds
build + publish. Both use `bun install --frozen-lockfile`.

## 2. CLI → provider → runtime map

Entry point: `src/bin/cli.ts` registers 13 Commander commands.

| Command | Main module | Providers accepted | Browser path |
|---------|-------------|--------------------|--------------|
| `login [provider]` / `--all` / `--tabs` / `--status` | `cli/login.ts` | all 8 | persistent context + profile lock (`--status` uses shared daemon) |
| `chat -p …` | `cli/chat.ts` → `core/orchestrator.ts` | any registered provider + `--all` | shared daemon by default; isolated/named profile optionally |
| `delegate <provider>` | `cli/delegate.ts` | any registered provider | same as chat; long-lived JSONL session |
| `history` | `cli/history.ts` | chatgpt, gemini, claude, grok, perplexity (`all` default) | shared daemon |
| `image -p …` | `cli/image.ts` → `core/image-orchestrator.ts` | chatgpt, gemini, grok | shared daemon |
| `research -p …` | `cli/research.ts` → `core/research-orchestrator.ts` | chatgpt, gemini, perplexity | shared daemon |
| `video -p …` | `cli/video.ts` → `core/video-orchestrator.ts` / `core/dreamina-video-orchestrator.ts` | flow (default), dreamina | **persistent shared context, not the daemon** |
| `status` / `session <id>` | `cli/status.ts` | — | none (session files only) |
| `config show` / `config set` | `cli/config.ts` | — | none (`~/.10x-chat/config.json`) |
| `skill install` / `skill show` | `cli/skill.ts` | — | none |
| `notebooklm` (alias `nb`) | `cli/notebooklm.ts` → `notebooklm/*` | — | HTTP RPC API; cookies read from profile via `notebooklm/auth.ts` (launches Chromium once if no `storage_state.json`) |
| `migrate` | `cli/migrate.ts` | — | none (moves profile directories on disk) |

Public argument/output surface is documented in `README.md`; flags missing there
(`--all`, `--attach`, `--save-images`, `--profile`, `--isolated-profile`, `--headless` on `chat`)
exist only in `--help`. Machine-readable outputs: `delegate` (JSONL), `history --json`.

## 3. Providers

Registry: `src/providers/registry.ts`; contract: `src/types.ts` (`ProviderConfig`,
`ProviderActions`). All 8 names are valid for `chat`/`delegate`/`login`; other commands whitelist.

| Provider | Config (URL, model default, timeout) | Modes | Used by |
|----------|--------------------------------------|-------|---------|
| chatgpt | chatgpt.com, no default model, 5 min, `headlessBlocked: true` | chat, image, research, history | 4 commands |
| gemini | gemini.google.com, `3.5 Flash`, 5 min | chat, image, research, **video (Flow)** | 4 commands |
| claude | claude.ai/new, `Sonnet 4.6`, 5 min | chat, history; forced headed (`browser/mode.ts`) | 2 commands |
| grok | grok.com, `Auto`, 5 min | chat, image, history | 3 commands |
| perplexity | perplexity.ai, `Auto`, 2 min, `headlessBlocked: true` | chat, research, history | 3 commands |
| notebooklm | notebooklm.google.com, 5 min | chat via RPC (`notebooklmActions`), own CLI | 2 commands |
| flow | labs.google/fx/tools/flow, `Omni Flash`, 10 min | video only (actions used directly by orchestrator) | 1 command |
| dreamina | dreamina.capcut.com, `Seedance 2.0 Fast`, 10 min | video only; `dreaminaActions.submitPrompt/captureResponse` throw "not yet implemented" | 1 command |

Notes:
- `chat --all` fans out to chatgpt, gemini, claude, grok, perplexity (`CHAT_PROVIDERS`).
- `chat --provider dreamina` passes validation and fails later at submit (stub).
- Flow video launches with `provider: 'gemini'`; Dreamina launches with `provider: 'dreamina'`,
  both `profileMode: 'shared', persistent: true`.

## 4. Browser / runtime components

| Module | Responsibility | Consumers |
|--------|----------------|-----------|
| `browser/engine.ts` | CloakBrowser → Playwright `BrowserType` adapter | `manager.ts`, `server.ts`, `cli/login.ts`, `notebooklm/auth.ts` |
| `browser/manager.ts` | `launchBrowser`: shared daemon / shared persistent / isolated persistent | 9 call sites (chat, delegate, history, login, image, research, flow video, dreamina video, public `src/index.ts`) |
| `browser/daemon.ts` | HTTP-RPC client + daemon lifecycle, remote Page/Locator proxies, state file | `manager.ts`, `tabs.ts`, `cli.ts` (`stopDaemon` on signals) |
| `browser/server.ts` | Detached Chromium process serving `/rpc`, `/health`, `/stop` | spawned only by `daemon.ts` |
| `browser/lock.ts` | File lock per profile dir | `manager.ts` (persistent/isolated), `daemon.ts` (start lock) |
| `browser/state.ts` | shared `storage-state.json` load/save | `daemon.ts`, `manager.ts`, `cli/login.ts` |
| `browser/stealth.ts` | Chrome channel detection + init script | `manager.ts`, `server.ts` |
| `browser/mode.ts` | `resolveHeadlessMode` (chatgpt/claude forced headed) | orchestrators, history, delegate, login |
| `browser/process.ts` | `isProcessAlive`, `CHROMIUM_ARGS` | `lock.ts`, `daemon.ts` |
| `browser/page-utils.ts` | URL-change wait helpers | `grok.ts`, `perplexity.ts`, `research-orchestrator.ts` |
| `browser/tabs.ts` | Tab ref-count wrappers | **none** (only re-exported by `browser/index.ts`) |

### Who actually uses the daemon/RPC

- Default `profileMode: 'shared'`, non-persistent → every `chat`, `image`, `research`, `delegate`,
  `history`, and `login --status` invocation.
- `login` (interactive), `video --provider flow`, `video --provider dreamina` → persistent context
  with profile lock, **no daemon**.
- `--isolated-profile` / `--profile <name>` → per-provider/named persistent context, no daemon.
- The daemon is an internal optimization only; the HTTP API is not a public contract.
- Tab RPC (`register`/`unregister`, `manualTabs`, `activeTabs`) has **no client consumer** other
  than `browser/tabs.ts`, which itself has no consumer.

## 5. Configuration, profiles, sessions, proxy

- Config file `~/.10x-chat/config.json` (JSON5): `defaultProvider`, `defaultModel`,
  `defaultTimeoutMs`, `headless`, `profileMode`. `config set` supports only
  provider/model/timeout/headless (`profileMode` must be edited manually).
- `TEN_X_CHAT_HOME` overrides the app directory.
- Profiles: shared `profiles/default/storage-state.json`; isolated `profiles/<provider>`;
  named `profiles/<name>`.
- Sessions: `~/.10x-chat/sessions/<uuid>/` with `meta.json`, `bundle.md`, `response.md`.
  (`SPEC.md` also lists `log.jsonl`, which is never written.)
- Daemon state: `~/.10x-chat/browser-daemon.json`; start lock `browser-daemon-lock/`.
- **Proxy: not implemented.** No `proxy`/`socks` option in config, CLI, or launch options
  (`socks-proxy-agent` is only an unused optional peer of CloakBrowser).

## 6. Dependencies & postinstall

Runtime deps and their real use:

| Dep | Use |
|-----|-----|
| `chalk`, `commander` | CLI everywhere |
| `cloakbrowser` | only `browser/engine.ts` |
| `playwright` | type imports + `scripts/debug-chatgpt-img.ts` |
| `playwright-core` | no direct import; required as `cloakbrowser` peer |
| `fast-glob` | `core/bundle.ts`, `core/files.ts` |
| `json5` | `config.ts` (dynamic import) |
| `clipboardy` | `chat --copy` (dynamic import) |
| `patchright`, `patchright-core` | **zero references anywhere** |

- `postinstall`: `npx cloakbrowser install 2>/dev/null || true` — downloads the CloakBrowser
  Chromium; failures are silently ignored. `README.md` still tells users to run
  `npx playwright install chromium`, which is not what the engine uses.
- `tsx` (dev) is required at runtime by `daemon.ts` when running from `src/` (`--import tsx`);
  built `dist/` uses plain `node`.
- `bun.lock` is the only lockfile (`bun@1.3.14`); there is no `package-lock.json`.

## 7. Tests: coverage and gaps

18 files / 153 tests, all unit-level with mocked `Page` objects (no browser launched).

Covered:
- providers: chatgpt (capture + overlays), claude, grok, gemini (login + image gen), dreamina (login),
  dreamina-video (helpers/constants), flow (config, selectors, mode config, generation, submit,
  capture, upload), registry, model selection, shared submit helper
- video CLI flags, video-orchestrator result/download helpers
- config loading (JSON + JSON5), paths, bundle, `resolveHeadlessMode`

Not covered (no tests): `browser/{daemon,server,manager,lock,state,tabs,stealth,process}.ts`,
`session/store.ts`, `core/{orchestrator,image-orchestrator,research-orchestrator,video-orchestrator,
dreamina-video-orchestrator}.ts` (only helper contracts), every CLI command except `video`,
the whole `notebooklm/` package, and `core/{files,images,video-download}.ts`.
There is no automated E2E test; live Flow/Dreamina runs are the only real regression signal.

## 8. Removal candidates (usages + tests)

Nothing below is removed yet; each item lists what it would touch.

| Candidate | Usages | Tests | Risk |
|-----------|--------|-------|------|
| `src/browser/tabs.ts` + daemon tab RPC (`registerDaemonTab`, `unregisterDaemonTab`, `readLiveTabCount`, client `getLiveTabCount`, `manualTabs`) | only `browser/index.ts` re-export | none | low; `activePageCount` is also only used for `activeTabs` in `/health`, keep or simplify |
| `getOrLaunchBrowserDaemon` | `daemon.ts` definition + `browser/index.ts` export; no callers | none | low |
| `isEngineLoaded` | `engine.ts` only; not exported from index | none | low |
| `getDaemonStatePath`, `clearDaemonState`, `readDaemonState` public exports | internal daemon use only; re-exported by `browser/index.ts`, not by `src/index.ts` | none | low (un-export rather than delete) |
| `patchright`, `patchright-core` deps | zero imports | — | low; update `bun.lock` |
| `scripts/debug-chatgpt-img.ts` | not referenced by scripts/docs | — | low (dev-only, uses `playwright` directly, bypasses CloakBrowser) |
| `getStorageStatePath` | exported by `state.ts`; used internally | none | trivial |

Keep: `playwright-core` (CloakBrowser peer), `playwright` (types + debug script), `tsx`
(daemon dev spawn), `docs/chatgpt-deep-research.md` + `skills/` (installed by `skill install`).

## 9. Mandatory regression cases: Flow and Dreamina

Flow (Veo) must keep:
- config/URL/models/default `Omni Flash`/10 min timeout; exact selector strings
- mode configuration: model pill (skip dropdown for default), Video tab, `16:9`/`9:16`, `1x`–`x4`, Escape
- generation polling: percentage callbacks, early exit when videos appear, timeout
- login detection (studio content → true; evaluate error → false)
- prompt submit: legacy `arrow_forward`, evaluate fallback, clear error when not found
- capture: video count text, `truncated` on timeout, `onChunk` progress
- ingredient upload: `filechooser` → `setInputFiles` fallback → clear error
- CLI flags and result/download helpers (mp4/webm/base64)

Dreamina (Seedance) must keep:
- five models, default `Seedance 2.0 Fast`, aspects/resolutions, duration bounds 4–15 s,
  ref-mode labels
- placeholder rejection: accept CDN `/video/` and `blob:`; reject the 780×780 spinner URL
- `buttonTextHasAspectRatio`: must match concatenated ratio+resolution (`16:9720P`)
- login: sign-in UI wins, numeric credit balance, CapCut passport cookie, transient-load window,
  passport redirect
- CLI flags; model-lock error (`lv-select-option-wrapper-disabled`), aspect/resolution/duration,
  ref-mode, multi-image upload, generate, poll, download are **not** unit-covered — they need a
  live/manual check before and after refactoring.

## 10. Known documentation drift (do not rely on these)

- `SPEC.md` is the original design, not current behavior: pnpm, per-provider-only profiles,
  `--providers` flag (actual is `--all`), `navigateToChat`/`waitForResponse` contract,
  `log.jsonl`, MCP as future.
- `README.md` data layout still shows only per-provider profiles; the default is the shared
  `profiles/default` + daemon. It also omits `proxy` (correctly — unimplemented) and
  `playwright install` no longer matches the engine.
- `AGENTS.md` is the most accurate map, but its Gemini default (`Thinking`) differs from
  `GEMINI_CONFIG.defaultModel` (`3.5 Flash`) and it documents `npm`/`biome src/` commands while
  the repo scripts are bun-based.
- `browser/daemon.ts` still exposes tab APIs that nothing uses (see §8).

## 11. Verification for the next refactor step

### Actually performed in this audit (npm, no Bun)

```bash
npm install --include=dev --no-package-lock --ignore-scripts   # install substitute
npm run typecheck   # PASS
npx -y @biomejs/biome@2.4.4 check .   # lint baseline, PASS (exit 0, 3 infos)
npm run test        # PASS, 18 files / 153 tests
npm run build       # PASS
```

`npm run lint` itself was not used for the final baseline because an unlocked npm install resolved
Biome 2.6.8 (see §1); the lockfile-pinned 2.4.4 was invoked directly.

### Not performed

- `bun install --frozen-lockfile` and all `bun run …` commands — Bun is not installed here.
- `bun run dev`, `npm start`, and the `postinstall` CloakBrowser download.
- Any browser/E2E execution (Flow, Dreamina, login, chat against live providers).
- GitHub CI/PR checks — at the time of writing the PR has no check runs or commit statuses.

### Expected after CI runs

`ci.yml` (Bun + frozen lockfile) should report: install PASS, typecheck PASS, lint PASS with
Biome 2.4.4, test PASS with `153` tests. `build` is not part of `ci.yml` (only `release.yml`);
it passed locally. This expectation is unconfirmed until the check runs appear on the PR.

Browser behavior is not covered by this baseline — validate Flow and Dreamina manually (§9)
before and after touching their providers or the browser lifecycle.
