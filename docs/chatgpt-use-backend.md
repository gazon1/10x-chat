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
10x-chat chat -p "Explain this" --backend chatgpt-use
```

- The backend is not a provider and not a transport: `--all`, `--transport`,
  `--new-chat` and the browser flags (`--headed`, `--headless`, `--profile`,
  `--isolated-profile`) are refused with it, not ignored.
- The backend drives ChatGPT: the provider of the run is `chatgpt`, and
  another one is refused.
- The backend saves no image: `--save-images` is refused with it, not ignored.
- The run is stored like any other session — the history of the runs shows it.
- The failure of a backend has its own hint (`busy`, `unavailable`,
  `timeout`, `unknown_submission`, …), not the hint of a provider run.
- The hint of an unusable answer depends on the state of the request: a
  request that may have reached ChatGPT is never sent again — the receipt of
  the CLI says what happened to it (`chatgpt-use status <request-id>`).

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

## What it supports

| Capability            |      | Why                                                     |
| --------------------- | ---- | ------------------------------------------------------- |
| Attachments           | yes  | `--file` and `--image`                                  |
| Streaming             | no   | the CLI answers in one piece                            |
| Cancellation          | yes  | `chatgpt-use cancel`                                    |
| Conversation reuse    | no   | `ask` has no "continue this conversation"                |
| Model selection       | yes  | the level of the composer                               |
| Image output          | no   | the plain `ask` mode returns text                       |

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
