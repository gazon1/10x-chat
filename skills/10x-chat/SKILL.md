---
name: 10x-chat
description: Ask another AI model (ChatGPT, Gemini, Claude, Grok, Perplexity, DeepSeek) from the terminal using your logged-in browser — no API key. Use for a second opinion on a bug, cross-model code review, PR review, gated Helix-style development, deep research, or image generation. Load when the user mentions 10x-chat or asks how to use it.
---

# 10x-chat

10x-chat sends a prompt to a web AI chat through a real, logged-in browser. It is a CLI over Playwright/CloakBrowser, not an API client. The model reads the code itself — from the GitHub coordinates in the prompt, not from files you send it.

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
# The reviewer reads the repository on GitHub itself — point it at the URLs
10x-chat chat --provider chatgpt --new-chat \
  -p "Review https://github.com/owner/repo/pull/42 (base <sha>, head <sha>). Report only real problems."

# Fresh conversation (default reuses the one stored per repo+branch+provider)
10x-chat chat --provider claude --new-chat -p "..."

# Ask every chat provider in parallel
10x-chat chat --all --new-chat -p "..."

# Preview exactly what will be sent (no browser)
10x-chat chat -p "..." --dry-run

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

**Never send files.** Not `--file` (inlined into the prompt) and not `--attach` (uploaded) — the model has GitHub: give it the repository URL, the pull request URL and the commit SHAs, and it reads the code, the conventions and the CI run itself. The review target has to be pushed to `origin` first, because nothing that is not on GitHub can be reviewed — and the push happens when the user asked for that publication: a request to review is not a request to publish.

## Playbooks

Two ready-made workflows live next to this file. They are provider-neutral and language-neutral — they work in any repository, with any build system.

| Playbook | File | Use it when |
|---|---|---|
| PR review | [workflows/pr-review.md](workflows/pr-review.md) | The user asks for a review of a PR, a branch, a patch or a diff. |
| Helix-style development | [workflows/helix-development.md](workflows/helix-development.md) | The user asks for a change to be built and gated by checkpoints. |
| Shared report format | [workflows/report-format.md](workflows/report-format.md) | Both playbooks end in this report shape. |

**The split of the work:** the coding agent inspects and changes the target repository and runs its checks. 10x-chat supplies the independent reviewers and the protocol that turns their answers into a verdict. 10x-chat is a reviewer interface, not a build executor.

**The reviewers read the repository on GitHub themselves.** Both playbooks hand the model the GitHub coordinates — repository URL, pull request URL, commit SHAs — instead of sending files. The pipeline commits and pushes the branch to `origin` first — with the user's word — then asks for the review. `--file` and `--attach` are not used.

Load the playbook file before starting one of these tasks — it carries the reviewer roles, the finding schema, the evidence rules and the report template.

## Workflow recipes

### 1. Review a pull request

For a real review, use the [PR review playbook](workflows/pr-review.md). The short version:

```bash
REPO=<owner>/<name>               # the repository under review
BASE_REF=main
git fetch origin "$BASE_REF" --quiet
git status --short                 # read it — add the paths of the change by name
git add <path> … && git commit -m "<message>" && git push origin <branch>
BASE=$(git rev-parse "origin/$BASE_REF")
HEAD=$(git rev-parse HEAD)
gh pr view --json number,url >/dev/null 2>&1 \
  || gh pr create --base "$BASE_REF" --head <branch> --title "<title>" --body "<what changed>"
PR=$(gh pr view --json number,url -q '"#\(.number) \(.url)"')

10x-chat chat --provider chatgpt --new-chat --timeout 1800000 \
  -p "You are reviewing pull request $PR of https://github.com/$REPO. Read the code on GitHub yourself:
       Repository:   https://github.com/$REPO
       Pull request: $PR
       Base: $BASE
       Head: $HEAD
     Report only real problems: bugs, security issues, data loss, broken callers, and risky logic without tests. For each finding give file:line, why it is wrong, and the minimal fix. If there are no blocking issues, say so."
```

- The **pull request** is the reviewer's entry point — create it before asking, and put its number and URL into the prompt. A reviewer that only gets a branch name does not find the change.
- Use `--new-chat` for every independent review; otherwise the same conversation continues and the model remembers the previous verdict.
- `claude` and `perplexity` are the strongest reviewers but run headed. `gemini` is the cheapest reliable headless option.
- `chat --all` sends the *same* prompt to every chat provider. It is a cross-model second opinion on one question — it does **not** give one prompt per reviewer role. Role-specific reviews need one `--provider` run each.
- The reviewer sees what is pushed to `origin`, so commit and push before asking — when the user asked for the publication. Nothing is attached to the prompt — the reviewer reads the repository itself.

### 2. Second opinion on a failure

```bash
10x-chat chat --provider chatgpt --new-chat --timeout 600000 \
  -p "In https://github.com/<owner>/<name> (branch <branch>, commit <sha>) the tests fail like this:

<the failing output, pasted into the prompt>

Identify the root cause. Do not propose a rewrite."
```

The reviewer opens the failing file on GitHub itself — paste only the failing output. If the failure is in a state that is not on `origin`, push it first (with the user's word); there is no attachment fallback.

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

- **Never send files.** No `--file` (inlined into the prompt), no `--attach` (uploaded). Give the model the GitHub coordinates (repository URL, pull request URL, commit SHAs) and it reads the code, the conventions and the CI run itself. The review target has to be committed and pushed to `origin` first, when the user asked for that publication — nothing that is not on GitHub can be reviewed.
- **Check login first.** `login --status` before a batch of runs; a failed run wastes minutes.
- **Keep the brief short.** The prompt carries coordinates, the role and the expected output format — not the code. Use `--dry-run` when unsure what will be sent.
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
