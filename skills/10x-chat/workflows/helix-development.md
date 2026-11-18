# Helix-style development playbook

Use it when the user asks for a change to be built in a repository — feature, fix, refactor, migration — and wants it gated: small checkpoints, verification, independent review, and evidence before the next step.

**Division of labour.** The coding agent (you) inspects and changes the target repository and runs its checks. 10x-chat supplies the independent adversarial review and the discipline around when to proceed. 10x-chat never edits the repository and never runs its build.

**The reviewer reads the repository on GitHub itself — no files are sent at all.** Give it the repository URL and the commit SHA of the checkpoint; it opens the files, the conventions and the surrounding code on its own. A pasted diff is a worse reviewer than one that can read the change where it lives.

- The prompt carries the **GitHub coordinates** — repository URL, branch, commit SHA — plus the checkpoint's goal and acceptance criteria. Nothing else.
- **No files are attached.** No `--file` (inlined into the prompt), no `--attach` (uploaded).
- The checkpoint must be **on `origin`** before the review: the pipeline commits and pushes the branch (step 5). If the checkpoint cannot be pushed, the review does not run — the checkpoint stays open and the report says the review was `UNAVAILABLE`. A provider that cannot open the repository must say so; that role is then `UNAVAILABLE`, not silently skipped.

## 1. Understand before touching

- Read the target repository's own instructions: `AGENTS.md`, `CLAUDE.md`, `README`, `CONTRIBUTING`, and the CI configuration. They define the conventions, the commands and the definition of done. They outrank your defaults.
- Map the architecture: the entry points, the layers, where the change belongs, the neighbouring code that a change here would break.
- Learn the **verification conventions**: the exact commands the repository documents for tests, lint, types and build — and how they are run in CI (working directory, flags, environment).
- Restate the task in your own words, with the acceptance criteria the user implies. If the task is ambiguous in a way that changes the design, ask now — a wrong assumption here costs a whole checkpoint.

## 2. Split the work into ordered checkpoints

A checkpoint is small enough to review in one pass and to revert in one step. Each checkpoint states five things:

| Field | Content |
|---|---|
| **Goal** | One sentence: what becomes true when this checkpoint is done. |
| **Scope** | The files or areas it touches — and nothing else. |
| **Acceptance criteria** | Checkable conditions (behaviour, contract, output). |
| **Verification** | The exact commands or manual procedure that prove the criteria, taken from the repository's conventions. |
| **Non-goals** | What this checkpoint deliberately does *not* do (later checkpoints, unrelated cleanup, speculative generality). |

Template:

```markdown
### Checkpoint 2 — <name>
- Goal: <one sentence>
- Scope: <files / areas>
- Acceptance criteria:
  1. <checkable condition>
  2. <checkable condition>
- Verification: `<exact command>` → <what a pass looks like>
- Non-goals: <explicitly excluded work>
```

Order the checkpoints by dependency, not by convenience. A checkpoint that leaves the repository in a broken state is not a checkpoint — each one ends green (or is explicitly gated as a WIP with a human decision).

## 3. Implement only the current checkpoint

- Stay inside the declared scope. No speculative refactoring, no unrelated cleanup, no "while I was here" changes.
- Follow the conventions of the surrounding code, not the conventions of another project you know better.
- Write the code the checkpoint asks for; keep the diff reviewable.
- If the checkpoint turns out to need a much larger change, stop, split it further, and record the new checkpoint list.

## 4. Run the repository's own checks

Run the checks that cover the change, using the repository's documented tooling — its test command, its linter, its type checker, its build. Use the repository's environment (its package manager, its container, its config).

Scope the run to what the checkpoint touches where the tooling allows it, but a full run is the default when the change is cross-cutting.

Record for each check: the exact command, the exit code, and the relevant output. Four states exist, and they are not interchangeable:

- `PASSED` — ran, exit code 0.
- `FAILED` — ran, non-zero exit code, or a test failure.
- `SKIPPED` — deliberately not run, with the reason.
- `UNAVAILABLE` — cannot run here (no display, no dependency, no network, no toolchain). Not the same as a pass.

A check that is `FAILED` or `UNAVAILABLE` stays visible in the report. It is never rewritten into a pass, and "probably fine" is not a result.

## 5. Commit, push and open the pull request

A review needs a target the reviewer can open, so the checkpoint goes to `origin` first — commit it, push the branch, and make sure the pull request exists:

```bash
git status --short                 # read it: only the files of this checkpoint
git add <path> …                   # add those paths — never `git add -A`
git commit -m "<message in the repository's style>"
git push origin <branch>
git rev-parse HEAD

# The pull request is the reviewer's entry point — open it if it does not exist
gh pr view --json number,url >/dev/null 2>&1 \
  || gh pr create --base <base> --head <branch> --title "<title>" --body "<what this branch changes>"
gh pr view --json number,url -q '"#\(.number) \(.url)"'
```

**Never commit what you did not read.** `git add -A` sweeps in everything in the working tree — a leftover file, a local config, a `.env` with credentials. Read `git status --short` first, add the paths of the checkpoint by name, and read the diff (`git diff --cached --stat`) before the commit. A file that looks like a secret (`.env`, `*.pem`, `credentials*`, a token in a config) stops the commit and goes to the user.

