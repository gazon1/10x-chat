# Capability matrix of the current providers

The inventory of what every provider of today can do. It is the base of the
backend contract (`src/backend/contract.ts`): the capabilities of a backend
must not promise more than the provider behind it can deliver.

Read the source, not this document, when the two disagree — the code is the
truth. The date of the inventory is the commit of this file.

The decision per provider — migrate to a backend or retain the browser — and the
inventory of the browser consumers are in
[docs/playwright-inventory.md](playwright-inventory.md).

## The migration of the plain chat

`chat --provider chatgpt` is served by the `chatgpt-use` backend, not by the
browser provider: one implementation, one set of failure states. The browser
provider of ChatGPT stays for the commands that need a page (`image`,
`research`, `login`, `history`) and for a `chat` run that asks for the browser
itself (`--headed`, `--headless`, `--profile`, `--isolated-profile`,
`--save-images`) or for `--all`.

Two consequences are deliberate and not accidents:

- **Conversation reuse is retired for the plain ChatGPT chat.** The CLI has no
  "continue this conversation" for `ask`, so every run starts a new chat. A run
  that finds a stored conversation says so and drops the entry; a request that
  names a conversation is refused with `rejected` instead of quietly starting a
  new chat. The reuse of the other providers is untouched, and so is the
  context-window continuation of the browser path.
- **Cancellation is gained.** The backend promises `cancellation: true`
  (`chatgpt-use cancel`), which the matrix records as `no` for every browser
  provider.

## The matrix

| Provider            | Auth                                     | Model selection                     | Attachments                  | Streaming / completion                                | Cancellation | Conversation reuse                                  | Image output                     |
| ------------------- | ---------------------------------------- | ----------------------------------- | ---------------------------- | ----------------------------------------------------- | ------------ | --------------------------------------------------- | ------------------------------- |
| **chatgpt** (`chat`, via the backend) | Google/email session of the CLI, bot-protected | The level of the composer (Instant…Pro) | Yes (`--file`, `--image`) | Whole answer, no stream (`streaming: false`)  | **Yes** (`chatgpt-use cancel`) | **No** — every `ask` is a new chat                                  | No — the plain `ask` returns text |
| **chatgpt** (browser: `image`, `research`, `login`, `history`, `chat --all`) | Google/email session, bot-protected      | Picker (Instant…o3, default `Pro`)  | Yes (deferred to the submit)  | Own poll loop, chunks via `onChunk`, `truncated` flag | No           | Yes — new chat, context window, continue with summary | Yes — generated images of the answer |
| **gemini**          | Google session (cookies, account menu)   | Modes (Fast, Thinking, Pro, Deep Think, Deep Research) | Yes (upload menu, needs a signed-in account) | `pollUntilStable`, chunks, Deep Think wait, `truncated` | No           | No — no new chat, no context window, no continuation  | Yes — generated images of the answer |
| **claude**          | Anthropic session, headed only           | Picker (Opus/Sonnet/Haiku/Thinking)  | Yes                          | `pollUntilStable`, chunks, thinking block stripped    | No           | No                                                    | No                              |
| **grok**            | X session                               | Picker (Auto/Fast/Expert/Heavy)     | Yes                          | `pollUntilStable`, chunks, failure text detected     | No           | No — the id comes from the URL                        | Yes — generated images of the answer |
| **perplexity**      | Optional (works signed out), bot-protected, headed | No                              | No                           | `pollUntilStable`, chunks, waits for the redirect     | No           | No — the id comes from the URL                        | No                              |
| **deepseek**        | DeepSeek session                         | Toggle (chat / reasoner)            | No                           | `pollUntilStable`, chunks, failure text detected      | No           | No — the id comes from the URL                        | No                              |
| **deepseek (api)**  | API key of the secrets store             | In the request body                 | No                           | Whole answer, no stream (`stream: false`)             | No           | No                                                    | No                              |

## The details behind the cells

### Auth

- **chatgpt** — `botProtected: true`: a Cloudflare challenge is a state of its
  own, the user solves it in the visible window. `isLoggedIn` reports the
  challenge itself as an error, not as a lost session.
- **gemini** — the composer alone is not enough: the check looks for the
  account indicators and falls back to the Google auth cookies.
- **perplexity** — `botProtected: true` and `requiresHeaded: true`. The check
  answers "logged in" when the composer is visible, also when the user is
  signed out — Perplexity answers without an account, the Pro features do not.
