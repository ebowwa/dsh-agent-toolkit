#!/usr/bin/env bash
# re-pin-toolkit.sh — the keepalive's GUARDED re-pin arm (issue #276),
# extended into the standing checkout's CONVERGENCE arm (issue #614).
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
#       stray edit is deleting it, not cron-side destruction. This is the
#       ABSOLUTE gate and the ONLY refuse-forever class.
#     - an UNTRACKED file whose PATH is tracked in the target tree (gate
#       3, issue #666) — `checkout --force` DOES overwrite that shape
#       (git writes the tracked blob over it, exit 0, no diagnostic).
#   NON-COLLIDING untracked files never block the re-pin: `checkout --force`
#   does not touch them, and counting them would strand a box on an old
#   release forever (scratch files accumulate on working cells).
#
#   CONVERGE (issue #614 — the drift class the old working-branch refusal
#   parked FOREVER): a CLEAN tree sitting on a working branch. The #276
#   refusal left that state standing until a human noticed — the air16
#   receipt: the box's harness copy sat on `dsh/issue-530-c6027819073`
#   [ahead 1, behind 6 of origin/main] across a behavior change
#   (FleetTower#1629's both-namespaces face rule) it never received. A
#   clean tree on a branch is RESIDUE, not live work: in-place claim work
#   is banned post-#276 (claims run in private clones), and converging it
#   destroys nothing (the branch ref keeps every commit — checkout moves
#   HEAD only). It is NEVER silent: the arm emits ONE LOUD stderr note per
#   converge (worker.log via the cron line) carrying the branch, its
#   ahead/behind vs origin/main, the exact recovery command, and the
#   hand-off that matters — `harness-drift.sh heal` (#616) REFUSES this
#   same shape as `refused-branch`, so this cron arm is the one that
#   resolves it and the log says which arm moved HEAD.
#
#   STAMP (issues #614 + #616) — ONE stamp per checkout, written by its
#   LANDED OWNER. `scripts/harness-drift.sh` (#616) owns the harness
#   checkout's deploy record (`scripts/HARNESS_DEPLOYED_SHA`: sha + ref +
#   commit date); this arm does NOT keep a second per-checkout file — the
#   original #614 `.toolkit-pin-stamp` is DROPPED, not aliased, because
#   two files answering "what is deployed here" drift apart the first time
#   one writer misses, and an alias would inherit the same trap (it must
#   never become a tracked path — see the #276 collision class above).
#   Every landing refreshes the owner's stamp by INVOKING the owner, so
#   "is this box on the remote tip" is answerable from the box alone. A
#   failed stamp DEGRADES (exit 4): an unstamped landing is an UNVERIFIED
#   landing. A checkout whose landed tree predates #616 carries no owner —
#   the landing still stands, one note says the stamp was not written.
#
# Order matters: gate 1 (absolute) → fetch → gate 3 (#666) → converge →
# checkout → stamp. Gate 3 needs the fetched target tree to compute the
# collision set; the converge decision needs the fetched origin/main for
# its drift counts; the stamp describes the LANDED head, so it runs last.
#
# Exit contract (the cron line separates with `;` — the sweep runs on
# EVERY exit code; these codes exist for the installer and humans):
#   0  re-pinned to v1 — or CONVERGED onto it from a clean working
#      branch. Steady-state re-pins stay QUIET (like the old -q flags:
#      steady state adds nothing to worker.log); a converge is the one
#      LOUD success — a HEAD move on the shared checkout must be visible
#      in the log
#   3  refused — the checkout carries live work (tracked modifications,
#      the absolute gate; or a path-colliding untracked file); HEAD kept
#   4  degraded — fetch, checkout, or the stamp write failed; kind of
#      failure matters: a fetch/checkout failure keeps the PREVIOUS pin,
#      a stamp failure happens AFTER a landing that happened (that
#      landing is unverified, not undone). Cron retries next sweep
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

# REFUSAL GATE 1 — tracked modifications (absolute, issue #276).
# `diff-index --quiet HEAD` exits nonzero when any tracked file differs
# from HEAD (staged or unstaged): exactly the payload checkout --force
# would destroy. This stays the ONLY refuse-forever gate — the cure is
# "commit or clean the tree", never cron-side destruction.
if ! G diff-index --quiet HEAD -- >/dev/null 2>&1; then
  echo "re-pin-toolkit: REFUSING re-pin of $DIR — tracked-file modifications present (agent work in flight, issue #276 class); HEAD kept; the sweep runs the previously pinned code. Modified (first lines):" >&2
  G diff-index --name-only HEAD -- 2>/dev/null | head -5 | sed 's/^/    /' >&2
  echo "re-pin-toolkit: commit or clean the tree to resume v1 re-pins." >&2
  exit 3
fi

# Fetch BEFORE the branch decision (issue #614): the converge note's
# ahead/behind counts and gate 3's target tree both need fresh remote
# refs, and a fetch touches no worktree path — safe wherever the tree
# sits. Degraded-not-fatal.
if ! G fetch --tags --force -q >/dev/null 2>&1; then
  echo "re-pin-toolkit: fetch failed — keeping the previous pin; the keepalive retries next sweep" >&2
  exit 4
