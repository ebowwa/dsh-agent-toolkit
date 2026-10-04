#!/usr/bin/env bash
# pin-toolkit.sh — the guarded v1 re-pin for a live toolkit checkout
# (issue #276).
#
# The keepalive (install-worker.sh's cron line) calls this every sweep
# instead of a bare `git checkout -q --force v1`. --force is load-bearing
# and stays: the 2026-09-21 incident (install-worker.sh NOTE) proved a
# bare `checkout v1` silently KEEPS local modifications, and the sweep
# shadowed v1.73.0→v1.74.0 for hours. But UNCONDITIONAL --force is the
# issue #276 destroyer: it discards an agent's in-flight work in the
# shared checkout mid-session (verified live on seed-L3, 2026-10-03 —
# HEAD force-moved and freshly edited files reverted twice within ~10
# minutes). The reconciliation: re-pin ONLY a quiescent checkout.
#
# Guard (all must hold before checkout --force fires):
#   * no tracked modifications
#     (`git status --porcelain --untracked-files=no`)
#   * HEAD is detached — steady state is detached-at-v1 (the installer
#     and every prior sweep leave it so); a successful symbolic-ref
#     means someone checked a working branch out
# A dirty or on-a-branch checkout is LEFT ALONE with a note on stdout
# (worker.log under cron): the sweep then runs the PREVIOUSLY pinned
# release — the degradation install-worker.sh already designs for
# ("checkout v1 failing degrades to running the previously pinned
# release — never a broken sweep"). Untracked files never block the
# re-pin: checkout --force does not destroy them as a class, and
# treating them as dirt would let one stray file shadow the moving tag
# forever — the 2026-09-21 failure mode, resurrected.
#
# Usage: pin-toolkit.sh [checkout-dir]
#   dir default: $DSH_AGENT_TOOLKIT_DIR, then $HOME/dsh-agent-toolkit
# Exit: 0 re-pinned; 2 refused-with-note (in-flight work left intact);
#   1 pin attempt failed (fetch/checkout error — same degradation as a
#   fetch failure: keep the previous pin, sweep continues).
#
# Rollout note: the cron line and installer both call this ONLY when it
# exists in the target checkout, falling back to the legacy inline
# force-pin otherwise — until the v1 release carries this file, boxes
# keep the old behavior, and the tag itself is the rollout.

set -euo pipefail

DIR="${1:-${DSH_AGENT_TOOLKIT_DIR:-$HOME/dsh-agent-toolkit}}"
GIT=(git -c safe.directory="$DIR" -C "$DIR")

note() { echo "pin-toolkit: $*"; }

# Fetch first — it never touches the working copy; the guard below reads
# the tree, not the refs, so fetching before the check cannot destroy
# anything and keeps the "fetch failed → keep previous pin" degradation
# in one place.
if ! "${GIT[@]}" fetch --tags --force --quiet; then
  note "fetch failed — keeping the previously pinned checkout"
  exit 1
fi

if [ -n "$("${GIT[@]}" status --porcelain --untracked-files=no)" ]; then
  note "REFUSING re-pin: tracked modifications in $DIR (issue #276 — in-flight work); the sweep runs the previously pinned release"
  exit 2
fi
if "${GIT[@]}" symbolic-ref -q HEAD >/dev/null; then
  note "REFUSING re-pin: HEAD is on a branch in $DIR (issue #276 — in-flight work); the sweep runs the previously pinned release"
  exit 2
fi

"${GIT[@]}" checkout -q --force v1
note "pinned at $("${GIT[@]}" describe --tags 2>/dev/null || echo v1)"