- **claude** — `requiresHeaded: true`: headless Chromium serves a different
  DOM.
- The API transport of deepseek has no session at all: the API key of the
  secrets store replaces the login (`docs/secrets.md`).

### Model selection

- A picker with a menu: chatgpt, claude, grok, gemini (modes).
- A toggle: deepseek (`deepseek-reasoner` switches DeepThink on).
- None: perplexity.
- The API transport takes the model in the request body and rejects an unknown
  one.
- Every browser picker **keeps the current model** when the picker or the
  option is not found — it warns, it does not fail the run.

### Attachments

- chatgpt stores the paths and uploads them in `submitPrompt` — the upload
  happens with the send, not before it.
- gemini needs a signed-in Google account for the upload menu.
- claude and grok set the files on the file input of the composer.
- perplexity and deepseek have no attachment support: `--attach` is a warning
  in the browser path and an error in the API path.

### Streaming and completion

- Every browser provider streams the answer through `onChunk` while it is
  generated. The completion is detected by a poll that waits for a stable
  answer (gemini, claude, grok, perplexity, deepseek) or by its own loop
  (chatgpt).
- A cut-off answer is explicit: `truncated: true`.
- gemini waits for the deferred answer of Deep Think and reports `truncated`
  when the wait runs out.
- grok and deepseek detect the failure text of the provider and raise it.

### Cancellation

The **`chatgpt-use` backend can cancel a running request** (`chatgpt-use
cancel`), and the contract of the backend carries it.

**No browser provider can cancel a running request.** The stop button of
chatgpt and the stop/cancel button of gemini are read as "the answer is still
coming", but they are never clicked. The API transport has no abort signal
either.

A browser backend that promises `cancellation: true` must implement it itself —
the providers of today cannot.

### Conversation reuse

- The plain **ChatGPT chat has no reuse**: the `chatgpt-use` backend cannot
  continue a conversation (`ask` opens a new one every time). A stored
  conversation is named and dropped when a run finds one, and a request that
  names a conversation is refused with `rejected`.
- The **browser provider of chatgpt** — `image`, `research`, `login`,
  `history`, `chat --all` — still implements the three continuation actions:
  `newChat`, `contextWindowFull` and `continueInNewChat` (the new chat starts
  with a summary of the old one).
- The other providers keep the conversation in the URL: grok `/c/<id>`,
  perplexity `/search/<id>` or `/thread/<id>`, deepseek `/a/chat/<id>`.
- gemini has no conversation actions at all.

### Image output

- **chatgpt, gemini, grok** return the generated images of the answer; the
  orchestrator downloads them into the session.
- The `image` command works with these three providers only.
- claude, perplexity and deepseek produce no images.

## The mapping to the backend contract

The row of ChatGPT is the backend that serves its plain chat
(`CHATGPT_USE_CAPABILITIES` in `src/backend/chatgpt-use.ts`); the browser
capabilities of the same provider — image output, streaming, the continuation
of an exhausted chat — belong to the commands that still use the browser and
are not promised by the backend.

| Capability of the contract | chatgpt (`chat`) | chatgpt (browser) | gemini | claude | grok | perplexity | deepseek | deepseek (api) |
| -------------------------- | ---------------- | ----------------- | ------ | ------ | ---- | ---------- | -------- | -------------- |
| `attachments`              | yes     | yes    | yes    | yes  | yes  | no         | no       | no             |
| `streaming`                | no      | yes    | yes    | yes  | yes  | yes        | yes      | no             |
| `cancellation`             | **yes** | no     | no     | no   | no   | no         | no       | no             |
| `conversationReuse`        | no      | yes    | no     | no   | no   | no         | no       | no             |
| `modelSelection`           | yes     | yes    | yes    | yes  | yes  | no         | yes      | yes            |
| `imageOutput`              | no      | yes    | yes    | no   | yes  | no         | no       | no             |

Only the plain ChatGPT chat runs through a backend today. The other providers
still run through the browser path of `src/core/orchestrator.ts`; their columns
say what a browser backend of each may promise when they are migrated.

A backend that promises `streaming: true` writes every piece of the answer
into the `onChunk` of the request — the same convention the browser providers
use today. The final answer of the response stays the whole text.

A backend that produces images saves them itself: the request carries the
target directory in `saveDir` — the `images/` directory of the session, unless
the caller asked for another one — and the answer reports the local paths. The
application does not download them — it has no page with the cookies of a
provider.
