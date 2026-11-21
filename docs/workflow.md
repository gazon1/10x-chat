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
found again. A worktree that is already there is taken over only when it can be
proved to be ours:

| The worktree that is already there | What the workflow does |
|---|---|
| the checkout of the user (the main worktree) | refuses it — the agent never works in the checkout of the user |
| a worktree of another branch | refuses it — the name of the Issue is not the proof of the ownership |
| the worktree of another workflow (its checkpoint names it) | refuses it — two workflows never share a checkout |
| a worktree with a comment of somebody else | refuses it — the workflow does not take a worktree it cannot prove |
| a worktree that already carries changes | refuses it — the work of somebody else is not taken over |
| the worktree of this workflow, untouched at the base | adopts it — the answer of a lost command is not a reason to make a second worktree |

The worktrees of the repository are read for the same reason: the list is how a
lost answer is reconciled.

**The answer of Orca is not the proof of the worktree.** A worktree that Orca has
just created is checked before the agent may work in it: it must not be the
checkout of the user, its git must be the git of the repository of the Issue
(the common directory of the two is the proof — a worktree of another repository
has another one), and it must work on the branch of the Issue. A worktree that
does not pass the check is refused, and the agent never works in it.

**One workflow at a time per Issue.** A second `start` of the same Issue is
refused while the first one runs: two workflows of one Issue would share the
worktree, and two agents would work in the same checkout.

**One registration of the repository in Orca.** The repository of the checkout may
be registered in Orca more than once — a clone and a mirror of it. The
registration that is the checkout of the user wins; when there is none, the
ambiguity is refused and never guessed: a worktree of the wrong clone is a
change of somebody else's checkout.

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
- **The Orca runtime** — ready, with the `orchestration.*` and `worktree.*`
  capabilities. The repository of the checkout must be registered in Orca
  (`orca repo add --path <path>`).
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
   judged the commit that is there now;
4. the review compared the change with the commit the worktree started from — a
   base ref that moved under the workflow is a comparison of another change;
5. the Issue is still the version the workflow started with — a requirement
   that changed since is a requirement nobody judged. The Issue is read while
   the agent works as well: a requirement that changes under the agent
   invalidates the context the agent works on, and the workflow stops for the
   reevaluation instead of waiting for a change that was made against
   requirements that are not the current ones;
6. the worktree is clean — the review reads the committed state only, and a
   change that is not committed is a change that nobody judged.

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

## The stop stops every worker

`stop` does not take the lock of the run — a workflow must be stoppable while
another process works on it. It stops **every worker of the Run**, not only the
Dispatch of the record: the Dispatch is written down after the start command
answers, and a stop in that window would leave an agent in the worktree that
nobody knows about. A stop that cannot be confirmed leaves the workflow
`blocked`: an agent that still works in the worktree is not a stopped workflow.

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
| the record on the disk is terminal | the run stops without a write — the stop owns the outcome of the workflow |

A workflow that is being stopped is not blocked by the step that ran into the
stop: the stop decides whether the workflow is `cancelled` or `blocked`.

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
take the read outside of it.

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
| The worktree is not clean | The workflow blocks — the review reads the committed state only. |
| The Issue changed | The workflow blocks — the change was judged against older requirements. |
| The agent could not be stopped | The workflow blocks — the agent may still work in the worktree. |
| The workers of the Run could not be read | The workflow blocks — an agent of the Run may still work in the worktree. |
| Another process moved the workflow | The run stops without a write — the state on the disk is the truth. |
| Another process wrote the record | The run stops without a write — the revision of the record is the truth. `stop` merges with the record that is there instead. |
| The answer of the start command was lost | The Run is asked: the worker that is already there is adopted — a second agent would work in the same worktree. |
| The answer of the creation of the Run was lost | The Runs are asked: the Run of the objective of the workflow is adopted — a second Run would be a second home of the mailbox. |
| The workflow was stopped while the agent was starting | The agent is not started, or the agent that was started is stopped again — a workflow that is cancelled never leaves an agent in the worktree. |

## The seams

The workflow depends on three things that are replaceable, so that its own
tests need no Orca, no GitHub and no model:

| Seam | Default | Replaced by the tests with |
|---|---|---|
| `OrcaApi` | the `orca` CLI (`src/orca/client.ts`) | a fake that records the calls |
| `WorkflowGit` | `git` (`src/workflow/git.ts`) | a fake with a variable head |
| the review | `runReviewPipeline()` (`src/pipeline/review.ts`) | a fake that answers with a verdict |
| the Issue | `gh` (`src/pipeline/requirements.ts`) | a fake that answers with a version |

A local change — the change of a worktree that was never pushed — is reviewed
from its diff: the reviewers have no page of it on GitHub. That is the one
place where the pipeline differs from the review of a pull request, and it is
opt-in per target (`local: true`).
