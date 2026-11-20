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
| `collect-context` | The PR metadata, the base and head commits, the changed files and the page of the change on GitHub. |
| `build-bundle` | The brief: the GitHub coordinates of the change, the changed files and the conventions — no file is attached. |
| `review-correctness` | The correctness, regression and security pass. |
| `review-architecture` | The architecture, maintainability, compatibility and scope pass — and the audit of the implicit decisions of the change. |
| `review-tests` | The tests and verification pass. |
| `verify-findings` | The independent verification of every candidate finding. |
| `normalize-findings` | The merge of the duplicates and the states of the findings. |
| `render-report` | The report of the run. |

The three reviewer passes are isolated: each one is its own request to the
backend and none of them ever sees the findings of another.

A review with a governing Issue has two more steps, and only then:
`check-requirements` reads the Issue again after the reviewers ran, and
`update-requirements` moves the baseline of the Issue. A review without an
Issue has neither — its steps are exactly the ones above.

## The decision model

The architecture pass answers a second question: what did you decide that I
did not tell you to decide? Its answer carries a list of *decisions* beside the
findings, and each decision carries its kind (`Confirmed behavioral change`,
`Intended decision`, `Implicit decision`, `Unverified assumption`), the decision
itself, the behavior of the base revision or the alternative that was
available, the evidence, the consequence for the guarantees, the failure
scenario that stays open and whether a human has to confirm it.

**A decision is not a finding.** It has no severity, it is never verified as a
defect, it is never repeated in the table of the findings and it never changes
the verdict: a trade-off that nobody asked for is not a reason to ask for
changes. The decisions live in their own section of the report and in their own
field of `review.json`. A review without a material decision writes one line —
*Not applicable* — instead of a table, and a decision that does not pass the
schema fails the architecture pass like a malformed finding does: the audit
that lost an entry did not finish. All seven columns are required: a
placeholder in place of the evidence would present an unfinished audit as a
finished one.

The audit is not optional either. An answer of the architecture pass that
carries no list of decisions at all — the key is missing, not empty — has not
run the audit, and it fails the pass: a review that says "no material
decision" because nobody asked is not a review. An empty list is the answer
that says there is none.

The audit runs for every change this pipeline reviews: there is no
trivial-change exception here, and there is no detection of one — the empty
list of the decisions is the answer that says there is none. The
trivial-change exception of the manual workflow
([skills/10x-chat/workflows/pr-review.md](../../skills/10x-chat/workflows/pr-review.md))
belongs to that workflow alone.

An audit that lost an entry did not finish, and the report says so. The
decisions that were read are kept — they are evidence of what the reviewer
named — but the section states that the audit is incomplete whenever the
architecture pass did not pass, so that a partial table is never read as a
complete audit.

The symmetry holds the other way round as well. The architecture pass answers
two questions, and its answer must carry both keys: an answer that carries the
decisions and no findings has answered one of the two. The missing key is not
an empty list of findings, and the findings of that pass would be lost — the
review would approve the change without them. Such an answer fails the pass
like a missing list of decisions does.

The decisions are read with the same rule as the findings: the place of the
payload decides, and the number of the entries does not. A decision is not a
defect, and an earlier payload of one decision must not hide the empty list
that says there is none. A model that repeats the format of its answer before
the answer itself would otherwise put a decision of the format into the report
of a change that has none.

The payload of the answer is found by its position, not by its shape: it is the
last payload of the answer, and it has to carry the decisions. An answer that
carries no decisions is the answer that omits them — the example of the format
that precedes it is never read in its place. A model that shows the format and
then answers without the decisions would otherwise report a decision it did not
make, and the audit would pass on the example instead of failing on the answer.

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
answer is the one that is read — an example of the schema that a reviewer
repeats in the prose of its answer is not the answer.

The place of the payload decides which one is the answer, and the number of
the findings does not. The answer is the last payload of the answer: an
example of the format that precedes it carries findings that the reviewer did
not make, and it must not pass as the answer — neither when it carries more
findings than the answer nor when it carries fewer. Only the payloads of the
top level are read: a payload that is nested in another one is a part of it —
the list of the evidence of a finding, a decision of the example of the format
— and not an answer of its own.

