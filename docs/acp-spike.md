# MCode ACP spike — findings (issue #86)

Disposable feasibility experiment for the production MCode adapter (parent issue #85).
Nothing in `src/` was touched: the harness lives in [`spike/acp/`](../spike/acp/README.md)
and this document records what the protocol actually does.

## Version under test

| What | Value |
|---|---|
| `mcode --version` | **0.7.10** (`@minimax-ai/code` 0.7.10, bundle in `~/.minimax-code/releases/0.7.10`) |
| ACP `protocolVersion` | **1** (the value the agent answered with) |
| Agent identity | `agentInfo = { name: "minimax-code", title: "MiniMax Code", version: "0.7.10" }` |
| Transport | newline-delimited JSON-RPC 2.0 over stdio (`mcode acp`) |

Version-sensitive assumptions: everything below was read out of the 0.7.10 bundle
(`chunks/run-acp-command-*.js`) **and** confirmed against the running agent. A newer
`mcode` may move the extension methods, so the harness re-checks the handshake instead
of trusting the document — and it **refuses to run** against a version other than
`0.7.10` (the findings below would not hold there). `SPIKE_ALLOW_ANY_VERSION=1` runs it
anyway, for the case where the new version is exactly what is being measured.

The run before this one was made against `0.7.9` and answered the same (the report of
that run is in the history of this repository); the extension methods in the two
bundles are the same list, so the upgrade of the runtime changed nothing here. The
`0.7.9` release cannot be executed on this machine any more (its native module is built
for an older Node ABI), so the findings below are the ones of `0.7.10` and the `0.7.9`
run is only a historical comparison.

## Capability negotiation

`initialize` → `protocolVersion: 1` with:

```json
{
  "agentCapabilities": {
    "loadSession": true,
    "mcpCapabilities": { "http": true, "sse": true },
    "promptCapabilities": { "image": true, "audio": false, "embeddedContext": false },
    "sessionCapabilities": { "list": {}, "fork": {}, "resume": {}, "close": {} }
  }
}
```

MCode announces its own extensions in `_meta["minimax-code/extensions"]`:

* methods: `session/activate`, `mcode/session/activate`, `mcode/session/steer`,
  `mcode/session/queue/{list,enqueue,update,delete,steer}`,
  `mcode/session/goal/{get,create,patch,clear}`,
  `mcode/session/delegation/{get,stop,message,transcript}`
* notifications: `mcode/session/current_session_update`, `mcode/session/queue_update`,
  `mcode/session/goal_update`, `mcode/session/delegation_update`

`authenticate` was **not** needed: the process inherits the credentials of the logged-in
CLI profile. Nothing is read from the environment by the spike, and no secret ever
reached the report.

## What works

| Operation | Call | Result |
|---|---|---|
| Handshake | `initialize` | protocol 1, capabilities as above |
| Create | `session/new {cwd, mcpServers}` | `{sessionId, modes, configOptions}`; `modes` = `default`, `plan` |
| List | `session/list {cwd?}` | `{sessions:[{sessionId, cwd, title, updatedAt}], nextCursor}` |
| Prompt | `session/prompt {sessionId, prompt:[{type:"text",text}]}` | `{stopReason, usage, _meta["minimax-code/turn"]}` |
| Streaming | `session/update` notifications | `agent_message_chunk`, `agent_thought_chunk`, `tool_call`, `tool_call_update`, `session_info_update`, `available_commands_update` |
| Second prompt | same session | works, same session, new `turnId`/`runId` |
| Resume | `session/load {sessionId, cwd, mcpServers}` | the session is usable again in a **new process** — the transcript of the session is checked separately, see [The transcript of a session](#the-transcript-of-a-session) |
| Resume (alt.) | `session/resume` | same response shape as `session/load` |
| Fork | `session/fork` | a new `sessionId` that **copies the records of the source session** (counted in the report, see [The transcript of a session](#the-transcript-of-a-session)); one run refused it with `-32603 "Internal error"` — a **refusal** is retried once, and both answers are in the report |
| Close | `session/close {sessionId}` | `{}` |
| Cancel | `session/cancel {sessionId}` — **notification** | the pending `session/prompt` resolves with `stopReason: "cancelled"`, `usageIncomplete: true` |
| Steer | `mcode/session/steer {sessionId, text}` | `{turnId, mode:"steered"}` — the message lands **inside the running turn** |
| Queue | `mcode/session/queue/enqueue {sessionId, text}` | `{itemId, status:"queued", position:1}`; `mcode/session/queue/list` shows it while queued |
| Ask for permission | `session/request_permission` (agent → client) | the agent asks before a write outside the workspace; the options are `allow_once`, `allow_always`, `reject_once` — the turn continues after the answer |
| Options | `session/set_config_option {sessionId, configId, value}` | `configId` = `permissionMode` \| `model` \| `thinkingEffort` |

`session/prompt` answers with `stopReason: "end_turn"` on a normal turn and
`"cancelled"` after the cancel notification. The turn metadata is rich enough for a
production adapter: `_meta["minimax-code/turn"]` carries `runId`, `turnId`, the resolved
`model` (provider, model id, variant) and `durationMs`; `usage` carries the token
counters.

## What does not work

| Operation | Call | Failure |
|---|---|---|
| Cancel as a request | `session/cancel` **with an id** | `-32601 "Method not found"` — it is a notification, not a request |
| Set the model (`minimax` provider) | `session/set_config_option {configId:"model", value:"m:minimax:…"}` | the call is **accepted** (the option of the session changes), but the model does not work on this machine: its managed OAuth bearer is not synced — an earlier run showed the turn failing with `LocalModelResolver: managed OAuth bearer is not synced for provider "minimax"` |
| Set the model (custom provider) | `… value:"m:custom_provider%3Aprovider-<id>:…"` | `-32602 "Model selection is not advertised."` — the provider that actually answers here cannot be selected at all |
| Attach to a foreign session | `session/activate {sessionId of another process}` | `-32002 "Resource not found: <id>"` — the agent only knows the sessions **of its own process**; `session/activate` merely marks one of them as the current session |
| Load with a wrong cwd | `session/load {cwd != persisted workspace}` | `-32602 "Requested cwd does not match the persisted session workspace: <dir>"` |
| Observe a running TUI | `session/activate` on a live TUI session id | `-32002 "Resource not found"` — there is no attach/observe channel |
| Create a session in an unresolvable project | `session/new {cwd}` | `-32603 "Session Project could not be resolved"` — the runtime resolves the cwd against a *project*; a scratch directory outside the repository is the reliable choice |

`session/new` is retried **once**, and only when the runtime refused it with an
internal error about the project (`-32603`, "could not be resolved") — the project of
the cwd could not be resolved at that moment. A refusal carries the code of the runtime
and means that no session was created, so the retry cannot leave one behind. A timeout
or a lost answer carries no code: it is ambiguous (the session may exist), and it is
**not** retried — a second `session/new` would leave a second session behind. An
internal error of another kind is not retried either: it is not this refusal, and it
may have had a side effect. The refusal that caused the retry is recorded in the report
(`retriedAfter`).

The same rule holds for `session/fork`: it is retried only when the answer is a
**refusal** (an error with a code, so that no fork was created). A timeout carries no
code — the fork may exist — and a second call would leave a second fork behind, so it
is not retried. Both answers are in the report (`forkAttempts`).

**Model selection is effectively unusable in this environment.** The advertised model
list contains the `minimax` provider — the call that selects it is accepted, but the
model does not work here (its managed OAuth bearer is not synced), and the custom
provider that actually works is refused with "Model selection is not advertised". The
model therefore comes from the CLI/config, not from ACP. The harness
restores the model of the **session** as it found it: it reads the current model from
`session/new` and sets exactly that value back after the experiment. The restore is
**mandatory** — a run that cannot put the model back is `failed`, not a successful
experiment. An accepted call is not enough: the state of the option in the answer of the
runtime is compared with the value of `session/new`, and a run that reports another
model is `failed` too (`restore.verified`).

**The runtime rewrites its own config file when the agent starts.** The restore
above is the *session option*; the runtime writes its own file (`~/.minimax/config.yaml`)
as well. The step `runtime config file (side effect of a session and of a turn)` measures
it: the file is hashed before the handshake, after the handshake, after the creation of
the session, after the change of the model of the session and after the first turn, so
every event is compared with the state before it.

The measured order is the finding, and it is not the order the hypothesis had:

| Event | The file changed? |
|---|---|
| the handshake (`initialize`) | **yes** (`changedByHandshake: true`) |
| `session/new` | no (`changedBySession: false`) |
| `session/set_config_option` (model) | no (`changedByModelOption: false`) |
| the first turn | no (`changedByTurn: false`) |

So the side effect belongs to the **start of the agent**: neither the session nor the
turn writes into the file of the machine — a turn writes nothing at all. What the
runtime wrote in the committed run was the section `memory`: it brought the memory
settings of the machine into the form it uses itself. The report publishes the names of
the sections only — the added, the removed and the rewritten ones (`addedKeys`,
`removedKeys`, `changedKeys`) — and never their values: they are the state of the
machine. The rewrite is idempotent: a later run on the migrated file changes nothing
(`changed: false`).

The file names the model that served the turn (`namesServedModel: true`) — the model of
a run comes from the file, because the model cannot be selected over ACP (see above).

So a run of the spike does **not** necessarily leave the machine byte for byte as it
found it, and no adapter can promise that either: the runtime owns that file and writes
its own state into it. The harness restores what the protocol exposes (the option of the
session); the file of the machine is the runtime's own state and is left alone — it is
documented here so that an operator knows what a run changes and can restore it (the
step only reads the file, it never writes it).

## The transcript of a session

Two different claims hide behind "the history is restored":

1. **the session is usable again** — `session/load` in a new process answers and the
   session accepts prompts again,
2. **the old turns are in the context of the model** — the model still sees them.

The first is proven by the call itself. The second needs a check that cannot be
fooled by the *position* of a message: the first user-role message of a session is a
runtime system reminder (the deferred tool catalog), so the question "what was your
first message" is answered by the reminder and proves nothing. The spike plants its
own marker instead — the first two prompts of the session ask for the single words
`PONG1` and `PONG2` — and the check asks for **both of them by content**:

> I sent you two short messages in this session, each asking you to reply with a
> single word. Quote both of them exactly.

A restored transcript makes both words appear in the answer; a session that lost its
turns cannot produce them.

A **fork** has a second, deterministic proof that does not depend on the model at
all: the fork gets its own log file in the session store, and the spike counts how
many records of the source log the log of the fork holds (`sourceRecordsInFork`).
No answer of a model can fake that count, and nothing of the transcript is
published — only the counts.

**In the committed run the transcript is restored.** `session/load` in a new process
answers with both markers quoted (`historyRestored: true`), and the log of the fork
holds **all 6 records** of the source session (`sourceRecordsInFork: {matched: 6,
total: 6}`). The answer of the fork itself did **not** quote the markers in that run
(`forkCarriesHistory: false`) — the model of the free tier answered in its own words.
That is the reason the record count is the evidence and the quote is only a bonus: the
count is made by the harness on the files of the store, no model can talk it into a
different number, and an answer of a model can miss a marker it actually sees.

The precision of the check matters. An earlier run of the same spike asked the model
for "the first thing I asked you" and got the runtime's system reminder back — a
check that measures the *position* of a message instead of its content proves
nothing, and the report said `historyRestored: false` for a session whose transcript
was in fact there. The content check settles the question.

## Steering and queue are not the same thing

They were tested separately, in separate turns — and each of the three interaction
experiments (steer, queue, cancel) runs in its **own** session: a turn that hangs leaves
its session busy, and the next experiment would be refused with `"A prompt is already
active for this session"`.

The harness acts only inside a live turn: it waits for the first chunk of the agent (a
thought chunk or a message chunk — a thinking model needs a long time before it writes
anything) and races that wait against the completion of the prompt. If the turn is over
before the first chunk, the operation is skipped and the step is recorded as
`inconclusive` instead of being counted as a success. The turn can also end *between*
the first chunk and the operation — the harness watches the settlement of the prompt
and skips the operation in that case too, so no experiment claims to steer, queue or
cancel a turn that is already over.

* **Steer** (`mcode/session/steer`) injects instructions into the **running** turn. It
  needs an admitted, active ACP prompt turn — otherwise
  `-32602 "Steering requires an admitted, active ACP prompt Turn for this Session."`.
  The **call is accepted**: the answer carries the same `turnId` and `mode: "steered"`.
  Whether the turn then *acts* on the instruction is a second question, and the spike
  keeps the two apart — the step is `ok` only when the agent answers the steer inside
  that same turn (the answer of the turn ends with `STEERED`). In the committed run it
  did: the answer ends with `STEERED` and the turn ends with `end_turn`
  (`steerAcknowledged: true`). In an earlier run the turn of the slow model of this
  machine did not reach the acknowledgement inside the window of the experiment — the
  step was recorded as `inconclusive`, not as a success. So a production adapter can
  rely on the acceptance of the call and on the effect of a steer that the model
  answers, but it must observe the turn itself: the effect is not guaranteed to be
  immediate.
* **Queue** (`mcode/session/queue/enqueue`) parks a message. `queue/list` shows it
  (`status:"queued"`, `source:"api"`) while the turn runs. What happens to it next is
  **not settled** by the spike: in the committed run the turn ended
  (`stopReason: "end_turn"`), the answer of that turn does not contain the queued text
  (`queuedDelivered: false`) and the queue was **empty again** afterwards
  (`queuedLeftover: 0`) — the item left the queue without reaching the model. In an
  earlier run the turn never ended — the `session/prompt` timed out after 240 s
  (`stopReason: "error: timeout after 240000ms: session/prompt"`) — so the item was
  still queued when the harness gave up (`queuedLeftover: 1`, the harness cancelled it
  and the runtime confirmed the cancellation), and in another run the message merged
  into the running turn (the answer ended with the queued text, no second turn id
  appeared). None of these observations is reproducible on this machine, so a
  production adapter must observe the queue itself instead of assuming a merge.

The advertised `mcode/session/queue_update` notification was **not** delivered in any
run (0 notifications), so a client must not rely on it.

## Cancellation and cleanup

* `session/cancel` is a client→agent **notification**; the agent answers it by
  resolving the outstanding `session/prompt` with `stopReason: "cancelled"`.
* `session/close {sessionId}` returns `{}` and closes the session in the agent.
* Closing stdin ends the process cleanly: the `mcode acp` process exits with code `0`
  and **without a signal** (`exitCode: 0`, `signal: null` in the report). The harness
  ends stdin and waits for the exit; a signal is only the fallback of a process that
  does not leave on its own.

## Permissions

`session/new` reports the permission mode of the process in `configOptions`:
`permissionMode` with `currentValue: "bypassPermissions"` and scope `process`.

The mode is process scoped, but `session/set_config_option` needs a `sessionId` — so the
mode can only be changed **after** the session exists. That is not a problem in
practice:

1. `session/new` → the session id,
2. `session/set_config_option {sessionId, configId:"permissionMode", value:"default"}`
   (Ask mode) → accepted,
3. a prompt that writes **outside** the workspace → the agent sends
   `session/request_permission` with the tool call and the options
   `allow_once`, `allow_always`, `reject_once`,
4. the client answers `{outcome:{outcome:"selected", optionId}}` → the turn continues and
   the file is written.

So a production adapter can gate the tools of a turn by answering the permission
request. A tool call inside the workspace did **not** raise a permission request — the
question is asked only where it is needed.

The step is only settled when all of it holds: the mode was established, the agent
really asked about a **write**, the turn ended (`stopReason: "end_turn"`) and the file
holds exactly the requested content (`fileContentMatches`). Otherwise it is `failed` — a
permission experiment that only half happened is not evidence. The probe file is
written into a fresh temporary directory and removed afterwards, so the spike never
overwrites a file of the machine.

The prompt is asked a second time when the model only *narrates* the write and ends
the turn without calling the tool (`attempts` in the report): that is a turn of the
model, not a fault of the flow the step measures. The retry happens in a **fresh
session** — a new session, the mode set on it and the prompt asked again — because a
model that only narrates the write answers the next prompt of the same session with
the same narration.

The spike answers every request **automatically** — a test behavior, not a policy: it
picks the narrowest option it is offered (`allow_once`, otherwise `reject_once`), and
never a permanent grant (`allow_always`). If neither narrow option is offered, the
request is **cancelled** rather than answered with an arbitrary option — a fallback
would grant a permanent permission. A production adapter must ask a human
instead; what the spike establishes is only that the request and the answer work.

The automatic answer is bounded: the handler allows a call only when it is a
**filesystem operation** (`kind` is `read`, `edit`, `delete`, `move` or `search`) *and*
every path it names lies inside the scratch roots of the run (the work directory and
the directory of the probe); every other call is refused (`reject_once`). The kind
matters because a path is not an operation: a shell command can name a file of the
scratch space **and** send it away, so a command is refused whatever paths it names
(only `read`/`edit`/`delete`/`move`/`search` are approved automatically). Every path
of the call counts
— the structured fields (`rawInput`, `locations`), every other field, and a path that
is mentioned inside a string (a command, a pattern) — and the paths are resolved
before they are compared, so a symbolic link that points out of the scratch space is
seen as what it points to (a link whose target does not exist yet is a link all the
same, and a **chain** of links is followed to its end — a link that points at a link
that points out of the scratch space is outside of it as well). A path of a
**single segment** (`/etc`) counts as well: only a token that
cannot be a path is left out — the slash of a mime type (`text/plain`) stands in the
middle of a word, and the `//` of a url is not a path of the machine. A call that
names **no path at all** cannot be checked and
is refused as well — an operation without a known target (a command, a network call)
can reach anything, and a default-allow would make the boundary of the run a claim
instead of a fact. The refusals are counted in the report (`refusedOutsideBoundary`),
so an unattended run cannot act outside its scratch space and the boundary is visible
in the evidence. In the committed run nothing was refused
(`refusedOutsideBoundary: []`): the agent asked twice — for the write of the probe file
and for the read that verified it — and both calls named a path inside the boundary.

The main experiments do **not** set a permission mode: they inherit the mode of the
machine (`permissionMode: "bypassPermissions"` in the committed report), so a tool call
of an experiment would run without a gate. Only the permission experiment itself sets
`default` (Ask mode) in a fresh process. The prompts of the other experiments are
answers and an essay, so no tool call was needed — but the spike does not prove that a
tool call of an experiment would have been gated.

## Cross-process behaviour

Two ACP processes can drive **one** session id — but only once the session has
content:

* process B `session/activate` on the session of process A → `-32002` (no attach),
* process B `session/load` the session of process A **before** it had a turn →
  `-32002 "Resource not found"` — a session without a turn is not in the store yet,
  and `session/list` does not list it either,
* process B `session/load` the same id **after** the owner gave it a turn →
  **succeeds**, and both processes can then prompt the same session (both answers
  arrived: `ATTACHED` from B, `OWNER-STILL-ALIVE` from A).

The session store is shared, so a session id belongs to the **store**, not to the
process that created it. A production adapter must therefore not assume that another
process is not driving the same conversation — and it must not expect to pick up a
session that has not run a turn yet.

(The run against `0.7.9` answered the same, except that the load of a *fresh* session
succeeded there too: the runtime published a session to the store right away. The
upgrade to `0.7.10` moved that publication to the first turn.)

**Concurrency was tested separately and is not safe.** The experiment above is
*sequential*: process B finishes its turn before process A starts its own. A second
experiment sends a prompt from both processes **at the same time** into the same
session. The result is recorded in the report (`cross-process concurrent prompts`):
one prompt won the turn (`CONCURRENT-A` or `CONCURRENT-B`, depending on the race) and
ended with `stopReason: "end_turn"`, the other was refused with
`-32603 "Session already has an active Turn. Use queue send to deliver the message
after it."` — the store serializes nothing, it only lets one turn run.
The conclusion for an adapter: one session id belongs to **one** driver at a time —
concurrent prompts into one session must be serialized by the caller.

## Can a manually launched interactive TUI session be attached to?

**No — not attached, and not observed.** What exists is *take-over of the stored
conversation*, which is a different thing:

1. There is no protocol operation that attaches to a running TUI process. `session/activate`
   on a live TUI session id fails with `-32002 "Resource not found"`, because the agent
   only knows the sessions of its own process.
2. The session **store** is shared between the TUI and the ACP server. An ACP process
   can `session/load` (and `session/fork`) a TUI session id — but only with the cwd of
   the persisted workspace — and can then read that conversation. The spike continued
   it through the **fork**; the continuation of the loaded session itself was not
   measured. The step is `ok` only when the session was really loaded and forked
   **and** the fork holds every record of the source: a session that cannot be loaded
   is `inconclusive` (nothing was measured), a fork that fails is `failed`, a
   transcript that is empty is `inconclusive` (there was nothing to carry), and a
   fork that holds fewer records than its source is `failed` — the transcript was
   not carried over.
3. **The records of the TUI session are really there.** The fork of the live TUI
   session has its own session log, and that log holds the records of the TUI session
   (its compaction summary, its session-identity reminder, its assistant turns and
   its tool results) plus the fork's own turn — the fork log has more records than
   the source log (4 against 2 in the committed run; 45 against 29 when the source was
   a session with a long conversation). The spike counts the records of the source log
   that the log of the fork holds: **all of them** (`sourceRecordsInFork:
   {matched: 2, total: 2}` in the committed run, `{matched: 29, total: 29}` in the
   run with the long source session). The count is the evidence, because no answer of
   a model can fake it.
   The source TUI session log was **not** modified by the load (size, mtime and the
   hash of the file unchanged) — the fork is a copy, the load is a read. The record
   counts of both logs are in the report (`forkLog`, `liveSessionLog`).
   The model of the fork **did** quote the first answer of the source session in the
   committed run (`forkAnswerQuotedSource: true`) — an earlier run did not
   (`false`), so the record count is the reliable evidence and the quote is only a
   bonus.
4. What is **not** possible: streaming the turn of the running TUI to the ACP client,
   steering the TUI's UI, or cancelling the TUI's turn. `session/cancel` and
   `mcode/session/steer` address the turn of the **ACP process**, not of the TUI.

The report publishes neither the id of the TUI session nor its transcript: the ids
are replaced by stable placeholders, and the answer of the fork is not recorded (it
would carry the text of another conversation). What is published about it is the
verdict of a local comparison — whether the answer quotes the first answer of the
source session (`forkAnswerQuotedSource`) and the hash of the marker it was compared
against (`sourceMarker`).

The pty harness (`python3`'s `pty` module — `script` is not installed) can start the
TUI itself: in the committed run the composer rendered, the TUI answered the prompt of
the harness and the run persisted **one new session directory** in the store, so the
step is `ok` — a manually launched TUI leaves a session behind, of the same kind that
the load test above picked up. The step is `ok` only when all of it holds: the
composer rendered, the pty run ended cleanly, the session was persisted **and** the
answer of the assistant is in the log of that session — the launch and the session
alone would prove nothing, because the prompt could have been submitted to a TUI that
never answered it. A run without a persisted session is `inconclusive` (nothing was
measured); a run whose session holds no answer is `failed` (the experiment ran, the
answer was missing). The raw output of the terminal is not published: the report keeps
only the exit code, the number of new session directories, the id of the session (as a
placeholder), whether the composer appeared and whether the answer is in the log. The
raw output is not logged either — it is a transcript of a conversation.

The harness types the prompt once the composer is there and waits for the turn to
end, so a slow answer is not cut off; the runtime persists the session a moment after
the process is gone, so the step waits for the directory to appear. Both waits are
about the *timing of the harness*, not about the runtime: without them a run that
worked would look like a run that left nothing behind.

## Recommendation for the production transport

**ACP only.** There is no runtime SDK to add on top: the CLI is the only product
interface, and `mcode acp` is its one documented, versioned, machine-readable surface.
A custom RPC around `mcode exec` is explicitly ruled out by the issue and by the
findings — `mcode exec` cannot be steered, queued, cancelled or resumed.

What the production adapter may rely on:

| Need | Use |
|---|---|
| start a conversation | `session/new` |
| run a turn, stream it | `session/prompt` + `session/update` |
| gate a tool call | `session/request_permission` (agent → client, answer it) |
| interrupt a running turn | `mcode/session/steer` (in-turn, the effect was observed in the committed run) or `mcode/session/queue/enqueue` (parked message, the delivery is not settled) |
| stop a running turn | `session/cancel` (notification) |
| continue after a restart | `session/load` with the same `cwd` |
| branch a conversation | `session/fork` (the fork copies the records of the source session) |
| end a conversation | `session/close`, then close stdin |

What the production adapter must **not** rely on:

* `session/activate` (process-local, no cross-process meaning),
* model selection over ACP (refused or unusable in this environment),
* `mcode/session/queue_update` (advertised, never delivered),
* attaching to or observing a running TUI session,
* the presence of a session id as proof that a session can be resumed — `session/load`
  is the only proof, and it refuses a mismatching `cwd`,
* two drivers on one session at the same time — a session id belongs to one driver
  at a time, concurrent turns interfere,
* the *effect* of a steer or of a queued message inside the running turn as a
  guarantee — the committed run shows a steer that the model answered, but a turn of
  a slow model can miss the window of the experiment, and the delivery of a queued
  message was never observed; the adapter has to observe the turn itself.

## Reproducing

```bash
cd spike/acp
node spike.mjs                                   # writes results/report.json
SPIKE_TUI_SESSION_ID=<a live TUI session id> \
SPIKE_TUI_SESSION_CWD=<its workspace> \
SPIKE_TUI_SESSION_FILE=<its messages.jsonl> \
  node spike.mjs                                 # adds the TUI attach test
```

The harness prints one line per step and records the answers in
`spike/acp/results/report.json` (written after every step, so a killed run still leaves
its evidence). Every step carries a `status` — `ok`, `inconclusive`, `skipped` or
`failed` — and `ok` is only true when the experiment really ran and produced its
evidence. A step that answers a question about a turn checks two things: the turn has
to **end** (`stopReason: "end_turn"`) and the answer has to **contain the marker** the
prompt asked for. A turn that ended without the marker is `inconclusive` (the model
answered something else, the protocol worked), a turn that did not end is `failed`. It
runs real model turns (a few minutes, a few thousand tokens per
prompt) — the essays are only there to keep a turn busy long enough to steer, queue and
cancel it.

The client of the harness accepts only what the protocol allows: a message that is not
JSON, not an object or not a JSON-RPC 2.0 envelope is a **violation of the protocol**,
and it is counted in the report (`meta.protocolErrors`) instead of being answered — a
result of a broken envelope would be a result of nothing. A response that carries
neither a `result` nor an `error` is such a violation too: answering the request with
it would turn a broken answer of the runtime into an empty one, so the request fails
with that reason instead. A dropped message must not
look like a missing answer, so the violations are part of the evidence. The run opens
several clients (the experiments that need a second process, the TUI experiment) and
every one of them is asked: a violation in a second process is a violation of the run,
not of a single client.

**The report keeps derived evidence, not the text of the model.** An answer of the
model can hold anything the model wrote, so it is never published and never logged as
it is: every step that carries an answer publishes `answer` — the length of the text,
the first twelve characters of its SHA-256 and whether it holds the marker the prompt
asked for. The text itself stays in the run and dies with it. The same holds for the
terminal of the pty experiment: its raw output is not published **and not logged**,
because it is the transcript of a whole conversation.

**The committed report is public.** `spike/acp/sanitize.mjs` replaces the data of the
machine before anything is written: absolute paths become relative (`<repo>/…` or
`~/…`, `<path>` on any other filesystem), the session ids become stable placeholders
(`mvs_<8 hex>` — two different ids stay different), and the BYOK provider of the
machine becomes `provider-<id>` (and `<provider>` inside a model value). The
transcript of another conversation (the answer of the fork of the TUI session) and the
titles of the sessions of the machine are not recorded at all.

Known environment limits of a run:

* the model of the machine decides how long a turn lasts — a slow or free provider may
  need minutes before it writes its first chunk, and the interaction steps are then
  recorded as `inconclusive` (the turn never became steerable inside the window),
* the model may answer `429 Token Plan usage limit reached` — the plan of this machine
  ran out during an earlier run; the affected step (`TUI session …`) was still settled
  from the session store, but a fresh run may hit it earlier,
* a free provider of the machine has a **daily** quota (1000 requests) **per model**:
  the model of the machine (`recursive/flint-v1.0:free`) ran out during a run of the
  spike (`429 You've used all 1000 free Flint requests for today`), while the variant
  of the same provider that the committed run uses (`stealth/glyph-cluster:free`)
  still answered. Nothing of the experiment depends on the model: the protocol answers
  are the same, only the length of a turn changes,
* `session/new` fails with `Session Project could not be resolved` for a cwd whose
  project the runtime cannot resolve — `SPIKE_WORKDIR` can point at a scratch directory
  outside the repository (`~/.cache/10x-chat-tmp/acp-spike`),
* the run refuses an `mcode` other than `0.7.10` — `SPIKE_ALLOW_ANY_VERSION=1` runs it
  against another version anyway.
