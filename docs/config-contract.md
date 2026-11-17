# Configuration contract

One place that says what 10x-chat reads, in which order, and what happens when
something is broken. Everything in here is enforced by the code — the rules are
not aspirational.

## 1. The order of precedence

For every setting the order is the same:

```
CLI flag  >  config file  >  built-in default
```

The environment is **not** part of that chain: it only carries the two things
that cannot live in a file — the root directory of the data (`TEN_X_CHAT_HOME`)
and the proxy (§5).

| Setting | CLI | Config file | Default |
|---|---|---|---|
| Provider | `--provider` | `defaultProvider` | `chatgpt` |
| Model | `--model` | `defaultModel` (chat commands) | the default of the provider |
| Timeout | `--timeout` | `defaultTimeoutMs` (chat only) | the default of the command/provider |
| Headless | `--headed` / `--headless` | `headless` | `true` (ChatGPT and Claude always run headed) |
| Profile mode | `--profile` / `--isolated-profile` | `profileMode` | `shared` |
| Proxy | — | — | the environment (§5) |

A CLI flag that is **not given** does not shadow the config file. This is why
`--timeout` has no default value: a flag with a default would always win over
`defaultTimeoutMs` in the config file.

The timeout of a **chat** (`chat`, `delegate`) is `--timeout` →
`defaultTimeoutMs` → the default of the provider.

The commands `image` and `research` have their own defaults (120 s and 600 s)
and are only changed by their own `--timeout` flag: `defaultTimeoutMs` is the
timeout of a chat, and it must not shorten a research run. `defaultTimeoutMs` is
unset by default.

`defaultModel` of the config file belongs to the chat commands (`chat`,
`delegate`) as well: `research` selects a model only when it is asked to
(`--model`) and `image` has no model selection at all. The models of the
providers are named differently, so a model that was set for a chat must not
change the other commands.

## 2. The config file

`~/.10x-chat/config.json` (JSON5: comments and trailing commas are allowed).
`TEN_X_CHAT_HOME` moves the whole directory.

```json5
{
  defaultProvider: 'chatgpt',   // chatgpt | gemini | claude | grok | perplexity | deepseek
  defaultModel: 'pro',          // optional
  defaultTimeoutMs: 300000,     // optional, positive number
  headless: true,               // boolean
  profileMode: 'shared',        // shared | isolated
}
```

`10x-chat config set <key> <value>` writes the same keys:
`provider`, `model`, `timeout`, `headless`, `profile-mode`.

### What is an error

Only a **missing** file falls back to the defaults. Everything else fails
loudly, with the path of the file and the problem in it:

| Situation | Result |
|---|---|
| No config file | the built-in defaults |
| Unreadable file | `Cannot read config file <path>: …` |
| Broken JSON/JSON5 | `Invalid config file <path>: cannot be parsed — …` |
| Unknown key | `Invalid config file <path>: unknown key "…" (known keys: …)` |
| Invalid value | `Invalid config file <path>: "headless" must be true or false (got "yes")` |

An unknown key is an error on purpose: `profile_mod` would otherwise be
silently ignored and the profile mode would stay what it was.

The config file is written atomically (temp file + rename), so a crash cannot
leave a half-written file behind.

## 3. Profiles and their isolation

| Mode | Directory | Cookies | Parallel runs |
|---|---|---|---|
| `shared` (default) | `~/.10x-chat/profiles/default` | one `storage-state.json` for all providers | yes, with the same headless mode and proxy |
| `isolated` | `~/.10x-chat/profiles/<provider>` | one persistent profile per provider | one run per profile (lock) |
| `--profile <name>` | `~/.10x-chat/profiles/<name>` | one persistent profile per name | one run per profile (lock) |

`--profile <name>` and `--isolated-profile` always win over `profileMode`; they
force the isolated, persistent mode with a profile lock. Without them the mode
of the config file decides.

The shared mode runs the browser in the **daemon** (`~/.10x-chat/browser-daemon.json`).
The daemon is started once and reused by every later invocation, and it is
restarted when it cannot serve the request any more:

- the headless mode differs from the requested one, or
- the proxy differs from the requested one (§5).

The restart only happens when the daemon is **idle**. A daemon that still has
the session of another process is never stopped *by a switch* — that would take
the browser away from the running session. Such a run fails with an error
instead:

```
The shared browser daemon is busy with another session (1 active page(s)) and
cannot be switched to a different headless mode (headed → headless): stopping
it would end that session. Wait for the other session to finish, then run the
command again.
```

The check and the stop are one step: the daemon is asked to **switch** first.
While it is switching, it refuses new sessions and waits for the session
creations that are already running. A session that starts in the meantime is
then visible, the switch is refused, and the daemon serves sessions again. A
process that is refused while the daemon switches gets a clear error and can
run the command again.

A session creation that is still running counts as a session: its context does
not exist yet, but it belongs to another process. If the wait for it runs into
its timeout (10 s), the switch is refused as well — a timeout is not an idle
daemon:

```
The shared browser daemon could not be switched to a different headless mode
(headed → headless): a session of another process is still being created and
did not finish in time (1 pending creation(s)). Stopping the daemon would end
that session. Wait for the other session to finish, then run the command again.
```

Parallel runs in the shared mode are therefore possible while they use the
**same headless mode and the same proxy**. A run with another mode or another
proxy waits for the other session to end (the daemon is idle again after 30
minutes at the latest) and then restarts the daemon.

The cookies of the shared profile live in `storage-state.json` and survive the
restart of the daemon.

## 4. Sessions

- Every run creates its own session directory `~/.10x-chat/sessions/<uuid>/`
  with `meta.json`, `bundle.md` and `response.md`. Sessions are never reused
  or overwritten — a new run is a new session.
- `meta.json` is written atomically; a crash cannot leave a broken metadata
  file behind.
- `10x-chat session <id>` takes the full id or a unique prefix of it
  (`10x-chat session 3f2a`). An ambiguous prefix is an error that lists the
  candidates, a missing one is an error too.
- A session with broken metadata is skipped by `10x-chat status` (one damaged
  session must not hide the others) and reported by `10x-chat session <id>`
  with the path of the broken file.

## 5. The proxy

**The environment is the only source of the proxy.** There is no config key and
no CLI flag for it: the shared browser daemon is a separate process that
inherits the environment of the invocation that started it, so a proxy that
lives in a file or in a flag would silently not apply to it.

### The variables and their order

The first variable with a value wins:

```
HTTPS_PROXY  >  https_proxy  >  HTTP_PROXY  >  http_proxy  >  ALL_PROXY  >  all_proxy
```

`NO_PROXY` (or `no_proxy`) becomes the list of hosts that bypass the proxy.

### What is supported

| Proxy | Supported | Verified |
|---|---|---|
| `http://` without credentials | yes | production |
| `http://` with Basic auth | yes | production (PR #14) |
| `https://` proxy (TLS to the proxy) | yes (Chromium) | not measured |
| `socks5://` without credentials | yes | production (PR #14) |
| `socks4://` without credentials | yes (Chromium), not measured | — |
| `socks4://` / `socks5://` **with** credentials | **no** | rejected, see below |

A proxy with an unsupported scheme (`ftp://`, …) is rejected with an error
that names the scheme. A proxy URL that cannot be parsed at all is rejected
with a generic message — the raw value is never printed, it can carry the
credentials.

### Why SOCKS with credentials is rejected

Chromium can only authenticate a SOCKS proxy through the URL of the
`--proxy-server` flag — and that URL ends up in the command line of every
process of the browser, where every local process of the machine can read it.
The safe path rejects the combination instead of leaking the password:

```
SOCKS proxy authentication is not supported without exposing the credentials
in the process table: …
```

Use an HTTP proxy with credentials (Playwright answers the `407` challenge
over CDP) — or a local relay, which needs its own security review.

### Where the credentials live

The userinfo of the proxy URL is split off the server URL:

- the **browser** only ever sees `--proxy-server=http://host:port` — no
  userinfo, in the command line and in the environment;
- the **credentials** go to Playwright (`launchOptions.proxy`), which
  authenticates the proxy from its own CDP session;
- the **proxy variables** are removed from the environment of the browser
  (`browserProcessEnv()`), because the environment of a process is as readable
  as its command line;
- the **logs and the debug artifacts** redact the userinfo of every URL
  (`redactText()`), and the fingerprint of the proxy in the state file of the
  daemon is a hash — the password never leaves the process that read it.

### Changing the proxy

The proxy is a property of the browser process. When the proxy of the
environment changes, the daemon is restarted with the new one (the fingerprint
of the proxy is part of its state file). A run in the isolated mode launches
its own browser and always uses the current environment.
