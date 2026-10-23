#!/usr/bin/env bash
# orphan-branch-sweep.sh — the branch-hygiene sweep half of issue #127
# (ewowba/dsh-agent-toolkit#453).
#
# The contract (CONTRIBUTING.md, .agents/README.md, stamped into every task
# by scripts/run-dsh-agent.sh) requires zero orphan branches: a branch whose
# work outlives the session without a PR is a lost thread. The repos run
# auto-delete-on-merge, so a MERGED branch cleans itself up; the leak paths
# are (1) a pushed branch whose PR never opened and (2) a PR closed WITHOUT
# merging whose branch was not deleted in the same breath (`gh pr close N
# --delete-branch`). The contract governs what SESSIONS do at exit; this
# script is the OTHER half — the retrospective sweep that reaps whatever
# leaked anyway:
#
#   - a stale `dsh/issue-*` head whose PR closed (merged OR unmerged) but
#     whose branch survives on origin, and
#   - a pushed branch with no PR behind it at all (the session died before
#     the PR step).
#
# The confirmed-orphan definition is exactly the issue's:
#
#   a remote `dsh/issue-*` branch with NO OPEN PR behind it.
#
# A branch that is the head of ANY open PR is protected — it is live work
# (or under review), never an orphan. And since issue #643 a second
# protected class exists: a branch whose NEWEST closed-unmerged PR carries
# APPROVED, UNLANDED work (a passing merge-guard gates check on its head
# SHA and/or a final APPROVE verdict — scripts/approved-lane.mjs) is
# protected too. The #643 receipts: PRs #495/#544 were review-approved
# with gates green, stale-closed unmerged by the branch-hygiene pass, and
# their heads then reaped — the reviewed work kept no path back to main
# (the files survived only as refs/pull/495/head). The branch behind an
# approved-unmerged PR is the work's only independent copy: reaping it is
# destroying reviewed work, not tidying. Such branches are skipped with a
# LOUD line naming the PR; the recovery lane (reopen/land) stays open. The
# consult itself is fail-closed: an unresolvable approval check REFUSES
# the sweep (never delete blind on the approval channel either).
#
# The sweep lists remote refs through `git ls-remote` (no clone needed)
# and the open-PR census through `gh pr list` (one call, `--head`
# matching per branch is unnecessary — the census is the set of open head
# refs; a branch not in it is an orphan by definition, and a branch name
# that IS an open head is skipped with a "protected" note, never
# deleted). The closed-PR census (the #643 consult) is one more `gh pr
# list` call, made only when a candidate orphan exists.
#
# Modes:
#
#   list    — print the confirmed orphans (one branch per line), exit 0
#             even when the census is empty; nothing deleted.
#   sweep   — delete the confirmed orphans (git push origin --delete), one
#             loud line per branch, refused on any protection or census
#             failure. Never partial: deletion stops at the first refusal
#             (the same fail-loud convention as cell-disk-guard.sh, #474).
#
# Safety invariants (fail-LOUD, never silent):
#   - the open-PR census MUST be readable. An unreadable census (gh auth
#     failure, network error, rate limit) refuses the sweep with exit 1 —
#     deleting branches blind is exactly the class of accident this tool
#     exists to prevent.
#   - only `dsh/issue-*` remote heads are candidates; anything else is
#     ignored entirely (never listed, never deleted).
#   - `--dry-run` (default for `sweep` unless `--yes` is given) prints the
#     deletions that WOULD happen and touches nothing.
#
# Env seams:
#   GH_BIN      the gh binary to use (default: gh from PATH) — the hermetic
#               test seam (tests/branch-hygiene-sweep.test.mjs). Handed to
#               the approved-lane consult as APPROVED_LANE_GH.
#   SWEEP_REMOTE the remote to census (default origin).
#   APPROVED_LANE_TOOL  the approved-lane guard to consult for the #643
#               protected class (default: the sibling
#               scripts/approved-lane.mjs) — the hermetic test seam, the
#               MERGE_GUARD_VERIFY_TOOL pattern.
#
# Exit codes: 0 = fine (list: orphans printed; sweep: all deletions
# landed or dry-run completed) · 1 = census unreadable / deletion refused /
# approval consult unresolvable · 2 = usage error.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SWEEP_REMOTE_DEFAULT=origin
GH="${GH_BIN:-gh}"
REMOTE="${SWEEP_REMOTE:-$SWEEP_REMOTE_DEFAULT}"
APPROVED_LANE="${APPROVED_LANE_TOOL:-$SCRIPT_DIR/approved-lane.mjs}"

