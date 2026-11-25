# Everyday setup: proxy, models, headless, conversation reuse

This is the practical guide for a repeated local setup. The enforced rules for
the configuration file are in [config-contract.md](config-contract.md); the
secrets store is in [secrets.md](secrets.md).

## Proxy

The proxy comes from the config file, from the environment, or from nowhere —
in that order:

```text
config file  >  environment  >  no proxy
```

The three states of the config file are different:

| Config file | The proxy |
|---|---|
| no `proxy` section | the proxy of the environment |
| `proxy.enabled: false` | **no proxy at all** — the environment is not used as a fallback |
| `proxy.enabled: true` | the proxy of the config file — the environment is ignored |

```bash
# persist a proxy (overrides the environment); omit --bypass to keep none
10x-chat config proxy set http://127.0.0.1:3128 --bypass localhost,127.0.0.1,::1

# disable without losing the settings (suppresses the environment fallback)
10x-chat config proxy disable

# remove the proxy section (back to the environment proxy, if any)
10x-chat config proxy clear
```

```json5
// ~/.10x-chat/config.json (equivalent)
{
  proxy: {
    enabled: true,
    server: 'http://127.0.0.1:3128',
    bypass: ['localhost', '127.0.0.1', '::1'],
  },
}
```

- `server` is the proxy URL **without** credentials. A URL that carries them
  (`http://user:pass@host:port`) is rejected — the credentials belong in the
  secrets store.
- `bypass` is the list of hosts that must not go through the proxy. It replaces
  `NO_PROXY` while the config file names a proxy.
- **Migrating from environment-only proxy:** keep no `proxy` section and the
  environment variables keep working (backward compatible). To persist them
  once, run `config proxy set <server>` (and store credentials as secrets) so
  later invocations no longer depend on the shell environment.

Without a `proxy` section the environment decides. The first variable with a
value wins:

```text
HTTPS_PROXY > https_proxy > HTTP_PROXY > http_proxy > ALL_PROXY > all_proxy
```

`NO_PROXY` / `no_proxy` becomes the bypass list.

### Proxy credentials

```bash
10x-chat secrets set proxy.username   # asks for the value, input hidden
10x-chat secrets set proxy.password
```

The values live in the system keyring (the Secret Service of the desktop
session) or, as a fallback, in `~/.10x-chat/secrets.json` (`0600`). They never
reach the config file, the command line, the browser process or the logs. The
browser only sees the bare proxy URL; Playwright answers the authentication
challenge.

Supported: `http://` and `https://` with or without Basic auth, `socks4://` /
`socks5://` without credentials. SOCKS with credentials is rejected: Chromium
could only authenticate through the URL of `--proxy-server`, which puts the
password into the process table.

The shared browser daemon is started with one proxy. A changed proxy restarts
an **idle** daemon; a daemon that still serves another session is not stopped —
the run fails with an error instead. In the isolated or named profile mode
every run launches its own browser and always uses the current proxy.

## Models

The model is chosen in this order:

```text
--model  >  defaultModel of the config file  >  the default of the provider
```

`defaultModel` belongs to the chat commands (`chat`, `delegate`). `research`
selects a model only when it is asked to (`--model`), and `image` has no model
selection at all.

```bash
10x-chat config set model Pro
10x-chat chat -p '…' --provider chatgpt --model Instant
```

ChatGPT's current UI — including the free plan — does not render a model
picker. The CLI probes the page briefly and then keeps the account's current
model. The `Selecting model: …` line is a no-op in that case and no longer
costs the old 25-second picker wait. On a provider whose picker still exists,
`--model` and `defaultModel` work as before.

## Headless and displays

The provider decides the default mode. Claude and Perplexity set
`requiresHeaded` because their sites block headless Chromium; the `headless`
key of the config file does **not** override that. ChatGPT follows the config
key (headless by default). Use `--headless` to force a windowless browser for
any provider:

```bash
10x-chat chat -p 'Review this' --provider claude --headless
```

> The plain ChatGPT chat does not use this browser at all: `chat --provider
> chatgpt` drives the `chatgpt-use` CLI, which owns its own window. Passing
> `--headless`, `--headed`, `--profile` or `--isolated-profile` asks for the
> browser path explicitly (`docs/capability-matrix.md`).

A Cloudflare challenge cannot be solved in a headless window. If the provider
shows one, run once with a visible browser (or `10x-chat login <provider>`) to
refresh the clearance cookie; the next headless run reuses it.

If you need a headed browser that does not open on your desktop, run it under
Xvfb. On Fedora:

```bash
sudo dnf install xorg-x11-server-Xvfb
xvfb-run -a -s "-screen 0 1280x900x24" env -u WAYLAND_DISPLAY \
  10x-chat chat -p '…' --provider chatgpt
```

`env -u WAYLAND_DISPLAY` makes Chromium use the virtual X display instead of
the Wayland session. A convenient alias:

```bash
alias gpt='10x-chat chat --provider chatgpt --headless --timeout 180000'
```

## ChatGPT Project destination

`chatgptProject` in `~/.10x-chat/config.json` files **new** ChatGPT
conversations into an existing ChatGPT Project. The value is the project
**name** as it appears in `~/.chatgpt-use/projects.json` — the lookup key
`chatgpt-use --project` accepts. The `g-p-…` id underneath the name is the real
identity.

```bash
10x-chat config set chatgpt-project chatgpt-use
10x-chat chat -p "Explain this" --provider chatgpt
10x-chat config unset chatgpt-project
```

- The name is resolved against `~/.chatgpt-use/projects.json` before the CLI
  runs. An unknown name fails explicitly; 10x-chat never passes an unknown name
  through, because the CLI would create a project for it.
- After a successful answer, 10x-chat verifies that the conversation is in the
  project's Chats list after a reload — the primary signal from
  [docs/chatgpt-projects.md](chatgpt-projects.md). A conversation not found in
  that list is a failure, not a success.
- The setting is ChatGPT-only. Other providers ignore it. A backend that cannot
  file a conversation into a project rejects the request instead of creating a
  chat outside the project.
- With nothing configured, behaviour is unchanged. An unconfigured `review`
  still follows the `chatgpt-use` CLI default (today the CLI's own
  `chatgpt-use` project); 10x-chat does not change that by accident.
- Existing conversations and conversation cache semantics are unchanged. The
  project is a destination for new chats, not a new cache key (repo + branch +
  provider).

## Timeouts, retries and cut-off answers

The prompt is sent **once**. What the run does afterwards depends on what the
provider does — a prompt that may have run already is never sent a second
time:

| Situation | What the run does |
|---|---|
| The answer was cut off by the timeout | The same turn is captured again (a grace window of 5 minutes). The prompt is **not** sent again. If the answer is still incomplete, the cut-off answer is returned and marked as truncated. |
| The provider reported an error and produced nothing | The question is asked once more — nothing was executed yet. |
| The provider reported an error after a part of the answer | The run fails with the error of the provider. The task of the prompt may have run already, so the prompt is not sent again. |
| The context window of the chat ran out | The conversation is continued in a new chat with a summary and the question is asked there. |

## Conversation reuse

A browser chat stores the provider conversation of the current git repository
and branch in `~/.10x-chat/conversations.json`. The next `chat` run in the same
repository and branch opens that conversation and appends the prompt. This
works for every provider that exposes a stable conversation URL **except
ChatGPT**, whose plain chat is served by the `chatgpt-use` backend and cannot
continue a conversation:

