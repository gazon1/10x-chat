---
name: 10x-chat
description: Ask another AI model (ChatGPT, Gemini, Claude, Grok, Perplexity, DeepSeek) from the terminal using your logged-in browser — no API key. Use for a second opinion on a bug, cross-model code review, PR review, deep research, or image generation. Load when the user mentions 10x-chat or asks how to use it.
---

# 10x-chat

10x-chat sends a prompt — with files attached as context — to a web AI chat through a real, logged-in browser. It is a CLI over Playwright/CloakBrowser, not an API client.

## Why it exists

- **No API key, no per-token bill.** It reuses the subscriptions the user already pays for (ChatGPT, Gemini, Claude Pro, etc.).
- **A different model, not a bigger context window.** The point is a second opinion: a reviewer that did not write the code, a model with different training data, a cross-check before shipping.
- **One command, scriptable.** Output goes to stdout, so it drops into any agent workflow or CI-ish shell script.

Use it when the user says "ask another model", "get a second opinion", "cross-review this", "review this PR", "does this look right", or when you are stuck and a different model's take is worth more than another pass of your own.

## Install

### The skill (for the coding agent)

```bash
npx skills add gazon1/10x-chat --skill 10x-chat -g -y
```

`-g` installs for the user (all projects), `-y` skips prompts. Without `-g` it lands in the current project. Drop `-g` and add `-a claude-code cursor` (or `-a '*'`) to target specific agents. The bundled installer is equivalent for Codex-style layouts:

```bash
10x-chat skill install        # → ~/.codex/skills/10x-chat
```

Manual fallback: copy `skills/10x-chat/` into the agent's skills directory (`~/.agents/skills/`, `~/.claude/skills/`, `.claude/skills/`, or whatever the agent reads).

### The CLI (Linux only)

```bash
npm install -g --install-links github:gazon1/10x-chat
10x-chat --version
```

npm 11 notes: `--install-links` is required for git installs; npm 11.20+ also needs `--allow-scripts=10x-chat` (or a manual `npx cloakbrowser install`) so the CloakBrowser build downloads. The npm registry name `10x-chat` belongs to the upstream project — install this fork from the repository.

## First run — check before you send anything

```bash
10x-chat --version
10x-chat login --status        # login state of every provider
```

- If a provider is **not logged in**, stop and ask the user to run `10x-chat login <provider>`. It opens a browser window that needs a human. Never try to type credentials, solve a CAPTCHA, or reuse the user's cookies yourself.
- Providers marked **headed** (`claude`, `perplexity`) need a display. On a headless machine wrap the command: `xvfb-run -a 10x-chat ...`.
- `chatgpt` and `perplexity` are Cloudflare-protected. An `antibot` failure means a human must solve the challenge in the window that stays open — tell the user, don't retry in a loop.

## Core commands

```bash
# Chat, files as context
10x-chat chat --provider gemini -p "Review this for race conditions" --file src/queue.ts

# Fresh conversation (default reuses the one stored per repo+branch+provider)
10x-chat chat --provider claude --new-chat -p "..." --file pr.diff

# Ask every chat provider in parallel
10x-chat chat --all --new-chat -p "..." --file pr.diff

# Preview exactly what will be sent (no browser)
10x-chat chat -p "..." --file "src/**/*.ts" --dry-run

# Deep research (minutes, not seconds)
10x-chat research --provider perplexity --timeout 900000 \
  -p "..." --save-dir ./notes

# Image generation
10x-chat image --provider gemini --save-dir ./assets -p "..."

# History and past sessions
10x-chat history --provider gemini --limit 10
10x-chat status
10x-chat session <id> --render
```

Sessions are saved under `~/.10x-chat/sessions/<id>/`; the response is also printed to stdout, so `> review.md` works.

## Workflow recipes

### 1. Review a pull request

Build a focused diff first — the whole repo is noise:

```bash
git fetch origin main --quiet
git diff origin/main...HEAD > /tmp/pr.diff

10x-chat chat --provider claude --new-chat --timeout 900000 \
  --file /tmp/pr.diff \
  -p "You are reviewing a pull request. Report only real problems: bugs, security issues, data loss, broken callers, and risky logic without tests. For each finding give file:line, why it is wrong, and the minimal fix. If there are no blocking issues, say so."
```

- Use `--new-chat` for every independent review; otherwise the same conversation continues and the model remembers the previous verdict.
- `claude` and `perplexity` are the strongest reviewers but run headed. `gemini` is the cheapest reliable headless option.
- For a cross-model verdict, run the same prompt with `--all` and compare. Two models agreeing on a finding is a much stronger signal than one.
- The diff excludes untracked files. Add the ones that matter with another `--file`.

