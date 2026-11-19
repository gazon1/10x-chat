# Secrets

The secrets store keeps credentials — provider API keys, the credentials of a
proxy — **out of `config.json`, out of the command line, out of the logs and
out of the session files**.

The store has two backends:

| Backend | Where the values live |
|---|---|
| **keyring** (the default) | the system keyring — the Secret Service of the desktop session (`gnome-keyring`, `kwallet`, …) |
| **file** (the fallback) | `~/.10x-chat/secrets.json` (`TEN_X_CHAT_HOME` moves the whole directory), `0600` on Unix |

The name of a secret is what the config file refers to; the value lives only
in the store.

```text
~/.10x-chat/
├── config.json      ← references only: { "providerKeys": { "chatgpt": "openai-key" } }
└── secrets.json     ← the values (only when the file store is used)
```

## The CLI

The value of a secret is never an argument — the shell history and the process
table would keep it. It is read from stdin or asked for with the echo switched
off (the prompt of `@inquirer/prompts`).

```bash
10x-chat secrets set openai-key        # asks for the value, input hidden
printf %s "$KEY" | 10x-chat secrets set openai-key   # or from a pipe
10x-chat secrets list                  # the names — never the values
10x-chat secrets remove openai-key     # delete a secret
```

`secrets set` replaces a secret with the same name; `secrets list` prints the
names only — there is no command that prints a value. The first line of
`secrets list` names the backend that holds the values:

```text
keyring: Secret Service (service 10x-chat-secrets)
```

A name may contain letters, numbers, dots, dashes and underscores. Names that
are properties of `Object.prototype` (`__proto__`, `constructor`, `toString`)
are ordinary secrets: the store keeps them as own properties, and a name that
was never stored reads as *missing* — it never resolves to something inherited
from the prototype.

The name is checked at **every** operation of the store — a read, a write, a
delete and the names that are read from `secrets.json`. A name that is not
allowed is an error and never reaches the keyring. The check is the same for
a name of the user and for an entry of the keyring: every character of the
name has to be allowed, so a trailing line terminator (`\n`, `\r`, `\r\n`)
never slips through. The CLI checks the name **before** it asks for the value:
a password that could not be stored is not typed in.

```text
Invalid secret name "../escape": a name may contain only letters, numbers,
dots, dashes and underscores
```

## The backend

The setting `credentialStorage` in the config file chooses the backend:

| Value | What happens |
|---|---|
| `auto` (the default) | the keyring when the Secret Service is reachable, the file otherwise |
| `keyring` | the keyring only — a run without a secret service **fails** instead of falling back to a plaintext file |
| `file` | the file store only |

```bash
10x-chat config set credential-storage keyring   # never write a secret to a file
10x-chat config unset credential-storage          # back to `auto`
```

The environment variable `TEN_X_CHAT_CREDENTIAL_STORAGE` (`auto`, `keyring`,
`file`) overrides the config file — it is the escape hatch for a machine
without a secret service and for the tests. It overrides the **setting**, not
the validation: a broken config file is an error in every case (see below).

`auto` falls back to the file **silently** — a server without a desktop
session has no Secret Service. `10x-chat secrets list` shows which backend is
in use; a run that must not write a secret to a file has to say `keyring`.

### A broken config file

The config file chooses the backend, so it has to be readable. **Only a
missing config file** falls back to the default (`auto`). A config file that
cannot be read, cannot be parsed or does not hold a valid config is an
**error**:

```text
Invalid config file ~/.10x-chat/config.json: cannot be parsed — JSON5: invalid
character 'j' at 1:7. The store of the secrets is not chosen while the config
file is broken — repair it, then try again.
```

The fallback is not a convenience here — it is a hole: a broken config file
would switch the run to `auto`, and `auto` writes the secret to a plaintext
file when the Secret Service is not reachable. `credentialStorage: "keyring"`
is the promise that no secret ever reaches a file, and a promise that cannot
be read is not a promise that may be broken quietly. The commands that touch
the store (`secrets set`, `secrets list`, `secrets remove`) do not run
`loadConfig()` — they read the setting themselves, with the same rule. They
validate the **whole** config file (the same validation as `loadConfig()`): a
config file with a typo in another setting (`"credentialStorag"`) or with an
invalid value (`"headless": "yes"`) is a broken config file too, and it is
refused before the store is chosen. The validation runs even when
`TEN_X_CHAT_CREDENTIAL_STORAGE` chooses the backend: the environment decides
*where* the secrets go, not whether the config file of the user is a valid
one.