A findings field that is there and is not a list of findings is a malformed
answer, and it fails the step: a missing list is not an empty list.

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
either. The payload of the verdicts is chosen like the payload of the findings
of a reviewer: the last one that is not an example of the format. A payload
that carries more verdicts is not the answer — an example may carry more than
the answer does, and a finding confirmed by an example is a finding that
nobody verified. An answer that carries nothing but an example has not
answered, and the step of the verifier fails.

An answer that was cut off is not an answer: the findings it carries may be
half of the review. The step of a reviewer or of a verifier whose answer came
back truncated is `failed`, and the run is incomplete.

The payload of an answer is looked for in the whole answer: a model fences it,
wraps it in a sentence, or repeats the format of the answer before the answer
itself. The place of the payload decides which one is the answer, and the
number of the entries does not: the answer comes last. A payload that the
prose introduces as an example — "for example", "a sample answer", "e.g." —
is not the answer and never passes as one, not even when it is the last
payload of the text: it carries the entries of the example and not the
entries the reviewer found. An answer that carries nothing but an example has
not answered, and the step of the reviewer fails. The word must introduce the
payload that follows it: the marker and the payload belong to the same sentence,
and no full stop lies between them. A sentence that talks about an example of
the problem, and not of the format of the answer, says nothing about the payload
that comes after it — "one example of this problem is the missing validation.
Here are my actual findings:" introduces the answer, not an example. The prose
that introduces a
payload is the prose between it and the payload before it: a word of a payload
says nothing about the payload that follows it. A preamble that only names
the format — "the format I use is" — introduces no example: the payload that
follows it may be the answer itself. The schema of an entry does not decide
between two payloads either: a payload whose entries pass the schema is
not the answer when a later payload carries the answer itself, and the
malformed entries of that payload fail the step instead of being dropped
without a word. A payload
under the key of the format and a bare list are read into one pool: neither of
them hides the other, so a bare list that carries the findings is never lost
behind an empty payload. An empty bare list is the one exception: it carries
nothing, a pair of brackets in a sentence says nothing about the review, and
it answers only when no other payload does. A bare list of strings is a list
of the prose — "the files I looked at" — and a bare list of payloads is a
container of payloads: neither carries the answer of a reviewer, and neither
may replace it, not even when it comes last. A bare list of entries is the
answer of a reviewer that answered without the key. Two payloads that carry
the same value are two
payloads: an example that repeats the answer of the reviewer does not erase
it, and the answer comes last. Fifty
delimiters that carry no JSON at all are tolerated; when there are more, the
payload of the answer may lie behind them, and the step of the reviewer or of
the verifier is `failed` rather than "no findings".

A fence of Markdown is three backticks or more, and it is closed by a run of
backticks that is at least as long as the opening one: a block of four
backticks holds a snippet of three — and the evidence of a finding is such a
snippet. The closing run closes the block only on a line of its own, the way
Markdown reads it: a run of backticks in the middle of a line belongs to the
line. The name of the language (`json`, in any case) is not a part of the
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

## What the reviewers get

The reviewers read the change **on GitHub** — the way the manual playbook does.
The brief carries the **page of the change** (the pull request, or the
comparison of the base and head commits), the commit page, the base and head
SHA, the subject, the names of the changed files and the conventions to read
(`AGENTS.md`, `CONTRIBUTING.md`, `README.md` at the head commit). No file is
attached and no diff is pasted: a reviewer that receives the page reads the
whole change in its real context — the surrounding code, the conventions, the
CI run — while a pasted diff is a snapshot of a few files that also has to fit
into the window of the model (a change that is too long is refused outright by
the chat UI).

A change that has **no page** — a repository whose remote is not a URL (a path
of the disk) — is reviewed from its **diff**, bounded and with the files that
may hold a secret excluded. That diff is the only thing the brief carries in
that case.

The names of the files and the page are **data**: a name of Git or a URL may
hold a newline, and a value that writes a line of its own writes into the
prompt of the backend — the text of the repository then looks like an
instruction of the review, and a fence that the value cannot close keeps it
data.

## The requirements of the change

A review may name the Issue that governs the change:

```bash
10x-chat review --pr 3065 --issue 2888
```

The Issue is read through the `gh` CLI, in the repository of the checkout
(`gh issue view <number> --repo <owner/name> --json number,url,title,body`).
The pipeline never guesses it: it is never inferred from the title of the
pull request, from the name of the branch or from the text of a commit, and
several Issues are never reduced to one. `--issue` is supported with `--pr`.