usage() {
  cat >&2 <<'EOF'
usage:
  orphan-branch-sweep.sh list            [--remote NAME]
  orphan-branch-sweep.sh sweep [--yes]   [--remote NAME]
modes:
  list    print confirmed orphan branches (no open PR behind them), delete nothing
  sweep   delete the confirmed orphans (requires --yes; default is a dry run)
env:
  GH_BIN         gh binary (default: gh from PATH — the hermetic test seam)
  SWEEP_REMOTE   remote to census (default: origin)
  APPROVED_LANE_TOOL  approved-lane guard (default: sibling approved-lane.mjs)
exit: 0 fine · 1 census unreadable, deletion refused, or consult unresolvable · 2 usage
EOF
  exit 2
}

[ $# -ge 1 ] || usage
MODE="$1"
shift
[ "$MODE" = list ] || [ "$MODE" = sweep ] || usage

YES=0
while [ $# -gt 0 ]; do
  case "$1" in
    --yes) YES=1 ;;
    --remote) REMOTE="${2:?--remote needs a name}"; shift ;;
    *) usage ;;
  esac
  shift
done

# --- census -----------------------------------------------------------------

# open_head_names REMOTE -> newline-separated head refs of OPEN PRs in this
# repo. One `gh pr list` call: the heads of every open PR. An unreadable
# census is a LOUD refusal — never delete blind. A census that FILLS its
# page (exactly 1000 rows) is refused the same way: heads beyond the limit
# would be misclassified orphans, and deleting them blind is the exact
# accident the never-delete-blind invariant exists to prevent (review
# finding on #497).
open_head_names() {
  local out
  if ! out="$("$GH" pr list --state open --limit 1000 --json headRefName 2>&1)"; then
    echo "orphan-branch-sweep: open-PR census unreadable ($out) — refusing to delete blind" >&2
    return 1
  fi
  printf '%s\n' "$out" | grep -q '"headRefName"' || true # empty or unreadable shape — the count below judges truncation
  # A full page means the census may be truncated: refuse rather than
  # classify heads past the page as orphans. (gh has no head-count field
  # in list mode; the row count is the honest proxy. The JSON is ONE
  # line, so the count is -o | wc -l, not grep -c.)
  if [ "$(printf '%s' "$out" | grep -o '"headRefName":' | wc -l | tr -d ' ' || true)" -ge 1000 ]; then
    echo "orphan-branch-sweep: open-PR census filled its 1000-row page — truncated census refused, nothing deleted (heads past the page would be misclassified)" >&2
    return 1
  fi
  # headRefName is a JSON array of {headRefName: "..."}: extract the names.
  # `|| true` — an empty census is a legit zero (no matches), and grep
  # exiting 1 on zero matches would trip set -e/pipefail into a refusal.
  printf '%s\n' "$out" \
    | grep -o '"headRefName":"[^"]*"' \
    | sed 's/^"headRefName":"//; s/"$//' \
    || true
  return 0
}

# remote_issue_heads REMOTE -> newline-separated dsh/issue-* remote head
# names. Anything else on the remote is out of scope (never touched).
# The ls-remote pattern asks for refs/heads/dsh/issue-*; the grep is the
# belt over that — the sweep's candidate class is decided HERE, never by
# the caller's pattern (or a stub's).
remote_issue_heads() {
  git ls-remote --heads "$REMOTE" 'refs/heads/dsh/issue-*' \
    | awk '{print $2}' \
    | sed 's#^refs/heads/##' \
    | grep '^dsh/issue-'
}

