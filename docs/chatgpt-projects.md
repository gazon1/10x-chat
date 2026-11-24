# ChatGPT Projects: creating a conversation inside a project

The investigation [#76](https://github.com/gazon1/10x-chat/issues/76) asked for
before any Project routing is built: can 10x-chat reliably create a **new
conversation inside an existing, user-created ChatGPT Project** through the
supported browser UI, and which observable proves the membership.

**Verdict: go — with the project page as the only entry point.** The flow below
was exercised in a real authenticated session, headed and headless, and the chat
it created was confirmed to belong to the project after a reload. One shortcut
that looks correct is **not** reliable and is named below. The reproducible
check exits 0:

```console
$ bun run spike/chatgpt-project/project-chat.ts g-p-<32 hex>
project page: https://chatgpt.com/g/g-p-<…>/project
heading: chatgpt-use
conversation: https://chatgpt.com/g/g-p-<…>-chatgpt-use/c/<id>
{ "inProject": true, "listed": true }
```

Measured on 2026-11-24 against chatgpt.com with a logged-in Free account. The
reproducible check is `spike/chatgpt-project/project-chat.ts`; the exploratory
scripts that produced the tables below were one-off and are not kept.

## The flow

1. Open the project page: `https://chatgpt.com/g/<project-id>/project`.
   The app rewrites it to `/g/<project-id>-<project-slug>/project`. **The slug is
   decorative**: a wrong slug renders the same project, and the slug-free URL
   works as well. Only `<project-id>` identifies the project.
2. Wait for the project composer — the input says `New chat in <project name>`
   and the page heading is the project name. The page renders a generic shell
   first and canonicalizes a few seconds later, so waiting for the composer is
   the honest readiness check.
3. Submit the prompt through the ordinary composer selector
   (`#prompt-textarea…`, `#send-button` — the ones `providers/chatgpt.ts` already
   uses). No project-specific selector is needed.
4. The URL becomes `/g/<project-id>/c/<conversation-id>`. The conversation is in
   the project.

### What does not work

The project row in the sidebar carries a button `New chat in <project>`
(`aria-label`). Clicking it from the **home page** creates a **global** chat:
the conversation was `6b059113-…`, and opening its bare `/c/<id>` a second time
left it at `/c/<id>` — no project segment, and the project page does not list
it. The button opens the *composer*, not the project. Do not use it as the entry
point; the project page composer is the reliable one.

## Reading the answer

The capture selectors of `providers/chatgpt.ts` work on a project chat, with one
caveat that cost this investigation most of its time: the body of an answer of
today's UI is rendered by the DIL renderer and matches only the **content**
selectors (`[data-markdown-text-style="assistant-message"]`,
`[data-response-body]`, `[data-dil-response]`, `[class*="MarkdownRoot"]`).

`[data-message-author-role="assistant"]` and
`[data-conversation-role="assistant"]` still exist but resolve to the **label**
of a turn (`"ChatGPT said:"`) with an `offsetHeight` of 0–1 px. They count turns;
they do not carry text. `.markdown`, `div.agent-turn` and
`[data-testid^="conversation-turn-"]` matched nothing on these chats at all.

The answer also arrives **late**: the conversation URL is written within seconds,
but the body is empty for the first ~10–15 s after a reload. A capture that
polls the wrong selector and gives up on an empty body will report an empty
answer that is in fact on the screen.

This is the UI of the account measured, not a property of projects — a global
chat on the same account shows the same shape — but any future Project work
should read the answer through the content selectors and keep the late render in
mind.

## The config value

Store the **project id alone**, `g-p-<32 hex>` — the form that appears in
`data-app-action-sidebar-project-id` and in every project URL. The slug is not
identity; storing it would break when the project is renamed.

Validate by navigation, not by shape:

- open `https://chatgpt.com/g/<id>/project`;
- a live project ends on a `/g/<id>…` URL with the project composer and the
  project name as the heading;
- an unknown or malformed id is redirected to `/` — there is no error page.

## The membership signal

**Navigate to the bare `/c/<conversation-id>` and read where the app sends
you.** A chat that belongs to a project is redirected to
`/g/<project-id>/c/<conversation-id>`; a global chat stays at `/c/<id>`.

This is the app's own answer, not a URL we constructed, and it is the only
signal that held up:

| Signal                                        | Project chat | Global chat | Verdict |
| --------------------------------------------- | ------------ | ----------- | ------- |
| URL contains `/g/` after submitting           | yes          | no          | usable, but a URL we wrote ourselves proves nothing |
| Bare `/c/<id>` → rewritten to `/g/…/c/<id>`   | **yes**      | no          | **accepted** — the app resolves it |
| Chat listed in `main a[href*="/c/"]` of the project page | yes | no       | accepted, second opinion (also needs the page to finish loading) |
| The sidebar's project row                     | inconclusive | inconclusive | rejected — see below |

The sidebar row is the trap. Querying "the project row" returns the **first
project of the sidebar** whether or not the chat belongs to it, so a naive check
"does the page have a project row" reports a project for a global chat. A first
draft of this investigation did exactly that and produced a false positive. The
row is only meaningful when the app itself marks it current *and* the chat is
drawn inside it — never trust the row alone. The chat header carries only the
chat title either way.

## Failure and redirect behavior

| Case                                              | Result |
| ------------------------------------------------- | ------ |
| Project id does not exist (`/g/g-p-0000…/project`) | redirected to `/` (home), composer present, no error |
| Malformed id (`/g/not-a-project/project`)          | redirected to `/` |
| Slug wrong (`/g/<id>-not-the-name/project`)        | project renders normally; slug is ignored |
| Conversation id does not exist (`/c/0000…`)         | redirected to `/` |
| Logged out / expired session                       | Cloudflare interstitial ("Just a moment…") first, then the login wall — already covered by the existing antibot and `unauthorized` handling |

The redirect to `/` is the trap: a run that navigates to a dead project and then
submits a prompt **writes into the global chat list** instead of failing. A
future implementation must verify the project page *before* typing, and refuse
when the URL is not a project URL.

## Go/no-go

**Go.** The flow uses the UI a human uses, needs no undocumented endpoint, no
new dependency and no new browser mode: the project page is an ordinary
`goto` and the composer is the selector 10x-chat already types into. The
membership check is a second `goto` of the bare conversation URL and a
comparison of the final URL's project segment.

### Known limitations

- **Verified on one account** (Free tier) with one project. The project page and
  its composer were reproducible across repeated runs, but a paid tier or a large
  account could differ; re-run `spike/chatgpt-project/project-chat.ts` before
  trusting a new account.
- **The probe leaves conversations behind.** The spike script creates a real chat
  in the project on every run and does not delete it — deleting chats is a
  mutation the investigation is not allowed to do.
- **Every project navigation costs a settle** of roughly 2–15 s before the
  composer exists; a run that submits too early types into the home page.
- **The project must already exist.** Creating, renaming, deleting and moving
  chats between projects are out of scope, untested, and stay out.
- **The membership check is one extra navigation** per run — acceptable for a
  review pipeline, too expensive for a tight loop.
- Reasoning-effort pill and model selection were **not** probed inside a
  project; the only prompt sent was a fixed-reply probe.
