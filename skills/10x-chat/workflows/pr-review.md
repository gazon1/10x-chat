# PR review playbook

Use it when the user asks for a review of a pull request, a branch, a patch, or a diff — in any repository, in any language, with any build system.

**Division of labour.** The coding agent (you) inspects the target repository, reads its conventions, runs its checks and adjudicates the findings. 10x-chat supplies independent reviewers and the protocol that turns their answers into a verdict. 10x-chat never builds, tests, or modifies the target repository.

**The same protocol in code.** `10x-chat review` runs this playbook end to end: it collects the context, asks the isolated roles, verifies every finding against the source and writes the report of [report-format.md](report-format.md) — see [docs/review-pipeline.md](../../../docs/review-pipeline.md). The steps below describe the **manual** path, where you run the reviewers yourself and they open the repository on GitHub; the pipeline instead gives them a bounded bundle of the change (the diff and the files around it) and reads the code of the checkout itself. Use the pipeline for a review of a git checkout, the steps below when the target is not a checkout or when the reviewer must read GitHub itself. Never run both for the same change: one verdict, one report.

**The reviewers read the repository on GitHub themselves — no files are sent at all.** A reviewer that receives a pasted diff sees a snapshot of a few files; a reviewer that receives the repository URL, the coordinates of the change and the commit SHAs reads the whole change in its real context: the surrounding code, the conventions, the CI run. So:

- The prompt carries the **GitHub coordinates** — repository URL, the identity of the target (**pull request number and URL**, or the **compare URL** of a branch), base and head SHA — plus the changed file list and a short brief. Nothing else.
- **No files are attached.** No `--file` (inlined into the prompt), no `--attach` (uploaded). The reviewer opens the repository itself.
- The review target must therefore be **on `origin`** — a pull request, or a pushed branch. The pipeline pushes the branch before the review (step 1) — when the user asked for that publication. A pull request is a convenience, not a precondition: **a pushed branch without a PR is reviewed by its base and head SHA.**
- **What is not on GitHub cannot be reviewed by a remote reviewer.** Uncommitted work and a pasted patch are invisible to them, and no file is attached to make them visible. Those two cases are reviewed **locally** — you do the analysis yourself, in the same roles and the same finding schema, and the report says explicitly that no independent check on GitHub happened.
- A provider that cannot open the repository (private repo without a connector, provider without web access) must **say so in its answer**. That is a finding about the review, not a licence to guess — the review is then `UNAVAILABLE` for that role, and the report says which role could not run.

## 1. Establish the review context

You cannot adjudicate what you have not read yourself.

### Choose the target

There are exactly four targets. Read the state first — this block never publishes:

```bash
git status --short                 # read it: only the files of this change
git branch --show-current
git remote get-url origin
gh pr view --json number,url -q '"#\(.number) \(.url)"' 2>/dev/null || echo "no pull request"
```

Then take the branch that matches the state — the target decides the coordinates the reviewers get and whether the remote reviewers can run at all:

| Target | How you recognise it | The reviewers review it by | Remote reviewers |
|---|---|---|---|
| **A — an existing pull request** | `gh pr view` prints a number | the PR: number, URL, base/head SHA, changed files | yes |
| **B — a pushed branch, no pull request** | the branch is on `origin`, `gh pr view` prints nothing | base/head SHA + the compare URL | yes |
| **C — local changes only** | `git status --short` is not empty and the change is not on `origin` | the local diff — ask about publication first | only after publication |
| **D — a patch or diff only** | the user gave a patch as text or as a file, and it is not a GitHub branch | the patch itself | no — local review |

#### A — an existing pull request

```bash
gh pr view <n> --json number,url,baseRefOid,headRefOid \
  -q '{number: .number, url: .url, base: .baseRefOid, head: .headRefOid}'
gh pr view <n> --json files -q '.files[].path'      # the changed files
```

The reviewers get the PR number, the PR URL, the base and head SHA and the changed file list. **No publication happens here** — nothing is committed, nothing is pushed, no PR is created.

#### B — a pushed branch without a pull request

The base of the comparison is the **default branch of the repository** — resolve it, never assume `main`:

```bash
BASE_REF=$(gh repo view --json defaultBranchRef -q .defaultBranchRef.name)
git fetch origin "$BASE_REF" --quiet
BASE=$(git rev-parse "origin/$BASE_REF")
HEAD=$(git rev-parse "origin/<branch>")
git diff --name-only "$BASE...$HEAD"                  # the changed files
gh api "repos/<owner>/<name>/compare/$BASE...$HEAD" --jq '.files[].filename'
```

If the repository has no default branch (an empty repository), or `gh repo view` fails, take the base from the pull request the branch will open:

```bash
BASE_REF=$(gh pr view <branch> --json baseRefName -q .baseRefName)
```

and, if there is no pull request either, from the remote's HEAD:

```bash
BASE_REF=$(git symbolic-ref --short refs/remotes/origin/HEAD | sed 's|^origin/||')
```

**Never leave `BASE_REF` empty** — an unset variable makes the fetch and the comparison fail with an error that looks like a network problem.

The reviewers get the base and head SHA and the compare URL
`https://github.com/<owner>/<name>/compare/<base-sha>...<head-sha>` plus the commit page
`https://github.com/<owner>/<name>/commit/<head-sha>` — the reviewer opens both itself and reads the commits and the diff there.

**A pull request is not required.** It is a convenience, not a precondition: **do not hold the review back for one, and do not treat its absence as a blocker.** Review the branch as it is. If the user wants a PR afterwards, that is a separate publication and runs only on an explicit request.

#### C — local changes only (not committed, not pushed)

```bash
git status --short
git diff --stat
git diff --name-only
```

The remote reviewers cannot see these changes: they read the repository on GitHub, and no file is ever attached. Say that to the user and ask:

> "The change is not on `origin` yet — the reviewers read GitHub themselves and no file is attached, so they would not see it. May I commit and push it?"

- **Yes** → publish (the publication block below), then continue with target **A** or **B**.
- **No, or the push is impossible** (no rights, no remote, nothing to push) → the review continues **locally** (see below).

#### D — a patch or diff only

The user gave a patch as text or as a file, and it is not a GitHub branch. There is nothing a remote reviewer could open, so the review is **local**: you read the patch yourself and produce the findings yourself.

### The local review path (targets C and D)

When the change is not on GitHub, the review does not fail — it changes shape:

- **You are the reviewer.** You read the diff or the patch yourself, in the same two roles as the remote passes: **role A — correctness, regressions, security, edge cases**, and **role B — architecture, maintainability, compatibility, scope discipline**. Run the passes one after the other, without letting the first answer narrow the second one.
- **The schema does not change.** Every finding carries `SEVERITY`, `LOCATION`, `PROBLEM`, `IMPACT`, `EVIDENCE`, `FIX` — exactly as in step 3.
- **The verdict does not change.** `APPROVE` or `REQUEST CHANGES`, decided against the same rules.
- **The report says it was a local analysis.** In the `Target` field write what was reviewed (for example `branch feature/x (local analysis — no independent check on GitHub)`); in the `Reviewers` table mark the roles as `local analysis`; and list the missing independent check under *Not verified*. Never present a local analysis as an independent review.

### Publication — only after the user's word

Publication is only needed for target **C**. A request to *review* is not a request to *publish*: the read-only review and the publication are two separate procedures, and the commands below run only after the user said yes.

```bash
git add <path> …                   # add those paths by name — never everything at once
git commit -m "<message in the repository's style>"
git push origin <branch>
git rev-parse HEAD          # the SHA the reviewers get
```

**Never commit what you did not read.** Adding everything at once (the all-files flag of `git add`) sweeps in everything in the working tree — a leftover file, a local config, a `.env` with credentials. Read `git status --short` first, add the paths of the change by name, and read the diff (`git diff --cached --stat`) before the commit. A file that looks like a secret (`.env`, `*.pem`, `credentials*`, a token in a config) stops the commit and goes to the user.

**A pull request is optional and opened only with the user's word.** If the user wants one, ask: *"The branch `<branch>` has no pull request — may I open one?"* Only after the answer comes the creation:

```bash
gh pr create --base <base> --head <branch> --title "<title>" --body "<what changed and why>"
```

Without that answer nothing is created — and the review still runs: target **B** covers the branch without a PR.

### What you read yourself

