---
name: 10x-chat
description: Chat with web AI agents (ChatGPT, Gemini, Claude, Grok, Perplexity, DeepSeek) via browser automation. Use when stuck, need cross-validation, want a second-model review, need image generation, want deep research, or need to inspect ChatGPT chats, download ChatGPT artifacts/ZIPs, or upload files to ChatGPT.
---

# 10x-chat — AI Agent Skill

Use 10x-chat to send prompts to web-based AI agents via automated browser sessions. Supports chat, image generation, and deep research. Sessions use a shared persisted profile by default.

## Runtime

- **Browser**: CloakBrowser (a patched Chromium). It is the only supported engine — there is no Firefox/Camoufox runtime.
- **Shared daemon**: one Chromium serves every parallel run over a local HTTP RPC; it stops itself after 30 minutes of idleness.
- **Profiles**: the shared profile (`~/.10x-chat/profiles/default`) holds the login of every provider; `--isolated-profile` gives each provider its own.
- **Proxy**: the environment only (`HTTPS_PROXY`, `HTTP_PROXY`, `ALL_PROXY`, `NO_PROXY`). SOCKS proxies with credentials are refused.
- **Debug artifacts**: `TEN_X_CHAT_BROWSER_DEBUG=1` writes redacted artifacts (metadata, console, screenshot, page source) into `~/.10x-chat/debug/`.

## Installation

```bash
npm install -g --install-links github:gazon1/10x-chat
10x-chat --version
```

The npm registry name `10x-chat` belongs to the upstream project — install this fork from the repository.

`--install-links` is required with npm 11: it installs the git dependency as a copy instead of a symlink into a temporary clone that npm deletes afterwards. Set it once with `npm config set install-links true --location=user`. npm 11.20+ also needs `--allow-scripts=10x-chat` (or a manual `npx cloakbrowser install`) to download the CloakBrowser build.

## When to use

- **Stuck on a bug**: ask another model for a fresh perspective
- **Code review**: send PR diff to GPT / Claude / Gemini for cross-review
- **Cross-validation**: compare answers from multiple models
- **Knowledge gaps**: leverage a model with different training data
- **Image generation**: DALL-E via ChatGPT or Imagen via Gemini
- **Deep research**: long-form analysis via Perplexity, ChatGPT, or Gemini

## Providers

| Provider | Chat | Image | Research | Models | Notes |
|----------|------|-------|----------|--------|-------|
| chatgpt | ✅ | ✅ (DALL-E) | ✅ | — | Headless by default |
| gemini | ✅ | ✅ (Imagen) | ✅ | Fast, **Thinking** (default), Deep Think, Pro | `--model` switches mode |
| claude | ✅ | ❌ | ❌ | — | Runs headed by default |
| grok | ✅ | ✅ | ❌ | — | UI changes often; keep the local checkout current |
| perplexity | ✅ | ❌ | ✅ | — | Runs headed by default (anti-bot) |
| deepseek | ✅ | ❌ | ❌ | deepseek-chat, deepseek-reasoner | `--model` switches the model |

## Commands

```bash
# Login (one-time per provider — opens browser for auth)
10x-chat login chatgpt
10x-chat login gemini
10x-chat login claude
10x-chat login grok
10x-chat login perplexity
10x-chat login deepseek
10x-chat login --status          # check the login state of every provider

# Chat
10x-chat chat -p "Review this code for bugs" --provider chatgpt --file "src/**/*.ts"
10x-chat chat -p "Hard reasoning task" --provider chatgpt --model "GPT-5.6 Sol High"
10x-chat chat --provider gemini --file "path/to/prompt.md" -p "Complete this task"
10x-chat chat --provider gemini --model Pro -p "Solve this math problem"
10x-chat chat --all -p "Compare the answers"          # every chat provider in parallel
# Chats are reused per git repo + branch and provider:
10x-chat chat -p "Now add tests" --provider chatgpt    # same conversation
10x-chat chat -p "Start over" --provider chatgpt --new-chat

# Multi-step provider delegate for external AI callers (JSONL over stdin/stdout)
10x-chat delegate gemini --model Pro
# then send JSON lines: {"action":"status"}, {"action":"submit","prompt":"..."}, {"action":"capture"}, {"action":"close"}

# Image generation
10x-chat image -p "A fox astronaut in space" --provider chatgpt
10x-chat image -p "Watercolor landscape" --provider gemini --save-dir ./images

# Deep research (long-form, 5-10 min)
10x-chat research -p "Latest breakthroughs in quantum computing" --provider perplexity
10x-chat research -p "Hard technical research" --provider gemini --model "Deep Think"
10x-chat research -p "Market analysis of EVs" --provider chatgpt --timeout 900000

# Dry run / clipboard
10x-chat chat --dry-run -p "Debug this error" --file src/
10x-chat chat --copy -p "Explain this" --file "src/**"

# Provider chat history + local session management
10x-chat history --provider gemini
10x-chat history --provider all --limit 10
10x-chat status
10x-chat session <id> --render

# Install bundled skill to coding agent
10x-chat skill install
```

## Provider delegate

Use `delegate <provider>` when an external AI caller needs flexible multi-step control instead of a single one-shot `chat`, `image`, or `research` command. It opens one provider tab, keeps it alive, reads JSONL commands from stdin, and emits JSONL responses on stdout.

