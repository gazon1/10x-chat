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
npm install -g @gazon1/10x-chat
10x-chat --version
```

The published package contains the compiled CLI — no build step on install. The install downloads the CloakBrowser build (`postinstall`); if that fails, run `npx cloakbrowser install` once by hand.

With npm 11.20+, allow the install script once: `npm install -g @gazon1/10x-chat --allow-scripts=@gazon1/10x-chat` (or run `npx cloakbrowser install` by hand).

The fork is published under the scoped name `@gazon1/10x-chat`, because the unscoped `10x-chat` on npm belongs to the upstream project.

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

**In the playbooks below, never send files.** Not `--file` (inlined into the prompt) and not `--attach` (uploaded) — the model has GitHub: give it the repository URL, the target (the pull request URL, or the compare URL of a pushed branch) and the commit SHAs, and it reads the code, the conventions and the CI run itself. A pull request is the best entry point but not the only one — a pushed branch is reviewed by its base and head SHA, and a change that is not on `origin` at all is reviewed **locally** by the coding agent itself, because no file is ever attached to make it visible. The push happens when the user asked for that publication: a request to review is not a request to publish. Outside the playbooks, `--file` and `--attach` stay available: an ordinary chat about a local file is a normal use of the CLI.

## Playbooks

Two ready-made workflows live next to this file. They are provider-neutral and language-neutral — they work in any repository, with any build system.

| Playbook | File | Use it when |
|---|---|---|
| PR review | [workflows/pr-review.md](workflows/pr-review.md) | The user asks for a review of a PR, a branch, a patch or a diff. |
| Helix-style development | [workflows/helix-development.md](workflows/helix-development.md) | The user asks for a change to be built and gated by checkpoints. |
| Shared report format | [workflows/report-format.md](workflows/report-format.md) | Both playbooks end in this report shape. |

**The split of the work:** the coding agent inspects and changes the target repository and runs its checks. 10x-chat supplies the independent reviewers and the protocol that turns their answers into a verdict. 10x-chat is a reviewer interface, not a build executor.

**The reviewers read the repository on GitHub themselves.** Both playbooks hand the model the GitHub coordinates — repository URL, the target (pull request URL or compare URL), commit SHAs — instead of sending files. The pipeline commits and pushes the branch to `origin` first — with the user's word — then asks for the review. `--file` and `--attach` are not used.

Load the playbook file before starting one of these tasks — it carries the reviewer roles, the finding schema, the evidence rules and the report template.

## Workflow recipes

### 1. Review a pull request, a branch, a patch or a diff

For a real review, use the [PR review playbook](workflows/pr-review.md). Pick the target first — a pull request is the best entry point, but it is not the only one:

| Target | How you recognise it | How it is reviewed |
|---|---|---|
| An existing pull request | `gh pr view` prints a number | remotely, by the PR number/URL and the base/head SHA |
| A pushed branch, no pull request | the branch is on `origin`, `gh pr view` prints nothing | remotely, by the base/head SHA and the compare URL — **no pull request required** |
| Local changes only | `git status --short` is not empty, nothing pushed | ask whether to publish; if no, the agent reviews the diff locally |
| A patch or diff only | the user pasted a patch or gave a patch file | the agent reviews the patch locally |

Read the state — this block never publishes:

```bash
REPO=<owner>/<name>               # the repository under review
BASE_REF=$(gh repo view --json defaultBranchRef -q .defaultBranchRef.name)   # never assume main
git fetch origin "$BASE_REF" --quiet
git status --short                 # read it — add the paths of the change by name
BASE=$(git rev-parse "origin/$BASE_REF")
HEAD=$(git rev-parse HEAD)
PR=$(gh pr view --json number,url -q '"#\(.number) \(.url)"' 2>/dev/null || echo "")
```

If the repository has no default branch, take the base from the pull request the branch would open (`gh pr view <branch> --json baseRefName -q .baseRefName`), and if there is none, from `git symbolic-ref --short refs/remotes/origin/HEAD`. An empty `BASE_REF` makes the fetch fail with an error that looks like a network problem.

Publication — **only after the user's word**, and only when the change is not on `origin` yet:

```bash
git add <path> …                   # add those paths by name — never everything at once
git commit -m "<message>" && git push origin <branch>
HEAD=$(git rev-parse HEAD)
```

Then ask for the review — the brief carries the PR coordinates, or the compare coordinates when the branch has no pull request:

```bash
10x-chat chat --provider chatgpt --new-chat --timeout 1800000 \
  -p "You are reviewing a change of https://github.com/$REPO. Read the code on GitHub yourself:
       Repository:   https://github.com/$REPO
       Pull request: $PR
       Compare:      https://github.com/$REPO/compare/$BASE...$HEAD
       Base: $BASE
       Head: $HEAD
     Report only real problems: bugs, security issues, data loss, broken callers, and risky logic without tests. For each finding give file:line, why it is wrong, and the minimal fix. If there are no blocking issues, say so."
