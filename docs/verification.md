# Verification — refactor 9/9

The check run for [#9](https://github.com/gazon1/10x-chat/issues/9): the state of the
repository after the refactoring, what was checked, and what is **not** covered on purpose.

- Branch: `gazon1/refactor-9-9-ci`
- Date: 2026-11-17
- Environment: Fedora 44, kernel 7.2.10, x86_64; Bun 1.4.4; Node v26.13.0; npm 11.20.0
- Browser runtime: CloakBrowser 0.4.10, Chromium `146.0.7680.177.5` (free build) in `~/.cloakbrowser/`

The historical baseline of the first refactoring step is
[docs/refactor-baseline.md](refactor-baseline.md); the numbers below are compared against it.

## 1. The check set

| # | Command | Result | Notes |
|---|---------|--------|-------|
| 1 | `bun install --frozen-lockfile` | **PASS** | 116 packages, lockfile unchanged; `prepare` builds `dist/`, `postinstall` downloads the CloakBrowser build |
| 2 | `bun run typecheck` | **PASS** | `tsc --noEmit` |
| 3 | `bun run lint` | **PASS** | `biome check .` — Biome 2.4.4 (the version the lockfile pins) |
| 4 | `bun run test` | **PASS** | 30 files, **300 tests**, ~1.3 s |
| 5 | `bun run test:e2e` | **PASS** | 7 CLI scenarios; the 7 live provider scenarios are skipped (see §4) |
| 6 | `bun run build` | **PASS** | `tsc -p tsconfig.build.json` |

Compared with the baseline: 18 files / 153 tests → **30 files / 300 tests**. The lint caveat of
the baseline still holds — a plain `npm install` resolves Biome 2.6.8, which reports formatter
findings in Markdown; the lockfile-pinned 2.4.4 is clean. Use `bun install --frozen-lockfile`.

## 2. Clean install

`bun install --frozen-lockfile` in an empty checkout:

- installs the 116 packages of the lockfile without changing it,
- runs `prepare` → `tsc -p tsconfig.build.json` → `dist/` (so an install from GitHub has a binary),
- runs `postinstall` → `npx cloakbrowser install` → Chromium `146.0.7680.177.5` in `~/.cloakbrowser/`.

The browser build is downloaded per machine, not per package — a second install reuses it.

## 3. The runtime decision

**CloakBrowser (patched Chromium) is the only supported runtime.** Camoufox/Firefox is a NO-GO
([#13](https://github.com/gazon1/10x-chat/issues/13) / [#5](https://github.com/gazon1/10x-chat/issues/5)),
measured in [docs/refactor-3-8-camoufox.md](refactor-3-8-camoufox.md) and
[docs/refactor-4-9-camoufox-production-readiness.md](refactor-4-9-camoufox-production-readiness.md):

- every provider selector was written against Chromium — a Firefox migration invalidates all of them,
- the stealth script fakes Chromium-only APIs and would have to be disabled for Firefox,
- Camoufox can neither carry SOCKS credentials nor serve a persistent context to the daemon.

Supported platforms (the CloakBrowser matrix): Linux x86_64/arm64, macOS arm64/x86_64, Windows
x86_64. Node ≥ 22 (or Bun ≥ 1.3).

The proxy contract is documented in [docs/config-contract.md](config-contract.md): HTTP(S) with and
without Basic auth, SOCKS5 without credentials; **SOCKS with credentials is rejected** — Chromium
would have to authenticate through the URL in its command line.

## 4. What is not covered, on purpose

| Item | State | Why |
|---|---|---|
| Live provider round trips | **skipped** | they need a browser and an authorized session; the CI job must not need secrets, so the scenarios are opt-in (`TEN_X_CHAT_E2E_PROVIDERS=1`, workflow `.github/workflows/e2e.yml`) |
| Grok, Perplexity in the readiness matrix | **unverified** | they are not part of the matrix of PR #14 (no authorized Grok session; Perplexity does not submit through its web UI in that environment) — no claim is made about them |
| DeepSeek | **new, unmeasured** | DeepSeek was added in [#7](https://github.com/gazon1/10x-chat/issues/7) and has an end-to-end scenario, but no authorized session was available for the run |
| Windows / macOS hosts | **not exercised** | the checks ran on Linux; the browser build supports them |
| npm registry name `10x-chat` | **taken by upstream** | the fork cannot be published under that name; the metadata now points at `gazon1/10x-chat`, the install instructions use the repository, and the release job needs a free name (open decision of the maintainer). Until that name is chosen, the `npm publish` step in `.github/workflows/release.yml` is disabled (`if: false`), so a `v*` tag still produces a GitHub Release instead of failing at the publish step |
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
GitHub Release. The publish step is currently disabled (`if: false`) because the registry name
belongs to the upstream project — see the table in §4.

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
