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
working on it. The protection against a lost update is the other half — every
write of the record checks the state on the disk first, and a run that finds a
different state stops instead of overwriting the work of the other process.

The worktrees of the repository are read before a new one is created: a worktree
of the same Issue that is already there is **adopted**, never created a second
time. The same holds for the agent — a worker that is already there is adopted
too.

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

1. every mandatory step of the review passed;
2. the verdict of the review is `APPROVE`;
3. the head of the worktree did not move while the review ran — the review
   judged the commit that is there now;
4. the Issue is still the version the workflow started with — a requirement
   that changed since is a requirement nobody judged.

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
leaves a readable record behind, never a half-written one.

The requirements of the Issue are not stored twice: the snapshot of the
[review pipeline](review-pipeline.md) is reused, and the `check-requirements`
step of the review is the gate that says that the Issue did not drift.

## The recovery

| Situation | What happens |
|---|---|
| The agent is still working when the wait is over | The workflow keeps its state and gives the turn back. `resume` continues it. |
| The command was interrupted | The record of the last completed step is on the disk. `resume` continues from there. |
| The agent changed nothing | The workflow blocks — there is no change to review. |
| The state of the agent is unknown | The workflow blocks — an unknown outcome is not a success. |
| The Issue changed | The workflow blocks — the change was judged against older requirements. |
| The agent could not be stopped | The workflow blocks — the agent may still work in the worktree. |
| Another process moved the workflow | The run stops without a write — the state on the disk is the truth. |

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