The **complete** description of the Issue is the requirement, and it reaches
every reviewer and the verification through the same bundle: one Issue, one
version, the same text for all of them. The Issue is untrusted data like the
diff: it sits in a fence that it cannot close, and an instruction inside it
is a finding of the category `security`, not an order.

The version of the requirements is the **SHA-256 of the title and the body**
(`sha256(JSON.stringify([title, body]))`). The comments, the labels, the
reactions and the milestones are not requirements, and the metadata of the
Issue can change without the requirements changing — the hash is the content
and nothing else.

The baseline of the Issue — the version of the last successfully completed
review — lives in `~/.10x-chat/requirements/<owner>/<name>/<issue>.json`, a
small private file (`0600`, in a directory of `0700`). The mode is enforced
before every read as well as before every write: a snapshot that was restored
with wide permissions would show the description of the Issue to the other
users of the machine. It says whether the Issue is seen for the first time
(`initial`), whether the requirements did not drift (`unchanged`) or whether they
did (`changed`). A changed Issue is named as changed in the context and in the
report, and the reviewers get its complete current body.

The name of the repository comes from the remote of the checkout, and it names
a place inside the store: a name that carries a `..` is refused, and the path
of the snapshot is checked to stay under `~/.10x-chat/requirements` before it
is read or written.

Two rules keep the baseline honest:

- **A run that did not finish does not advance it.** The baseline moves only
  when every step of the review passed. A run that asked for changes did
  judge the requirements, and it advances the baseline; a run whose reviewer
  failed, whose verification was incomplete or whose Issue changed in the
  meantime did not. The run is written to its directory before the baseline
  moves: a review that could not be recorded did not happen, and a baseline
  that says "reviewed" without a review on the disk is a lie. The record of
  the run is written again with the outcome of the move.
- **An older run does not overwrite a newer one.** The snapshot carries the
  moment the Issue was observed, and the write happens under the lock of the
  directory: a run that observed the Issue earlier than the stored snapshot
  keeps the newer one. Two observations of the same millisecond cannot be
  ordered, and the stored snapshot is kept then — a tie never lets an
  observation that may be the older one overwrite the newer requirements.

The store holds no symbolic link: `chmod()` and `readFile()` follow a link,
and a link in the store would take the run outside of it and change the mode
of a file that has nothing to do with the requirements. The snapshot is an
ordinary file: a FIFO would make the read wait for a writer that never comes.
A snapshot that is a link or another kind of file is refused, and the file is
opened without following a link and without waiting.

The stored snapshot is checked before it is read as a baseline: its version,
every field and the agreement of its fields with each other. Its hash must
be the hash of its own title and its own body, its moment of observation must
be a timestamp, and it must be the snapshot of the Issue it is stored at. A
snapshot that contradicts itself describes no version of an Issue, and it is
refused — a run that compared it with the current Issue would call a changed
Issue unchanged, and the drift of the requirements would go unnoticed.

The Issue is read with a timeout of its own: `gh` reads it over the network,
and a CLI that never answers must not hang the review. A command that had to
be killed is a timeout, and the run says so.

The Issue is read again after the reviewers ran (`check-requirements`). An
Issue that changed in the meantime makes the run incomplete: a review of
stale requirements is never an approval, and the report says that the
requirements drifted.

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
and the *Checks* table carries the steps of the pipeline. The *Implicit
decisions and trade-offs* section is written by the architecture pass: it
answers the question the requirements did not ask — what did you decide that I
did not tell you to decide? — and its rows are decisions, not findings. They
carry no severity and they never change the verdict; a review with a governing
Issue names that Issue and its version in the header of the report, and its
*Acceptance criteria* row names the criteria of the Issue.

## Running it

