# Capability matrix of the current providers

The inventory of what every provider of today can do. It is the base of the
backend contract (`src/backend/contract.ts`): the capabilities of a backend
must not promise more than the provider behind it can deliver.

Read the source, not this document, when the two disagree — the code is the
truth. The date of the inventory is the commit of this file.

## The matrix

| Provider            | Auth                                     | Model selection                     | Attachments                  | Streaming / completion                                | Cancellation | Conversation reuse                                  | Image output                     |
| ------------------- | ---------------------------------------- | ----------------------------------- | ---------------------------- | ----------------------------------------------------- | ------------ | --------------------------------------------------- | ------------------------------- |
| **chatgpt**         | Google/email session, bot-protected      | Picker (Instant…o3, default `Pro`)  | Yes (deferred to the submit)  | Own poll loop, chunks via `onChunk`, `truncated` flag | No           | Yes — new chat, context window, continue with summary | Yes — generated images of the answer |
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

**No provider can cancel a running request.** The stop button of chatgpt and
the stop/cancel button of gemini are read as "the answer is still coming", but
they are never clicked. The API transport has no abort signal either.

A backend that promises `cancellation: true` must implement it itself — the
providers of today cannot.

### Conversation reuse

- Only **chatgpt** implements the three actions of the contract: `newChat`,
  `contextWindowFull` and `continueInNewChat` (the new chat starts with a
  summary of the old one).
- The other providers keep the conversation in the URL: grok `/c/<id>`,
  perplexity `/search/<id>` or `/thread/<id>`, deepseek `/a/chat/<id>`.
- gemini has no conversation actions at all.

### Image output

- **chatgpt, gemini, grok** return the generated images of the answer; the
  orchestrator downloads them into the session.
- The `image` command works with these three providers only.
- claude, perplexity and deepseek produce no images.

## The mapping to the backend contract

| Capability of the contract | chatgpt | gemini | claude | grok | perplexity | deepseek | deepseek (api) |
| -------------------------- | ------- | ------ | ------ | ---- | ---------- | -------- | -------------- |
| `attachments`              | yes     | yes    | yes    | yes  | no         | no       | no             |
| `streaming`                | yes     | yes    | yes    | yes  | yes        | yes      | no             |
| `cancellation`             | no      | no     | no     | no   | no         | no       | no             |
| `conversationReuse`        | yes     | no     | no     | no   | no         | no       | no             |
| `modelSelection`           | yes     | yes    | yes    | yes  | no         | yes      | yes            |
| `imageOutput`              | yes     | yes    | no     | yes  | no         | no       | no             |

The contract of the application does not know these providers yet — they still
run through the browser path of `src/core/orchestrator.ts`. The matrix says
what a browser backend of each provider may promise when the providers are
migrated to the contract.

A backend that promises `streaming: true` writes every piece of the answer
into the `onChunk` of the request — the same convention the browser providers
use today. The final answer of the response stays the whole text.