## The keyring

The entries live in the service `10x-chat-secrets` of the Secret Service: the
name of a secret is the *account* of an entry, its value the *password*. The
values are encrypted by the keyring of the desktop session and are not readable
by the other processes of the machine.

The platform limits:

- **Linux is the supported platform** — for the whole project, not only for the
  keyring. The lock that guards this store (and the browser profiles) is an
  **abstract unix socket**: only the kernel of Linux provides one, so on macOS
  and Windows every command that touches the store fails with `The lock of
  10x-chat is an abstract unix socket — it works on Linux only.`
- The **Secret Service** is the only backend. The kernel keyring
  (`keyutils`) is not used: it does not survive a reboot and it cannot list its
  entries — and the store needs to list them. On macOS and Windows the same
  adapter would use the keychain of the system (the native module ignores the
  Linux-only option there) — it is not tested and not supported.
- The Secret Service must be **unlocked** in the desktop session. A locked
  keyring makes the command fail with the error of the keyring, not with an
  empty value.
- The entries are **not** part of `TEN_X_CHAT_HOME` and they are **not** part of
  a backup of that directory (see below).

### The migration out of the file

A store that was created before the keyring existed holds its values in
`secrets.json`. The first run with the keyring moves them:

1. every secret of the file is **compared with the keyring**,
2. the secrets that the keyring does not hold yet are written into it,
3. every secret is read back and compared with the value of the file,
4. only then the file is deleted.

**The keyring is never overwritten by the file.** The keyring holds the
credentials of the running system; the file may be an old copy of them. A
secret that the keyring already holds is therefore never written again:

| The keyring | The file | What happens |
|---|---|---|
| does not hold the secret | holds it | the secret is written into the keyring |
| holds it with the **same** value | holds it | nothing is written — the values are equal |
| holds it with **another** value | holds it | **the migration is refused** |

A conflict is found **before the first write**: a conflict that is found
halfway would leave the keyring half migrated and the file deleted in the end.
The refused migration changes nothing — the keyring keeps its value, the file
keeps its content — and the command fails with a message that names the
secret, never its value:

```text
The secrets of the file store could not be migrated into the system keyring:
the keyring already holds a different value for "openai-key". The file is kept
and the keyring is untouched — remove the secret from the keyring or update
the file, then try again.
```

A migration that cannot be verified — a keyring that answers with a different
value, a file that cannot be read — **keeps the file** and fails with a clear
message. Nothing is lost: repair the cause and run the command again.

To keep the secrets in the file, set `credentialStorage: file`.

A switch back to `file` starts with an **empty** file: the secrets of the
keyring are not written back into it. Set them again (`10x-chat secrets set …`)
or read them out of the keyring with `secret-tool` first.

## References in the config file

```json5
{
  providerKeys: { chatgpt: 'openai-key' },         // the API key of a provider
}
```

| Key | What it refers to |
|---|---|
| `providerKeys.<provider>` | The API key of the provider (`chatgpt`, `gemini`, `claude`, `grok`, `perplexity`, `deepseek`) |

It can be written with the CLI:

```bash
10x-chat config set provider-key chatgpt openai-key
```

A reference to a secret that is not stored is an error — the run stops with a
message that names the reference and the provider, never the value:

```text
Invalid config file ~/.10x-chat/config.json: No secret named "openai-key"
(config key "providerKeys.chatgpt"). Create it with: 10x-chat secrets set openai-key
```

`10x-chat config show` prints the references (the names) and never a value.
Even a value that leaked into another config key is redacted from the output.

## The proxy

The proxy itself is configured in the config file (the section `proxy`: the
server, the switch and the bypass list — see
[config-contract.md](config-contract.md)); only its **credentials** are
secrets. They are two secrets of the store with fixed names:

```bash
10x-chat secrets set proxy.username
10x-chat secrets set proxy.password
```

Without a `proxy` section in the config file the proxy comes from the
environment (`HTTPS_PROXY` and friends).

The credentials of the proxy never reach the browser process — the browser
only sees the bare proxy URL in its command line, Playwright answers the
authentication challenge of the proxy from its own CDP session, and the proxy
variables are dropped from the environment of the browser. The daemon stores a
**hash** of the proxy in its state file, so a changed proxy restarts it.

## The file and its permissions

The file store is the fallback — it holds **plaintext** secrets. It runs on
Linux only (the lock of the store is an abstract unix socket); the table below
shows what the modes mean on Unix and what they would mean on Windows.

