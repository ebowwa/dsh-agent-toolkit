#!/usr/bin/env bash
# pin-toolkit.sh — guarded re-pin of the LIVE shared toolkit checkout to
# the moving v1 tag (issue #276).
#
# Two incidents, one line of git, and the guard that threads both:
#   - 2026-09-21 (PR #104): a bare `checkout v1` silently KEPT a stray
#     local patch (settings.zai.yaml) and the dirty tree shadowed
#     v1.73.0→v1.74.0 for hours — so on the DETACHED pin state, --force
#     must stay: stray edits must never shadow the tag.
#   - 2026-10-03 (issue #276): that same per-minute `--force` re-pin
#     reset the live checkout UNDER a working agent twice in ten minutes
#     on seed-L3 — uncommitted edits gone, HEAD yanked mid-session, all
#     work re-derived in a private clone.
# The distinguisher is the HEAD state, not the dirtiness: an agent doing
# in-place work rides a BRANCH (the dispatch contract mints dsh/*
# branches); a stray edit rides the detached pin. So:
#   HEAD on a branch → REFUSE (exit 0): write .pin-held + one log line,
#                     run the tree as-is for this sweep — the same
#                     degradation a failed fetch already has, and the
#                     pin resumes the sweep after the branch is left.
#   HEAD detached    → fetch --tags --force && checkout --force v1
#                     (the 2026-09-21 cure, unchanged).
#
# Usage: pin-toolkit.sh <toolkit-dir> [log-file]
# Exit: 0 = pinned or held (both steady states for the sweep);
#       2 = usage (no checkout at <dir>);
#       3 = fetch/checkout failed (caller's `|| true` degrades to the
#           previous pin; cron retries each sweep).

set -euo pipefail
DIR="${1:-}"
LOG="${2:-}"
[ -n "$DIR" ] && [ -d "$DIR/.git" ] \
  || { echo "pin-toolkit: no toolkit checkout at '${DIR:-<unset>}'" >&2; exit 2; }

# safe.directory is set explicitly: the live checkout is owned by the
# box user while cron may run under a different HOME/gitconfig view —
# git's ownership guard must never turn a sweep into a silent skip
# (install-worker.sh precedent).
g() { git -c safe.directory="$DIR" -C "$DIR" "$@"; }

note() { # <message> — stderr (cron log redirect) + optional log file
  echo "pin-toolkit: $*" >&2
  if [ -n "$LOG" ]; then
    mkdir -p "$(dirname "$LOG")" 2>/dev/null || true
    { date -u '+%Y-%m-%dT%H:%M:%SZ'; echo "pin-toolkit: $*"; } >>"$LOG" 2>/dev/null || true
  fi
}

BR="$(g symbolic-ref -q HEAD || true)"
if [ -n "$BR" ]; then
  # An agent may be working in-place ON this branch (issue #276) — do
  # NOT --force it away. The note rides the checkout itself so an agent
  # cd'ing in sees it in git status (untracked .pin-held) before editing.
  cat >"$DIR/.pin-held" <<EOF
The v1 re-pin is HOLDING: this checkout is on branch ${BR#refs/heads/}
(${BR}). Per issue #276 the sweep will not --force a branch off — a
working agent's tree stays intact. The pin RESUMES automatically on the
first sweep after this branch is left (checkout the tag / main, delete
the branch). Claim work belongs in a throwaway clone or git worktree,
never in this shared checkout.
EOF
  note "pin held — HEAD is on branch ${BR#refs/heads/}; NOT re-pinning (issue #276)"
  exit 0
fi

rm -f "$DIR/.pin-held"
if g fetch --tags --force -q && g checkout -q --force v1; then
  note "pinned at $(g describe --tags 2>/dev/null || echo v1)"
  exit 0
fi
note "fetch/checkout failed — running the previous pin (cron retries each sweep)"
exit 3
