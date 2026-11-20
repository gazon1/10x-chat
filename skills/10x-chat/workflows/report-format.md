# Shared report format

Both playbooks ([pr-review.md](pr-review.md), [helix-development.md](helix-development.md)) end in the same report. One shape, so a review and a development run read alike.

Keep it short: a reader should get the verdict, the evidence and the open risks without scrolling twice.

```markdown
# <PR review | Development> — <subject>

- Repository: <owner/name or path>
- Target: <PR # / branch / checkpoint set>
- Base → Head: <base-ref> (<sha>) → <head-ref> (<sha>)
- Reviewed at: <UTC timestamp>
- Scope: <changed files or checkpoints, with the inspected area>

## Verdict
<APPROVE | REQUEST CHANGES — one paragraph: why>

## Checks
| Check | Command | Result | Notes |
|---|---|---|---|
| <name> | `<command>` | PASSED | <output summary> |
| <name> | `<command>` | FAILED | <what failed> |
| <name> | — | SKIPPED | <why> |
| <name> | — | UNAVAILABLE | <why: no display, no toolchain, no network> |

## Findings
| # | Severity | Location | Problem | Impact | Evidence | Status |
|---|---|---|---|---|---|---|
| 1 | BLOCKING | `path/file.ts:42` | <one line> | <failure scenario> | <proof> | Fixed / Open / Unverified / Rejected / Accepted |

## Implicit decisions and trade-offs
<what the change decided where the requirements said nothing — the reading of the reviewers, not a verdict>

1. **<the decision>** — <behavior change | intended decision | implicit decision | unverified assumption>
   - Previous behavior or alternative: <what it was, or what else was available>
   - Evidence and rationale: <the code, the test, the document or the requirement>
   - Consequence: <what changes because of it>
   - Failure scenario or unresolved risk: <what can go wrong, or none>
   - Human confirmation: needed / not needed

## Acceptance criteria
| Criterion | Status | Evidence |
|---|---|---|
| <criterion> | MET / NOT MET / UNVERIFIED | <check or file:line> |

## Not verified
- <check, scenario or platform> — <reason>

## Reviewers
| Role | Provider | Verdict | Notes |
|---|---|---|---|
| Correctness / security | <provider> | <verdict> | <notes> |
| Architecture / scope | <provider> | <verdict> | <notes> |

## Remaining risks
- <risk> — <why it is still open, who accepted it>
```

Rules that make the report trustworthy:

- **Every check has a command and a result.** A check without both is `SKIPPED` at best. Copy the command exactly as it was run — a future reader must be able to repeat it.
- **`PASSED` means exit code 0.** Not "the failure looked unrelated", not "the previous run passed". A non-zero exit is `FAILED`, even if the failing test is unrelated to the change — say so in the notes.
- **`SKIPPED` and `UNAVAILABLE` are different.** Skipped is a decision; unavailable is a missing capability. Both are listed under *Not verified* as well.
- **Unverified is a first-class state.** A finding you could not reproduce is `UNVERIFIED` — visible, not promoted to a defect and not dropped.
- **Every finding has a status.** `Fixed`, `Open`, `Unverified`, `Rejected` (with the reason) or `Accepted` (with the human decision). A finding without a status is unresolved.
- **A decision is not a defect.** The *Implicit decisions and trade-offs* section says what the change decided where the requirements said nothing: a behavior change, an intended decision, an implicit decision or an unverified assumption. Only a proven defect is a finding, only a finding blocks the merge, and a decision is never repeated as a finding. A design trade-off that the change accepts on purpose is a decision, not a bug.
- **The section says when it does not apply.** A trivial change may skip the audit — the section then carries a one-line note instead of an empty list.
- **No secrets.** Never paste credentials, tokens, `.env` contents or customer data into the report, even to quote a finding.

For a development run, the *Verdict* section is replaced by the completion summary (what was built per checkpoint) and the *Acceptance criteria* table is the main body. Everything else stays the same.
