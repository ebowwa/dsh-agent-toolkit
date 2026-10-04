#!/usr/bin/env bash
# merge-guard.sh — the merge-time gates guard (issue #434).
#
# The receipt: PR #422 merged at 2026-10-04T12:17:56Z while its `gates` run
# (37201311833) was still QUEUED — it never ran; zero completed CI runs have
# ever graded the head that landed. Branch protection with required status
# checks is the native backstop; this script is the portable guard for the
# actors that merge from a shell (the gh-scrub-shim gates `gh pr merge`
# through it when the driver arms GH_MERGE_GUARD=on).
#
# Semantics (issue #434's explicit requirement): ONE snapshot of the PR's
# check runs, never a poll-until-green loop. The named check counts ONLY
# when it is `completed` + `success` ON THE PR'S HEAD SHA — queued,
# in_progress, cancelled, failure, neutral, skipped, timed_out, stale and
# absent are all NOT green. A stale green (an older run for a previous head,
# or a check graded before the last push) is not green either: the API is
# queried for the exact head SHA and only same-SHA runs match.
#
# Usage:
#   merge-guard.sh check [pr-number|url|branch]   exit 0 iff green; refuse 1/2
#   merge-guard.sh merge [gh pr merge args...]    check, then exec gh pr merge
#
# Env contract:
#   MERGE_GUARD_CHECK   the check-run name that gates merges (default
#                       "gates" — the job name in this repo's gates.yml;
#                       the check-run name is the JOB name, per the rollup
#                       {"name":"gates"} in the #434 receipts)
#   MERGE_GUARD_GH      gh binary to use. The gh-scrub-shim passes the REAL
#                       gh here so the guard can never recurse into the shim
#                       (inside an agent session PATH resolves `gh` to the
#                       shim); default `command -v gh` for standalone use.
#   GH_TOKEN / GH_CONFIG_DIR  pass through to gh, as usual.
#
# Fail-closed (REVIEW.md): every unresolvable state — no gh, PR not
# resolvable, API failure, check absent — REFUSES non-zero with a typed
# reason on stderr. Refusing is the safe direction; a human who truly must
# merge ungated says so explicitly (GH_MERGE_GUARD=off in the shim, or merge
# without the guard) and owns the loudness.

set -uo pipefail

CHECK="${MERGE_GUARD_CHECK:-gates}"

refuse() { echo "merge-guard: REFUSED — $*" >&2; exit 1; }
unresolvable() { echo "merge-guard: REFUSED (unresolvable) — $*" >&2; exit 2; }

MODE="${1:-}"
[ -n "$MODE" ] && shift
case "$MODE" in
  check) TARGET="${1:-}";;
  merge) TARGET="";;
  *) unresolvable "usage: merge-guard.sh check [pr|url|branch] | merge [gh pr merge args...] — got '${MODE:-<none>}'";;
esac

GH_BIN="${MERGE_GUARD_GH:-}"
[ -n "$GH_BIN" ] || GH_BIN="$(command -v gh 2>/dev/null || true)"
[ -n "$GH_BIN" ] \
  || unresolvable "gh not found — cannot verify the '$CHECK' check; merging without a verified check is the #422 receipt (issue #434)"
[ -x "$GH_BIN" ] \
  || unresolvable "gh at '$GH_BIN' is missing/not executable — refusing rather than merging unverified (issue #434)"

# merge mode: find the PR target in the `gh pr merge` argv — the first
# non-flag element that is not a consumed value (pr merge's value flags are
# --subject/-t, --body/-b, --match-head-commit). No target found is fine:
# gh resolves the current branch, and so do we — unresolvable THERE refuses.
prev=""
if [ "$MODE" = "merge" ]; then
  for a in "$@"; do
    case "$prev" in
      --subject|-t|--body|-b|--match-head-commit) prev="$a"; continue;;
    esac
    case "$a" in
      -*) ;;
      *) [ -z "$TARGET" ] && TARGET="$a";;
    esac
    prev="$a"
  done
fi

PR_JSON="$("$GH_BIN" pr view ${TARGET:+"$TARGET"} --json number,headRefOid,url 2>&1)" \
  || unresolvable "cannot resolve PR ${TARGET:-<current branch>}: $PR_JSON"
PR_NUM="$(printf '%s' "$PR_JSON" | sed -n 's/.*"number":\([0-9][0-9]*\).*/\1/p' | head -n1)"
PR_SHA="$(printf '%s' "$PR_JSON" | grep -o '"headRefOid":"[0-9a-f]*"' | head -n1 | cut -d'"' -f4)"
PR_URL="$(printf '%s' "$PR_JSON" | grep -o '"url":"[^"]*"' | head -n1 | cut -d'"' -f4)"
[ -n "$PR_NUM" ] && [ -n "$PR_SHA" ] && [ -n "$PR_URL" ] \
  || unresolvable "PR ${TARGET:-<current branch>} resolved to an unusable shape (number/sha/url empty): $PR_JSON"
REPO_PATH="$(printf '%s' "$PR_URL" | sed -n 's#https://github.com/\([^/]*\)/\([^/]*\)/pull/.*#\1/\2#p')"
[ -n "$REPO_PATH" ] || unresolvable "cannot parse owner/repo from PR url '$PR_URL'"

RUNS_JSON="$("$GH_BIN" api "repos/$REPO_PATH/commits/$PR_SHA/check-runs" 2>&1)" \
  || unresolvable "check-runs API failed for $REPO_PATH@${PR_SHA:0:7}:$RUNS_JSON"

# ONE snapshot, filtered to (check name == head SHA) pairs; the highest id
# wins if the check was re-run on this head (latest attempt is the truth).
VERDICT="$(printf '%s' "$RUNS_JSON" | MERGE_GUARD_CHECK="$CHECK" MERGE_GUARD_SHA="$PR_SHA" node -e '
let s = "";
process.stdin.on("data", (d) => (s += d)).on("end", () => {
  let j;
  try { j = JSON.parse(s); } catch { console.log("UNPARSEABLE"); return; }
  const runs = (j.check_runs || []).filter(
    (r) => r.name === process.env.MERGE_GUARD_CHECK && r.head_sha === process.env.MERGE_GUARD_SHA,
  );
  if (!runs.length) { console.log("ABSENT"); return; }
  const latest = runs.reduce((a, b) => (b.id > a.id ? b : a));
  console.log((latest.status || "?") + " " + (latest.conclusion || "none"));
});')"

case "$VERDICT" in
  ABSENT)
    refuse "no '$CHECK' check run graded head ${PR_SHA:0:7} of PR #$PR_NUM — the workflow never ran on this head; landing it is exactly the #422 receipt (issue #434)";;
  "completed success")
    echo "merge-guard: GREEN — '$CHECK' completed/success on PR #$PR_NUM head ${PR_SHA:0:7}"
    [ "$MODE" = "check" ] && exit 0
    exec "$GH_BIN" pr merge "$@"
    ;;
  UNPARSEABLE)
    unresolvable "check-runs response for PR #$PR_NUM head ${PR_SHA:0:7} did not parse — refusing rather than trusting an unreadable rollup (issue #434)";;
  *)
    refuse "'$CHECK' on PR #$PR_NUM head ${PR_SHA:0:7} is {status=$(printf '%s' "$VERDICT" | cut -d' ' -f1) conclusion=$(printf '%s' "$VERDICT" | cut -d' ' -f2)} — queued/in-progress/cancelled/failed/absent are NOT green (issue #434); the guard takes ONE snapshot and does NOT poll until green";;
esac