- The **changed files** and the **surrounding code** of each of them — read them in your checkout. A diff without its context hides most real defects, and *you* are the one who resolves disagreements later.
- The **project conventions**: `AGENTS.md`, `CLAUDE.md`, `README`, `CONTRIBUTING`, the lint/format/CI configuration. Point the reviewer at these files **by path in the repository** (`AGENTS.md` at the head SHA) instead of pasting them.
- The **CI/test evidence**: the CI run of the target (its URL) or a local run of the repository's documented test command.

### The brief

The reviewers get a brief, not a bundle. The brief has one of two shapes — the line that identifies the target is the only difference:

```text
# Target A — an existing pull request
Repository:  https://github.com/<owner>/<name>
Pull request: #<n> — https://github.com/<owner>/<name>/pull/<n>
Base:        <base-ref> -> <base-sha>
Head:        <head-ref> -> <head-sha>
Changed files:
  path/a.ts
  path/b.ts
Conventions: read AGENTS.md and CONTRIBUTING.md at the head SHA
CI:          https://github.com/<owner>/<name>/actions/runs/<id>
```

```text
# Target B — a pushed branch without a pull request
Repository:  https://github.com/<owner>/<name>
Compare:     https://github.com/<owner>/<name>/compare/<base-sha>...<head-sha>
Commit:      https://github.com/<owner>/<name>/commit/<head-sha>
Base:        <base-ref> -> <base-sha>
Head:        <head-ref> -> <head-sha>
Changed files:
  path/a.ts
  path/b.ts
Conventions: read AGENTS.md and CONTRIBUTING.md at the head SHA
CI:          <the CI run URL, or the local test result>
```

For the local path (targets **C** and **D**) there is no brief — there is no remote reviewer to send it to.

## 2. Run independent first passes

Each reviewer runs in a **fresh conversation** (`--new-chat`) and gets a **role-specific prompt**. Two roles are the minimum:

- **Role A — correctness, regressions, security, edge cases.** Does it do what it claims, in every branch? What breaks for existing callers? Injection, authz, secrets, unsafe input, races, error handling, boundary values, nullability, resource leaks.
- **Role B — architecture, maintainability, compatibility, scope discipline.** Does it fit the codebase's shape and conventions? Is it the smallest change that solves the task? Public API/format/schema changes, backwards compatibility, dead code, duplication, unnecessary abstraction, missing or pointless tests.

A third role (**Role C — tests and verification**) is worth it when the change carries real logic: is the behaviour covered, are the assertions meaningful, would the test fail without the fix?

**Isolation rule.** Reviewer B must not see reviewer A's findings before submitting its first pass, and A must not see B's. Independent first passes are the whole point — a reviewer that anchors on another reviewer's finding stops looking. Cross-examination comes later, in step 4.

Both commands below work for target **A** and target **B**: the reviewer opens the pull request when there is one and falls back to the compare URL and the commit page when there is not.

```bash
# Role A
10x-chat chat --provider chatgpt --new-chat --timeout 1800000 \
  -p "You are an independent reviewer of a pull request or of a pushed branch. Your role: correctness, regressions, security and edge cases.

Read the code yourself on GitHub — do not guess and do not ask for the files:
  Repository:   https://github.com/<owner>/<name>
  Pull request: #<n> — https://github.com/<owner>/<name>/pull/<n>
  Compare:      https://github.com/<owner>/<name>/compare/<base-sha>...<head-sha>
  Base:         <base-sha>
  Head:         <head-sha>
  Changed files: path/a.ts, path/b.ts
  Conventions:  read AGENTS.md and CONTRIBUTING.md at the head SHA

If the target has no pull request, review the compare URL and the commit page https://github.com/<owner>/<name>/commit/<head-sha> instead.
Open every changed file at the head SHA and the code around it. Look only for real defects: logic that is wrong, callers that break, data loss, security holes, missing error handling, unhandled boundary values.
Report every finding in this exact format, one block per finding:

SEVERITY: BLOCKING | MAJOR | MINOR | INFO
LOCATION: <path>:<line or start-end>
PROBLEM: <one or two sentences>
IMPACT: <the concrete failure scenario — inputs/state -> wrong result>
EVIDENCE: <the code, the trace, or the reproduction that shows it>
FIX: <the minimal correction>

If you find nothing blocking, say so explicitly. Do not invent problems to fill the format. Do not rewrite the code."

# Role B — a separate command, its own conversation, no reference to A
10x-chat chat --provider chatgpt --new-chat --timeout 1800000 \
  -p "You are an independent reviewer of a pull request or of a pushed branch. Your role: architecture, maintainability, compatibility and scope discipline.

Read the code yourself on GitHub — do not guess and do not ask for the files:
  Repository:   https://github.com/<owner>/<name>
  Pull request: #<n> — https://github.com/<owner>/<name>/pull/<n>
  Compare:      https://github.com/<owner>/<name>/compare/<base-sha>...<head-sha>
  Base:         <base-sha>
  Head:         <head-sha>
  Changed files: path/a.ts, path/b.ts
  Conventions:  read AGENTS.md and CONTRIBUTING.md at the head SHA

If the target has no pull request, review the compare URL and the commit page https://github.com/<owner>/<name>/commit/<head-sha> instead.
Open every changed file at the head SHA and the code around it. Judge the change against the conventions of the repository (read AGENTS.md and CONTRIBUTING.md at the head SHA) and against the surrounding code: does it fit the codebase's shape, is it the smallest change that solves the task, does it break public APIs, formats or schemas, does it leave dead code or needless abstraction, are the tests meaningful?
Report every finding in this exact format, one block per finding:

SEVERITY: BLOCKING | MAJOR | MINOR | INFO
LOCATION: <path>:<line or start-end>
PROBLEM: <one or two sentences>
IMPACT: <the concrete failure scenario — inputs/state -> wrong result>
EVIDENCE: <the code, the trace, or the reproduction that shows it>
FIX: <the minimal correction>

If you find nothing blocking, say so explicitly. Do not invent problems, and do not rewrite the code."
```

