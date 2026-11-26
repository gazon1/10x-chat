# The ChatGPT backend of `chatgpt-use`

The ChatGPT implementation of the backend contract
([src/backend/contract.ts](../src/backend/contract.ts)) that does not touch a
browser itself: it drives the `chatgpt-use` CLI, which owns the window of
ChatGPT, sends the prompt and reads the answer.

The adapter lives in [src/backend/chatgpt-use.ts](../src/backend/chatgpt-use.ts).
It speaks the JSON envelope of the CLI and nothing else — no DOM, no selector,
no browser type crosses the seam.

## From the CLI

```bash
10x-chat chat -p "Explain this"                # the plain ChatGPT chat: this backend
10x-chat chat -p "Explain this" --backend chatgpt-use   # the same run, named
10x-chat config set chatgpt-project chatgpt-use  # optional: file new chats into a ChatGPT Project
```

- **This backend is the plain chat of ChatGPT.** `chat --provider chatgpt` needs
  no `--backend`: it reaches the backend through the registry
  (`plainChatBackend` in [src/backend/registry.ts](../src/backend/registry.ts)).
  The browser provider of ChatGPT stays for `image`, `research`, `login`,
  `history`, `--all`, and for a `chat` run that asks for the browser.
- The backend is not a provider and not a transport: `--all`, `--transport`
  and the browser flags (`--headed`, `--headless`, `--profile`,
  `--isolated-profile`) are refused with it, not ignored. `--new-chat` is
  accepted: the run never hands a conversation to the backend, so a new chat
  is what happens either way.
- The backend drives ChatGPT: the provider of the run is `chatgpt`, and
  another one is refused.
- The backend saves no image: `--save-images` is refused with it, not ignored.
- The backend cannot continue a conversation (`conversationReuse: false`). A
  request that names one is refused with `rejected` and the CLI is never
  started; a run that finds a conversation stored for the repository and branch
  says so and leaves the entry alone — the browser path (`--headed`) still
  reopens it — instead of silently starting a new chat.
- The run is stored like any other session — the history of the runs shows it.
- The failure of a backend has its own hint (`busy`, `unavailable`, `timeout`,
  `unknown_submission`, `rejected`, …), not the hint of a provider run.
- The hint of an unusable answer depends on the state of the request: a
  request that may have reached ChatGPT is never sent again — the receipt of
  the CLI says what happened to it (`chatgpt-use status <request-id>`).

## ChatGPT Project destination

`chatgptProject` in `~/.10x-chat/config.json` names an existing ChatGPT Project
for **new** ChatGPT conversations. The value is the project **name** as it
appears in `~/.chatgpt-use/projects.json` — the lookup key
`chatgpt-use --project` accepts. The `g-p-…` id underneath the name is the real
identity.

- The backend resolves the name against `projects.json` **before** running the
  CLI. An unknown name is rejected (`rejected`, `not_submitted`) with an
  actionable message; 10x-chat never passes an unknown name through, because the
  CLI would create a project for it.
- After a successful answer, 10x-chat verifies membership with the project's
  Chats list after a reload — the primary signal from
  [docs/chatgpt-projects.md](chatgpt-projects.md). A bare `/c/<id>` redirect is
  corroboration only. If the conversation is not in that list, the run fails; it
  is not reported as a success.
- Membership is verified through the 10x-chat browser profile. The `chatgpt-use`
  CLI runs in its own browser, so that 10x-chat profile must be logged into the
  same ChatGPT account. `10x-chat login chatgpt` is the normal way to establish
  it.
- The setting is ChatGPT-only. A backend that cannot file a conversation into a
  project rejects the request; nothing is silently created outside the project.
- With nothing configured, behaviour is unchanged. An unconfigured `review` still
  follows the `chatgpt-use` CLI default — today that is the CLI's own
  `chatgpt-use` project — and 10x-chat does not change that by accident.

## How it is called

```bash
chatgpt-use ask --json --request-id <id> --busy fail [--model <level>] \
  [--timeout <seconds>] [--file <path> | --image <path>]... -- "<prompt>"
```

- The process is started **without a shell**, so a prompt or a path is never
  interpolated into a command line.
- **stdout is machine-readable**: it carries exactly one JSON envelope. The
  diagnostics of the CLI come from stderr and are only used in the message of
  a failure.
- The prompt is the positional argument after `--`, so a prompt that starts
  with a dash is not read as an option.
- A prompt that does not fit into one argument of a process travels through
  the **stdin** of the CLI (`--stdin`): the kernel of Linux limits one
  argument to 128 KiB (`MAX_ARG_STRLEN`) and the command line of Windows to
  32 767 characters, and a prompt that is bigger is refused before the CLI
  sees it. The stdin is read as the context of the request, and the
  positional argument asks for the answer of it. The stdin is never read for a
  prompt that fits into an argument (`--no-stdin`).
