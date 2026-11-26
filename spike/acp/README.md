# ACP spike — MCode session lifecycle and interactive control

Disposable experiment for issue [#86](https://github.com/gazon1/10x-chat/issues/86)
(parent: [#85](https://github.com/gazon1/10x-chat/issues/85)): which operations of the
MCode/ACP surface actually work, and can a manually launched interactive TUI session
be attached to.

The findings live in [`docs/acp-spike.md`](../../docs/acp-spike.md). This directory
contains the harness only — nothing here is production code.

## Files

| File | What |
|---|---|
| `client.mjs` | NDJSON JSON-RPC 2.0 over stdio: request/notify, `onRequest`/`onNotification`, update collection |
| `spike.mjs` | the steps; writes `results/report.json` |
| `boundary.mjs` | the rule of the permission experiment: a tool call is allowed only when it is a filesystem operation and every path it names lies inside the scratch roots of the run |
| `sanitize.mjs` | replaces the data of the machine before the report is written |
| `tui.py` | launches an interactive TUI on a pty (`script` is not installed on this machine) |

## The report is public

`results/report.json` is committed, so it must not carry the layout of the machine
it was produced on. `sanitize.mjs` replaces it before every write:

* absolute paths → relative (`<repo>/…` inside the repository, `~/…` in the home
  directory, `<path>` on any other filesystem) — the convention of `spike/readiness`,
* session ids → stable placeholders (`mvs_<8 hex>`): two different ids stay
  different, so the evidence survives, but the id no longer addresses a stored
  conversation,
* the id of the BYOK provider → `provider-<id>`, and the name of its account inside
  a model value → `<provider>`.

The transcript of another conversation is not recorded: the answer of the fork of the
live TUI session would carry it. What is kept is the *verdict* of a local comparison —
whether that answer quotes the first answer of the source session (the marker is
derived from the source log and published as a hash, never as text) and how many
records of the source log the log of the fork holds. The raw output of the terminal of
the pty experiment is not published either — the report keeps only the exit code, the
number of new session directories, whether the composer appeared and whether the answer
of the TUI is in the log of the session it left behind.

The answers of the model are not published as text either: every step that carries an
answer publishes `answer` — the length of the text, the first twelve characters of its
SHA-256 and whether it holds the marker of the prompt. The text of an answer stays in
the run and dies with it.

## The machine is not left byte for byte unchanged

The harness restores the *model option of the session* (it sets back the value that
`session/new` reported). The config file of the runtime (`~/.minimax/config.yaml`) is
the state of the machine itself: the runtime writes its own state into that file when
the agent **starts** — neither the session nor a turn changes it. The step
`runtime config file (side effect of a session and of a turn)` measures that: the file
is hashed before the handshake, after the handshake, after the creation of the session,
after the change of the model and after the first turn, and the report says which event
changed it (`changedByHandshake`, `changedBySession`, `changedByModelOption`,
`changedByTurn`) and which section was rewritten (`changedKeys`). The harness only reads
the file and never writes it; an operator who wants the machine unchanged restores it
afterwards.

## Running

```bash
node spike.mjs                     # writes results/report.json
```

The run uses the real model: a few minutes and a few thousand tokens per prompt. The
long essay prompts exist only to keep a turn busy long enough to steer, queue and
cancel it. Each of the three interaction experiments (steer, queue, cancel) runs in its
own session, so a turn that hangs cannot block the next experiment.

The run refuses an `mcode` other than the verified `0.7.10`: the findings of the
spike are the findings of that version. `SPIKE_ALLOW_ANY_VERSION=1` overrides the
refusal.

The written report is formatted by the repository linter — a fresh run leaves
`results/report.json` in the format of `JSON.stringify`, so run
`biome check --fix spike/acp/` before committing it.

Every step of the report carries a `status`: `ok`, `inconclusive` (the experiment could
not measure what it claims to measure), `skipped` or `failed`. The run exits with `1`
when a step failed; `inconclusive` and `skipped` are not a failure. A step about a turn
is `ok` only when the turn ended (`stopReason: "end_turn"`) **and** the answer carries
the marker the prompt asked for.

Environment variables:

| Variable | Meaning |
|---|---|
| `SPIKE_WORKDIR` | cwd of the created session (default `spike/acp/.workdir`) |
| `SPIKE_TUI_SESSION_ID` | id of a live TUI session, for the attach test |
| `SPIKE_TUI_SESSION_CWD` | workspace of that TUI session (must match it exactly) |
| `SPIKE_TUI_SESSION_FILE` | its `messages.jsonl` (optional — the store is searched for the session id) |
| `SPIKE_RUNTIME_CONFIG` | the config file of the runtime (default `~/.minimax/config.yaml`) — read only |
| `SPIKE_ALLOW_ANY_VERSION` | run against an `mcode` other than the verified `0.7.10` |

```bash
SPIKE_TUI_SESSION_ID=<id> SPIKE_TUI_SESSION_CWD=<workspace> \
SPIKE_TUI_SESSION_FILE=<messages.jsonl> node spike.mjs
```

## Note on `session/new`

The runtime resolves a session against a *project*. A cwd whose project cannot be
resolved fails with `-32603 "Session Project could not be resolved"` — a scratch
directory outside the repository (`~/.cache/10x-chat-tmp/acp-spike`) is the reliable
fallback.
