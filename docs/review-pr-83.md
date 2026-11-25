# PR review — Serve ChatGPT plain chat through the chatgpt-use backend

- Repository: gazon1/10x-chat
- Target: PR #83 — https://github.com/gazon1/10x-chat/pull/83 (governs Issue #77)
- Base → Head: `main` (56641644478fbd7d4ef5a0c62d884a007e4c1543) → `gazon1/serve-chatgpt-plain-chat-through-the-chatgpt-use` (4f71096e8e968b1bb65170b23c7df739e2adcc60)
- Reviewed at: 2026-11-25T01:30Z
- Scope: 20 changed files — the backend contract, the chatgpt-use adapter, the registry seam, the orchestrator routing, the CLI guards, the backend runner, 5 test files and 7 documents. Reviewed area: the whole chat path, the conversation cache, the failure taxonomy.

## Verdict

**APPROVE.** Both reviewers of the final head report no `BLOCKING` and no `MAJOR` finding, and every check passes. The eleven defects this review found across earlier rounds are all fixed, and six of them are pinned by a test that fails on the previous code. The one behaviour the change deliberately removes — conversation reuse for the plain ChatGPT chat — is the decision the user took explicitly, is enforced in code (`rejected` on a named conversation, the stored entry preserved for the browser path) and is recorded in the docs.

## Checks

| Check | Command | Result | Notes |
|---|---|---|---|
| Typecheck | `bun run typecheck` | PASSED | `tsc --noEmit`, no output |
| Lint | `bun run lint` | PASSED | 0 errors; 17 warnings, all in files this change does not touch (`src/browser/manager.ts`, `tests/config-cli.test.ts`, …), identical at the base commit |
| Unused code | `bun run knip` | PASSED | no unused export, file or dependency added |
| Build | `bun run build` | PASSED | `tsc -p tsconfig.build.json` |
| Unit + integration | `bun run test` | PASSED | 64 files, 1315 tests |
| E2E (CLI flows) | `bun run test:e2e` | PASSED | 22 passed, 10 skipped (the live provider scenarios are opt-in) |
| CI | `gh pr checks 83` | PASSED | `ci` pass, 1m35s, run 45499258733 — the first head; later commits carry no CI run |
| Review role A | `chatgpt-use ask …` (correctness) | PASSED | no findings on head 4f71096 |
| Review role B | `chatgpt-use ask …` (architecture) | PASSED | no blocking findings on head 4f71096 |
| `workflow-cli` timeout | `bun run test -- tests/workflow-cli.test.ts` | FAILED | `refuses a limit of the iterations…` exceeds its 5 s default under load average ≈30 (Android emulators and Gradle builds of other sessions). A clean worktree at the base SHA fails it the same way (`5024 ms`), and no file it exercises is in this change. It passed on the final full run. |

## Findings

| # | Severity | Location | Problem | Impact | Evidence | Status |
|---|---|---|---|---|---|---|
| 1 | MAJOR | `src/core/backend-runner.ts:398` | The runner kept its own copy of the failure kinds, and the copy did not learn the new `rejected` | A real refusal became `invalid_output`: the user was told an unusable answer arrived and told not to resend, instead of being told the request never ran | `FAILURE_KINDS` listed six kinds; role A traced it. Regression test `keeps a rejected failure…` | Fixed |
| 2 | MAJOR | `src/core/backend-runner.ts:257` | The plain backend deleted the stored conversation that the browser path still reuses | `chat --headed` lost the conversation a plain run had just retired — data loss for the path that can continue it | Role A's confirming round; `chat --provider chatgpt` then `--headed` reopened nothing | Fixed |
| 3 | MAJOR | `src/core/backend-runner.ts:87` | The backend resolved the model as flag → config, dropping the provider default the browser path uses | The same command line reached a different model depending only on the path taken | `options.model ?? config.defaultModel` vs `chatModel(...)`; role A | Fixed |
| 4 | MAJOR | `src/core/backend-runner.ts:155` | The run advertised `cancellation: true` but never called `backend.cancel` | Ctrl+C stopped the local wait while the request kept generating in ChatGPT | The matrix promised the capability; role A | Fixed |
| 5 | MAJOR | `src/core/orchestrator.ts:106` | An explicit `--transport browser` was answered by the backend and then refused | A run that named the browser used to be a browser run and became a hard error | Reproduced: `Error: The backend 'chatgpt-use' is not a transport`; fixed and re-checked end to end | Fixed |
| 6 | MINOR | `src/core/backend-runner.ts:45` | `--save-images` was validated only in the CLI, so a programmatic caller had it silently ignored | `runChat(options, { backend })` created the directory and saved nothing | Role A | Fixed |
| 7 | MINOR | `src/core/backend-runner.ts:241` | `--new-chat` left the stored entry behind, while the browser path clears it | A later browser run reopened a conversation the user had abandoned, and explained a retirement nobody asked for | Role B. The first fix cleared the entry; finding 2 then showed the entry must not be cleared at all, and both paths now leave it alone | Fixed |
| 8 | MINOR | `docs/*`, `README.md`, `AGENTS.md` | Five documents promised that a plain run drops the stored conversation | The documentation described behaviour the code does not have, and contradicted the regression test | Role A's confirming round | Fixed |
| 9 | MINOR | `AGENTS.md:126` | The failure taxonomy omitted `rejected` and claimed no provider is migrated | A developer would omit the kind, and believe the browser path is still the only one | Role B | Fixed |
| 10 | MINOR | `tests/chat-continuation.test.ts`, `tests/conversation-reuse.test.ts` | Retargeting the suites to `gemini` made them assert continuation behaviour that provider does not have | Green tests proving nothing: the fixtures are ChatGPT's (banner, summary chat, local ids, `/c/<id>`) | Found while adjudicating; the suites keep the ChatGPT fixtures and name `headed` | Fixed |
| 11 | MINOR | `tests/backend.test.ts:149,272` | Two hand-written lists of failure kinds — the same drift that caused finding 1 | A kind added to the contract would go untested | Role B | Fixed |
| 12 | — | `tests/workflow-cli.test.ts:114` | `refuses a limit of the iterations` times out at 5 s under host load | Unrelated to this change; fails identically on a clean worktree at the base SHA | Reproduced at base (`5024 ms`) | Rejected (environmental) |

