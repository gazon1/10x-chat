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
and the proxy (§5). The proxy is the one exception: the config file wins over
the environment.

| Setting | CLI | Config file | Default |
|---|---|---|---|
| Provider | `--provider` | `defaultProvider` | `chatgpt` |
| Model | `--model` | `defaultModel` (chat commands) | the default of the provider |
| Timeout | `--timeout` | `defaultTimeoutMs` (chat only) | the default of the command/provider |
| Headless | `--headed` / `--headless` | `headless` | `true` (a provider that needs a visible browser always runs headed) |
| Profile mode | `--profile` / `--isolated-profile` | `profileMode` | `shared` |
| Proxy | — | `proxy` (§5) | the environment (§5) |
| API key of a provider | — | `providerKeys.<provider>` (a name, §6) | none |
| Transport | `--transport browser\|api` | — | `browser` |

A CLI flag that is **not given** does not shadow the config file. This is why
`--timeout` has no default value: a flag with a default would always win over
`defaultTimeoutMs` in the config file.

The timeout of a **chat** (`chat`, `delegate`) is `--timeout` →
`defaultTimeoutMs` → the default of the provider.

The headless mode is decided per provider: a provider whose config sets
`requiresHeaded` (Claude, Perplexity) runs in a visible browser,
every other provider follows the `headless` key of the config file. There is no
list of provider names in the code — the decision belongs to the provider
config. `--headless` forces the headless mode for such a provider as well
(needed on a host without a display), `--headed` forces the visible browser.

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
  providerKeys: { deepseek: 'deepseek-key' },  // optional, names of secrets (§6)
  credentialStorage: 'auto',    // optional, auto | keyring | file (§6)
  proxy: {                      // optional, see §5
    enabled: true,
    server: 'http://proxy.example:3128',
    bypass: ['localhost', '127.0.0.1'],
  },
}
```

`10x-chat config show` prints the stored configuration (references only, never
secret values) and the **effective non-secret** state: where the proxy comes
from (config, environment, or none) and whether proxy credentials and provider
key secrets are configured or missing.

`10x-chat config set <key> <value>` writes the keys:
`provider`, `model`, `timeout`, `headless`, `profile-mode`, `provider-key`,
`credential-storage`. `10x-chat config unset <key>` removes `provider-key`,
`credential-storage` and `proxy`.

Proxy settings are managed under the same `config` command:

```bash
10x-chat config proxy set http://proxy.example:3128 --bypass localhost,127.0.0.1
10x-chat config proxy disable   # suppresses the environment fallback
10x-chat config proxy clear     # removes the proxy section (falls back to the environment)
```

The credentials of the proxy are not stored in the config file — put them in
the secrets store as `proxy.username` and `proxy.password` (§5). Existing
commands remain backward compatible: a config file with no `proxy` section
still uses the proxy of the environment, and a config file that already
contains a `proxy` section keeps working.

`providerKeys` holds **names**, never values: the values live in the secrets
store ([docs/secrets.md](secrets.md)). A provider key is configured once and
reused in later invocations:

```bash
10x-chat secrets set deepseek-key
10x-chat config set provider-key deepseek deepseek-key
10x-chat chat -p "Explain this" --provider deepseek --transport api
```

Currently DeepSeek has a native API transport (OpenAI-compatible chat
completions). As other native or OpenAI-compatible providers gain API
transports, configure their key the same way and use `--transport api
--provider <provider>`.

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
| Reference to a secret that is not stored | `Invalid config file <path>: No secret named "…" (config key "providerKeys.chatgpt"). Create it with: 10x-chat secrets set …` |

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

A **bot challenge** (Cloudflare) is a state of its own, not "not logged in".
When a run meets one, the browser is asked to solve it in the window that is
already open — one attempt, 120 s. The clearance cookie is written to
`storage-state.json` right away, so the next run reuses the cleared session.
Without a visible window (headless) the run fails with an antibot error
instead of waiting for a challenge nobody can see.

Every command that talks to a provider — `chat`, `research`, `image`, `delegate`
and `history` — goes through the same session check, so a challenge is solved
and the cleared session is saved everywhere. Every command that can fail this
way prints the same hint (`antibot` / `unauthorized` / `unavailable`).

The cleared session is written to `storage-state.json` **only in the shared
profile mode**. An isolated (`--isolated-profile`) or a named (`--profile`)
profile is a persistent Chromium context: it keeps its cookies in its own
directory and never writes them into the shared state — the isolation would
be broken otherwise.

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

The proxy comes from the config file, from the environment, or from nowhere —
in that order:

```
config file  >  environment  >  no proxy
```

There is no CLI flag for it. The three states of the config file are different
and are tested as such:

| Config file | The proxy |
|---|---|
| no `proxy` section | the proxy of the environment (the old behaviour) |
| `proxy.enabled: false` | **no proxy at all** — the environment is *not* used as a fallback |
| `proxy.enabled: true` | the proxy of the config file — the environment is ignored |

The proxy of the config file reaches the browser in every mode: the shared
daemon, the persistent context of the shared profile and the persistent
context of an isolated or named profile. The daemon is a separate process, and
it resolves the proxy itself — from the same config file, the same secrets
store and the same environment as the invocation that started it.

### The config file

```json5
{
  proxy: {
    enabled: true,                          // required: true or false
    server: 'http://proxy.example:3128',   // required when enabled
    bypass: ['localhost', '127.0.0.1'],     // optional
  },
}
```

`server` is the proxy URL **without** credentials. A URL that carries them is
rejected — the credentials belong into the secrets store. The check runs
whenever the field is present, also when the proxy is switched off: a
disabled proxy is not used, but its credentials would still sit in a
plaintext config file. `bypass` is the list of the hosts that must not go
through the proxy; it replaces `NO_PROXY` while the config file names a
proxy.

The section can be managed from the CLI: `10x-chat config proxy set <server>
[--bypass hosts]` enables it, `config proxy disable` suppresses the
environment fallback without removing the settings, and `config proxy clear`
removes the section (back to the environment). Migrating from environment-only
proxy configuration is explicit: keep no `proxy` section to continue using the
environment, or persist it once with `config proxy set …` (and store any
credentials as `proxy.username` / `proxy.password` secrets).

### The credentials

The credentials of the proxy live in the secrets store, not in the config
file — under the names `proxy.username` and `proxy.password`:

```bash
10x-chat secrets set proxy.username   # asks for the value, input hidden
10x-chat secrets set proxy.password
```

The file of the store (`~/.10x-chat/secrets.json`, JSON5) must not be readable
by other users of the machine (`chmod 600`): a secrets file that every local
process can read is a password in the open. A missing file is not an error — a
proxy without credentials works. A broken one is: a password that is silently
dropped would send the browser through a proxy that cannot authenticate it.
No error message ever names a value. The whole contract of the store is in
[docs/secrets.md](secrets.md).

### The variables and their order

Without a `proxy` section in the config file the environment decides. The
first variable with a value wins:

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
- the **config file** never carries the credentials — they live in the secrets
  file, and a `server` with a userinfo in it is rejected;
- the **proxy variables** are removed from the environment of the browser
  (`browserProcessEnv()`), because the environment of a process is as readable
  as its command line;
- the **logs and the debug artifacts** redact the userinfo of every URL
  (`redactText()`), and the fingerprint of the proxy in the state file of the
  daemon is a hash — the password never leaves the process that read it;
- a proxy from the **secrets store** is read by the process that launches the
  browser and is never written into the environment of that process.

### Changing the proxy

The proxy is a property of the browser process. The fingerprint of the
effective proxy — the server, the user, the password and the bypass list, all
of them hashed — is part of the state file of the daemon, so a changed proxy
restarts it: an idle daemon is stopped and started again with the new proxy,
a daemon that still serves the session of another process is never stopped —
the run fails with an error instead (§3). A run in the isolated mode launches
its own browser and always uses the current proxy.

## 6. Secrets

The config file refers to secrets by **name**; the values live in the secrets
store — the system keyring (the Secret Service of the desktop session) or the
file `~/.10x-chat/secrets.json` (`0600` on Unix). The setting
`credentialStorage` chooses the backend (`auto` — the keyring when it is
reachable, the file otherwise; `keyring` — the keyring only; `file` — the file
only); the environment variable `TEN_X_CHAT_CREDENTIAL_STORAGE` overrides it.
The store, the CLI (`10x-chat secrets …`), the permissions, the platform limits
and the rotation are documented in [docs/secrets.md](secrets.md).

| Situation | Result |
|---|---|
| The secret is stored | the run uses the value |
| The secret is not stored | `Invalid config file <path>: No secret named "…" (config key "…")` |
| The store is broken | `Secrets file <path> is corrupt — …` — never an empty value |
| The keyring is required but not reachable | `The system keyring (Secret Service) is not available: …` |
| The config file is broken and a secret is stored or read | `Invalid config file <path>: cannot be parsed — …` (or `Cannot read config file <path>: …`, or an unknown key / an invalid setting of the file) — the store of the secrets is **not** chosen behind the back of the user |
