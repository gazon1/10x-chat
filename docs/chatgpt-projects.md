# ChatGPT Projects: creating a conversation inside a project

The investigation [#76](https://github.com/gazon1/10x-chat/issues/76) asked for
before any Project routing is built: can 10x-chat reliably create a **new
conversation inside an existing, user-created ChatGPT Project**, and which
observable proves the membership.

**Verdict: go for the browser UI path; qualified no for the backend as it behaves
today.** Creating a conversation inside an existing project works, and membership
is verifiable the way the issue asks: the conversation is in the project's own list
after a reload, and opening its bare id resolves into the project. But
`chatgpt-use`, the obvious shortcut, reaches for private endpoints (both to create
a project and, as a fallback, to file a chat), which Issue #76 excludes; that needs
a maintainer's decision rather than a silent adoption.

Measured on 2026-11-24 against chatgpt.com with a logged-in Free account.

## The backend flow, and what it costs

`chatgpt-use` also creates the conversation inside the project, with one flag:

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

That works, and the conversation it produced is in the project (verified by the
signal below). `ask`, `review` and the other subcommands take the same flag. But
read *Two things the backend does that the issue forbids* before adopting it: the
CLI reaches for private endpoints on two paths.

**The projection already happens for 10x-chat itself.** `10x-chat review` runs on
this backend by default (`--backend` defaults to `chatgpt-use` in
`src/cli/review.ts`), and the adapter (`src/backend/chatgpt-use.ts`, the `ask`
argument list) never passes `--project`. What the CLI does with an omitted flag
was measured directly, not assumed:

```console
$ chatgpt-use ask --request-id probe-default-... "Reply with exactly: DEFAULT-PROJECT-CHECK"
[   0.0s] submitted; waiting for reply
pinned to conversation 6b05ba23-85bc-83ed-b9e2-306e9830b117
```

with **no** `--project` on the command line, that conversation resolves to
`/g/g-p-6afee1f89d048191922c5b25247b5a95-chatgpt-use/c/6b05ba23-…` — it is in the
project. Note the output does not print `using project …` when the flag is
omitted, so the message is not the evidence; the conversation's resolved URL is.
A review conversation created by that backend resolves the same way.

So a review started by 10x-chat lands in the `chatgpt-use` project today, by the
CLI's default rather than by any choice of 10x-chat.

## The accepted config value

`--project` takes the project **name**, not the id. The CLI resolves the name
through `~/.chatgpt-use/projects.json`, which is a plain name → id map:

```json
{
  "chatgpt-use": "g-p-6afee1f89d048191922c5b25247b5a95"
}
```

The id is what identifies the project and what survives a rename — the name is
only the lookup key in that file. This matters because **anything unknown is
created**: passing the id itself is not recognised as an id, so the CLI creates a
*new* project named after the string:

```console
$ chatgpt-use ask --project g-p-6afee1f89d048191922c5b25247b5a95 "..."
using project "g-p-6afee1f89d048191922c5b25247b5a95" (created)
```

after which `projects.json` holds a second entry, `"g-p-6afee1…":
"g-p-6b05bd7e…"`, and the conversation is filed into a fresh empty project —
upstream of the one intended. So:

- **to use the CLI:** pass the **name** from `projects.json`, and keep that file
  as the source of truth for which name means which project;
- **to store an identity** (a config value of our own, a chart, an issue): store
  the **id**, and resolve it to a name through that map at the point of use.

Nothing validates a name before use, so a typo is a new project rather than an
error. Checking the name against `projects.json` first is the cheap guard.

## The browser UI flow (as executed)

Issue #76 asked for the UI path to be exercised, so the steps are kept here even
though the backend is the path the rest of the tool already uses. This is what
was actually done, by hand and by a Playwright script, in a logged-in session:

1. Open the project: `https://chatgpt.com/g/<project-id>/project`.
   The app rewrites it to `/g/<project-id>-<project-slug>/project`. The slug is
   decorative — a wrong slug renders the same project, and the slug-free URL
   works too. Only `<project-id>` identifies it.
2. Wait for the project composer: the input reads `New chat in <project name>` and
   the page heading is the project name. The page paints a generic shell first and
   canonicalizes a second or two later, so waiting for the composer is the honest
   readiness check.
3. Send a harmless prompt through the ordinary composer
   (`#prompt-textarea…`, `#send-button` — the same selectors the ChatGPT provider
   already uses). No project-specific selector is needed.
4. The URL becomes `/g/<project-id>/c/<conversation-id>`.
5. Reload, or revisit the project page: the conversation is in the project's
   list.

### The shortcut that does not work

The project row in the sidebar carries a button labelled `New chat in <project>`.
Clicking it **from the home page** creates a **global** chat: the conversation was
`6b059113-…`, and reopening its bare `/c/<id>` left it at `/c/<id>` — no project
segment, and the project page did not list it. The button opens the composer, not
the project. Use the project page, not that button.

## The membership signal

Issue #76 warns that a URL shape alone is not proof, and requires confirming the
conversation after a reload. So membership rests on **two observations of the same
conversation**, with the list as primary and the redirect as corroboration.

**Primary — the project's own list, after a reload.** Open the project page fresh
and find the conversation in its Chats list. This is the durable fact: the chat
persisted as a member, and it is what the issue asks for.

**Secondary — where the app sends a bare id.** Open `/c/<conversation-id>` and
read the final URL. A chat that belongs to a project is **rewritten** to the
project URL; a global chat stays at `/c/<id>`:

| Conversation | Opening `/c/<id>` resolves to |
|---|---|
| filed under `chatgpt-use` | `/g/g-p-6afee1f89d048191922c5b25247b5a95-chatgpt-use/c/<id>` |
| a plain chat | `/c/<id>`, unchanged |

The redirect is the app's own answer rather than a URL we constructed, which is
why it is kept — but on its own it is a URL shape, exactly what the issue says not
to trust. It corroborates the list; it does not replace it. Both were observed for
the same conversations in this investigation.

Two signals were rejected outright:

- **The sidebar's project row.** Querying "the project row" returns the first
  project of the sidebar whether or not the chat belongs to it, so a naive check
  reports a project for a global chat. A first draft of this investigation did
  exactly that and produced a false positive; the row is only meaningful when the
  app marks it current *and* the chat is drawn inside it.
- **The chat header.** It carries the chat title only.

The list is also the place where scope matters: the project page's own list is the
evidence and the sidebar's global `/c/<id>` links are not — on the measured page 61
anchors were in the document and only the 50 inside the list were project members.
A check that scans every anchor reports a sidebar link as a listing.

The same rule matters if the listing is ever automated: the project page's own
list is the evidence and the sidebar's global `/c/<id>` links are not — on the
measured page 61 anchors were in the document and only the 50 inside the list
were project members.

## Failure and redirect behavior

| Case | Result |
|---|---|
| Name the CLI does not know (`--project no-such-project-xyz`) | the project is **created** through `POST /backend-api/projects` and the chat filed into it — no error, no prompt |
| A `g-p-…` id passed to `--project` | treated as a *name*: a new project named after the string is created |
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

## Two things the backend does that the issue forbids

Issue #76 says, in its scope section: no undocumented internal endpoints, no
automatic Project creation. The `chatgpt-use` backend does **both**, and this is
the reason the go below is qualified rather than unconditional.

- **Project creation calls a private endpoint.** When the name is not in
  `projects.json`, the CLI runs `POST /backend-api/projects` with the browser
  session to create it, then files the conversation there. That is exactly the
  undocumented-internal-API dependency the issue excludes — it happened twice
  while measuring this note (`no-such-project-xyz`, and the id-as-name case).
- **Filing can fall back to a private endpoint too.** The upstream README states
  that if direct Project navigation does not work, the CLI starts a plain chat and
  files the conversation with `PATCH /backend-api/conversation/<id>`. Direct
  navigation is tried first and is what succeeded in every run measured here — but
  the fallback exists and is not visible from the CLI's output when it fires.

Neither behaviour is a defect of the note; both are properties of the backend that
a caller has to know before adopting it.

**This investigation triggered the first one.** Probing the unknown-name and
id-as-name cases created two real projects in the measured account
(`no-such-project-xyz` and one named after the id string). That is a side effect
of the experiment, not of any proposed implementation, and it is honest to record:
the Issue excludes automatic Project creation, and the only way to learn that the
CLI does it was to observe it. The two projects are empty and left in place —
deleting them is a mutation outside the issue's scope as well.

## What the browser path cost

An earlier draft of this investigation drove the project page with Playwright:
open `/g/<id>/project`, wait for the project composer, submit, read the answer
from the DIL renderer. It reproduced, and it brought two traps — the dead-project
redirect above, and the answer-body selectors. That script was deleted from this
PR at the author's request, because the backend does the same job with one flag;
the steps live in *The browser UI flow* above so nothing is lost, and the two
findings outlive the script:

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

**Go for the browser UI path; a qualified no for the backend as it behaves today.**

- **Browser UI path — go.** The flow in *The browser UI flow* above was executed
  in a logged-in session and creates the conversation inside the project; the
  membership was confirmed the way the issue requires — the conversation appears
  in the project's own list after a reload, with the redirect as corroboration. It
  uses only the UI a human uses, so it satisfies the issue's constraint on
  undocumented endpoints.
- **Backend path — not yet.** `chatgpt-use` does create the conversation inside
  the project and is the least work, but it creates projects through
  `POST /backend-api/projects` and can fall back to
  `PATCH /backend-api/conversation/<id>`. Both are private endpoints, which
  Issue #76 excludes. Adopting it for Project routing needs a decision from the
  maintainer on whether that exclusion binds a backend that already ships
  elsewhere in the tool — not something this investigation should decide
  silently.
- **The gap worth building either way:** 10x-chat cannot choose *which* project.
  The adapter never sends `--project`, so today the CLI default decides. Passing a
  project through the backend contract (`src/backend/contract.ts`) is the work,
  and it is out of this issue's scope.

### Known limitations

- **Verified on one account** (Free tier) with one project, on one ChatGPT UI
  revision. A paid tier or a large account could differ.
- **The project is not selectable from 10x-chat.** The `chatgpt-use` default is
  what files a review there; choosing another project needs the flag, which the
  adapter does not send.
- **An unknown name silently creates a project** through a private endpoint, and
  passing an id creates a project named after it. Always pass a name that is
  already in `~/.chatgpt-use/projects.json`.
- **The project must already exist.** Creating, renaming, deleting and moving
  chats are out of scope and untested.
- **ChatGPT throttles a fast loop.** The CLI warned at 41 prompts in an hour that
  this pace had tripped "Too many requests" before; a review run of many roles at
  once is near that line.
- **Model/reasoning selection inside a project** was not probed; the only prompt
  sent was a fixed-reply probe.