### 2. Second opinion on a failure

```bash
10x-chat chat --provider gemini --new-chat --timeout 600000 \
  --file src/problem.ts --file /tmp/test-output.log \
  -p "Tests fail with the output in test-output.log. The source is problem.ts. Identify the root cause. Do not propose a rewrite."
```

Include the failing output and the smallest set of source files. Fewer, focused files produce better answers than the whole `src/`.

### 3. Cross-validation of a decision

```bash
10x-chat chat --all --new-chat -p "Compare PostgreSQL advisory locks and a Redis lock for this use case. Name the failure mode of each." > /tmp/compare.txt
```

### 4. Long-form research

```bash
10x-chat research --provider perplexity --timeout 900000 \
  -p "State of the art in browser automation anti-bot evasion in 2026" --save-dir ./docs/notes
```

## Agent rules

- **Check login first.** `login --status` before a batch of runs; a failed run wastes minutes.
- **Keep bundles small.** `--file` accepts globs. Include the code under review, not the repository. Use `--dry-run` when unsure.
- **Timeout deliberately.** Defaults are in seconds-to-minutes; research and reasoning models need `--timeout 600000`–`900000`. A truncated answer prints a warning — re-run with a larger timeout rather than trusting it.
- **Conversation reuse is a feature.** Within the same git repo + branch + provider, follow-ups land in the same chat. Use that for "now fix it"; use `--new-chat` for independent judgments.
- **Exit code 1 means failure**, with a hint printed. `antibot` → ask the user to solve it; `unauthorized` → `10x-chat login <provider>`; `unavailable` → retry later or another provider.
- **Never send secrets.** Do not bundle `.env`, keys, tokens, or private customer data. Treat the session like the user's own browser — it is.

## Providers

| Provider | Chat | Image | Research | Default mode | Notes |
|---|---|---|---|---|---|
| chatgpt | yes | DALL-E | yes | headless | Cloudflare-protected; strongest general model |
| gemini | yes | Imagen | yes | headless | Modes: Fast, Thinking (default), Deep Think, Pro via `--model` |
| claude | yes | no | no | **headed** | Best for code review |
| grok | yes | yes | no | headless | UI changes often; use `--headed` if flaky |
| perplexity | yes | no | yes | **headed** | Cloudflare-protected; best for research |
| deepseek | yes | no | no | headless | `--model deepseek-chat` or `deepseek-reasoner` |

`--headed` / `--headless` override the default. Parallel runs share one Chromium daemon (tabs, ref-counted), so `chat --all` and backgrounded runs are safe.

## Delegate (advanced)

For multi-step scripted control from another program, `delegate <provider>` keeps one tab alive and speaks JSONL over stdin/stdout:

```bash
10x-chat delegate gemini --model Pro <<'EOF'
{"id":1,"action":"status"}
{"id":2,"action":"chat","prompt":"Review this plan."}
{"id":3,"action":"close"}
EOF
```

Actions: `status`, `goto`, `selectModel`, `attach`, `submit`, `capture`, `chat`, `eval`, `close`.

## ChatGPT file helper

`scripts/chatgpt-files.mjs` (same directory as this skill) lists ChatGPT chats, inspects a conversation, downloads artifacts, and uploads files:

```bash
SKILL_DIR=~/.agents/skills/10x-chat   # wherever the skill was installed
xvfb-run -a node "$SKILL_DIR/scripts/chatgpt-files.mjs" list --limit 12
xvfb-run -a node "$SKILL_DIR/scripts/chatgpt-files.mjs" inspect --url "https://chatgpt.com/c/<id>"
xvfb-run -a node "$SKILL_DIR/scripts/chatgpt-files.mjs" download --url "https://chatgpt.com/c/<id>" --label "..." --out-dir ./downloads
xvfb-run -a node "$SKILL_DIR/scripts/chatgpt-files.mjs" upload --file ./x.zip --prompt "Summarize this."
```

Verify any downloaded ZIP before reporting success: `sha256sum file.zip && unzip -t file.zip`.

## Troubleshooting

- **"Not logged in"** → `10x-chat login <provider>` (human required).
- **Bot challenge** → leave the window open and ask the user to solve it; the clearance is saved for the next run.
- **Empty or truncated answer** → raise `--timeout`, retry with `--headed`.
- **Flaky UI** → retry `--headed`; if it persists, the provider's selectors changed — use another provider.
- **Debug artifacts** → `TEN_X_CHAT_BROWSER_DEBUG=1` before the command writes to `~/.10x-chat/debug/`.
- **Proxy** → `HTTPS_PROXY` / `HTTP_PROXY` / `NO_PROXY`, or the `proxy` section of `~/.10x-chat/config.json`.