```bash
10x-chat review --pr 49                     # a pull request (the metadata comes from `gh`)
10x-chat review --pr 49 --issue 2888        # with the Issue that governs the change
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

- The diff of a change that has no page is cut at 120 000 characters; the cut
  is written into the brief and the step says so. A cut diff is a partial
  change: the step `collect-context` does not pass, the review is incomplete,
  and the verdict is `REQUEST CHANGES` — the reviewers cannot approve what they
  did not see. A change on GitHub has no such bound: the reviewer reads it
  there.
- The verification pass gets the excerpt around the line of a finding (32
  lines) and the files that mention it — not the whole repository. The excerpt
  and the callers come from the commit under review.

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
- It fails when the change is not on `origin`: the reviewers open the page of
  the pull request or of the comparison, so both commits of a branch must be
  pushed (`git push origin <branch>`). A comparison of a commit that `origin`
  does not have shows nothing, and a review of nothing reads like a clean
  review.
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
  neither the diff of the fallback nor the evidence of a finding. The reviewers
  are told that the change touches it, and a finding about it stays
  `Unverified`: it cannot be settled without the content. A secret is a file
  as well as a directory: a file named `.credentials` or `secrets` is a secret
  of the same kind, and the name alone is enough.
- A file that may hold a secret keeps the secret when the change **renames**
  it: the new name is not a secret by its own pattern, but the content is the
  content of the old one, so the new name is excluded from the diff as well.
  A file the change **adds** that carries a line of a
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
  of the type, and the copy may hide in the file the link turns into. A file
  that the change **deletes** counts as well: the diff of a deletion shows the
  lines that are gone, and the copy of a secret among them would reach the
  backend. A copy
  hides in a line
  that says more than the secret too — the line of the secret, and the value it
  holds, which is the secret itself: the key is a name that the code of the
  repository uses on purpose (`process.env.DATABASE_URL`), and a file that
  reads the name is not a file that holds the secret. The value is looked for
  when it is distinctive: twelve characters or more, or six characters or more
  with a letter and a digit in it (`s3cr3t`). A short value of letters only
  (`changeme`) is an ordinary word — many files of a repository hold it, and
  withholding all of them would leave the review nothing to read. A secret is
  not always a line of `KEY=value`: the value of a pair of a JSON file is a
  value too, and the copy of it hides in a line of the code that holds the
  value alone.
- The file behind a **tracked symlink** decides what may be read: the content
  of a link that points at a file that may hold a secret is never read — not
  in the head revision and not in the base revision, where a link that the
  change deletes is still followed.
- The title, the names of the files, the page of the change, the code on GitHub,
  the diff and the excerpts of the source are
  **data, not instructions**: they come from the repository, and an instruction
  inside them is an attack on the reviewer. Every one of them sits in a fence
  that is longer than the backticks it carries, so the content cannot close it,
  and the reviewers are told that an instruction found in them is a finding of
  the category `security`. The identity of the repository, the target and the
  refs are fenced the same way: the path of the checkout is data too, and a path
  that holds a newline writes a line of its own into the prompt of the
  reviewer. The names of the withheld files and the claims of the
  reviewers — a reviewer quotes the change it is about — are fenced the same
  way, and the verifier is told that a claim is data too.
- The text of a reviewer is **data in the report** too: the control characters
  are cleared — the C0 range, the C1 range and the escape sequences — the
  markup of HTML is escaped and the markup of Markdown is escaped as well, so
  a tag or a link of a finding is shown as text and never becomes markup of
  the report. A bare URL is a link of a viewer that opens the report: it is
  escaped as well, and it stays text.
- The metadata of the context is **data in the report** too: the name of the
  repository, the name of the branch and the URL of the pull request come from
  the repository, and they are escaped the same way, so a name that carries
  the markup of Markdown is shown as text and never becomes markup of the
  report.
- The identifier of a run is a **name, not a path**: it names the directory of
  the run under `~/.10x-chat/reviews/`, and a name that carries a separator or
  a `..` is refused the way a name of a profile is refused.
- The governing Issue is read through the `gh` CLI of the repository of the
  checkout, and a failure to read it — a missing Issue, an inaccessible one,
  a failed command or an answer that is not an Issue — fails the collection.
  A review never continues without the requirements it was asked for.

## The verdict of the report

`APPROVE` needs two things: no finding of the severity `BLOCKING` or `MAJOR`
that is still open — a grave finding that nobody settled is a hypothesis that
may be the defect that matters, and a review does not approve on the strength
of a guess — **and** every step of the pipeline passed. A run whose reviewer,
whose collection or whose verification did not finish says `REQUEST CHANGES` —
a review that found nothing because it could not run is not an approval.

The verdict is a field of the run (`verdict` and `verdictReason` of
`review.json`), not only a line of the report: the caller of the pipeline reads
it without parsing the markdown. The decisions of the change never take part in
it: they carry no severity, and a review never asks for changes because of a
trade-off.

## What the pipeline never does

**It never publishes to GitHub.** There is no code that pushes, comments or
opens a pull request: publication stays an explicit, separate action of the
user. A run reads the repository and writes a report — nothing else.