```

- The **pull request** is the best entry point — put its number and URL into the prompt. A reviewer that only gets a branch name does not find the change.
- **A pull request is not required.** A pushed branch is reviewed by its base and head SHA; the reviewer opens the compare URL and the commit page itself — leave the `Pull request:` line empty for that target. Do not ask the user to open a pull request just to make the review possible — a PR is a convenience, not a precondition.
- **Local changes and pasted patches are reviewed locally.** The remote reviewers read the repository on GitHub and no file is ever attached, so they cannot see such a change. Ask the user whether to publish it (commit + push) — only after an explicit "yes" — and if the answer is no, or the push is impossible, the agent reviews the diff or the patch itself, in the same roles and the same finding schema; the report then says explicitly that no independent check on GitHub happened.
- **The read-only review and the publication are separate procedures.** A request to *review* is not a request to *publish*: a request that only asks for a review commits and pushes nothing. Ask the user first — *"The change is not on `origin` yet — may I commit and push it?"* — and run the publication block only after the answer.
- **A pull request is opened only with the user's word — and it is optional.** If the user wants one, ask: *"The branch `<branch>` has no pull request — may I open one?"* Only after the answer comes `gh pr create --base "$BASE_REF" --head <branch> --title "<title>" --body "<what changed>"`. Without that answer nothing is created — and the review still runs on the branch.
- **Never commit what you did not read.** Adding everything at once (the all-files flag of `git add`) sweeps in a leftover file, a local config, a `.env` with credentials. Read `git status --short`, add the paths of the change by name, and read the staged diff before the commit.
- Use `--new-chat` for every independent review; otherwise the same conversation continues and the model remembers the previous verdict.
- `claude` and `perplexity` are the strongest reviewers but run headed. `gemini` is the cheapest reliable headless option.
- `chat --all` sends the *same* prompt to every chat provider. It is a cross-model second opinion on one question — it does **not** give one prompt per reviewer role. Role-specific reviews need one `--provider` run each.
- The reviewer sees what is pushed to `origin`, so the branch must be pushed before asking — when the user asked for the publication. Nothing is attached to the prompt — the reviewer reads the repository itself.

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

- **Never send files in the playbooks.** No `--file` (inlined into the prompt), no `--attach` (uploaded). Give the model the GitHub coordinates (repository URL, the target — pull request URL or compare URL — and the commit SHAs) and it reads the code, the conventions and the CI run itself. A pull request is the best entry point, but it is not the only one: a pushed branch without a pull request is reviewed by its base and head SHA, and a change that is not on `origin` at all (uncommitted work, a pasted patch) is reviewed **locally** by the coding agent — with the same roles and the same finding schema — and the report says that no independent check on GitHub happened. The review target has to be committed and pushed to `origin` first when the user asked for that publication — nothing that is not on GitHub can be reviewed by a remote reviewer. In an ordinary chat, `--file` and `--attach` are still the way to show a local file to the model.
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