| Provider | Conversation URL | Reused by `chat` |
|---|---|---|
| ChatGPT | `https://chatgpt.com/c/…` | **no** — the backend starts a new chat every run |
| Gemini | `https://gemini.google.com/app/…` | yes |
| Claude | `https://claude.ai/chat/…` | yes |
| Grok | `https://grok.com/c/…` or `https://grok.com/chat/…` | yes |
| Perplexity | `https://www.perplexity.ai/search/…` or `/thread/…` | yes |
| DeepSeek | `https://chat.deepseek.com/a/chat/…` | yes |

```bash
cd ~/src/my-project          # branch: feature/login
10x-chat chat -p 'Implement the login form' --provider gemini
10x-chat chat -p 'Now add validation'       --provider gemini   # same chat
10x-chat chat -p 'Start over'               --provider gemini --new-chat
```

- **ChatGPT is the exception.** Every `10x-chat chat --provider chatgpt` run is
  a new conversation: the `chatgpt-use` CLI has no "continue this chat". A chat
  you want to follow up on needs a provider from the table above, or
  `10x-chat chat --provider chatgpt --headed/--headless` with the browser path.
  A run that finds a stored ChatGPT conversation says that it cannot continue it
  and starts a new one; the entry stays in the cache, because the browser path
  (`--headed`) still reopens that conversation.
- The key is the **repository**, the checked-out branch and the provider. The
  repository is identified by its origin URL, so another worktree or another
  clone of the same repository finds the same chat; without a remote the git
  common directory is used. A detached HEAD uses the short commit; outside git
  the working directory is used.
- The providers' capture logic is baselined before the prompt, so the answer
  of the new turn is captured even in a conversation that already has turns.
- A conversation the provider no longer serves (deleted, expired, or a redirect
  to the landing page / a new chat) is dropped automatically and the run starts
  a new one. A redirect to a login page is left to the login check — the
  conversation is kept for after `10x-chat login`.
- `--new-chat` forces a fresh conversation and replaces the stored entry. For
  ChatGPT it changes nothing: a backend run always starts a new chat.
- **An exhausted context window does not end the work.** When the provider reports
  that the context window of the conversation is full (ChatGPT shows a banner
  with a "Continue in a new chat" button), the run continues in a **new chat with
  an automatic summary** of the old one — the native mechanism of the app, not a
  paraphrase. The new chat becomes the stored conversation of the repository and
  the branch, so the next run appends to it, until its own context window runs
  out too. The check happens before the prompt and again before every retry, so
  a context that runs out while the answer is being generated also lands in the
  new chat. This is a property of the **browser path**: the `chatgpt-use`
  backend of the plain ChatGPT chat has no such continuation.
- `chat --all` keeps one conversation per provider for the same repository and
  branch (browser transport only).
- The API transport has no conversation (`--transport api` is a single HTTP
  request), and `delegate` keeps its own long-lived browser session.

The cache contains only conversation URLs — no cookies and no credentials. It
is written atomically and guarded by a cross-process lock, so parallel
`chat --all` runs do not lose each other's entries. A broken cache file is
treated as empty and replaced on the next save.

## Web login vs API keys

These are two different credentials:

- **Web chat** (the default browser transport) uses the login session in
  `~/.10x-chat/profiles/default/storage-state.json`. Log in with
  `10x-chat login <provider>`; `10x-chat login --status` checks the state. In
  the shared profile mode one profile serves all providers.
- **API transport** (`--transport api`) uses an API key from the secrets store,
  referred to by `providerKeys.<provider>` in the config file. It starts no
  browser and uses no profile. DeepSeek currently has a native API transport
  (OpenAI-compatible chat completions); as other native or OpenAI-compatible
  providers gain API transports, configure their key the same way.

```bash
10x-chat secrets set deepseek-key
10x-chat config set provider-key deepseek deepseek-key
10x-chat chat -p 'Explain this' --provider deepseek --transport api
```

A provider without an API transport fails with an error; it never falls back to
the browser behind your back. `chat --all` runs the browser transport only and
cannot be combined with `--transport api`, so paid API calls are never mixed in
unexpectedly. See [transports.md](transports.md).
