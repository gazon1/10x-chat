# The development workflow

`10x-chat workflow` automates the loop of the [Helix-style development](../skills/10x-chat/workflows/helix-development.md)
playbook for **one GitHub Issue**: the Issue is read, an isolated worktree is
created for it, a coding agent implements it, the review pipeline judges the
change, the findings go back to the agent, and the loop repeats until the
review approves the change — or the workflow blocks and a human takes over.

The workflow is **opt-in**. No other command of 10x-chat changes its behaviour
because of it, and Orca is not required to use 10x-chat at all.

## The division of labour

| Owner | What it owns |
|---|---|
| 10x-chat | The state of the workflow, the transitions, the review gate, the recovery and the report. |
| Orca | The worktree of the Issue and the coding agent that works in it. |
| GitHub (`gh`) | The Issue and its requirements — the version of them is hashed. |
| The review pipeline | The independent review of the change and its verdict. |

## The loop

```text
created → issue-loaded → worktree-created → implementation-running
   → awaiting-review → review-running ─┬→ completed          (APPROVE)
                                        └→ fixes-requested → implementation-running
```

Every state is a step of the loop, and every step is written to the disk
**before** the next one starts. A workflow that was interrupted is therefore
inspectable (`status`), continuable (`resume`) and stoppable (`stop`) without
losing the evidence of what happened.

`blocked` is a terminal state: the workflow cannot decide on its own, and a
retry is a new workflow.

## One workflow, one process

Two processes that work on the same workflow would otherwise both see an empty
list of workers and both start an agent for the same worktree. The run of the
loop therefore holds the **lock of the workflow** — the abstract unix socket of
the project (`src/core/lock.ts`). The kernel gives the name of the socket to
exactly one process and takes it away when the holder dies, so a killed run
never leaves a lock behind.

The lock is held by `start` and by `resume` for the whole run of the loop. It is
**not** held by `stop`: a workflow must be stoppable while another process is
working on it. The protection against a lost update is the other half — the
record is written under the **lock of the state**, and the check of the record on
the disk and the write of the record happen together: a run that finds a
different state, or a record that another process wrote in the meantime, stops
instead of overwriting the work of the other process. The record carries a
**revision** — the number of its write — because two processes can hold the same
state and still be two processes.

`stop` and the blocking of a failed step are the exception: they read the record
on the disk again under the lock of the state and change the state of that
record. The identifiers of the other process — the Run, the Dispatch and the
worktree — are never lost to an older copy of the record.

The worktrees of the repository are read before a new one is created: a worktree
of the same Issue that is already there is **adopted** — but only when it is
provably the worktree of this workflow. The same holds for the agent: a worker
that is already there is adopted too — even when the answer of the command that
started it was lost: the Run is asked, and the worker that is there is adopted
instead of a second one.

## The worktree belongs to one workflow

The branch and the name of the worktree are derived from the Issue
(`10x-chat/issue-<n>` and `issue-<n>`), so that the worktree of a lost answer is
found again. The workflow writes its mark into the comment of the worktree when
it creates it (`orca worktree create --comment …`), so that a worktree of a lost
answer still carries the proof of its owner. A worktree that is already there is
taken over only when it can be proved to be ours:

| The worktree that is already there | What the workflow does |
|---|---|
| the checkout of the user (the main worktree) | refuses it — the agent never works in the checkout of the user |
| a symbolic link to the checkout of the user | refuses it — the identity of a checkout is the directory it really is, and the git of the checkout resolves the links |
| a worktree of another branch | refuses it — the name of the Issue is not the proof of the ownership |
| the worktree of another workflow (its checkpoint names it) | refuses it — two workflows never share a checkout — unless the record of that run is a run of the same Issue, and then it is the worktree of a run that died |
| a worktree linked to another Issue | refuses it — the worktree of another Issue is not the worktree of this one |
| a worktree with a comment of somebody else | refuses it — the workflow does not take a worktree it cannot prove |
| a worktree without any proof of its owner | refuses it — an empty comment is not a proof |
| a worktree that already carries changes | refuses it — the work of somebody else is not taken over |
| a worktree with changes that are not committed | refuses it — the agent would carry the work of somebody else into the change of the Issue |
| the worktree of this workflow, untouched at the base | adopts it — the answer of a lost command is not a reason to make a second worktree |