## Implicit decisions and trade-offs

1. **The backend is the default implementation of plain ChatGPT chat, not an option beside it** — intended decision
   - Previous behaviour: `chat --provider chatgpt` used the browser provider; `--backend chatgpt-use` selected the second implementation.
   - Evidence and rationale: the user's explicit choice on Issue #77, recorded in `docs/capability-matrix.md`, `docs/playwright-inventory.md` and `AGENTS.md`.
   - Consequence: the default run inherits the backend's capabilities and failure semantics — cancellation gained, streaming and image output lost.
   - Failure scenario or unresolved risk: a `chatgpt-use` that is not installed now breaks a command that used to work through the browser. Named in the report; the failure is `unavailable`, not a silent success.
   - Human confirmation: not needed — the user decided it.

2. **The stored conversation is announced but not deleted** — implicit decision
   - Previous behaviour: the first implementation announced and deleted the entry.
   - Evidence and rationale: `conversations.json` belongs to the browser path, which reopens the same conversation with `--headed`; deleting it took data away from the only path that can use it (finding 2).
   - Consequence: the warning can repeat until the browser path replaces the entry.
   - Failure scenario: a user reads the announcement as "the conversation is gone" — the text now says the browser path still reuses it.
   - Human confirmation: not needed.

3. **`rejected` was added to the shared backend contract** — intended decision
   - Previous behaviour: an unsupported request had no dedicated kind; it would have been `invalid_output` (wrong advice) or a thrown error (untyped).
   - Evidence and rationale: `SUBMISSIONS_OF_FAILURE.rejected = ['not_submitted']` says the request never ran, which neither existing kind could say. Both reviewers judged it proportionate.
   - Consequence: `BackendFailureKind` is a public union — exhaustive switches outside this repository must handle it.
   - Failure scenario: a consumer that switches exhaustively on the old six kinds fails to compile. That is the intended signal.
   - Human confirmation: not needed.

4. **Routing lives in `wantsBrowser()` in the orchestrator** — implicit decision
   - Alternative: a separate routing module, or `plainChatBackend()` reading every option itself.
   - Evidence and rationale: the orchestrator already owns transport and browser selection; both reviewers accepted it and asked only that the predicate stay aligned with the CLI's validation.
   - Failure scenario: a future browser-only option that is not added to the predicate reaches the backend silently.
   - Human confirmation: not needed — recorded in `AGENTS.md` as the rule for adding an option.

5. **`--new-chat` is accepted by a backend run and has no effect** — behavior change
   - Previous behaviour: `--backend` + `--new-chat` was a hard error.
   - Evidence and rationale: a backend run hands no conversation, so a new chat is what happens either way; the error made the two entry points disagree, and every skill playbook passes the flag.
   - Consequence: the option is harmless rather than refused.
   - Human confirmation: not needed — documented in `README.md` and `docs/usage.md`.

6. **`--all` stays a browser run for every provider** — intended decision
   - Evidence and rationale: `runChatAll` passes `providers` down so no target is split across two paths; the parallel run is documented as browser-only.
   - Failure scenario: the ChatGPT column of `--all` has different capabilities from a plain run — cancellation, mostly.
   - Human confirmation: not needed.

## Acceptance criteria