# closed_unmerged_head_prs REMOTE -> "<head>\t<pr-number>" rows: for every
# head branch, the NEWEST closed-WITHOUT-merge PR behind it (issue #643's
# consult scope). One `gh pr list --state closed` census — the same
# N-calls lesson as the open census (a per-branch `--head` query would be
# N calls for an N-branch pile). Newest = highest PR number (numbers are
# monotonic); a head whose newest closed PR MERGED emits nothing (its
# branch is the auto-delete setting's residue — an ordinary orphan). The
# JSON is unwieldy in shell, so the reduction runs in node (the
# merge-guard rollup pattern); unparseable JSON refuses, never shortens.
closed_unmerged_head_prs() {
  local out
  if ! out="$("$GH" pr list --state closed --limit 1000 --json headRefName,number,mergedAt 2>&1)"; then
    echo "orphan-branch-sweep: closed-PR census unreadable ($out) — refusing to delete blind on the approval channel (issue #643)" >&2
    return 1
  fi
  if [ "$(printf '%s' "$out" | grep -o '"headRefName":' | wc -l | tr -d ' ' || true)" -ge 1000 ]; then
    echo "orphan-branch-sweep: closed-PR census filled its 1000-row page — truncated census refused, nothing deleted (issue #643)" >&2
    return 1
  fi
  local census_file
  census_file="$(mktemp "${TMPDIR:-/tmp}/orphan-sweep-643.XXXXXX")" || {
    echo "orphan-branch-sweep: cannot create the closed-census scratch file — refusing to delete blind (issue #643)" >&2
    return 1
  }
  printf '%s' "$out" > "$census_file"
  local rc=0
  node -e '
    (() => {
      const fs = require("fs");
      let rows;
      try { rows = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); }
      catch { process.exit(3); }
      if (!Array.isArray(rows)) process.exit(3);
      const newest = new Map(); // head -> {number, mergedAt}
      for (const r of rows) {
        // One malformed row = a broken gather, not a shorter one: a
        // skipped row here could be THE unmerged-PR row behind a branch,
        // and skipping it would misclassify protected work as deletable
        // — the exact #643 loss. Refuse.
        if (typeof r?.headRefName !== "string" || typeof r?.number !== "number") process.exit(3);
        const prev = newest.get(r.headRefName);
        if (!prev || r.number > prev.number) newest.set(r.headRefName, r);
      }
      for (const [head, r] of [...newest].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
        if (r.mergedAt == null) console.log(`${head}\t${r.number}`);
      }
    })();' "$census_file" || rc=$?
  rm -f "$census_file"
  case $rc in
    0) return 0 ;;
    *) echo "orphan-branch-sweep: closed-PR census did not parse — refusing to delete blind on the approval channel (issue #643)" >&2; return 1 ;;
  esac
}

echo "--- orphan census: remote=$REMOTE ---" >&2

# The set of open-PR head refs — a branch IN this set is protected, live.
# The census is ONE call (the issue receipts' `gh pr list --head` per
# branch would be N calls for a 60-branch pile — same answer, N× the API).
OPEN_HEADS="$(open_head_names "$REMOTE")" || exit 1
echo "open PR heads: $(printf '%s\n' "$OPEN_HEADS" | grep -c . || true)" >&2

# Candidate orphans: dsh/issue-* heads with no open PR behind them. Each
# is then either confirmed (reap) or protected (the #643 approved lane).
CANDIDATES=""
PROTECTED=""
for b in $(remote_issue_heads "$REMOTE"); do
  if ! printf '%s\n' "$OPEN_HEADS" | grep -qx "$b"; then
    CANDIDATES="$CANDIDATES$b
