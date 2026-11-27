# Real-ChatGPT latency validation of the review pipeline (#112)

The before/after of the review pipeline against the real `chatgpt-use` backend,
on the nine pull-request fixtures of the baseline of 2026-11-26. Every number
below comes from a run written to `~/.10x-chat/reviews/`; the cohorts are frozen
copies of those runs under `build/benchmark/`, and `scripts/review-latency.mjs`
reduces them.

## What was compared

| | Baseline | After |
|---|---|---|
| Date | 2026-11-26 | 2026-11-27 |
| Backend | `chatgpt-use` (chatgpt) | `chatgpt-use` (chatgpt) |
| Concurrency | 1 (serialized turns) | 1 (serialized turns) |
| Fixtures | #82 #67 #60 / #71 #70 #61 / #83 #74 #39 | the same nine |
| Profile | standard | standard, and quick as its own cohort |

The backend concurrency stays at 1 by design: one ChatGPT window serves one
request, so no turn of one session runs beside another and the queue wait of
every timed stage is 0 ms in both rounds. No improvement below is attributed to
concurrency, because there is none to attribute.

## Standard: the primary comparison

- Before: 9 runs, 9 timed — total p50 **212 319 ms**, range 159 362–377 951 ms
- After: 10 runs, 9 timed — total p50 **272 890 ms**, range 191 361–324 907 ms
  (plus one failed attempt, kept as a data point and excluded from the timings)
- Failure rate: 0/9 before, 1/10 after (the one failure is analysed below)

| Size | Before p50 | After p50 | Change | Before range | After range | Ranges overlap |
|---|---:|---:|---:|---|---|---|
| small (1-5) | 188 625 ms | 191 435 ms | +2 810 ms (+1.5%) | 159–207 s | 191–201 s | yes |
| medium (6-20) | 212 319 ms | 281 040 ms | **+68 721 ms (+32.4%)** | 204–245 s | 273–300 s | **no** |
| large (>20) | 340 077 ms | 320 456 ms | −19 621 ms (−5.8%) | 225–378 s | 259–325 s | yes |

A p95 is **not available**: no cohort has 20 observations, which is the sample
size `review-latency.mjs` requires before a p95 is a percentile rather than the
maximum of the sample. The range is shown instead.

The **medium** bucket is the one result that survives the sample size. Its two
ranges do not overlap: every "after" sample (272 890, 281 040, 300 415 ms) is
slower than every "before" sample (204 209, 212 319, 244 930 ms). With three
observations per side that is not a p-value, but it is the strongest statement
this sample can make — the slowdown is not one slow run dragging a median. The
small and large buckets overlap, so their changes remain indistinguishable from
run-to-run variance.

### Per fixture

| PR | Size | Before | After | Change |
|---|---|---:|---:|---:|
| #82 | small | 207 113 ms | 191 361 ms | −15 752 ms (−7.6%) |
| #67 | small | 188 625 ms | 191 435 ms | +2 810 ms (+1.5%) |
| #60 | small | 159 362 ms | 200 887 ms | +41 525 ms (+26.1%) |
| #71 | medium | 204 209 ms | 272 890 ms | +68 681 ms (+33.6%) |
| #70 | medium | 244 930 ms | 281 040 ms | +36 110 ms (+14.7%) |
| #61 | medium | 212 319 ms | 300 415 ms | +88 096 ms (+41.5%) |
| #83 | large | 225 156 ms | 259 449 ms | +34 293 ms (+15.2%) |
| #74 | large | 377 951 ms | 324 907 ms | −53 044 ms (−14.0%) |
| #39 | large | 340 077 ms | 320 456 ms | −19 621 ms (−5.8%) |

All nine fixtures were replayed. #61 is the re-run described below: its first
"after" attempt failed on a pipeline defect and is kept in the cohort as a
failed sample (1 of 10), while the re-run is the timed one.

### Stage level

| Stage | Before p50 | After p50 | Change p50 |
|---|---:|---:|---:|
| `collect-context` | 862 ms | 881 ms | +19 ms |
| `build-bundle` | 0 ms | 0 ms | 0 ms |
| `review-correctness` | 62 987 ms | 62 619 ms | −368 ms |
| `review-architecture` | 51 560 ms | 67 548 ms | +15 988 ms |
| `review-tests` | 45 095 ms | 50 467 ms | +5 372 ms |
| `verify-findings` | 15 841 ms | 17 695 ms | +1 854 ms |
| `normalize-findings` | 0 ms | 0 ms | 0 ms |
| `render-report` | 4 ms | 3 ms | −1 ms |

Every stage that costs time is a model call, and none of them got cheaper. The
queue wait is 0 ms in both rounds, so `durationMs` is provider time and the
execution column equals the total.

## Quick: a separate cohort, never a Standard result

Quick is a reduced-coverage profile: one reviewer, no verification, no advisory
assessment, and it can never approve. Its latency is a different product, not a
faster Standard, and `review-latency.mjs` prints it in its own sections.

- 9 runs, 8 timed (one failed on a schema-contract miss, below), every verdict
  REQUEST CHANGES (Quick cannot approve)
- total p50 **65 753 ms**, range 42 326–117 589 ms

| Size | Runs | Total p50 | Range |
|---|---:|---:|---|
| small (1-5) | 3 | 50 336 ms | 42 326–54 777 ms |
| medium (6-20) | 3 | 66 317 ms | 65 753–117 589 ms |
| large (>20) | 2 | 72 055 ms | 72 055–74 185 ms |

Against the Standard cohort's p50 of 272 890 ms, Quick is roughly **a quarter
of the wall clock** — and it buys a quarter of the review: one reviewer instead
of three, no verification and no advisory assessment. It is not a faster
Standard and must not be read as one.