fi

# REFUSAL GATE 3 (issue #666) — path-colliding untracked files. The header's
# "untracked files never block the re-pin" reading is TRUE ONLY for
# non-colliding ones: `git checkout --force <tag>` DOES overwrite an untracked
# file when its PATH is tracked in the target tree (git writes the tracked
# blob over it, exit 0, no diagnostic) — measured on this fleet's git. The
# intersection below is computed BEFORE the move, so the #276 class refuses
# here instead of destroying an operator's or an agent's live untracked work
# through a path collision (a same-name scratch file, a rename-adjacent
# runbook artifact).
COLLIDING=""
if [ -n "$(G ls-tree -r --name-only v1 2>/dev/null)" ]; then
  COLLIDING="$(
    { G ls-tree -r --name-only v1 2>/dev/null; G ls-files --others --exclude-standard 2>/dev/null; } \
      | LC_ALL=C sort | uniq -d
  )"
fi
if [ -n "$COLLIDING" ]; then
  echo "re-pin-toolkit: REFUSING re-pin of $DIR — untracked file(s) collide with a path tracked at v1; checkout --force WOULD OVERWRITE them (issue #666 class); HEAD kept. Colliding (first lines):" >&2
  printf '%s\n' "$COLLIDING" | head -5 | sed 's/^/    /' >&2
  echo "re-pin-toolkit: move or delete the colliding file(s) to resume v1 re-pins." >&2
  exit 3
fi

# State snapshot for the converge note. symbolic-ref prints the branch
# name and exits 0 on a branch, exits 1 (empty) when HEAD is detached
# (the steady state). The drift counts answer against origin/main — the
# same comparison base deploy-drift polls — and an unreadable count
# degrades to `unknown`, never blocks the re-pin.
BRANCH="$(G symbolic-ref -q --short HEAD || true)"
if G rev-parse --verify -q origin/main >/dev/null 2>&1; then
  BEHIND_MAIN="$(G rev-list --count HEAD..origin/main 2>/dev/null || echo unknown)"
  AHEAD_MAIN="$(G rev-list --count origin/main..HEAD 2>/dev/null || echo unknown)"
else
  BEHIND_MAIN=unknown
  AHEAD_MAIN=unknown
fi

# CONVERGE ARM (issue #614) — the old REFUSAL GATE 2. A CLEAN tree on a
# working branch is standing-checkout residue, not live work: re-pinning
# it destroys nothing (the branch ref keeps every commit — checkout moves
# HEAD only), while the old refusal parked the box on stale code FOREVER
# (the air16 receipt above). The detach is ANNOUNCED, never silent, and
# the note hands the boot arm its own verdict: harness-drift.sh heal
# refuses this shape as `refused-branch`, so the log names the arm that
# actually moved HEAD instead of leaving the refusal's disappearance
# unexplained.
if [ -n "$BRANCH" ] && [ "$BRANCH" != "main" ]; then
  echo "re-pin-toolkit: CONVERGING $DIR — HEAD sat on branch '$BRANCH' (${AHEAD_MAIN} commit(s) not on origin/main, ${BEHIND_MAIN} behind; issue #614 standing-checkout drift). This arm DETACHES it onto the pin: the boot's harness-drift.sh heal refuses this shape as refused-branch, so the cron arm is the one that moves HEAD — announced here, never silent. Nothing discarded: the branch ref survives." >&2
  echo "re-pin-toolkit: recover it with: git -C \"$DIR\" checkout \"$BRANCH\" — push any work you still need FIRST." >&2
fi

if ! G checkout -q --force v1 >/dev/null 2>&1; then
  echo "re-pin-toolkit: checkout v1 failed — keeping the previous pin; the keepalive retries next sweep" >&2
  exit 4
fi

# STAMP (issues #614 + #616) — ONE stamp per checkout, refreshed through its
# landed owner. scripts/harness-drift.sh (#616) owns the harness deploy record
# (scripts/HARNESS_DEPLOYED_SHA) and this arm INVOKES it rather than writing a
# second file (see the header: .toolkit-pin-stamp is dropped, not aliased).
# The owner's stdout/stderr are captured so a steady-state sweep stays QUIET;
# only a FAILED stamp speaks, and it degrades — an unstamped landing is an
# unverified landing, and the exit-4 class the installer already teaches.
STAMP_OWNER="$DIR/scripts/harness-drift.sh"
if [ -f "$STAMP_OWNER" ]; then
  if ! STAMP_OUT="$(bash "$STAMP_OWNER" stamp "$DIR" 2>&1)"; then
    printf '%s\n' "$STAMP_OUT" | sed 's/^/    /' >&2
    echo "re-pin-toolkit: harness-drift stamp write failed at $DIR (scripts/HARNESS_DEPLOYED_SHA) — landing treated as unverified (exit 4); the keepalive retries next sweep" >&2
    exit 4
  fi
else
  echo "re-pin-toolkit: landed tree carries no scripts/harness-drift.sh — stamp owner absent (a pre-#616 pin); landing kept, no stamp written" >&2
fi
exit 0