"
  else
    PROTECTED="$PROTECTED$b
"
  fi
done
[ -z "${PROTECTED:-}" ] || echo "protected (open PR behind them): $(printf '%s' "$PROTECTED" | grep -c .) branch(es)" >&2

# The #643 consult — only when a candidate exists (a clean repo pays no
# extra call): which candidates sit behind a newest-closed-UNMERGED PR?
# Those are the ones whose branch may be reviewed-but-unlanded work; the
# approved-lane guard decides, fail-closed.
CLOSED_UNMERGED=""
CANDIDATE_LIST="$(printf '%s' "$CANDIDATES" | sed '/^$/d')"
if [ -n "$CANDIDATE_LIST" ]; then
  CLOSED_UNMERGED="$(closed_unmerged_head_prs "$REMOTE")" || exit 1
fi

ORPHANS=""
for b in $CANDIDATE_LIST; do
  pr_num="$(printf '%s\n' "$CLOSED_UNMERGED" | awk -F'\t' -v head="$b" '$1 == head {print $2}' | head -n1)"
  if [ -z "$pr_num" ]; then
    # No closed-unmerged PR behind it (never-PR'd, or the newest closed
    # PR merged and the auto-delete missed the branch): ordinary orphan.
    ORPHANS="$ORPHANS$b
"
    continue
  fi
  set +e
  lane_out="$(APPROVED_LANE_GH="$GH" node "$APPROVED_LANE" "$pr_num" 2>&1)"
  lane_rc=$?
  set -e
  case "$lane_rc" in
    0)
      # Approved, unlanded work: the head is its only independent copy.
      # LOUD skip — the recovery lane (reopen/land) stays open.
      echo "PROTECTED $b — approved-unmerged PR #$pr_num behind it ($lane_out); NOT reaped (issue #643 — an approved PR is not an idle lane; reopen/land it, this branch is the work's only path back to main)" >&2
      ;;
    1)
      # Not approved (idle or merged): retire/reap proceeds.
      ORPHANS="$ORPHANS$b
"
      ;;
    *)
      echo "orphan-branch-sweep: approval consult UNRESOLVABLE for $b (PR #$pr_num): $lane_out — refusing to delete blind on the approval channel, nothing further deleted (issue #643)" >&2
      exit 1
      ;;
  esac
done

if [ "$MODE" = list ]; then
  printf '%s' "$ORPHANS" | sed '/^$/d'
  echo "confirmed orphans: $(printf '%s' "$ORPHANS" | sed '/^$/d' | grep -c . || true)" >&2
  exit 0
fi

# --- sweep ------------------------------------------------------------------

ORPHAN_LIST="$(printf '%s' "$ORPHANS" | sed '/^$/d')"
if [ -z "$ORPHAN_LIST" ]; then
  echo "no confirmed orphans — nothing to sweep" >&2
  exit 0
fi
echo "confirmed orphans ($(printf '%s\n' "$ORPHAN_LIST" | grep -c .)):" >&2
printf '%s\n' "$ORPHAN_LIST" | sed 's/^/  - /' >&2

if [ "$YES" -ne 1 ]; then
  echo "== dry run — pass --yes to delete ==" >&2
  exit 0
fi

# Delete each orphan. refs/heads/<branch> is the ref form git push wants
# for a deletion (`git push <remote> --delete <branch>` would also work,
# but the explicit ref form cannot be misread as a push of local content).
for b in $ORPHAN_LIST; do
  if ! push_err="$(git push "$REMOTE" "refs/heads/$b" --delete 2>&1)"; then
    echo "REFUSED deleting $b — stop, nothing further deleted (fail-loud)" >&2
    printf '%s\n' "$push_err" | sed 's/^/  push: /' >&2
    exit 1
  fi
  echo "deleted $b" >&2
done
echo "sweep complete: $(printf '%s\n' "$ORPHAN_LIST" | grep -c .) orphan branch(es) deleted" >&2