```bash
10x-chat delegate gemini --model Pro <<'EOF'
{"id":1,"action":"status"}
{"id":2,"action":"submit","prompt":"Draft three launch angles for this product."}
{"id":3,"action":"capture","timeoutMs":600000}
{"id":4,"action":"close"}
EOF

printf '%s\n' '{"action":"chat","model":"Thinking","prompt":"Review this pasted plan."}' \
  | 10x-chat delegate gemini
```

Actions:
- `status`: return url/title/login state
- `goto`: navigate with `{ "url": "https://..." }`
- `selectModel`: provider UI model/mode switch with `{ "model": "Pro" }`
- `attach`: attach files with `{ "files": ["path/to/file.png"] }`
- `submit`: submit prompt without waiting
- `capture`: wait for and extract the current response
- `chat`: select optional model/files, submit, then capture
- `eval`: run a page evaluation script for inspection/debugging
- `close`: close the browser tab and end the delegate

Flags: `--model`, `--headed`, `--timeout <ms>`, `--isolated-profile`, `--no-login-check`.

## Parallel sessions

The daemon makes parallel runs stable. All providers share one Chromium:

```bash
# Login all once
10x-chat login gemini
10x-chat login claude
10x-chat login chatgpt

# Run concurrently — each opens a tab in the shared daemon
10x-chat chat --provider gemini -p "Your prompt" --file context.md &
10x-chat chat --provider claude -p "Your prompt" --file context.md &
10x-chat chat --provider chatgpt -p "Your prompt" --file context.md &
wait
```

## Browser mode

- **Headless (default for chatgpt, gemini, grok, deepseek)**: no visible window
- **Headed (default for claude, perplexity)**: visible Chromium window (anti-bot protection)
- **Force headed**: `--headed` flag on any provider
- **Force headless**: `--headless` flag on any provider

The daemon stores the headless/headed mode in its state file. If you switch modes, the daemon restarts automatically.

## Profile modes

**Shared (default):** One browser profile, all providers share cookies.

**Isolated:** Separate profile per provider: `--isolated-profile`

```bash
# Migrate from isolated to shared
10x-chat migrate
```

## ChatGPT artifacts (helper script)

For ChatGPT sidebar inspection, downloading artifact buttons, uploading files and polling, use the bundled helper. It drives the same CloakBrowser build as the CLI. Resolve `$SKILL_DIR` to this skill directory.

```bash
SKILL_DIR=~/.codex/skills/10x-chat   # wherever `10x-chat skill install` put it

# List visible ChatGPT chats
xvfb-run -a node "$SKILL_DIR/scripts/chatgpt-files.mjs" list --limit 12

# Inspect a conversation for downloadable artifacts/buttons
xvfb-run -a node "$SKILL_DIR/scripts/chatgpt-files.mjs" inspect \
  --url "https://chatgpt.com/c/<conversation-id>"

# Download the latest matching artifact button from a conversation
xvfb-run -a node "$SKILL_DIR/scripts/chatgpt-files.mjs" download \
  --url "https://chatgpt.com/c/<conversation-id>" \
  --label "Download the full updated code ZIP" \
  --out-dir ./downloads

# Upload files into ChatGPT and submit a prompt
xvfb-run -a node "$SKILL_DIR/scripts/chatgpt-files.mjs" upload \
  --file /path/to/file.zip \
  --prompt "Use this uploaded file and summarize the implementation."
```

The helper reads the shared profile (`~/.10x-chat/profiles/default`); `TEN_X_CHAT_CHATGPT_PROFILE`, `TEN_X_CHAT_REPO` and `TEN_X_CHAT_DOWNLOAD_DIR` override the defaults.

After downloading a ZIP, always verify it before claiming success:

```bash
sha256sum /path/to/file.zip
unzip -t /path/to/file.zip
```

## Daemon management

```bash
# Check daemon state
cat ~/.10x-chat/browser-daemon.json

# Force stop daemon
# (the CLI calls stopDaemon() on Ctrl+C automatically)
kill $(cat ~/.10x-chat/browser-daemon.json | python3 -c "import sys,json; print(json.load(sys.stdin)['pid'])")
```

## Tips

- **Login first**: `login <provider>` once per provider. Sessions persist in `~/.10x-chat/profiles/`
- **Use `--headed`** if a provider is flaky (Grok especially)
- **Keep file sets small**: fewer files + focused prompt = better answers
- **Research needs longer timeouts**: `--timeout 600000` for 10-min research jobs
- **Image gen can take 1-2 min**: use `--timeout 120000` when needed
- **Use `--dry-run`** to preview what will be sent
- **Debug with artifacts**: `TEN_X_CHAT_BROWSER_DEBUG=1` before the failing command

## Known issues

- **Grok**: UI changes frequently. Keep the local checkout current and use `--headed` for best reliability
- **ChatGPT/Grok sessions expire quickly**: login again if you get "Not logged in" errors
- **Some provider UIs are flaky under automation**: retry with `--headed` before assuming a hard failure

## Safety

- Never include credentials, API keys, or tokens in the bundled files
- The tool opens a real browser with real login state. Treat it like your own browser session
