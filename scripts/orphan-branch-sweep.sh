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
# (or under review), never an orphan. The sweep lists remote refs through
# `git ls-remote` (no clone needed) and the open-PR census through `gh pr
# list` (one call, `--head` matching per branch is unnecessary — the census
# is the set of open head refs; a branch not in it is an orphan by
# definition, and a branch name that IS an open head is skipped with a
# "protected" note, never deleted).
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
#               test seam (tests/branch-hygiene-sweep.test.mjs).
#   SWEEP_REMOTE the remote to census (default origin).
#
# Exit codes: 0 = fine (list: orphans printed; sweep: all deletions
# landed or dry-run completed) · 1 = census unreadable / deletion refused ·
# 2 = usage error.

set -euo pipefail

SWEEP_REMOTE_DEFAULT=origin
GH="${GH_BIN:-gh}"
REMOTE="${SWEEP_REMOTE:-$SWEEP_REMOTE_DEFAULT}"

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
exit: 0 fine · 1 census unreadable or deletion refused · 2 usage
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
# census is a LOUD refusal — never delete blind.
open_head_names() {
  local out
  if ! out="$("$GH" pr list --state open --limit 1000 --json headRefName 2>&1)"; then
    echo "orphan-branch-sweep: open-PR census unreadable ($out) — refusing to delete blind" >&2
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

echo "--- orphan census: remote=$REMOTE ---" >&2

# The set of open-PR head refs — a branch IN this set is protected, live.
# The census is ONE call (the issue receipts' `gh pr list --head` per
# branch would be N calls for a 60-branch pile — same answer, N× the API).
OPEN_HEADS="$(open_head_names "$REMOTE")" || exit 1
echo "open PR heads: $(printf '%s\n' "$OPEN_HEADS" | grep -c . || true)" >&2

ORPHANS=""
PROTECTED=""
for b in $(remote_issue_heads "$REMOTE"); do
  if printf '%s\n' "$OPEN_HEADS" | grep -qx "$b"; then
    PROTECTED="$PROTECTED$b
"
  else
    ORPHANS="$ORPHANS$b
"
  fi
done

[ -z "$PROTECTED" ] || echo "protected (open PR behind them): $(printf '%s' "$PROTECTED" | grep -c .) branch(es)" >&2

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
  if ! git push "$REMOTE" "refs/heads/$b" --delete >/dev/null 2>&1; then
    echo "REFUSED deleting $b — stop, nothing further deleted (fail-loud)" >&2
    exit 1
  fi
  echo "deleted $b" >&2
done
echo "sweep complete: $(printf '%s\n' "$ORPHAN_LIST" | grep -c .) orphan branch(es) deleted" >&2