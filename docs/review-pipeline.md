# The review pipeline

The pipeline owns a review: it collects the context of the change, asks
independent reviewers for findings, verifies the findings against the source
and writes the report.

It is ordinary TypeScript. It depends on the **AI backend contract**
(`src/backend/contract.ts`) and on the repository — never on Playwright, never
on a provider module, never on a selector. It runs against the fake backend
without a browser and without credentials.

## The steps

Every step has a stable id. The outcome of every step is reported in the
*Checks* table of the report and persisted in `review.json`.

| Step id | What it does |
|---|---|
| `collect-context` | The PR metadata, the base and head commits, the changed files and the diff. |
| `build-bundle` | The bounded bundle: the brief, the diff and the changed files (through `buildBundle`). |
| `review-correctness` | The correctness, regression and security pass. |
| `review-architecture` | The architecture, maintainability, compatibility and scope pass. |
| `review-tests` | The tests and verification pass. |
| `verify-findings` | The independent verification of every candidate finding. |
| `normalize-findings` | The merge of the duplicates and the states of the findings. |
| `render-report` | The report of the run. |

The three reviewer passes are isolated: each one is its own request to the
backend and none of them ever sees the findings of another.

## The finding model

A finding carries a stable id, a title, a severity, a category, a file and an
optional line, the problem, the concrete failure scenario, the evidence, an
optional fix and the state of the verification (`unverified`, `confirmed`,
`rejected`).

The reviewers answer with JSON; the answer is validated against that schema.
An answer that is not JSON, or an entry that does not pass the schema, is
**invalid** — it is reported in the step and never becomes a finding. The
payload is read out of a fenced block, of a sentence, or of both: every
balanced object and array of the answer is tried, and the one that carries the
`findings` (or the `verdicts`) wins.

**A finding is not confirmed because it parsed.** A finding is `confirmed`
only when the verification pass confirms it *with evidence*. A verdict without
evidence leaves the finding `unverified`, and a finding that points at a file
or a line that is not in the checkout is `rejected` before the model is even
asked. A verification that answered for nobody is not a verification that
passed: the step is `failed` and the findings stay `unverified`.

Two findings of two reviewers are one finding when they are at the same file
and the same line and their titles overlap. The coverage of the shorter title
and of the longer one both count, so a title that is swallowed by a much
longer one is a different defect, not the same one written twice.

## The report

The report is the one of
[`skills/10x-chat/workflows/report-format.md`](../skills/10x-chat/workflows/report-format.md) —
the same headings, the same tables, the same states. The finding schema of the
playbook (`SEVERITY`, `LOCATION`, `PROBLEM`, `IMPACT`, `EVIDENCE`, `FIX`) maps
onto it like this:

| The playbook | The pipeline |
|---|---|
| `SEVERITY` | `severity` — `BLOCKING`, `MAJOR`, `MINOR`, `INFO` |
| `LOCATION` | `file` and `line` |
| `PROBLEM` | `title` and `problem` |
| `IMPACT` | `impact` — the concrete failure scenario |
| `EVIDENCE` | `evidence` — a list of references |
| `FIX` | `fix` — optional |
| the status of the finding | `verification` — `confirmed` → *Open*, `unverified` → *Unverified*, `rejected` → *Rejected* |

Two fields of the report have no counterpart in a pipeline run and say so:
the *Acceptance criteria* of the change are the caller's, not the pipeline's,
and the *Checks* table carries the steps of the pipeline.

## Running it

```bash
10x-chat review --pr 49                     # a pull request (the metadata comes from `gh`)
10x-chat review --base main --head feature  # a branch of the current repository
10x-chat review --pr 49 --out review.md     # the report also as a file
```

The run is written to `~/.10x-chat/reviews/<run-id>/`: `review.json` (the
steps, the findings and the context) and `report.md` (the report).

## The bounds

- The diff of the bundle is cut at 120 000 characters; the cut is written into
  the bundle and the step says so.
- The bundle holds at most 25 changed files; the omitted ones are named in the
  step.
- The verification pass gets the excerpt around the line of a finding (32
  lines) and the files that mention it — not the whole repository.

## The rules of the collection

The pipeline reads the files of the checkout, so the checkout must be the
revision under review:

- `collect-context` fails when the checkout is at another commit than the head
  of the review — check the head out first (`git checkout <head>`).
- It fails when the checkout has uncommitted changes to tracked files: the
  evidence of the verification must be the code of the head, not the code on
  the disk.
- It fails when the difference of the commits cannot be computed (a diff that
  cannot be computed is an error, never an empty change that looks clean).
- A file of a finding must be inside the repository by its **real** path: a
  symlink that points out of the checkout is refused, so nothing outside the
  repository can reach the prompt of the backend.

## The verdict of the report

`APPROVE` needs two things: no confirmed finding of the severity `BLOCKING` or
`MAJOR`, **and** every step of the pipeline passed. A run whose reviewer, whose
collection or whose verification did not finish says `REQUEST CHANGES` — a
review that found nothing because it could not run is not an approval.

## What the pipeline never does

**It never publishes to GitHub.** There is no code that pushes, comments or
opens a pull request: publication stays an explicit, separate action of the
user. A run reads the repository and writes a report — nothing else.
