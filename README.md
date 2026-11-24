# 10x-chat

> Chat with web AI agents (ChatGPT, Gemini, Claude, Grok, Perplexity, DeepSeek) from your terminal via browser automation.

10x-chat drives a **patched Chromium** ([CloakBrowser](https://www.npmjs.com/package/cloakbrowser)) through Playwright, with persisted login profiles. Login once, then send prompts — bundled with file context — from your CLI or AI coding agent.

## Use with OpenClaw

Paste this into your [OpenClaw](https://openclaw.ai) chat to install as a skill:

```text
https://raw.githubusercontent.com/gazon1/10x-chat/refs/heads/main/skills/10x-chat/SKILL.md
```

## Prerequisites

| Requirement | Version |
|---|---|
| Node.js | ≥ 22 (or Bun ≥ 1.3) |
| OS | Linux x86_64/arm64 — the supported platform (see the note below) |
| Display | only for the headed mode — the headed mode is the default for ChatGPT, Claude and Perplexity |

> [!NOTE]
> **Linux only.** The browser build of CloakBrowser also ships for macOS and Windows, but 10x-chat does not run there: the lock that guards the browser profiles and the secrets store is an **abstract unix socket**, and only the kernel of Linux provides one. On macOS and Windows every launch of a browser and every command that touches the store fails with `The lock of 10x-chat is an abstract unix socket — it works on Linux only.`

No system Chromium is needed: the `postinstall` step of the package downloads the CloakBrowser build into `~/.cloakbrowser/`. If that download fails, the install fails — the CLI then reports that the browser is missing; re-run the install or run `npx cloakbrowser install` once by hand.

## Install

```bash
npm install -g @gazon1/10x-chat
```

The published package contains the compiled CLI — no TypeScript build and no devDependencies on install. The install downloads the CloakBrowser build (`postinstall`). Every example below uses the `10x-chat` binary of a global install.

> [!NOTE]
> With npm 11.20+, the install scripts of a dependency are not run until they are allowed: add `--allow-scripts=@gazon1/10x-chat` to the install command, or run `npx cloakbrowser install` once by hand.

> [!NOTE]
> The fork is published under the scoped name `@gazon1/10x-chat`: the unscoped `10x-chat` on npm belongs to the upstream project, which still ships the integrations that were removed here.

## Quick Start

```bash
# 1. Login to a provider (opens a browser window)
10x-chat login chatgpt

# 2. Send a prompt
10x-chat chat -p "Explain this error" --provider chatgpt

# 3. View session history
10x-chat status
```

> [!TIP]
> Bun starts the CLI faster: `bun run src/bin/cli.ts …` in a checkout, `bunx` for a published package.

## Browser runtime

The runtime is **CloakBrowser (a patched Chromium)** — there is no other supported engine.

Firefox/Camoufox was evaluated and rejected: the migration would invalidate every provider selector (they were written against Chromium), the stealth script fakes Chromium-specific APIs, and Camoufox cannot carry a SOCKS proxy with credentials. The full measurement is in
[docs/refactor-3-8-camoufox.md](docs/refactor-3-8-camoufox.md) and
[docs/refactor-4-9-camoufox-production-readiness.md](docs/refactor-4-9-camoufox-production-readiness.md).

## Proxy

The proxy comes from the config file, from the environment, or from nowhere — in that order. A config file without a `proxy` section keeps using the environment; `proxy.enabled: false` switches the proxy off completely.

```bash
# persist a proxy (config wins over the environment)
10x-chat config proxy set http://proxy.example:3128 --bypass localhost,127.0.0.1
10x-chat config proxy disable   # no proxy at all (suppresses the environment)
10x-chat config proxy clear     # back to the environment proxy, if any
```

The credentials of the proxy are not part of the config file — they live in the secrets store under the names `proxy.username` and `proxy.password`:

```bash
10x-chat secrets set proxy.username   # asks for the value, input hidden
10x-chat secrets set proxy.password
```

Migrating from environment-only proxy configuration is backward compatible: keep
no `proxy` section and `HTTPS_PROXY` / `HTTP_PROXY` / `NO_PROXY` keep working;
persist them once with `config proxy set …` to stop depending on the shell
environment.

| Proxy | Supported |
|---|---|
| `http://` / `https://` without credentials | yes |
| `http://` with Basic auth | yes — the credentials go to Playwright, the browser only sees the bare proxy URL |
| `socks5://` without credentials | yes |
| `socks4://` / `socks5://` **with** credentials | **no** — rejected, because Chromium would have to authenticate through the URL in its command line |

The full contract (the order of the variables, where the credentials live, why SOCKS with credentials is refused) is in [docs/config-contract.md](docs/config-contract.md).

## Secrets

Provider API keys and proxy credentials are stored once — in the **system
keyring** (the Secret Service of the desktop session) or, as a fallback, in
`~/.10x-chat/secrets.json` (`0600` on Unix) — and referred to by name in the
config file. `config show` never prints secret values and reports each
reference as configured or missing.

```bash
10x-chat secrets set deepseek-key   # asks for the value, input hidden
10x-chat secrets list               # the names — never the values
10x-chat secrets remove deepseek-key

10x-chat config set provider-key deepseek deepseek-key
10x-chat config unset provider-key deepseek
10x-chat config show                # stored config + effective non-secret state
```

DeepSeek currently has a native API transport (OpenAI-compatible chat
completions). As other native or OpenAI-compatible providers gain API
transports, configure their key the same way. The backend is chosen by
`credentialStorage` (`auto`, `keyring`, or `file`). Details in
[docs/secrets.md](docs/secrets.md).

## Login and sessions

`login` opens a headed browser, waits until the provider reports a logged-in session and stores the cookies in the browser profile. In the default **shared** profile mode all providers use the same profile (`~/.10x-chat/profiles/default/storage-state.json`), so one login per provider is enough and parallel runs share it.

```bash
10x-chat login chatgpt      # one provider
10x-chat login --all        # every provider, one after another
10x-chat login --all --tabs # every provider as a tab of one window
10x-chat login --status     # check the login state of every provider
```

- `--isolated-profile` gives every provider its own profile (`~/.10x-chat/profiles/<provider>`), `--profile <name>` a named one.
- `migrate` merges the old per-provider profiles into the shared one.
- Every run writes its own session (`meta.json`, `bundle.md`, `response.md`) into `~/.10x-chat/sessions/<uuid>/`; `status` lists them, `session <id>` shows one.
## Conversation reuse

A browser chat remembers the provider conversation of the current **git repository and branch**. The next `chat` run in the same repository and branch appends to that conversation instead of starting a new one — for every provider that exposes a stable conversation URL: Gemini, Claude, Grok, Perplexity and DeepSeek.

**ChatGPT is the exception.** Its plain chat is served by the `chatgpt-use` backend, and that backend cannot continue a conversation: every `10x-chat chat --provider chatgpt` run is a new chat. A run that finds a stored ChatGPT conversation says so and starts a new one; the entry stays, because the browser path (`--headed`) still reopens it. For a multi-turn chat use another provider, or force the browser path of ChatGPT with one of the browser flags.

```bash
cd ~/src/my-project          # branch: feature/login
10x-chat chat -p "Implement the login form" --provider gemini
10x-chat chat -p "Now add validation"       --provider gemini   # same chat
10x-chat chat -p "Start over"               --provider gemini --new-chat
```

The cache lives in `~/.10x-chat/conversations.json`:

```json5
{
  repos: {
    "/home/me/src/my-project": {
      "feature/login": {
        chatgpt: { url: "https://chatgpt.com/c/…", id: "…", updatedAt: "…" },
        claude:  { url: "https://claude.ai/chat/…", id: "…", updatedAt: "…" }
      }
    }
  }
}
```

- The key is the repository **root** (a run from a subdirectory finds the same chat) and the checked-out branch. A detached HEAD uses the short commit; outside git the working directory is used.
- A conversation the provider no longer serves (deleted, expired, or redirected to a new chat) is dropped automatically and a new one is created.
- `--new-chat` forces a fresh conversation and replaces the stored entry.
- `chat --all` reuses one conversation per provider for the same repository and branch.
- The API transport (`--transport api`) has no conversation — it is a single HTTP request.
- `delegate` keeps one long-lived browser session; it does not use this cache.

## Models and headless

The model is chosen in this order: `--model` → `defaultModel` of the config file (chat and delegate only) → the default of the provider. `research` selects a model only when asked to; `image` has no model selection.

```bash
10x-chat config set model Pro
10x-chat chat -p "…" --provider chatgpt --model Instant
```

ChatGPT's current UI (including the free plan) does not render a model picker. The CLI probes briefly and then keeps the account's current model; the `Selecting model: …` line is a no-op in that case.

Claude and Perplexity set `requiresHeaded` because their sites block headless Chromium. ChatGPT is headless by default too (CloakBrowser clears its Cloudflare check); force a windowless browser on any provider with `--headless`, or a visible one with `--headed`:

```bash
10x-chat chat -p "…" --provider claude --headless
```

A Cloudflare challenge cannot be solved in a headless window: run once headed (or `10x-chat login <provider>`) to refresh the clearance cookie. If you need a headed browser that does not open on your desktop, run it under Xvfb (`sudo dnf install xorg-x11-server-Xvfb` on Fedora):

```bash
xvfb-run -a -s "-screen 0 1280x900x24" env -u WAYLAND_DISPLAY \
  10x-chat chat -p "…" --provider chatgpt
```

The full practical guide — proxy precedence, proxy credentials, models, headless and Xvfb — is in [docs/usage.md](docs/usage.md).

## Transports

A prompt reaches a provider through the **browser** (the default — the web app is driven, a logged-in session is needed) or through the **HTTP API** of the provider (`--transport api` — an API key from the secrets store is needed, no browser is started).

```bash
10x-chat secrets set deepseek-key
10x-chat config set provider-key deepseek deepseek-key
10x-chat chat -p "Explain this" --provider deepseek --transport api
```

`chat --all` runs the browser transport only and cannot be combined with
`--transport api` (no mixed transports, no unexpected paid API calls). DeepSeek
currently has a native API transport (OpenAI-compatible chat completions); as
other native or OpenAI-compatible providers gain API transports, configure them
the same way. See [docs/transports.md](docs/transports.md).

## Backends

A prompt can also reach a provider through a **backend** — a program that
answers it instead of a browser. The ChatGPT backend drives the
[`chatgpt-use`](docs/chatgpt-use-backend.md) CLI, which owns the window of
ChatGPT: no browser is started by 10x-chat, and the login lives in the
browser of `chatgpt-use`.

**It serves the plain ChatGPT chat by default** — `chat --provider chatgpt`
needs no `--backend`:

```bash
10x-chat chat -p "Explain this"                          # the ChatGPT backend
10x-chat chat -p "Explain this" --backend chatgpt-use    # the same run, named
```

A backend is not a provider and not a transport: `--all`, `--transport` and
the browser flags are refused with it. `--new-chat` is accepted, since a
backend run starts a new chat either way. The browser provider of ChatGPT is
still the only path for `image`, `research`, `login`, `history` and `--all` —
and for a `chat` run that passes one of the browser flags.

## Commands

### `login <provider>`

Opens a headed browser for you to authenticate. The session persists across runs.

```bash
10x-chat login chatgpt       # Login to ChatGPT
10x-chat login gemini         # Login to Gemini
10x-chat login claude         # Login to Claude
10x-chat login grok           # Login to Grok
10x-chat login perplexity     # Login to Perplexity
10x-chat login deepseek       # Login to DeepSeek
10x-chat login --status       # Check login status for all providers
```

### `chat`

Send a prompt to an AI provider via browser automation.

```bash
10x-chat chat -p "Review https://github.com/owner/repo/pull/42 (base <sha>, head <sha>)" --provider chatgpt
10x-chat chat -p "Debug this error: <paste the output>" --provider chatgpt
10x-chat chat -p "Explain this" --dry-run              # Preview bundle without sending
10x-chat chat -p "Explain this" --copy                  # Copy bundle to clipboard
10x-chat chat -p "Long task" --timeout 600000 --headed  # 10min timeout, visible browser
```

| Flag | Description |
|------|-------------|
| `-p, --prompt <text>` | **(required)** The prompt to send |
| `--provider <name>` | Provider: `chatgpt`, `gemini`, `claude`, `grok`, `perplexity`, `deepseek` (default: config) |
| `--all` | Send to all chat providers in parallel via browser and compare the answers (browser transport only) |
| `--model <name>` | Model/mode to select in the provider UI (e.g. ChatGPT: `GPT-5.6 Sol High`, `Pro`; Gemini: `Fast`, `Thinking`, `Deep Think`, `Pro`) |
| `-f, --file <paths...>` | Files/globs to bundle as context |
| `-a, --attach <paths...>` | Images/files to upload as attachments |
| `--copy` | Copy bundle to clipboard instead of sending |
| `--dry-run` | Preview the bundle without sending |
| `--headed` | Show browser window during chat (for ChatGPT: the browser path instead of the backend) |
| `--headless` | Force headless, also for the providers that normally run headed (for ChatGPT: the browser path instead of the backend) |
| `--timeout <ms>` | Response timeout in milliseconds (default: the provider's — 1800000 for ChatGPT) |
| `--transport <name>` | `browser` (default) or `api` (requires `--provider` with API support) — see [docs/transports.md](docs/transports.md) |
| `--backend <name>` | Backend instead of the browser: `chatgpt-use` (the `chatgpt-use` CLI) — see [docs/chatgpt-use-backend.md](docs/chatgpt-use-backend.md) |
| `--new-chat` | Start a new conversation instead of reusing the one stored for this repo/branch (no effect on the ChatGPT backend, which always starts a new chat) |
| `--save-images <dir>` | Save the generated images to a directory |
| `--profile <name>` | Use a named browser profile |
| `--isolated-profile` | Use the per-provider browser profile |

### `delegate <provider>`

Start a provider-specific JSONL delegate for external AI callers that need multi-step control instead of a single one-shot prompt. The delegate opens the provider once, keeps the tab alive, then reads JSON commands from stdin and writes JSON responses to stdout.

```bash
# One long-lived provider session controlled over JSONL
10x-chat delegate gemini --model Pro <<'EOF'
{"id":1,"action":"status"}
{"id":2,"action":"submit","prompt":"Draft three launch angles for this product."}
{"id":3,"action":"capture","timeoutMs":600000}
{"id":4,"action":"close"}
EOF

# Convenience combined action: select model/files, submit, capture
printf '%s\n' '{"action":"chat","model":"Thinking","prompt":"Review this pasted plan."}' \
  | 10x-chat delegate gemini
```

Supported actions: `status`, `goto`, `selectModel`, `attach`, `submit`, `capture`, `chat`, `eval`, `close`.

| Flag | Description |
|------|-------------|
| `--model <name>` | Select a model/mode immediately after opening |
| `--headed` | Show browser window |
| `--timeout <ms>` | Default capture timeout |
| `--isolated-profile` | Use per-provider browser profile |
| `--no-login-check` | Start even if login detection fails |

### `image`

Generate images via ChatGPT (DALL-E), Gemini (Imagen), or Grok with non-blocking polling.

```bash
10x-chat image -p "A fox astronaut in space, digital art" --provider chatgpt
10x-chat image -p "Watercolor landscape" --provider gemini --save-dir ./images
10x-chat image -p "Logo design" --provider grok --headed --timeout 120000
```

| Flag | Description |
|------|-------------|
| `-p, --prompt <text>` | **(required)** The image generation prompt |
| `--provider <name>` | Provider: `chatgpt`, `gemini`, `grok` (default: chatgpt) |
| `--headed` | Show browser window |
| `--timeout <ms>` | Generation timeout (default: 120000) |
| `--save-dir <dir>` | Directory to save generated images |

### `research`

Deep research via ChatGPT, Gemini, or Perplexity with non-blocking progress polling. Designed for long-running research tasks (5-10+ minutes).

```bash
10x-chat research -p "Latest breakthroughs in quantum computing" --provider gemini
10x-chat research -p "Hard technical research" --provider gemini --model "Deep Think"
10x-chat research -p "Market analysis of EVs" --provider chatgpt --model "Extra High" --timeout 900000
10x-chat research -p "Compare React vs Vue in 2026" --provider perplexity --save-dir ./reports
```

| Flag | Description |
|------|-------------|
| `-p, --prompt <text>` | **(required)** The research query |
| `--provider <name>` | Provider: `chatgpt`, `gemini`, `perplexity` (default: gemini) |
| `--model <name>` | Optional model/mode to select before starting research |
| `--headed` | Show browser window |
| `--timeout <ms>` | Total timeout (default: 600000 / 10 min) |
| `--poll-interval <ms>` | Progress check interval (default: 5000) |
| `--save-dir <dir>` | Directory to save the research report |

#### ChatGPT Deep Research

ChatGPT Deep Research is selected from the composer `+` (`Add files and more`) menu, then verified by the active `Deep research` pill before the prompt is submitted. Model/thinking level is selected separately from the composer model pill (`Instant`, `Medium`, `High`, `Extra High`, `Pro`) and the GPT family submenu (`GPT-5.6 Sol`, `GPT-5.5`, `GPT-5.4`, `GPT-5.3`, `o3`). You can combine both in one `--model`, e.g. `--model "GPT-5.6 Sol High"`. See [`docs/chatgpt-deep-research.md`](docs/chatgpt-deep-research.md).

### `knowledge`

NotebookLM as a **knowledge provider** — notebooks, sources and grounded
answers. The `notebooklm` CLI of [notebooklm-py](https://github.com/teng-lin/notebooklm-py)
owns the login and the credentials; 10x-chat never sees them.

```bash
pipx install notebooklm-py
notebooklm login

10x-chat knowledge status --json
10x-chat knowledge notebooks list --json
10x-chat knowledge notebooks create --title "Project research" --json
10x-chat knowledge sources add --notebook <notebook-id> --url https://example.com/article --json
10x-chat knowledge sources list --notebook <notebook-id> --json
10x-chat knowledge sources refresh --notebook <notebook-id> --source <source-id> --json
10x-chat knowledge ask --notebook <notebook-id> --question "Extract key decisions and risks" --json
```

| Flag | Description |
|------|-------------|
| `--json` | Machine-readable output — the versioned envelope and nothing else |
| `--profile <name>` | The profile of `notebooklm-py` to use |
| `--timeout <ms>` | The deadline of the operation (default: 120000) |

See [`docs/knowledge.md`](docs/knowledge.md).

### `history`

List chat history visible in provider sidebars (ChatGPT, Gemini, Claude, Grok, Perplexity).

```bash
10x-chat history --provider gemini
10x-chat history --provider all --limit 10
10x-chat history --provider chatgpt --json
```

| Flag | Description |
|------|-------------|
| `--provider <name>` | Provider: `chatgpt`, `gemini`, `claude`, `grok`, `perplexity`, `deepseek`, or `all` (default: all) |
| `--limit <n>` | Maximum items per provider (default: 20) |
| `--headed` | Show browser window |
| `--json` | Output JSON |

### `status`

List local 10x-chat CLI sessions.

```bash
10x-chat status              # Last 24 hours
10x-chat status --hours 72   # Last 3 days
```

### `session <id>`

View details of a specific session.

```bash
10x-chat session <id> --render   # Pretty-print the response
```

### `config`

View or modify configuration (`config show` prints stored config plus effective
non-secret state, with provider secret references marked configured/missing).

```bash
10x-chat config show
10x-chat config set provider gemini
10x-chat config set timeout 600000
10x-chat config set headless false
10x-chat config set profile-mode isolated

# provider API key reference (value lives in the secrets store)
10x-chat config set provider-key deepseek deepseek-key
10x-chat config unset provider-key deepseek

# proxy (config > environment > none)
10x-chat config proxy set http://proxy.example:3128 --bypass localhost,127.0.0.1
10x-chat config proxy disable
10x-chat config proxy clear
```

The order of the settings (CLI flag > config file > default), the rules of the
profiles and the proxy contract are documented in
[docs/config-contract.md](docs/config-contract.md).

### `secrets`

Store credentials outside of the config file — see [Secrets](#secrets).

```bash
10x-chat secrets list
10x-chat secrets set corp-proxy
10x-chat secrets remove corp-proxy
```

### `skill`

Manage the agent integration skill (for Codex, Claude Code, etc).

```bash
10x-chat skill install   # Install SKILL.md to ~/.codex/skills/
10x-chat skill show      # Display SKILL.md content
```

### `migrate`

Merge older per-provider isolated browser profiles into the single shared
profile used by default. Useful when upgrading from a version that stored a
separate profile per provider.

```bash
10x-chat migrate --dry-run            # Preview without making changes
10x-chat migrate                      # Auto-pick the largest profile as the base
10x-chat migrate --source chatgpt     # Use a specific provider's profile as the base
10x-chat migrate --keep               # Keep the old isolated profiles after migrating
```

### `daemon`

Inspect and control the shared browser daemon — the Chromium process that
serves every `chat` run.

```bash
10x-chat daemon status      # PID, port, mode, version, open sessions
10x-chat daemon stop         # Stop it (refuses while another session runs)
10x-chat daemon stop --force # Stop it even with a running session
10x-chat daemon restart      # Replace it with a new one (new code after an update)
```

The daemon runs the code of the package it was started from. After an update
the running daemon is too old, so it is replaced automatically on the next
command — and the install script stops an idle daemon right away. A daemon
that still has the session of another process is never killed: the command
tells you to wait instead.

## File Bundling

The `--file` flag accepts globs. Files are assembled into a markdown bundle sent as the prompt:

```bash
10x-chat chat -p "Review these" --file "src/**/*.ts" "!src/**/*.test.ts"
```

Security-sensitive files (`.env*`, `*.pem`, `*.key`, etc.) are automatically excluded.

The skill's playbooks do not use it: a reviewer that receives a pasted diff cannot see the surrounding code, the conventions or the CI run. They get the GitHub coordinates instead — repository URL, pull request URL, commit SHAs — and read the code themselves. Nothing is attached either: the pipeline commits and pushes the branch to `origin` before the review, because a reviewer can only read what is on GitHub.

## Data Layout

```text
~/.10x-chat/
├── profiles/
│   ├── default/             # Shared profile (default): storage-state.json
│   └── <provider>/          # Isolated or named profile
├── sessions/
│   └── <uuid>/
│       ├── meta.json        # Session metadata
│       ├── bundle.md        # Prompt bundle sent
│       └── response.md      # Captured response
├── conversations.json       # Provider conversation per git repo + branch
├── debug/                   # Debug artifacts (only with TEN_X_CHAT_BROWSER_DEBUG=1)
├── browser-daemon.json      # State of the shared browser daemon
└── config.json              # User configuration
```

`TEN_X_CHAT_HOME` moves the whole directory.

## Agent Integration

10x-chat includes a `SKILL.md` for AI coding agents. Install it with:

```bash
10x-chat skill install
```

This lets agents like Codex or Claude Code use 10x-chat to query other models for cross-validation, code review, or debugging help.

The skill ships three playbooks next to `SKILL.md`: `workflows/pr-review.md` (independent role-specific reviewers, a finding schema, verification and a final verdict), `workflows/helix-development.md` (gated checkpoints with acceptance criteria and evidence) and `workflows/idea-adoption.md` (an external source turned into reuse-first decisions, a plan and approved Issue drafts). The first two end in the shared report format in `workflows/report-format.md`.

The pipeline is: commit → push the branch → open the pull request → ask the reviewer, with the pull request number and URL in the prompt. The reviewer reads the repository on GitHub itself; no files are sent to the provider.

The publication steps happen **only with the user's word** — a request to review something is not a request to publish it. The playbooks keep the read-only review and the publication apart, so an agent that follows them never pushes without permission.

## Supported Providers

| Provider | Status | Models | URL |
|----------|--------|--------|-----|
| ChatGPT | ✅ chat + image | — | chatgpt.com |
| Gemini | ✅ chat + image | Fast, **Thinking** (default), Deep Think, Pro | gemini.google.com |
| Claude | ✅ chat | — | claude.ai |
| Grok | ✅ chat + image | — | grok.com |
| Perplexity | ✅ | — | perplexity.ai |
| DeepSeek | ✅ | deepseek-chat, deepseek-reasoner | chat.deepseek.com |

The provider UIs change without notice — Grok in particular is the most fragile one. A provider that stops answering is usually a changed selector, not a broken login.

## Troubleshooting

| Symptom | What to do |
|---|---|
| `CloakBrowser is not installed or failed to load` | `npm install -g @gazon1/10x-chat` again, or run `npx cloakbrowser install` |
| The browser does not start / no window | the build is missing: `npx cloakbrowser install` (it lands in `~/.cloakbrowser/`) |
| `Not logged in` although you logged in | the session expired — `10x-chat login <provider>` again; `login --status` shows the state of every provider |
| Claude / Perplexity open a window even with headless | both are blocked by anti-bot protection and always run headed; `--headless` overrides it |
| The daemon is busy with another session | another run holds the shared browser — wait for it to finish, or use `--isolated-profile` |
| `SOCKS proxy authentication is not supported…` | use an HTTP proxy with credentials, or a SOCKS proxy without them |
| `Invalid config file …` | the config file is broken — it is an error, not a fallback; fix or delete `~/.10x-chat/config.json` |

### Debug artifacts

Set `TEN_X_CHAT_BROWSER_DEBUG=1` and every browser operation writes its artifacts into `~/.10x-chat/debug/<timestamp>-<provider>-<operation>/`:

```text
meta.json       # the operation, the URL and the duration
events.json     # console messages, page errors, failed requests
screenshot.png  # a screenshot of the page
page.html       # the page source
```

The artifacts are redacted: the userinfo of every URL, cookies, tokens and the home directory of the machine are removed — they are safe to attach to a bug report.

## Development

```bash
bun install
bun run dev login chatgpt      # Run CLI in dev mode
bun run typecheck               # Type check
bun run lint                    # Lint
bun run test                    # Unit tests
bun run test:e2e                # End-to-end scenarios (CLI flows; the live provider scenarios are opt-in)
bun run build                   # Build for production
```

The live provider scenarios need a browser and a logged-in profile:

```bash
TEN_X_CHAT_E2E_PROVIDERS=1 bun run test:e2e                 # every provider
TEN_X_CHAT_E2E_PROVIDERS=gemini,deepseek bun run test:e2e   # only these
```

The result of the last full check run — and the exceptions that are documented on purpose — is in [docs/verification.md](docs/verification.md).

## Publishing

Releases are automated via GitHub Actions. Push a version tag to publish:

```bash
npm version patch   # or minor / major
git push --follow-tags
```

Requires `NPM_TOKEN` secret in the GitHub repository settings.

> [!NOTE]
> The fork is published as the scoped package `@gazon1/10x-chat`, because the unscoped `10x-chat` on npm belongs to the upstream project. The release workflow builds `dist/` and publishes it before creating the GitHub Release.

## Disclaimer

This project is provided **for research and educational purposes only**. It
automates web interfaces that may be subject to the terms of service of the
respective providers. You are solely responsible for how you use it, including
compliance with any applicable terms, and you use it at your own risk.

## License

MIT © Mike Chong (upstream) — this fork is maintained by gazon1. See [LICENSE](./LICENSE).
