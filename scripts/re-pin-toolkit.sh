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
#       stray edit is deleting it, not cron-side destruction.
#
#   CONVERGE (issue #614 — the drift class the old working-branch
#   refusal parked FOREVER): a CLEAN tree sitting on a working branch.
#   The #276 refusal left that state standing until a human noticed —
#   the air16 receipt: the box's harness copy sat on
#   `dsh/issue-530-c6027819073` [ahead 1, behind 6 of origin/main]
#   across a behavior change (FleetTower#1629's both-namespaces face
#   rule) it never received. A clean tree on a branch is RESIDUE, not
#   live work: in-place claim work is banned post-#276 (claims run in
#   private clones), and converging it destroys nothing — the branch
#   ref keeps every commit (`git checkout v1` moves HEAD only) and
#   untracked files survive. The arm re-pins with ONE LOUD stderr note
#   (worker.log via the cron line) naming the branch, its ahead/behind
#   vs origin/main, and the exact recovery command, so the residue is
#   visible the minute it heals instead of festering quiet. Tracked
#   modifications still REFUSE first — gate 1 is absolute, the only
#   payload a force checkout can destroy.
#
#   STAMP (issue #614 — the deploy-drift stamp contract FleetTower#776
#   shipped for the node binary, scaled to the harness home): every
#   successful landing rewrites an UNTRACKED `.toolkit-pin-stamp` at
#   the checkout root — decision, UTC time, previous/landed HEAD, the
#   pin sha, branch, ahead/behind vs origin/main — so "is this box on
#   the remote tip" is answerable from the box alone and the last
#   converge/refuse/degrade state is auditable without ssh. Untracked
#   files never block the re-pin and `checkout --force` never removes
#   them, so the stamp survives its own next write. A failed stamp
#   write DEGRADES: an unstamped landing is an unverified landing.
#
# Exit contract (the cron line separates with `;` — the sweep runs on
# EVERY exit code; these codes exist for the installer and humans):
#   0  re-pinned to v1 — or CONVERGED onto it from a clean working
#      branch. Steady-state re-pins stay QUIET (like the old -q flags:
#      steady state adds nothing to worker.log); a converge is the one
#      LOUD success — a HEAD move on the shared checkout must be
#      visible in the log
#   3  refused — the checkout carries live work (tracked modifications,
#      the absolute gate); HEAD kept
#   4  degraded — fetch, checkout, or the stamp write failed; previous
#      state kept, cron retries next sweep
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

# REFUSAL GATE 1 — tracked modifications (UNCHANGED, absolute; issue
# #276). `diff-index --quiet HEAD` exits nonzero when any tracked file
# differs from HEAD (staged or unstaged): exactly the payload
# checkout --force would destroy. This stays the ONLY refuse-forever
# gate — the cure is "commit or clean the tree", never cron-side
# destruction.
if ! G diff-index --quiet HEAD -- >/dev/null 2>&1; then
  echo "re-pin-toolkit: REFUSING re-pin of $DIR — tracked-file modifications present (agent work in flight, issue #276 class); HEAD kept; the sweep runs the previously pinned code. Modified (first lines):" >&2
  G diff-index --name-only HEAD -- 2>/dev/null | head -5 | sed 's/^/    /' >&2
  echo "re-pin-toolkit: commit or clean the tree to resume v1 re-pins." >&2
  exit 3
fi

# Fetch BEFORE the branch gate (issue #614): the converge decision and
# its ahead/behind counts need fresh remote refs, and a fetch touches
# no worktree path — safe wherever the tree sits. Degraded-not-fatal.
if ! G fetch --tags --force -q >/dev/null 2>&1; then
  echo "re-pin-toolkit: fetch failed — keeping the previous pin; the keepalive retries next sweep" >&2
  exit 4
fi

# State snapshot for the converge note + the stamp. symbolic-ref prints
# the branch name and exits 0 on a branch, exits 1 (empty) when HEAD is
# detached (the steady state). The drift counts answer against
# origin/main — the same comparison base deploy-drift polls — and an
# unreadable count degrades to `unknown`, never blocks the re-pin.
BRANCH="$(G symbolic-ref -q --short HEAD || true)"
HEAD_SHA="$(G rev-parse HEAD 2>/dev/null || true)"
V1_SHA="$(G rev-parse v1 2>/dev/null || true)"
if G rev-parse --verify -q origin/main >/dev/null 2>&1; then
  BEHIND_MAIN="$(G rev-list --count HEAD..origin/main 2>/dev/null || echo unknown)"
  AHEAD_MAIN="$(G rev-list --count origin/main..HEAD 2>/dev/null || echo unknown)"
else
  BEHIND_MAIN=unknown
  AHEAD_MAIN=unknown
fi

# CONVERGE ARM (issue #614) — the old REFUSAL GATE 2. A CLEAN tree on a
# working branch is standing-checkout residue, not live work: re-pinning
# it destroys nothing (the branch ref keeps every commit — checkout
# moves HEAD only — and untracked files survive), while the old refusal
# parked the box on stale code FOREVER (the air16 receipt above).
# Converge LOUDLY: the note rides the cron line into worker.log.
DECISION=re-pinned
if [ -n "$BRANCH" ] && [ "$BRANCH" != "main" ]; then
  DECISION=converged
  echo "re-pin-toolkit: CONVERGING $DIR — HEAD sat on branch '$BRANCH' (${AHEAD_MAIN} commit(s) not on origin/main, ${BEHIND_MAIN} behind; issue #614 standing-checkout drift). Nothing discarded: the branch ref survives." >&2
  echo "re-pin-toolkit: recover it with: git -C \"$DIR\" checkout \"$BRANCH\" — push any work you still need FIRST." >&2
fi

if ! G checkout -q --force v1 >/dev/null 2>&1; then
  echo "re-pin-toolkit: checkout v1 failed — keeping the previous pin; the keepalive retries next sweep" >&2
  exit 4
fi

# STAMP (issue #614) — every landing rewrites the untracked stamp at the
# checkout root; a failed write degrades because an unstamped landing is
# an unverified landing (the deploy-drift rule: an UNSTAMPED home is
# drift, not truth).
NEW_HEAD="$(G rev-parse HEAD 2>/dev/null || true)"
STAMP_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
if ! cat > "${DIR}/.toolkit-pin-stamp" <<EOF
format=1
at=${STAMP_AT}
decision=${DECISION}
branch=${BRANCH}
prev_head=${HEAD_SHA}
head=${NEW_HEAD}
pin_v1=${V1_SHA}
behind_main=${BEHIND_MAIN}
ahead_main=${AHEAD_MAIN}
EOF
then
  echo "re-pin-toolkit: stamp write failed at ${DIR}/.toolkit-pin-stamp — landing treated as unverified (exit 4); the keepalive retries next sweep" >&2
  exit 4
fi
exit 0