The ownership is a proof and not a guess: the worktree carries the mark of this
workflow, or the record of the workflow already knows it, or Orca links it to the
Issue of the workflow (`linkedIssue`) and it carries the name and the branch of
the Issue. Two worktrees of the branch of the Issue are an ambiguity that is
refused, never guessed.

The worktrees of the repository are read for the same reason: the list is how a
lost answer is reconciled.

**The answer of Orca is not the proof of the worktree.** A worktree that Orca has
just created is checked before the agent may work in it: it must not be the
checkout of the user, its git must be the git of the repository of the Issue
(the common directory of the two is the proof — a worktree of another repository
has another one), and it must work on the branch of the Issue. A worktree whose
branch cannot be read at all is refused too: a branch that cannot be proved is
not the branch of the Issue. A worktree that does not pass the check is refused,
and the agent never works in it.

**The identity of a checkout is the directory it really is.** A path and the
checkout it names are two different things: a symbolic link to the checkout of
the user is a path of its own, and a lexical comparison of the paths does not
see it. The git of the checkout resolves the links (`rev-parse --show-toplevel`),
and the main worktree of the repository (`git worktree list`) is the checkout of
the user under whatever path names it. A worktree that resolves to the checkout
of the user is refused — when it is created, when it is adopted and on every run
of the record.

**The worktree of the record is the worktree of Orca.** On every run the worktree
of the record is compared with the worktrees of Orca: the id, the path, the
branch of Orca (a branch that is not named is a refusal) and the git of the
checkout — its branch, its common directory against the common directory of the
repository that is registered in Orca, and its identity against the repository of
the workflow. An identity that cannot be read is a refusal: nothing proves that
the agent works in the repository of the Issue.

**One agent in the worktree.** Two candidates in the Run of the workflow — two
workers that are not settled, or two that are — are an ambiguity that is refused:
the workflow does not guess which one is its own and starts no agent next to
them.

**One workflow at a time per Issue.** A second `start` of the same Issue is
refused while the first one runs: two workflows of one Issue would share the
worktree, and two agents would work in the same checkout.

**One registration of the repository in Orca.** The repository of the checkout may
be registered in Orca more than once — a clone and a mirror of it. The
registration that is the checkout of the user wins; when there is none, the
ambiguity is refused and never guessed: a worktree of the wrong clone is a
change of somebody else's checkout.

**The host of the remote is a part of the identity.** The same `owner/name` on
another host is another repository: a registration of Orca whose host is not the
host of the remote of the checkout is refused, and the agent never works in a
repository of another host.

**The base ref is the ref that resolves.** The default branch of `origin` is
resolved, never assumed: when the checkout has no local branch of that name —
a detached checkout that fetched the remote only — the ref of origin is used
(`origin/main`), and a worktree is created from the commit it names.

**The worktree starts at the base.** The commit the worktree is at is read and
compared with the commit the workflow asked for: a worktree at another commit
is refused, because the review compares the change with the commit the
worktree started from, and a change of another commit is a change of another
code. The commit that is proved this way is the base of the review.

**The agent works in a clean worktree.** The agent is started only when the
worktree has no changes that are not committed: the review reads the committed
state, and the changes of somebody else would be approved as a part of the
change of the Issue.

## The commands

```bash
# Start the workflow of an Issue of the repository of the checkout.
10x-chat workflow start --issue 59

# The agent that implements the change (default: codex).
10x-chat workflow start --issue 59 --agent codex

# The backend that reviews the change (default: chatgpt-use) and its model.
10x-chat workflow start --issue 59 --backend chatgpt-use --model gpt-5

# How many times the findings may go back to the agent (default: 3).
10x-chat workflow start --issue 59 --max-iterations 2

# The ref the worktree is created from (default: the default branch of origin).
10x-chat workflow start --issue 59 --base main

# How long the workflow waits for the agent before it gives the turn back.
10x-chat workflow start --issue 59 --wait 1800000

# The state of a workflow — it never changes it.
10x-chat workflow status issue-59-20260101000000-abcd1234

# Continue a workflow that was interrupted.
10x-chat workflow resume issue-59-20260101000000-abcd1234

# Stop a workflow — the state and the worktree stay for the inspection.
10x-chat workflow stop issue-59-20260101000000-abcd1234

# The report of a workflow.
10x-chat workflow report issue-59-20260101000000-abcd1234
```

