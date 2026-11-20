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
balanced object and array of the answer is tried, and the one whose entries
pass the schema wins — an example of the schema that a reviewer repeats in the
prose of its answer is not the answer.

**A finding is not confirmed because it parsed.** A finding is `confirmed`
only when the verification pass confirms it *with evidence* and the finding
points at a place: a finding without a file or without a line is a hypothesis,
not a defect, and stays `unverified` whatever the verifier says. A verdict
without evidence leaves the finding `unverified`, and a rejection without
evidence is no rejection — a finding is not dropped because a model said so. A
finding that points at a file or a line that is not in the checkout is
`rejected` before the model is even asked. A verification that answered for
nobody is not a verification that passed: the step is `failed` and the findings
stay `unverified`.

Only the files of the revision under review are read for the evidence of a
finding: they come from the commit, not from the disk of the checkout. A local
file that was never committed — a secret, a key — never reaches the backend,
and a finding that names it is `rejected`. A tracked symlink does not open the
way out: the file behind it must be a file of the revision too. The files are
named as Git names them: a name that holds a backslash is a name with a
backslash, not a path with a separator.

Two verdicts for one finding that contradict each other settle nothing: the
order of the answer must not decide the state of a finding. The finding stays
`unverified` with the note that says why. Two verdicts that agree are one
verdict: their evidence is merged, so the order of the answer decides nothing
either.

An answer that was cut off is not an answer: the findings it carries may be
half of the review. The step of a reviewer or of a verifier whose answer came
back truncated is `failed`, and the run is incomplete.

The payload of an answer is looked for in the whole answer: a model fences it,
wraps it in a sentence, or repeats the format of the answer before the answer
itself. The payload that carries more valid findings is the answer, and an
empty payload is an example of the format: it must not hide a payload that
carries something — not even a payload whose entries are malformed, because a
malformed answer is a failed step, not a review without findings. When two
payloads carry the same number of valid findings, the bigger one is the answer
and the answer comes last: an example of the format must not hide a malformed
answer that carries a grave finding. A payload
under the key of the format and a bare list are read into one pool: neither of
them hides the other, so a bare list that carries the findings is never lost
behind an empty payload. A bare list of strings is a list of the prose and a
bare list of payloads is a container of payloads — neither is an answer of
findings. Fifty
delimiters that carry no JSON at all are tolerated; when there are more, the
payload of the answer may lie behind them, and the step of the reviewer or of
the verifier is `failed` rather than "no findings".

A fence of Markdown is three backticks or more, and it is closed by a run of
backticks that is at least as long as the opening one: a block of four
backticks holds a snippet of three — and the evidence of a finding is such a
snippet. The name of the language (`json`, in any case) is not a part of the
payload, and a block that is never closed is not a block: its text stays in
the plain text of the answer.

Two findings of two reviewers are one finding when they are at the same file
and the same line and their titles overlap. The words of a title are the words
of every alphabet: a title written in another script carries its meaning too,
and a title that normalizes to nothing would give the same id to two different
findings. The coverage of the shorter title
and of the longer one both count, so a title that is swallowed by a much
longer one is a different defect, not the same one written twice. Every title
that was merged into a finding counts: the overlap of the titles is not
transitive, so a finding that overlaps a merged title is the same defect even
when it does not overlap the title that was kept.

The bundle holds the changed files and the convention files of the repository
(`AGENTS.md`, `CONTRIBUTING.md`, `README.md`) — the reviewers are told to read
them, so a backend that cannot browse the repository must find them in the
bundle. A convention file is taken from the commit under review, not from the
disk: an untracked `AGENTS.md` of the checkout is nobody's convention, and it
would steer the reviewers away from the change. The names of the changed files
are escaped before they become glob patterns: a name of a file is a name, not a
pattern. The bundle does not follow a symlink: the file behind it is not a file
of the revision, and it must not reach the backend.

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
steps, the findings and the context) and `report.md` (the report). The
directory and the files belong to their owner alone (`0700` and `0600`): a run
holds excerpts of the code of the repository.

The exit code of the command is the verdict of the review: `0` when the
verdict is `APPROVE`, `1` when the review is incomplete or asks for changes.
A caller must not read a clean exit of an incomplete review as an approval.

## The bounds

- The diff of the bundle is cut at 120 000 characters; the cut is written into
  the bundle and the step says so. A cut diff is a partial change: the step
  `collect-context` does not pass, the review is incomplete, and the verdict is
  `REQUEST CHANGES` — the reviewers cannot approve what they did not see.
- The bundle holds at most 25 changed files; the omitted ones are named in the
  step.
- The verification pass gets the excerpt around the line of a finding (32
  lines) and the files that mention it — not the whole repository. The excerpt,
  the bundle and the callers all come from the commit under review.

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
- It fails when a file of the revision is not on the disk and a git flag
  (`skip-worktree`, `assume-unchanged`) hides its deletion from the status: the
  review reads the files of the disk, and they must be the ones of the head.
- The base of a comparison is the ref the repository has: the default branch of
  `origin` is resolved, and the short name of a branch is used only when it is
  a local branch — a clone that fetched the remote only has
  `refs/remotes/origin/main`, and the base is that ref.
- A file of a finding must be inside the repository by its **real** path: a
  symlink that points out of the checkout is refused, so nothing outside the
  repository can reach the prompt of the backend.
