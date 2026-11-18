# PR review playbook

Use it when the user asks for a review of a pull request, a branch, a patch, or a diff — in any repository, in any language, with any build system.

**Division of labour.** The coding agent (you) inspects the target repository, reads its conventions, runs its checks and adjudicates the findings. 10x-chat supplies independent reviewers and the protocol that turns their answers into a verdict. 10x-chat never builds, tests, or modifies the target repository.

**The reviewers read the repository on GitHub themselves — no files are sent at all.** A reviewer that receives a pasted diff sees a snapshot of a few files; a reviewer that receives the repository URL, the pull request URL and the commit SHAs reads the whole change in its real context: the surrounding code, the conventions, the CI run. So:

- The prompt carries the **GitHub coordinates** — repository URL, **pull request number and URL**, base and head SHA — plus the changed file list and a short brief. Nothing else.
- **No files are attached.** No `--file` (inlined into the prompt), no `--attach` (uploaded). The reviewer opens the repository itself.
- The review target must therefore be **on `origin`**. The pipeline pushes the branch before the review (step 1) — when the user asked for that publication. If the change cannot be pushed — no rights, no remote — the review is `UNAVAILABLE` for every role that needs the code, and the report says so.
- A provider that cannot open the repository (private repo without a connector, provider without web access) must **say so in its answer**. That is a finding about the review, not a licence to guess — the review is then `UNAVAILABLE` for that role, and the report says which role could not run.

## 1. Establish the review context

You cannot adjudicate what you have not read yourself. Locally, gather:

```bash
BASE=<base-ref>            # main, origin/main, the merge base …
HEAD=<head-ref>            # the PR head
git fetch origin "$BASE" --quiet
git diff --stat "$BASE...$HEAD"
git diff --name-only "$BASE...$HEAD"
git remote get-url origin
```

Then make the change reachable for the reviewers — **commit, push and open the pull request**, so that the PR the reviewers open is the change you reviewed.

**Publication needs the user's word.** A request to *review* is not a request to *publish*. Commit, push and open the pull request only when the user asked for it. When the request is an assessment of local work — an uncommitted change, a local branch, a patch — ask first, and if the answer is no, review the pushed commit the user already published; if the change never reaches `origin`, the review is `UNAVAILABLE` and the report says so:

```bash
git status --short                 # read it: only the files of this change
git add <path> …                   # add those paths by name — never everything at once
git commit -m "<message in the repository's style>"
git push origin <branch>
git rev-parse HEAD          # the SHA the reviewers get

# Does the pull request exist? Opening one is a publication — the user's word
gh pr view --json number,url >/dev/null 2>&1 \
  || echo "no pull request yet — ask the user before opening one"
gh pr view --json number,url -q '"#\(.number) \(.url)"'
```

**The pull request is opened only with the user's word.** If the check above says that no pull request exists, ask the user: *"The branch `<branch>` has no pull request — may I open one?"* Only after the answer comes the creation:

```bash
gh pr create --base <base> --head <branch> --title "<title>" --body "<what changed and why>"
```

Without that answer the review of an unpublished change is `UNAVAILABLE`, and the report says so.

**Never commit what you did not read.** Adding everything at once (the all-files flag of `git add`) sweeps in everything in the working tree — a leftover file, a local config, a `.env` with credentials. Read `git status --short` first, add the paths of the change by name, and read the diff (`git diff --cached --stat`) before the commit. A file that looks like a secret (`.env`, `*.pem`, `credentials*`, a token in a config) stops the commit and goes to the user.

**The prompt carries the pull request number and URL.** A reviewer that only gets a branch name does not find the change; the PR page carries the diff, the discussion and the head SHA. Without a pull request there is nothing to review — create it first, if the user asked for it; otherwise ask the user.

- The **changed files** and the **surrounding code** of each of them — read them in your checkout. A diff without its context hides most real defects, and *you* are the one who resolves disagreements later.
- The **project conventions**: `AGENTS.md`, `CLAUDE.md`, `README`, `CONTRIBUTING`, the lint/format/CI configuration. Point the reviewer at these files **by path in the repository** (`AGENTS.md` at the head SHA) instead of pasting them.
- The **CI/test evidence**: the CI run of the PR (its URL) or a local run of the repository's documented test command.

What the reviewers get is a brief, not a bundle:

```text
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

## 2. Run independent first passes

Each reviewer runs in a **fresh conversation** (`--new-chat`) and gets a **role-specific prompt**. Two roles are the minimum:

- **Role A — correctness, regressions, security, edge cases.** Does it do what it claims, in every branch? What breaks for existing callers? Injection, authz, secrets, unsafe input, races, error handling, boundary values, nullability, resource leaks.
- **Role B — architecture, maintainability, compatibility, scope discipline.** Does it fit the codebase's shape and conventions? Is it the smallest change that solves the task? Public API/format/schema changes, backwards compatibility, dead code, duplication, unnecessary abstraction, missing or pointless tests.

A third role (**Role C — tests and verification**) is worth it when the change carries real logic: is the behaviour covered, are the assertions meaningful, would the test fail without the fix?

**Isolation rule.** Reviewer B must not see reviewer A's findings before submitting its first pass, and A must not see B's. Independent first passes are the whole point — a reviewer that anchors on another reviewer's finding stops looking. Cross-examination comes later, in step 4.

```bash
# Role A
10x-chat chat --provider chatgpt --new-chat --timeout 1800000 \
  -p "You are an independent reviewer of a pull request. Your role: correctness, regressions, security and edge cases.

Read the code yourself on GitHub — do not guess and do not ask for the files:
  Repository:   https://github.com/<owner>/<name>
  Pull request: #<n> — https://github.com/<owner>/<name>/pull/<n>
  Base:         <base-sha>
  Head:         <head-sha>
  Changed files: path/a.ts, path/b.ts
  Conventions:  read AGENTS.md and CONTRIBUTING.md at the head SHA

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
  -p "You are an independent reviewer of a pull request. Your role: architecture, maintainability, compatibility and scope discipline.
...same repository coordinates...
Judge the change against the conventions of the repository (read AGENTS.md and CONTRIBUTING.md at the head SHA) and against the surrounding code: does it fit the codebase's shape, is it the smallest change that solves the task, does it break public APIs, formats or schemas, does it leave dead code or needless abstraction, are the tests meaningful?
Report every findings in this exact format: ... (same block as Role A) ...
If you find nothing blocking, say so explicitly. Do not invent problems, and do not rewrite the code."
```

Any provider that can reach the repository works — `chatgpt` first (it can browse GitHub), then `claude` or `gemini` if they can open the URLs as well. Check `10x-chat login --status` first: an unlogged-in provider wastes the whole run.

**`chat --all` is not a role split.** It sends the *same* prompt to every chat provider in parallel. It is a good way to get several models to judge the same question; it cannot give one prompt per role. Role-specific reviews need one `--provider` run each.

**A full context window is not a failed review.** A long review can exhaust the context window of the conversation (ChatGPT shows a "Context window full" banner). 10x-chat then continues in a new chat with an automatic summary of the old one and asks there — the same reviewer, the same conversation, a fresh window. The new chat stays bound to the same repository and branch. The protocol does not change: the reviewer still gets the GitHub coordinates and still reads the code itself. Do not restart a role because the chat was continued, and do not report a continued chat as a missing answer.

**What is not on GitHub cannot be reviewed.** Uncommitted work, untracked files and local-only artifacts are invisible to the reviewer, and no file is attached to make them visible. If the change under review is not on `origin`, push it (step 1) before starting the review — when the user asked for that publication; otherwise ask the user first. If it cannot be pushed, the review does not run: report the review as `UNAVAILABLE` with the reason.

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

Write the report with the shared format in [report-format.md](report-format.md).

## Checklist

- [ ] Context gathered locally: diff, changed files, conventions, CI/test evidence.
- [ ] The change is committed and pushed to `origin`, with the user's word; the reviewers got the pushed head SHA.
- [ ] The reviewers got GitHub coordinates (repository, PR, base/head SHA, changed files); no file was attached — neither `--file` nor `--attach`.
- [ ] At least two role-specific reviewers ran, each in a fresh conversation.
- [ ] First passes were isolated — no reviewer saw another's findings.
- [ ] Every finding has a severity, a location, an impact, evidence and a fix.
- [ ] Findings deduplicated; verified and unverified ones labelled; false positives dropped.
- [ ] Disagreements resolved explicitly, with the reasoning recorded.
- [ ] Each reported finding checked against the diff and the repository's checks.
- [ ] Every check recorded with its command and result; nothing claimed without evidence.
- [ ] One verdict: `APPROVE` or `REQUEST CHANGES`, plus remaining risks.