| Criterion | Status | Evidence |
|---|---|---|
| A plain ChatGPT chat is served by one implementation; the other path is explicitly retained with the reason recorded | MET | `plainChatBackend` (`src/backend/registry.ts:63`); `wantsBrowser` (`src/core/orchestrator.ts:106`); `docs/capability-matrix.md` "The migration of the plain chat"; `docs/playwright-inventory.md:15` |
| A capability the backend lacks is rejected with a typed failure; no silent degradation | MET | `rejected` on a named conversation (`src/backend/chatgpt-use.ts:329`); `--transport browser` (finding 5); `--save-images` (finding 6); `--attach`/browser flags/model refused in `runBackendChat` |
| The fate of conversation reuse is decided, stated and enforced in code | MET | User decision: retired. Stated in `docs/capability-matrix.md:26-30`, `README.md:140`, `docs/usage.md:186`; enforced by the `rejected` kind and by not deleting the entry |
| The matrix shows the real capabilities of the ChatGPT backend, including `cancellation: true` and `conversationReuse: no` | MET | `docs/capability-matrix.md:143-144`; `cancellation` wired to SIGINT (finding 4) |
| `image`, `research`, `login`, `history` and the non-ChatGPT providers are unchanged | MET | `git diff --stat 5664164..4f71096 -- src/providers/ src/cli/image.ts src/cli/research.ts src/cli/login.ts src/cli/history.ts` is empty; `src/providers/` and `src/cli/review.ts` untouched |
| `docs/capability-matrix.md` and `docs/playwright-inventory.md` match the code | MET | Findings 8 and 9 closed; no stale "dropped" claim remains (`grep`) |
| Tests: parity across success, busy, timeout, empty answer; the reuse case; the untouched suites | MET | `tests/chatgpt-plain-chat.test.ts` (13 tests); `tests/backend.test.ts` (64); `tests/backend-chat-cli.test.ts` (6); full suite 1315 |

## Not verified

- A live ChatGPT round trip through the CLI — needs a logged-in window (`TEN_X_CHAT_E2E_CHATGPT_USE=1`). The adapter's args, envelope parsing and failure mapping are covered by unit tests with a stub; the real handshake is not.
- `image`, `research`, `login`, `history` against a live provider — unchanged by this diff, and their browser behaviour was not exercised.
- CI on the final head `4f71096` — the only CI run is for `20dffa9`. Every later commit was verified locally with the five commands above.

## Reviewers

| Role | Provider | Verdict | Notes |
|---|---|---|---|
| Correctness / security | chatgpt (`chatgpt-use`) | No blocking findings | Round 1 (head `20601a7`): finding 1. Round 2 (`ad7ae0e`): findings 2, 3. Round 3 (`bf02cce`): finding 8. Round 4 (`b2372ba`): finding 4. Round 5 (`44fadfe`): finding 6. Final (`4f71096`): none. Two attempts failed on transport/access (a `busy` window, a transient GitHub 404) and were re-run, not dropped. |
| Architecture / scope | chatgpt (`chatgpt-use`) | No blocking findings | Round 1 (`20601a7`): findings 7, 9. Round 2 (`bf02cce`): a MAJOR that rested on my own stale brief text — rejected, the code was right (finding 2 settled it). Round 3 (`b2372ba`): finding 11. `bf02cce` re-run: none. Final (`4f71096`): none. |

## Remaining risks

- **The default ChatGPT run now depends on `chatgpt-use`.** Without the CLI installed, `chat --provider chatgpt` fails as `unavailable` where the browser path used to work. Accepted by the user's decision; documented in `docs/chatgpt-use-backend.md`.
- **`--headed` is the only way back to reuse for ChatGPT.** The docs say so, but a user of the cache will notice the difference.
- **An unreadable `conversations.json` suppresses the retirement warning.** The cache is documented as a convenience and must never fail a chat; the run still answers.
- **The `wantsBrowser()` predicate is a compatibility boundary.** A future browser-only option that is not added there will silently reach the backend. Named by both reviewers; recorded in `AGENTS.md`.
- **The CI run covers `20dffa9`, not the final head.** The nine fixes after it were verified locally.

## Follow-up improvements

| # | Priority | Recommendation | Rationale | Evidence | Benefit | Scope | Existing solution | Separate Issue/PR |
|---|---|---|---|---|---|---|---|---|
| 1 | RECOMMENDED | Give the backend contract a `resume`/`status` recovery path in `runBackendChat` | `cancellation` is now wired, but a run that dies after submission still cannot be picked up: the CLI's `resume`/`status` are implemented and tested, and no command uses them | `src/backend/chatgpt-use.ts` `resume`/`status`; `docs/chatgpt-use-backend.md` says "the command runs `ask` only today" | Recovery of an interrupted review without re-sending the prompt | `src/core/backend-runner.ts` | the adapter's own `resume` | Yes |
| 2 | OPTIONAL | Let `--project` reach the backend | The adapter never sends `--project`, so a review always lands in the CLI's default project; Issue #76 found the gap and left it out of scope | `src/backend/chatgpt-use.ts` `ask`; `docs/chatgpt-projects.md` "Known limitations" | A review filed where the user wants it | `BackendRequest` + adapter | `chatgpt-use --project` | Yes |
| 3 | OPTIONAL | Record the timeout parity between the two paths | The backend uses `options.timeoutMs ?? config.defaultTimeoutMs`, the browser path uses `chatTimeoutMs(...)` with the provider default (30 min for ChatGPT). The model now matches; the timeout does not | `src/core/backend-runner.ts:86`; `src/core/orchestrator.ts:154` | One default instead of two | one line, or a documented decision | `chatTimeoutMs` | Yes |