| | Unix | Windows |
|---|---|---|
| File | `0600` — readable by its owner only | the POSIX mode is ignored by NTFS |
| Directory | `0700` — for the owner only | the rights of the user profile apply |

The mode of the directory is enforced on every write **and on every read**: a
directory that existed already (the config file creates it) is tightened to
`0700` as well. If that fails — the directory belongs to another user, for
example — the read and the write are **refused**: a directory that other users
can enter is not a safe place for the file of the store, and they could replace
the file or the lock file under the running process. The mode of the file alone
does not protect it — the file can be deleted or replaced through a directory
that may be written.

On Windows the modes above have **no effect**: the protection comes from the
access rights of the user profile that holds `~/.10x-chat`. The file is not
encrypted — anyone who can read the file can read the secrets.

The file is written **atomically** (temp file + rename): a crash cannot leave
a half-written file behind, and the old file stays valid until the new one is
complete.

Two processes that write the store at the same time would lose one of the
updates without a lock — the last rename wins. The read-modify-write cycle is
therefore guarded by a lock that is taken for the whole cycle and released
afterwards. The lock is an **abstract unix socket** (Linux): a name that the
kernel gives to exactly one process. Taking it is atomic — the second process
is told that the name is taken and waits — and the kernel takes the name away
when the holder dies, so a crash cannot block the store forever.

A file-based lock cannot do this. Taking a dead lock over means replacing the
file at the path, and no filesystem offers "replace it, but only if the dead
lock is still there" as one step: two processes could both take the lock over
and both enter the critical section — one update would be lost. The socket has
no such window, and it leaves no file behind: the lock of the store is the
socket `ten-x-chat-lock-<user>-<hash of the path>`, visible in
`ss -x | grep ten-x-chat-lock`.

The lock has **no protocol** — a process that holds the lock does not talk to
the other ones, it only holds the name. A connection to the socket is
therefore destroyed at once: a stranger that connects and keeps the
connection open cannot delay the release of the lock.

The temporary file of a write is unique per operation, so two writers never
share a name.

The **migration into the keyring** takes the same lock for the whole cycle —
read the file, compare it with the keyring, write the missing secrets, read the
values back, delete the file. Two processes that migrate at the same time
would otherwise write the old values over the new ones: the second one waits
for the lock and reads the file again inside it — by then the file is gone and
there is nothing left to migrate.

A broken store is an error, never an empty key:

```text
Secrets file ~/.10x-chat/secrets.json is corrupt — it cannot be parsed (…).
Repair or delete the file, then set the secret again.
```

A file with a name that is not allowed is broken in the same way:

```text
Secrets file ~/.10x-chat/secrets.json is corrupt — the secret name "bad name"
is not allowed: a name may contain only letters, numbers, dots, dashes and
underscores. Repair or delete the file, then set the secret again.
```

## Backup and migration

- The **keyring** is not part of `~/.10x-chat` and it is not in a backup of
  that directory: the entries belong to the keyring of the desktop session of
  the user. A new machine gets **no secrets** — every command that needs one
  fails with `No secret named "…"` until the secrets are set again. Set them
  first, then use the machine.
- The **file** holds **plaintext secrets**. It belongs in the same backup
  class as a password manager export: keep it out of a git repository, out of
  a cloud sync folder and out of a shared backup.
- `TEN_X_CHAT_HOME` moves the whole directory — with the file store.
- The file format of the proxy settings of [#34](https://github.com/gazon1/10x-chat/pull/34)
  (`{ "proxy": { "username": "…", "password": "…" } }`) is still read: the two
  values become the secrets `proxy.username` and `proxy.password`. The next
  write stores the new format. A file that carries the old format **and** the
  new name of the same secret is refused (`the secret "proxy.username" is
  defined twice`) — the value would depend on the order of the keys of the
  file.

## Rotating and revoking a key

1. Create a new key at the provider.
2. `10x-chat secrets set openai-key` (the value is asked for, hidden).
3. The next run uses the new key — nothing else has to change, the reference
   stays the same.
4. Revoke the old key at the provider.

To remove a key completely: revoke it at the provider, then
`10x-chat secrets remove openai-key` and
`10x-chat config unset provider-key chatgpt`. The credentials of the proxy are
removed with `10x-chat secrets remove proxy.username` and
`10x-chat secrets remove proxy.password`. A missing secret is reported by
name, never by value.