`start` prints the id of the workflow — the argument of every other command.

## What it needs

- **`gh`** — installed and authenticated (`gh auth status`). The Issue is read
  through it, and the requirements of the change are its title and its body.
- **The Orca runtime** — ready, with the whole lifecycle of the worktrees and
  of the orchestration: the aggregate contract `orchestration.contract.v1`, or
  every verb of it (`run-create`, `run-list`, `worker-start`, `worker-show`,
  `worker-list`, `worker-stop`, `check`), and the verbs of the worktrees
  (`worktree.list`, `worktree.create`, `worktree.comment`). A runtime that
  names a verb of the worktrees has to name all of them — a runtime that
  offers `worktree.list` alone cannot create a worktree. A runtime that names
  no verb of the worktrees at all publishes them as the features they are
  (`worktree.*`) — the real Orca publishes twenty-six capabilities of that
  family and not one verb of them — and then the family has to promise the
  creation of a worktree (`worktree.create…`): a family that promises nothing
  about the creation cannot create one. The operations of the worktrees are
  never taken from the names: they are **proved**. The workflow reads the
  worktrees of the repository before it creates anything, and a runtime whose
  worktrees cannot be read is a refusal, not a promise. The repository of the
  checkout must be registered in Orca (`orca repo add --path <path>`).
- **A review backend** — the same ones the `review` command uses
  (`--backend chatgpt-use` by default). The review of the change is the
  pipeline of the repository, not a second one.

## The gates

The workflow reports `completed` only when **all** of these hold:

1. every mandatory step of the review ran and passed — a step that is missing is
   a step that did not run, and the absence of a failure is not the evidence of a
   judgment. The mandatory steps are the steps of the pipeline that judge the
   change, the rendering of its report included: a review that approved the
   change and never wrote its report has not produced the report the workflow
   refers to;
2. the verdict of the review is `APPROVE`;
3. the head of the worktree did not move while the review ran — the review
   judged the commit that is there now. The head is also compared with the head
   the agent left behind **before** the review starts: a commit that appeared
   between the end of the agent and the start of the review is a change that
   nobody asked the agent for, and the report of the agent belongs to another
   commit;
4. the review compared the change with the commit the worktree started from — a
   base ref that moved under the workflow is a comparison of another change;
5. the Issue is still the version the workflow started with — a requirement
   that changed since is a requirement nobody judged. The Issue is read while
   the agent works as well: a requirement that changes under the agent
   invalidates the context the agent works on, and the workflow stops for the
   reevaluation instead of waiting for a change that was made against
   requirements that are not the current ones. The agent is stopped before the
   workflow is blocked there — a blocked workflow is terminal and nobody
   supervises the worker any more, and a worker that keeps working changes the
   worktree against requirements that are already obsolete. A stop that cannot
   be confirmed is named in the reason of the block;
6. the worktree is clean — the review reads the committed state only, and a
   change that is not committed is a change that nobody judged. The worktree is
   checked when the review starts **and** when it ends: a change that appears
   while the review runs was never judged, and a commit is not the only form of
   a change — the head of the worktree can stay where it is while the worktree
   gets dirty;
7. the worktree is still the worktree of the workflow — the review takes
   minutes, and a worktree that was moved to another path or to another branch
   under the review is not the checkout the workflow started. The identity of it
   is proved again, immediately before the approval;
8. the approval is bound to the version of the requirements that the review
   really read — the record keeps the hash of that version, and the hash the
   workflow remembers has to be the same one: an approval of another version of
   the Issue is not an approval of this change, whatever the verdict says.

The report of the run is **evidence, not the outcome**: a report that cannot be
written is noted in the history of the workflow, and it does not turn a
completed workflow into a failure.