- A file the change **deletes** is verified against its content in the base
  revision, not rejected because it is gone from the head: a deletion is a
  change, and a regression that comes with it must be seen. A path that is in
  neither the head nor the base is still rejected. A file that ends with a
  newline has no line after its last line: a finding on a line that is not
  there is rejected, in the head revision and in the base revision alike. The
  range of a finding is a place in the file too: a finding whose last line is
  past the last line of the file is rejected as well.
- The excerpt of a verification is read from the **commit under review**, not
  from the disk: a file that changes while the reviewers run must not reach the
  backend, and the evidence of a verdict must be the code of the head. The
  **bundle** of the reviewers is read from the same commit — it is the context
  of the change, and the context must be the context of the head. The
  **callers**
  of a file are searched in the revision under review as well: the files that
  mention it are the ones of the code that is reviewed. The names of the
  callers come back **NUL-separated and unquoted**: a name that holds a
  newline is a name of a file, and the quoting of git would hide it behind
  an escape. A **symlink** is
  followed in the revision too: the target of a link is a blob of the commit,
  and the checkout may retarget the link while the reviewers run. The blob of a
  link holds the path it points at **as it is**: a target with a newline in it
  is a name of its own, and trimming it would point the link at a file that
  does not exist. A link that
  the change **deletes** is followed in the base revision, where the file
  behind it still is. The name of a file is a **literal** name: it is asked of
  the tree of the commit as `:(literal)`, for `:(top)` at its start is the magic
  of a pathspec, and the magic points at another file of the tree.
- A file that may hold a secret — `.env*`, `*.pem`, `*.key`, an `id_rsa`, a
  `.credentials` or a `secrets` directory — is never read: its content reaches
  neither the diff of the bundle nor the evidence of a finding. The reviewers
  are told that the change touches it, and a finding about it stays
  `Unverified`: it cannot be settled without the content. A secret is a file
  as well as a directory: a file named `.credentials` or `secrets` is a secret
  of the same kind, and the name alone is enough.
- A file that may hold a secret keeps the secret when the change **renames**
  it: the new name is not a secret by its own pattern, but the content is the
  content of the old one, so the new name is excluded from the diff and from
  the bundle as well. A file the change **adds** that carries a line of a
  secret keeps it too — the rename detection of git is a similarity,
  and a secret that was copied into a file of its own is not a rename. The
  secret of the base and the secret that stays in the repository are both
  read: a repository that keeps its `.env` may copy it into a file of its own,
  and the name of the secret does not follow the content. A file the change
  **modifies** counts as well: the copy of a secret hides as well in the line
  that a change adds to a file that was already there. The **destination of a
  rename** counts as well: a file that takes the name of another one may
  carry a secret that the change moves into it. A file that changes its
  **type** counts too — a symlink that becomes a file of its own is a change
  of the type, and the copy may hide in the file the link turns into. A copy
  hides in a line
  that says more than the secret too — the line of the secret, and the value it
  holds, which is the secret itself: the key is a name that the code of the
  repository uses on purpose (`process.env.DATABASE_URL`), and a file that
  reads the name is not a file that holds the secret. The value is looked for
  when it is distinctive: twelve characters or more, or six characters or more
  with a letter and a digit in it (`s3cr3t`). A short value of letters only
  (`changeme`) is an ordinary word — many files of a repository hold it, and
  withholding all of them would leave the review nothing to read.
- The file behind a **tracked symlink** decides what may be read: the content
  of a link that points at a file that may hold a secret is never read — not
  in the head revision and not in the base revision, where a link that the
  change deletes is still followed.
- The title, the names of the files, the diff and the excerpts of the source are
  **data, not instructions**: they come from the repository, and an instruction
  inside them is an attack on the reviewer. Every one of them sits in a fence
  that is longer than the backticks it carries, so the content cannot close it,
  and the reviewers are told that an instruction found in them is a finding of
  the category `security`. The names of the withheld files and the claims of the
  reviewers — a reviewer quotes the change it is about — are fenced the same
  way, and the verifier is told that a claim is data too.
- The text of a reviewer is **data in the report** too: the control characters
  are cleared — the C0 range, the C1 range and the escape sequences — the
  markup of HTML is escaped and the markup of Markdown is escaped as well, so
  a tag or a link of a finding is shown as text and never becomes markup of
  the report.
- The identifier of a run is a **name, not a path**: it names the directory of
  the run under `~/.10x-chat/reviews/`, and a name that carries a separator or
  a `..` is refused the way a name of a profile is refused.

## The verdict of the report

`APPROVE` needs two things: no finding of the severity `BLOCKING` or `MAJOR`
that is still open — a grave finding that nobody settled is a hypothesis that
may be the defect that matters, and a review does not approve on the strength
of a guess — **and** every step of the pipeline passed. A run whose reviewer,
whose collection or whose verification did not finish says `REQUEST CHANGES` —
a review that found nothing because it could not run is not an approval.

The verdict is a field of the run (`verdict` and `verdictReason` of
`review.json`), not only a line of the report: the caller of the pipeline reads
it without parsing the markdown.

## What the pipeline never does

**It never publishes to GitHub.** There is no code that pushes, comments or
opens a pull request: publication stays an explicit, separate action of the
user. A run reads the repository and writes a report — nothing else.