The reviewer reads the change at the pull request: the diff, the discussion, the head SHA, in its real context. If the push or the pull request cannot be created — no rights, no remote, a protected branch — the review does not run: leave the checkpoint open, report the review as `UNAVAILABLE` with the reason, and go back to the user.

Pushing the branch and opening the pull request are part of the pipeline. Merging, tagging a release or deploying is not (step 9).

## 6. Independent adversarial review of the checkpoint

Ask 10x-chat for an adversarial review of *this checkpoint*, in a fresh conversation (`--new-chat`), pointing it at the repository:

```bash
10x-chat chat --provider chatgpt --new-chat --timeout 900000 \
  -p "You are an adversarial reviewer. Your job is to find the ways this change fails.
Assume it is wrong until the code proves it.

Read the code yourself on GitHub (the pull request page, its diff and the discussion) — do not guess and do not ask for the files:
  Repository:   https://github.com/<owner>/<name>
  Pull request: #<n> — https://github.com/<owner>/<name>/pull/<n>
  Branch:       <branch>
  Commit:       <sha of the checkpoint>
  Conventions:  read AGENTS.md and CONTRIBUTING.md at that commit

Look for: wrong logic, unhandled edge cases, missing error handling, races, security holes, broken callers, violated conventions of this repository, missing tests, and scope that creeps beyond the stated goal.
For each finding: SEVERITY (BLOCKING | MAJOR | MINOR | INFO), LOCATION (file:line), PROBLEM, IMPACT (the concrete failure scenario), EVIDENCE (the code that shows it), FIX (the minimal correction).
Also state explicitly whether the acceptance criteria below are met by the code as written.
Acceptance criteria:
<the checkpoint's criteria>
If you find nothing blocking, say so. Do not invent problems, and do not rewrite the code."
```

Use a second provider for the same checkpoint when the change is risky — two independent adversarial reviews catch more than one twice. `chat --all` sends the *same* prompt to every provider, so it works here as a second opinion on one role, but not as role-specific reviews.

**A full context window is not a failed review.** When the conversation runs out of context (ChatGPT shows a "Context window full" banner), 10x-chat continues in a new chat with an automatic summary of the old one and asks there — the same conversation, a fresh window. The new chat stays bound to the same repository and branch, so the following checkpoint appends to it. Treat the answer as the answer of that reviewer; never restart a role because the chat was continued.

## 7. Resolve the findings

Fix every `BLOCKING` finding. Fix or explicitly resolve every `MAJOR` one. `MINOR` and `INFO` are recorded, not silently dropped.

Each finding ends in one of three states:

- **Fixed** — the change is applied, and the check that covers it was re-run.
- **Rejected** — you checked it and it is not a defect; record why.
- **Accepted** — a real issue you are not fixing now, with the reason and the human decision behind it.

Never resolve a finding by editing the report instead of the code.

## 8. Gate and proceed

Proceed to the next checkpoint only when:

- every acceptance criterion of the current checkpoint is met;
- every check relevant to the checkpoint is `PASSED`, or its non-pass state (`SKIPPED` / `UNAVAILABLE` / `FAILED`) is explicitly accepted by the user;
- no `BLOCKING` finding is open.

If a gate fails, stop and report. Do not push the problem into the next checkpoint and do not keep going because "the next step might fix it". If the user explicitly accepts the exception, record it as a human decision — who accepted it, what was not verified, and what risk it carries.

## 9. Never merge or release autonomously

Committing, pushing the branch and opening the pull request are part of the pipeline (step 5) — the pull request is the reviewer's entry point, and it is opened for the branch under review. Merging, tagging a release or deploying never happen without an explicit instruction from the user.

## 10. Integration review and completion report

After the last checkpoint, run one review over the *combined* change — at the pushed head SHA, since the interaction between checkpoints is where integration bugs live — and finish with the completion report in [report-format.md](report-format.md):

- what was built, per checkpoint;
- the acceptance criteria and their status;
- the checks that ran, with their exact commands and results;
- the findings, their resolution and who accepted what;
- the checks and scenarios that were **not** verified, and why;
- the remaining risks and the follow-ups that were deliberately deferred.

## Checklist

- [ ] Repository instructions, architecture and verification conventions read.
- [ ] Ordered checkpoints with goal, scope, acceptance criteria, verification, non-goals.
- [ ] Only the current checkpoint implemented; no speculative refactoring.
- [ ] Repository's own checks run, each recorded as PASSED / FAILED / SKIPPED / UNAVAILABLE with its command and output.
- [ ] The checkpoint is committed and pushed to `origin`, and the reviewer read that SHA; no file was attached — neither `--file` nor `--attach`.
- [ ] Independent adversarial review of the checkpoint; findings fixed, rejected with reason, or explicitly accepted.
- [ ] Every acceptance criterion has recorded evidence.
- [ ] Proceeded only with the gates satisfied or an explicit human exception.
- [ ] Committed and pushed per checkpoint; nothing merged or released without an explicit instruction.
- [ ] Integration review done; completion report written.
