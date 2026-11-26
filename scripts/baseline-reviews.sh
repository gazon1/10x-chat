#!/bin/bash
# Run the baseline reviews: three representative PRs per size bucket.
#
# One ChatGPT window serves one request, so the reviews run one after the
# other. Each review is of the PR head, in a clean detached checkout: the
# pipeline refuses a checkout that is not the revision under review, and the
# worktree of the change is the wrong place to measure from.
#
# The runs land in ~/.10x-chat/reviews/ like any other review: they are the
# measurements, and scripts/review-latency.mjs reduces them.
#
#   ./scripts/baseline-reviews.sh
#   node scripts/review-latency.mjs
set -u

WORKSPACE=${WORKSPACE-$(cd "$(dirname "$0")/.." && pwd)}
CLI="$WORKSPACE/dist/bin/cli.js"
WT=${WT-$HOME/.cache/10x-chat-tmp/baseline-checkout}
LOG="$WORKSPACE/build/diagnostics/baseline-reviews-$(date +%Y%m%d-%H%M%S).log"
TIMEOUT=${TIMEOUT-1500}

# The target PRs, one bucket per size of the change. Override them to measure
# another set — and note that an empty value skips the bucket instead of
# falling back to the default:
#   SMALL="12 13" MEDIUM="" LARGE="" ./scripts/baseline-reviews.sh
SMALL=${SMALL-82 67 60}
MEDIUM=${MEDIUM-71 70 61}
LARGE=${LARGE-83 74 39}

mkdir -p "$(dirname "$LOG")"
: > "$LOG"

# The checkout the reviews read: a detached worktree of the repository, created
# here when it is not there yet.
if [ ! -d "$WT" ]; then
  mkdir -p "$(dirname "$WT")"
  git -C "$WORKSPACE" worktree add --detach "$WT" HEAD >>"$LOG" 2>&1 || {
    echo "SKIP all — cannot create the checkout at $WT" >> "$LOG"
    echo "BASELINE COMPLETE" >> "$LOG"
    echo "$LOG"
    exit 0
  }
fi

run_one() {
  local pr="$1" bucket="$2"
  local sha
  sha=$(gh pr view "$pr" --json headRefOid --jq .headRefOid 2>>"$LOG")
  if [ -z "$sha" ]; then
    echo "SKIP pr=$pr bucket=$bucket — no head commit" >> "$LOG"
    return 0
  fi

  # A clean detached checkout of the commit under review, never of a branch
  # that may have moved since.
  git -C "$WT" checkout --quiet --detach --force "$sha" 2>>"$LOG" || {
    echo "SKIP pr=$pr bucket=$bucket — cannot check out $sha" >> "$LOG"
    return 0
  }
  git -C "$WT" clean -qfd 2>>"$LOG"

  local before after elapsed out code runid verdict
  before=$(date +%s)
  out=$(cd "$WT" && timeout "$TIMEOUT" node "$CLI" review --pr "$pr" 2>&1)
  code=$?
  after=$(date +%s)
  elapsed=$((after - before))

  # The report is printed at the end of the run; the run id names the artifact.
  runid=$(printf '%s\n' "$out" | sed -n 's/^Run: //p' | tail -1)

  # The verdict is read from the record of the run, not from the printed
  # report: the report carries the verdict of the run *and* the text of its
  # findings, and a line of a finding holds either word. A run whose record
  # cannot be read stays unknown instead of being guessed.
  verdict=UNKNOWN
  if [ -n "$runid" ] && [ -f "$HOME/.10x-chat/reviews/$runid/review.json" ]; then
    verdict=$(node -e 'const r=require(process.argv[1]);process.stdout.write(String(r.verdict??"UNKNOWN"))' \
      "$HOME/.10x-chat/reviews/$runid/review.json" 2>/dev/null) || verdict=UNKNOWN
  fi

  echo "DONE pr=$pr bucket=$bucket exit=$code verdict=$verdict run=$runid wall=${elapsed}s" >> "$LOG"
  # A failed review is a data point too: keep the reason.
  if [ "$code" -ne 0 ]; then
    printf '%s\n' "$out" | tail -6 | sed 's/^/  /' >> "$LOG"
  fi
}

for pr in $SMALL;  do run_one "$pr" small;  done
for pr in $MEDIUM; do run_one "$pr" medium; done
for pr in $LARGE;  do run_one "$pr" large;  done

echo "BASELINE COMPLETE" >> "$LOG"
echo "$LOG"