- The attachments of the request are `--file` (the contents become context);
  the images (png, jpg, jpeg, gif, webp) are `--image` (ChatGPT sees them).
- The model of the request is the level of the composer of ChatGPT
  (`instant`, `medium`, `high`, `extra high`, `pro`, `current`); a name of a
  model of the picker (`GPT-5.5`) is passed as it is.
- When `chatgptProject` is configured, the adapter passes `--project <name>`.
  The name is resolved from `~/.chatgpt-use/projects.json` before the CLI runs;
  an unresolved name is a `rejected` failure and the CLI is not started.

## The envelope

```json
{"status":"completed","request_id":"…","conversation_id":"…","result":{"text":"…"}}
{"status":"busy","request_id":"…","error":{"kind":"busy","message":"…","submitted":"no"}}
```

The envelope is validated, not trusted: a JSON that is not an object, a
completed answer without a text, a completed answer without the id of the
request and the answer of another request are all `invalid_output`.

| The kind of the CLI                        | The kind of the contract      | The state         |
| ------------------------------------------ | ----------------------------- | ----------------- |
| `busy`                                     | `busy`                        | as reported (`not_submitted` when the prompt was not sent) |
| `unavailable`, `login_required`, `session_unavailable`, `page_blocked`, `rate_limited`, `not_submitted` | `unavailable` | `not_submitted` |
| `cancelled`                                | `cancelled`                   | `submitted`       |
| `incomplete` (the reply was cut off)      | `timeout`                     | `submitted`       |
| `duplicate_request`                        | `invalid_output`              | as reported       |
| `submit_unknown`, or a state that is unknown | `unknown_submission`        | `unknown`         |
| everything else                            | `invalid_output`              | as reported       |

One failure does not come from the CLI at all: a request that names a
conversation (`conversationId`) is `rejected` — `not_submitted`, and the CLI is
never started — because `ask` cannot continue one.

A state that the CLI reports as unknown is **never** a retry: the request may
have reached ChatGPT, so it must be looked up (`status`) or resumed
(`resume`) — never sent again.

## The request id and the receipt

The id of the request is the receipt of the CLI:
`~/.chatgpt-use/requests/<id>.json`. It is written from before the submission
to the end of the turn, and it is what `status`, `resume` and `cancel` read.

The CLI accepts letters, digits, `.`, `_` and `-` in an id. Every other byte of
the id of the request is escaped (`_` and its hex code), so two requests never
share a receipt; an id that is too long for the CLI becomes a hash of it, and
the hash carries a trailing `_` — the escape never ends that way, so the two
names cannot collide.

- `status` prints the receipt: the state of the request, whether it reached
  ChatGPT (`yes`, `no`, `unknown`) and the conversation it belongs to. A
  request without a receipt was never submitted.
- `resume` waits for the reply of a request whose caller lost it — **the
  prompt is not sent again**. It is the way to recover an interrupted run.
- `cancel` stops the generation behind a request. A request that is already
  finished cannot be cancelled (`cancelled: false`).

`status`, `resume` and `cancel` are the primitives of the backend contract:
the adapter implements them and the tests cover them, but the command of
10x-chat runs `ask` only today. The recovery workflow of the application — a
run that was interrupted and a session that can be picked up again — comes
with the migration of the providers.

## The busy policy

One ChatGPT window serves one request.

- **Inside one process** the asks are serialized: the second one waits for the
  first one.
- **Across processes** the CLI itself refuses the second one
  (`--busy fail`), and the refusal becomes a `busy` failure of the contract
  (`not_submitted` — the prompt was never sent).

The wait inside the queue is measured and stamped on the answer and on the
failure (`queueWaitMs` of the contract) — a caller that times a review can tell
a slow provider from a request that waited behind another one (see
[review-pipeline.md](review-pipeline.md#the-timing-of-a-run)).

## What it supports

| Capability            |      | Why                                                     |
| --------------------- | ---- | ------------------------------------------------------- |
| Attachments           | yes  | `--file` and `--image`                                  |
| Streaming             | no   | the CLI answers in one piece                            |
| Cancellation          | yes  | `chatgpt-use cancel`                                    |
| Conversation reuse    | no   | `ask` has no "continue this conversation"                |
| Model selection       | yes  | the level of the composer                               |
| Image output          | no   | the plain `ask` mode returns text                       |

The matrix of every provider is [docs/capability-matrix.md](capability-matrix.md).

The `review` mode of the CLI and its agent loop are not used: the review
pipeline belongs to 10x-chat.

## The tests

The unit tests use a fake process runner — no browser, no login, no clock:

```bash
bun run test -- tests/backend-chatgpt-use.test.ts
```

The live scenario drives the real CLI and needs a logged-in ChatGPT:

```bash
TEN_X_CHAT_E2E_CHATGPT_USE=1 bun run test:e2e
```