**Both commands carry the same coordinates.** A placeholder that points at the other role is not a command: copied literally it sends a reviewer into the chat without the target, and the second pass becomes a review of nothing. Fill every placeholder of both commands with the coordinates of step 1 — the two reviewers differ in their role and their instructions, not in what they read.

**The provider of a role is `chatgpt` unless it cannot read the repository.** Both commands above use `--provider chatgpt`: only ChatGPT browses GitHub, so it is the provider that can open the URLs, read the changed files at the head SHA and look at the CI run. Model diversity is not a reason to pick another provider — a provider that cannot open the repository produces no review, and a role that dies on a broken input is worse than three roles judged by one model. Check `10x-chat login --status` first: an unlogged-in provider wastes the whole run.

**When a role fails on the transport, run it again — do not drop it.** A role that dies while the prompt is being sent (the input did not answer within its bound, the session was invalidated, the provider was busy) has produced no answer at all: it is not a role without findings, it is a role that never ran. In that case run the *same* role prompt again on another provider that can read the repository, in a fresh conversation (`--new-chat`), and record **both** attempts in the *Checks* table of the report — the failed one as `FAILED` with its error, the successful one as `PASSED`. Only a role that failed on every provider that can read the repository is `UNAVAILABLE`, and the report says which providers were tried and why each failed. A role that ran and found nothing is reported as a role that found nothing; the two are never the same line.

**The roles are isolated by the conversation, not by the model.** Two roles that read the same model are still two independent passes as long as they ran in separate conversations and neither saw the other's findings. A role that had to be re-run after a transport failure keeps that isolation: the re-run starts a fresh conversation and the failed attempt has no answer to leak.

**`chat --all` is not a role split.** It sends the *same* prompt to every chat provider in parallel. It is a good way to get several models to judge the same question; it cannot give one prompt per role. Role-specific reviews need one `--provider` run each.

**A full context window is not a failed review.** A long review can exhaust the context window of the conversation (ChatGPT shows a banner with a "Continue in a new chat" button). 10x-chat then continues in a new chat with an automatic summary of the old one and asks there — the same reviewer, the same conversation, a fresh window. The new chat stays bound to the same repository and branch. The protocol does not change: the reviewer still gets the GitHub coordinates and still reads the code itself. Do not restart a role because the chat was continued, and do not report a continued chat as a missing answer.

**What is not on GitHub cannot be reviewed by a remote reviewer.** Uncommitted work, untracked files and local-only artifacts are invisible to the reviewer, and no file is attached to make them visible. For that case the review runs **locally** (see the local review path in step 1) — you are the reviewer, the findings carry the same schema, and the report states that no independent check on GitHub happened.

## 3. Read the findings against a common schema

Every finding carries:

| Field | Meaning |
|---|---|
| `SEVERITY` | `BLOCKING` — must fix before merge. `MAJOR` — fix before merge or get an explicit human decision. `MINOR` — should fix, not a gate. `INFO` — observation, no action required. |
| `LOCATION` | File and line or line range, when the finding is anchored. A finding with no location is a hypothesis, not a defect. |
| `PROBLEM` | What is wrong, in one or two sentences. |
| `IMPACT` | The concrete failure scenario: which input, state or sequence produces which wrong outcome. |
| `EVIDENCE` | The supporting code, trace or reproduction. |
| `FIX` | The minimal correction. |

Severity is not a matter of taste:

- **BLOCKING** — data loss, security hole, wrong results for realistic input, broken public contract, a crash on a supported path.
- **MAJOR** — a real defect with a narrower trigger, a missing guard that a supported input can hit, an untested risky path.
- **MINOR** — style, naming, a small duplication, a missing comment.
- **INFO** — an observation or a suggestion for later.

## 4. Merge, deduplicate, resolve

You are the adjudicator. Reviewer answers are input, not the verdict.

1. **Deduplicate.** Two reviewers describing the same defect at the same place are one finding. Keep the highest severity and merge the evidence. Report it once.
2. **Separate verified defects from hypotheses.** A finding is *verified* only when you checked it against the diff, the surrounding code, or a run of the repository's checks. Everything else is *unverified* and must be labelled as such — never silently promoted, never silently dropped.
3. **Reject unsupported findings.** No impact scenario, or an impact scenario the code cannot actually reach, is a false positive. Drop it, and say it was dropped if the user cares about the reviewer split.
4. **Resolve disagreement explicitly.** When reviewers contradict each other (one says a behaviour is a bug, the other says it is intentional), decide against the evidence: the diff, the surrounding code, the project's conventions, the tests. Record both positions and the resolution — do not average them into a vague middle.
5. **Fix what is clearly broken before reporting** if the user asked for a fix; otherwise the report lists the fixes.

## 5. Verify

For every finding you intend to report as real, check it yourself in the target repository:

- Read the exact lines in the head checkout and trace the failure scenario.
- Run the repository's documented checks when they cover the change (`npm test`, `pytest`, `cargo test`, `go test ./...` — whatever the repository itself documents, in the repository's own environment).
- Write the smallest reproduction that shows the defect, when the repository makes that cheap.

**Never claim a check passed without its result.** Record the exact command and the observed output. A check that is unavailable, not run, or failed stays visible in the report as such — `FAILED`, `SKIPPED` or `UNAVAILABLE`, never as a pass.

## 6. Verdict

Produce exactly one of:

- **APPROVE** — no `BLOCKING` and no unverified `MAJOR` finding remains, and every check you ran passed.
- **REQUEST CHANGES** — at least one `BLOCKING` finding, or a `MAJOR` finding that is still unverified, or a relevant check that failed.

Non-blocking recommendations (MINOR, INFO) never block approval, but they belong in the report.

Write the report with the shared format in [report-format.md](report-format.md). For a local review (target **C** without publication, or target **D**) the report says in the `Target` field that this was a local analysis, and lists the missing independent check under *Not verified*.

## Checklist

- [ ] The target identified: an existing pull request, a pushed branch without a PR, local changes, or a patch.
- [ ] Context gathered locally: diff, changed files, conventions, CI/test evidence.
- [ ] For targets A and B: the change is on `origin` — a PR or a pushed branch; the reviewers got the pushed head SHA. A PR was never required.
- [ ] The reviewers got GitHub coordinates (repository, PR or compare URL, base/head SHA, changed files); no file was attached — neither `--file` nor `--attach`.
- [ ] At least two role-specific reviewers ran, each in a fresh conversation.
- [ ] First passes were isolated — no reviewer saw another's findings.
- [ ] Every finding has a severity, a location, an impact, evidence and a fix.
- [ ] Findings deduplicated; verified and unverified ones labelled; false positives dropped.
- [ ] Disagreements resolved explicitly, with the reasoning recorded.
- [ ] Each reported finding checked against the diff and the repository's checks.
- [ ] Every check recorded with its command and result; nothing claimed without evidence.
- [ ] For a local review: the report states that it was a local analysis, and the missing independent check is listed under *Not verified*.
- [ ] One verdict: `APPROVE` or `REQUEST CHANGES`, plus remaining risks.