Quick has **no baseline cohort**: the baseline of 2026-11-26 ran Standard only.
Its cost is therefore a first measurement, not a before/after, and the report
prints it in its own sections with no comparison.

## Quality and coverage

- **Standard keeps its three independent perspectives.** All nine timed runs
  executed `review-correctness`, `review-architecture`, `review-tests` and
  `verify-findings`, and passed every one of them.
- **Quick is explicitly reduced and cannot approve.** All nine runs skipped the
  architecture and tests reviewers and the verification, and every one returned
  REQUEST CHANGES. Zero approvals came from a Quick run.
- **No approval comes from an incomplete run.** In both cohorts the count of
  approvals on a run that did not finish every stage is 0; the one incomplete
  Standard run was gated to REQUEST CHANGES by the pipeline itself.
- **One material verdict difference investigated.** #67 flip-flopped from
  APPROVE (baseline) to REQUEST CHANGES (after) on the same head commit
  `bf2e8c7e`. The finding is the same defect in both runs — a failed session
  close permanently loses ownership of the browser session — but the baseline
  reviewer graded it MINOR and the later one MAJOR. The gate is severity-based,
  so a MINOR stays below it and a MAJOR does not. This is model grading
  variance on one defect, not a coverage regression: both runs found it, and
  the stricter grade is the safer one.

## Failures, and the two defects they exposed

**One: the kind of a decision written in prose.** One Standard run (#61) and one
Quick run died on the same pipeline bug, not on a review:

```
review-tests failed — 0 findings, 8 decisions, 1 invalid
  — decisions[7]: kind missing or unknown
```

The reviewer answered the kind of a decision as the prose phrase
`"Confirmed behavioral change"`, and `DECISION_KIND_WORDS` in
`src/pipeline/findings.ts` knew `behavior_change` and the three other phrases
but not that one. The step failed, the run became incomplete, and the review
that had done its work was thrown away. The same bug was already visible in
the inherited store: 18 of the 22 runs of pull request #108 failed on it, and
older records had persisted the spellings `Confirmed behavioral change`,
`Intended decision`, `Implicit decision` and `Unverified assumption`.

Fixed by teaching the map the qualified spellings (the qualifier is not a
second kind), with a test that reproduces the observed answer. The failed
Standard run above is reported as it happened and is excluded from the timed
set; the Quick cohort was re-measured with the fix in place.

**Two: a cheaper profile could never be timed.** The benchmark counted every
step that was not `passed` against a run, so a `quick` run — which skips two
reviewers and the verification *by design* — was always incomplete. Every Quick
run was therefore excluded from the percentiles, and the one profile a cohort
most needs to price was the one whose latency was never reported. Fixed by
marking a profile omission on the step (`omittedByProfile`) and reading it in
the benchmark. The flag never relaxes the pipeline gate: Quick still cannot
approve, and a skip that is *not* the profile's choice still counts against the
run. In the re-measured cohort 8 of 9 runs are timed.

**One Quick run still failed, correctly.** It answered with findings but no
`decisions` key at all, and the pipeline requires the key — that is the
documented contract, and the run is counted as a failure rather than dropped.

## What the result says

**The pipeline did not get faster on the real backend, and on the medium
bucket it got slower.** With ChatGPT serialized at concurrency 1, the model
calls are the whole cost and they did not shrink. The optimizations of #100–#105
changed *what* runs — profiles, conditional execution, scheduling policy — but
on the default Standard path they do not remove a model call, so there is
nothing for them to save. The apparent gain of the synthetic concurrency
benchmarks does not appear here, exactly as the issue predicted.

The sample is three runs per bucket, which gives a median and a range, not a
p95. For **small** and **large** the spread within a bucket (159–207 s for the
same three small fixtures, before the change) is comparable to the difference
between the rounds, so neither bucket supports a claim in either direction.

**Medium is different, and it is now the firmest finding of this round.** With
#61 replayed to a third sample, the bucket's two ranges do not overlap at all:
every "after" run is slower than every "before" run, and the median moved
+32.4%. Three samples per side are still not a p-value, so this is stated as a
consistent separation rather than a proven regression — but it is no longer the
kind of result a single slow run could produce.

The one unambiguous gain is Quick: a real review pass at roughly a quarter of
the Standard cost, at the price of the coverage it does not do and the approval
it cannot give.

## The smallest additional sample

The re-run of #61 settled that the medium slowdown is not one slow run: three of
three "after" samples sit above three of three "before" samples.

Attribution on the medium fixtures alone is sharper than the all-buckets stage
table, and it points at two stages rather than the whole pipeline:

| Stage (medium only) | Before p50 | After p50 | Change |
|---|---:|---:|---:|
| `review-architecture` | 51 560 ms | 92 713 ms | **+41 153 ms** |
| `review-tests` | 45 095 ms | 71 487 ms | **+26 392 ms** |
| `review-correctness` | 62 987 ms | 62 619 ms | −368 ms |
| `verify-findings` | 19 602 ms | 17 648 ms | −1 954 ms |

Two of the three reviewer passes roughly doubled their time while the third and
the verification did not move. That is not a uniform "the provider was slow"
signal — a slow hour would slow every stage. The remaining candidates are the
prompts of those two roles and how they scale with a 10–15 file change, which
the records alone cannot separate.

Twenty observations per bucket is what a p95 needs, and that is not worth
buying yet. The cheaper next step is to attribute the medium regression: profile
the medium fixtures only, comparing the prompt sizes and stage durations of the
before and after records, before spending more ChatGPT wall clock. If the
prompt did grow, that is a specific bottleneck the issue can name; if it did
not, the regression is provider variance and the honest answer is that the
optimizations bought nothing on this path.
