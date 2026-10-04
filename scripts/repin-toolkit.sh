#!/usr/bin/env bash
# repin-toolkit.sh — the GUARDED v1 re-pin the keepalive runs each sweep
# (and install-worker.sh runs at install time). Extracted from the bare
# cron line `fetch --tags && checkout -q --force v1` by issue #276.
#
# WHY GUARDED (#276): the blind force-checkout moved HEAD off a working
# agent's branch and cleaned the tree mid-edit — twice in ten minutes on
# seed-L3 (receipts: issue #276) — silently discarding in-flight work.
# The re-pin must REFUSE while a human/agent holds the checkout in place.
#
# The guard, by HEAD state:
#   - working branch checked out (anything but main/master): SKIP always.
#     Moving HEAD under an in-place worker destroys its context even when
#     the tree reads clean; the branch IS the occupancy signal.
#   - main/master with a dirty tree (tracked OR untracked): SKIP. A dirty
#     default branch is someone's in-flight edit, not provisioning drift.
#   - detached HEAD (the pinned steady state) or clean main: re-pin with
#     --force. This preserves the 2026-09-21 semantics — a stray local
#     patch on the pinned checkout must never shadow the moving tag; the
#     template channel stays tag-only.
#
# A SKIP prints a dated note (the sweep's worker.log carries it — the
# "leave a note" half of #276) and exits 0: the sweep then runs the
# PREVIOUS pin, which is the documented degrade for a failed re-pin.
# A fetch/checkout failure exits non-zero so the cron line's `|| echo`
# can note the degrade; the checkout is left untouched either way.
#
# Rollout: existing boxes carry the old bare line until the next
# install-worker.sh run re-enforces this canonical form.
#
# Invoked as `bash <script> [dir]` (scripts ship mode 644 — never exec).
# dir defaults to $DSH_AGENT_TOOLKIT_DIR, then ~/dsh-agent-toolkit.

set -euo pipefail

DIR="${1:-${DSH_AGENT_TOOLKIT_DIR:-$HOME/dsh-agent-toolkit}}"
STAMP="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
G() { git -c safe.directory="$DIR" -C "$DIR" "$@"; }

# moving tag: --force (a plain fetch clobbers: "would clobber existing tag")
G fetch --tags --force -q

BRANCH="$(G symbolic-ref -q --short HEAD || true)"
if [ -n "$BRANCH" ] && [ "$BRANCH" != "main" ] && [ "$BRANCH" != "master" ]; then
  echo "$STAMP repin: SKIP — working branch '$BRANCH' checked out; an in-place worker owns the tree (#276). The sweep runs the previous pin; clean the branch to resume pinning."
  exit 0
fi
if [ -n "$BRANCH" ] && [ -n "$(G status --porcelain 2>/dev/null)" ]; then
  echo "$STAMP repin: SKIP — dirty tree on '$BRANCH' (#276); refusing to force-move the tag over in-flight edits. The sweep runs the previous pin; commit or clean the tree to resume pinning."
  exit 0
fi

G checkout -q --force v1
DESC="$(G describe --tags 2>/dev/null || true)"
echo "$STAMP repin: pinned at ${DESC:-v1}"