Anything else ends in `blocked` with the reason. **An approval of the model is
not an approval of a human**: the worktree of the workflow stays for a human,
and nothing is published.

## What it never does

- It never pushes a branch, never opens a pull request, never merges and never
  deletes a worktree or a branch. The change stays in the worktree of the
  Issue.
- It never starts a second agent for the same workflow. A worker that is
  already there is adopted — the answer of a lost command is not a reason to
  run the agent twice. A worktree of the same Issue is adopted the same way.
  A worker that has **finished** is adopted too: the agent of an interrupted
  start may have ended before its Dispatch was written down, and a second agent
  would work in the same worktree. Its result is read by the wait — and a
  result that nobody confirmed blocks the workflow instead of approving a
  change.
- It never reports a stop it did not confirm. The state of the worker is
  checked: a worker that cannot be stopped leaves the workflow `blocked` with
  the reason, because an agent that still works in the worktree is not a
  stopped workflow.
- It never treats the text of the Issue as an instruction: the body of the
  Issue is data inside a fence of the brief of the agent.

## The iteration is a supervised work item

Every iteration of the workflow is its own **supervised work item**: the
corrections of a review are a new Dispatch of the same Run, with a brief of
their own — the findings of the review. The Dispatch of the judged iteration is
finished, and a finished Dispatch does not wake up: a correction that reused it
would read the result of the work that was already judged, and the workflow
would report that the agent changed nothing.

The outcome of a worker is only read from the **structured result** of its
Task — the outcome of the Dispatch or the message of the mailbox. A state that
says `succeeded` is terminal, not successful: a worker that reports no
structured outcome leaves the result of its Task unknown, and the workflow
blocks instead of approving a change nobody confirmed.

The message of the mailbox belongs to the Dispatch that names it. The Run is
shared between the iterations of the workflow, so a message of another worker
of the Run is not the result of this iteration: it is skipped, and the
workflow reconciles against the state of its own worker instead. A message
without a Dispatch belongs to the worker that still works — when every worker
of the Run is done, only a Run with a single worker may answer it, and a Run
with several of them leaves the message ambiguous. An ambiguous message is
never the result of an iteration: the workflow waits for the state of its own
worker.

## The worker works in the worktree of the workflow

The worker of the workflow works in the worktree of the workflow, and the
workflow **proves** it instead of assuming it. The Run is reused between the
iterations, and Orca may put a worker of it in another checkout: an agent that
works in the worktree of another Issue would be judged on the change of the
worktree of this workflow — a change nobody made — and its result would close
the wrong iteration.

The proof is the checkout the worker names and the branch it names: the
checkout must be the worktree of the workflow — the same directory it really
is, the symbolic links of it resolved — and the branch must be the branch of
the workflow. A worker that the workflow **found** — the one that is already
there, the one of a lost answer of the start command — and that names neither
its checkout nor its branch cannot be identified at all: the workflow does not
adopt a worker it cannot identify, and it blocks instead of guessing. A worker
of an **own** start names the worktree in the command itself, so it only has
to be free of a contradiction.

A worker that the workflow refuses is stopped before the workflow is blocked —
unless it works provably somewhere else: a worker of another checkout is not
the worker of this workflow, and the workflow does not stop what is not its own.
A blocked workflow is terminal, and nobody supervises the worker any more: an
agent that keeps working in the worktree changes it while the workflow says
that it is over.

The **corrections go to a worker that received them**. The findings of a review
are the brief of a new Dispatch, and a worker of an earlier task does not know
them: the workflow adopts the worker whose task carries the title of the
corrections, and a worker of an earlier task that still works in the worktree is
stopped before the workflow starts its own agent — two agents in one worktree
are a change nobody judges.

## The brief carries the instructions of the repository

The brief of the agent is not only the Issue: it carries the instructions of the
repository — the `AGENTS.md` of the worktree — and says that the files that
`AGENTS.md` names are to be read before the change is written. A rule that says
"read AGENTS.md" is not the rule itself: an agent that does not know the
conventions of the repository writes a change the repository does not want.

