# ChatGPT Projects: creating a conversation inside a project

The investigation [#76](https://github.com/gazon1/10x-chat/issues/76) asked for
before any Project routing is built: can 10x-chat reliably create a **new
conversation inside an existing, user-created ChatGPT Project**, and which
observable proves the membership.

**Verdict: go — and the work is already done by the `chatgpt-use` backend.** The
CLI creates the conversation inside the project with one flag, keys projects by a
stable id, and the conversation it creates is confirmed to belong to the project.
Nothing needs to be built in this repository for the backend path; the only gap
is that 10x-chat cannot yet choose *which* project.

Measured on 2026-11-24 against chatgpt.com with a logged-in Free account.

## The flow

```bash
chatgpt-use ask --project chatgpt-use "Reply with exactly: PROJECT-PROBE-OK"
```

```console
reusing the open ChatGPT tab (new chat, no page reload)
using project "chatgpt-use"
[   0.0s] submitted; waiting for reply
pinned to conversation 6b05b609-9e0c-83ed-ac65-418a9ec6a76f
CHATGPT-USE-PROJECT-OK
```

That is the whole flow: the CLI opens a new chat, files it under the project, and
reports the conversation id in its receipt. `ask`, `review` and the other
subcommands take the same flag.

**The projection already happens for 10x-chat itself.** `10x-chat review` runs on
this backend by default (`src/cli/review.ts`). The adapter
(`src/backend/chatgpt-use.ts`, the `ask` argument list) never passes `--project`,
so the CLI's own default applies — and that default is `chatgpt-use`. A review
started by 10x-chat therefore lands in the `chatgpt-use` project without anyone
asking for it, which is confirmed below.

## The accepted config value

The CLI keys its projects by **name** and stores the identity underneath:
`~/.chatgpt-use/projects.json` is a plain name → id map.

```json
{
  "chatgpt-use": "g-p-6afee1f89d048191922c5b25247b5a95"
}
```

So the stable value is the **project id**, `g-p-<32 hex>` — the form that also
appears in every project URL and in `data-app-action-sidebar-project-id`. The
name is a convenience label on top of it: renaming the project does not change the
id, and the slug in a project URL is decorative (a wrong slug renders the same
project).

A name the CLI does not know is **created** as a new project on first use, so a
misspelled name is not an error — it is a new, empty project. Accepted for this
investigation.

## The membership signal

Open the bare conversation id and read where the app sends you. A chat that
belongs to a project is **rewritten** to the project URL; a global chat stays at
`/c/<id>`:

| Conversation | Opening `/c/<id>` resolves to |
|---|---|
| filed under `chatgpt-use` | `/g/g-p-6afee1f89d048191922c5b25247b5a95-chatgpt-use/c/<id>` |
| a plain chat | `/c/<id>`, unchanged |

This is the app's own answer, not a URL we constructed, and it is the signal that
held up. Two weaker ones were rejected:

- **The sidebar's project row.** Querying "the project row" returns the first
  project of the sidebar whether or not the chat belongs to it, so a naive check
  reports a project for a global chat. A first draft of this investigation did
  exactly that and produced a false positive; the row is only meaningful when the
  app marks it current *and* the chat is drawn inside it.
- **The chat header.** It carries the chat title only.

The same rule matters if the listing is ever automated: the project page's own
list is the evidence and the sidebar's global `/c/<id>` links are not — on the
measured page 61 anchors were in the document and only the 50 inside the list
were project members.

## Failure and redirect behavior

| Case | Result |
|---|---|
| Name the CLI does not know (`--project no-such-project-xyz`) | the project is **created** and the chat filed into it — no error, no prompt |
| Project id does not exist, opened as a URL (`/g/g-p-0000…/project`) | redirected to `/` (home), which has a composer, no error page |
| Malformed URL (`/g/not-a-project/project`) | redirected to `/` |
| Slug wrong (`/g/<id>-not-the-name/project`) | project renders normally; the slug is ignored |
| Conversation id does not exist (`/c/0000…`) | redirected to `/` |
| Logged out / expired session | Cloudflare interstitial ("Just a moment…") first, then the login wall |

The redirect to `/` is a trap for any URL-driven implementation: the home page has
a composer too, so "a composer is visible" proves nothing — check the URL before
typing. The backend path never has this problem, because it does not navigate by
a project URL: it resolves the configured name to an id and lets the CLI file the
chat.

## What the browser path cost, and why it was dropped

An earlier draft of this investigation drove the project page with Playwright:
open `/g/<id>/project`, wait for the project composer, submit, read the answer
from the DIL renderer. It reproduced, but it re-discovered what the backend
already does and brought two traps of its own — the dead-project redirect above,
and the answer-body selectors. The backend is the supported path, so that script
was removed and this note carries the commands instead.

Two things from that work outlive the script and are worth recording:

- **Where the answer text lives today.** The body is rendered by the DIL renderer
  and matches only the content selectors
  (`[data-markdown-text-style="assistant-message"]`, `[data-response-body]`,
  `[data-dil-response]`, `[class*="MarkdownRoot"]`).
  `[data-message-author-role="assistant"]` and
  `[data-conversation-role="assistant"]` still exist but resolve to a zero-height
  `"ChatGPT said:"` label — they count turns, they do not carry text — while
  `.markdown`, `div.agent-turn` and `[data-testid^="conversation-turn-"]` match
  nothing. The body also renders ~10–15 s after a reload.
- **Never type before checking the URL.** The home page and a project page both
  have a composer, so a composer-based readiness check passes after a dead-project
  redirect and writes into the global chat list.

## Go/no-go

**Go.** The backend path is the implementation: it already creates the
conversation inside the project and the membership is verified. The only thing
worth building is passing a project through the backend contract, so a caller can
pick a project other than the `chatgpt-use` default instead of depending on it.
That is a contract change (`src/backend/contract.ts`), not a UI discovery, and it
is out of this issue's scope.

The browser path is **not recommended**: it duplicates the backend and exists
only to avoid traps the backend does not have.

### Known limitations

- **Verified on one account** (Free tier) with one project, on one ChatGPT UI
  revision. A paid tier or a large account could differ.
- **The project is not selectable from 10x-chat.** The `chatgpt-use` default is
  what puts a review there; choosing another project needs the flag, which the
  adapter does not send.
- **A misspelled project name silently creates a project.** Check the name once
  in `~/.chatgpt-use/projects.json` before a batch run.
- **The project must already exist** when an id is used directly. Creating,
  renaming, deleting and moving chats are out of scope and untested.
- **ChatGPT throttles a fast loop.** The CLI warned at 41 prompts in an hour that
  this pace had tripped "Too many requests" before; a review run of many roles at
  once is near that line.
- **Model/reasoning selection inside a project** was not probed; the only prompt
  sent was a fixed-reply probe.
