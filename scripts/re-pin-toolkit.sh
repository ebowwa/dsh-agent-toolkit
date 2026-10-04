#!/usr/bin/env bash
# re-pin-toolkit.sh — the keepalive's GUARDED re-pin arm (issue #276).
#
# The cron keepalive that scripts/install-worker.sh arms must keep every
# lane box's toolkit checkout on the moving `v1` release tag — but the
# checkout it re-pins is ALSO the shared working tree a lane agent may be
# editing in place. The pre-#276 keepalive ran
#     git fetch --tags --force && git checkout -q --force v1
# inline, every minute, unconditionally: the moment drift-check advanced
# v1 under an agent's mid-edit tree, the next tick force-discarded the
# edits and moved HEAD (the #276 receipt: two resets in ~10 minutes on
# seed-L3, freshly edited files reverted to zero matches, all work
# re-derived in a private clone). This script is the same re-pin with a
# refusal gate in front of the destructive half:
#
#   REFUSE (loud note to the log, HEAD kept, sweep proceeds on the
#   previously pinned release — the same degradation a failed fetch
#   already had):
#     - tracked-file modifications exist (staged or unstaged) — the exact
#       payload a `checkout --force` destroys. The 2026-09-21 incident
#       class ("an in-place patch left the checkout dirty and the sweep
#       shadowed the tag") is deliberately NO LONGER answered by
#       discarding: silent destruction of whatever sits in the tree is
#       the #276 hazard itself. The refusal is loud (one note per sweep
#       in worker.log) instead of a silent shadow, and the cure for a
#       stray edit is deleting it, not cron-side destruction.
#     - HEAD is on a branch other than main (an agent's working branch;
#       steady state is detached at the pin, and a fresh clone sits on
#       main — both may be moved).
#   Untracked files never block the re-pin: `checkout --force` does not
#   touch them, and counting them would strand a box on an old release
#   forever (scratch files accumulate on working cells).
#
# Exit contract (the cron line separates with `;` — the sweep runs on
# EVERY exit code; these codes exist for the installer and humans):
#   0  re-pinned to v1 (quiet on success, like the old -q flags: steady
#      state adds nothing to worker.log)
#   3  refused — the checkout carries live work; HEAD kept
#   4  degraded — fetch or checkout failed; previous pin kept, cron
#      retries next sweep
#   2  usage / not a git checkout
#
# GIT_OPTIONAL_LOCKS=0 on every read: the guard must never take the
# index lock under a concurrently working agent — a blocked agent is the
# very hazard this script exists to remove.
#
# Usage: re-pin-toolkit.sh [toolkit-dir]   (default $DSH_AGENT_TOOLKIT_DIR)

set -uo pipefail

DIR="${1:-${DSH_AGENT_TOOLKIT_DIR:-}}"
if [ -z "$DIR" ]; then
  echo "re-pin-toolkit: no toolkit dir given (arg 1 or DSH_AGENT_TOOLKIT_DIR)" >&2
  exit 2
fi
if [ ! -d "$DIR/.git" ]; then
  echo "re-pin-toolkit: $DIR is not a git checkout (.git missing)" >&2
  exit 2
fi

# Every git call: explicit safe.directory (the Actions runner's per-job
# HOME/gitconfig handling can trip the ownership guard silently — the
# same reason install-worker.sh:53 sets it) and no optional index locks.
G() { GIT_OPTIONAL_LOCKS=0 git -c safe.directory="$DIR" -C "$DIR" "$@"; }

# REFUSAL GATE 1 — tracked modifications. `diff-index --quiet HEAD`
# exits nonzero when any tracked file differs from HEAD (staged or
# unstaged): exactly the payload checkout --force would destroy.
if ! G diff-index --quiet HEAD -- >/dev/null 2>&1; then
  echo "re-pin-toolkit: REFUSING re-pin of $DIR — tracked-file modifications present (agent work in flight, issue #276 class); HEAD kept; the sweep runs the previously pinned code. Modified (first lines):" >&2
  G diff-index --name-only HEAD -- 2>/dev/null | head -5 | sed 's/^/    /' >&2
  echo "re-pin-toolkit: commit or clean the tree to resume v1 re-pins." >&2
  exit 3
fi

# REFUSAL GATE 2 — a working branch. symbolic-ref prints the branch name
# and exits 0 on a branch, exits 1 (empty) when HEAD is detached.
BRANCH="$(G symbolic-ref -q --short HEAD || true)"
if [ -n "$BRANCH" ] && [ "$BRANCH" != "main" ]; then
  echo "re-pin-toolkit: REFUSING re-pin of $DIR — HEAD is on branch '$BRANCH' (a working branch, issue #276 class); HEAD kept; the sweep runs the previously pinned code." >&2
  exit 3
fi

# Fetch first (the old cron arm's order), degraded-not-fatal.
if ! G fetch --tags --force -q >/dev/null 2>&1; then
  echo "re-pin-toolkit: fetch failed — keeping the previous pin; the keepalive retries next sweep" >&2
  exit 4
fi

if ! G checkout -q --force v1 >/dev/null 2>&1; then
  echo "re-pin-toolkit: checkout v1 failed — keeping the previous pin; the keepalive retries next sweep" >&2
  exit 4
fi
exit 0