The instructions are **data of the task**, like the body of the Issue: they
decide how the change is written, and they never override the rules of the
brief. The corrections of a review are a new worker with a brief of their own,
and it gets the same instructions.

An `AGENTS.md` that is not there is a checkout without rules of its own. An
`AGENTS.md` that is there and cannot be read is another thing: the rules of the
repository are unknown, and an agent that does not know them works against
them — the agent is not started.

## The stop stops every worker

`stop` does not take the lock of the run — a workflow must be stoppable while
another process works on it. It stops **every worker of the Run**, not only the
Dispatch of the record: the Dispatch is written down after the start command
answers, and a stop in that window would leave an agent in the worktree that
nobody knows about. A stop that cannot be confirmed leaves the workflow
`blocked`: an agent that still works in the worktree is not a stopped workflow.

The state of the worker is the truth, and it says three different things:

| What the runtime reports | What the workflow says |
|---|---|
| the worker was stopped | "The agent was stopped." |
| the worker does not work in the worktree any more — it finished on its own | "The agent does not work in the worktree any more." — it was not stopped by the workflow |
| the state is unknown | "The state of the agent is unknown — it may still work in the worktree." |

A worker that **succeeded** is in the second row and not in the first: the
workflow never claims that it stopped an agent that finished on its own. A stop
that could not be confirmed is named in the reason of the block — it is never
swallowed.

The stop reaches a workflow that is **over** as well. A workflow that was
blocked may still have an agent in its worktree — the block of an iteration
does not stop the agent it blocked on — and the stop of such a workflow stops
the workers of its Run all the same. The state of a workflow that is over does
not move: a stop is not the cancellation of it, and the reason of the stop is
written into the history of the run and into the reason of the block.

## The stop and the start never meet

The stop does not take the lock of the run, so it can run while another process
starts an agent. The state `stopping` closes that window: the stop writes it
down **before** it looks for the workers, and the process that starts an agent
reads the state of the record on the disk twice — before the agent starts and
after it started.

| Moment | What happens |
|---|---|
| the record on the disk says `stopping` before the agent starts | no agent is started — the workflow is on its way out |
| the record on the disk says `stopping` after the agent started | the worker that was just started is stopped again, and the run reports that the agent was stopped |
| the answer of the start command was lost and the workflow is on its way out | the worker that the Run holds is stopped again too — a lost answer hides the worker from the stop, not from the workflow |
| the record on the disk is terminal | the run stops without a write — the stop owns the outcome of the workflow |

A workflow that is being stopped is not blocked by the step that ran into the
stop: the stop decides whether the workflow is `cancelled` or `blocked`.

The state `stopping` is **not a dead end**. The process that was stopping the
workflow may have been killed between the mark of the stop and the
cancellation, and the workflow would wait there for ever, doing nothing and
occupying its Issue. A `resume` finishes the stop: the workers of the Run are
stopped and the workflow is cancelled — or blocked, when a worker cannot be
stopped.

## The resume keeps the review of the workflow

A workflow is resumed with the backend and the model it was started with: the
review of the next iteration has to be the review of the same kind, and a
backend that is silently another one is a review nobody asked for. The command
line still wins — `--backend` and `--model` change the review on purpose. A
backend of the record that is not available is a refusal and not a silent
fallback to another one.

## The state on the disk

```text
~/.10x-chat/workflows/<id>/
├── workflow.json          ← the record of the workflow (0600)
├── events.jsonl           ← the history of the states (0600)
├── report.md              ← the report of the workflow (0600)
└── reviews/iteration-N/   ← the review of every iteration
```

The directory is private (`0700`) and the files belong to their owner alone
(`0600`). The record is written atomically — a workflow that was interrupted
leaves a readable record behind, never a half-written one. The privacy is
enforced before every read and not only after every write, and a link in the
store is refused: `readFile()` follows a link, and a link in the store would
take the read outside of it. The directory of the store is made private before
every **listing** too: the names of the workflows are evidence as well — a
store that was restored with wide permissions tells everybody which Issues were
worked on.

**A record that cannot be read is never replaced.** A record that is not there
and a record that is broken are two different failures: only the first one is
an empty store. A broken record, a record behind a link and a record that the
owner may not read are refused by every write — the evidence of the run is not
overwritten by a fresh one, and the workflow reports that the record cannot be
read instead of pretending that nothing happened.

**A broken record of an Issue also stops a second workflow of that Issue.** The
record may still describe a workflow that runs, and a second workflow of the
same Issue would put a second agent into the same worktree. The start is
refused with the reason, and the broken record is left as it is: the user
removes it after looking at it. A broken record of another Issue is skipped —
it cannot speak about this one.

The requirements of the Issue are not stored twice: the snapshot of the
[review pipeline](review-pipeline.md) is reused, and the `check-requirements`
step of the review is the gate that says that the Issue did not drift.

## The recovery

| Situation | What happens |
|---|---|
| The agent is still working when the wait is over | The workflow keeps its state and gives the turn back. `resume` continues it. |
| The command was interrupted | The record of the last completed step is on the disk. `resume` continues from there. |
| The agent changed nothing | The workflow blocks — there is no change to review. |
| The state of the agent is unknown | The workflow blocks — an unknown outcome is not a success. A Dispatch that says `succeeded` without a structured outcome is unknown. |
| The worktree is not clean | The workflow blocks — the review reads the committed state only. The same check keeps the agent from starting in a dirty checkout. |
| The worktree is at another commit than the base | The worktree is refused — the agent would work on another commit than the one the change is compared with. |
| The worktree of the record is not in Orca anymore | The workflow does not continue — the record remembers a worktree, Orca owns it, and a worktree that is not there is not the worktree of the workflow. |
| The worktree of Orca is on another branch | The workflow does not continue — the worktree of the workflow is not the worktree of Orca. |
| The Issue changed | The workflow blocks — the change was judged against older requirements. |
| The agent could not be stopped | The workflow blocks — the agent may still work in the worktree. |
| The workers of the Run could not be read | The workflow blocks — an agent of the Run may still work in the worktree. |
| Another process moved the workflow | The run stops without a write — the state on the disk is the truth. |
| Another process wrote the record | The run stops without a write — the revision of the record is the truth. `stop` merges with the record that is there instead. |
| The answer of the start command was lost | The Run is asked: the worker that is already there is adopted — a second agent would work in the same worktree. |
| The answer of the creation of the Run was lost | The Runs are asked: the Run of the objective of the workflow is adopted — a second Run would be a second home of the mailbox. Two Runs of the same objective are an ambiguity that is refused, never guessed. |
| The workflow was stopped while the agent was starting | The agent is not started, or the agent that was started is stopped again — a workflow that is cancelled never leaves an agent in the worktree. The same holds for the agent of a lost answer. |
| The record of the workflow cannot be read | Every write is refused — a broken record is the evidence of the run, and it is not replaced by a fresh one. |
| The record of the workflow of this Issue cannot be read | The start of a second workflow of the Issue is refused — the broken record may still describe a workflow that runs. |
| The branch of the created worktree cannot be read | The worktree is refused — the agent never works in a checkout whose branch cannot be proved. |
| The repository is registered in Orca for another host | The registration is refused — the same `owner/name` on another host is another repository. |

## The seams

The workflow depends on a few things that are replaceable, so that its own
tests need no Orca, no GitHub and no model:

| Seam | Default | Replaced by the tests with |
|---|---|---|
| `OrcaApi` | the `orca` CLI (`src/orca/client.ts`) | a fake that records the calls |
| `WorkflowGit` | `git` (`src/workflow/git.ts`) | a fake with a variable head |
| the review | `runReviewPipeline()` (`src/pipeline/review.ts`) | a fake that answers with a verdict |
| the Issue | `gh` (`src/pipeline/requirements.ts`) | a fake that answers with a version |
| the instructions of the repository | the `AGENTS.md` of the worktree | a fake that answers with the rules of the change |
| the environment of `gh` | the environment of the process | the PATH of a `gh` of the test |

A local change — the change of a worktree that was never pushed — is reviewed
from its diff: the reviewers have no page of it on GitHub. That is the one
place where the pipeline differs from the review of a pull request, and it is
opt-in per target (`local: true`).
