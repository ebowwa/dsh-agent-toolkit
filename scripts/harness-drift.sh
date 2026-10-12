#!/usr/bin/env bash
# harness-drift.sh — STAMP/COMPARE/LOUD for the HARNESS checkout (issue #616).
#
# The node home's deploy-drift (FleetTower scripts/1o/lib/deploy-drift.mjs,
# issue #776) reconciles ~/dsh-node only. The checkout the node actually
# SPAWNS through — this repo's harness checkout (~/dsh-bot-class dirs, the
# tree whose scripts/run-dsh-agent.sh mints, sanitizes, and launches every
# dispatched session) — had no stamp, no compare, and no self-heal: air16's
# sat 10 days behind (committed 2026-09-28) while the node home beside it
# converged within minutes of every main landing, and nothing on the box
# could even answer "what wrapper version spawned this session" (the
# FleetTower#2047 diagnosis needed a node-side ssh session to pin it).
# Stale-deployed-code is inert but LOOKING alive (#776's words) — verbatim
# true of the wrapper. This script is the node's contract, wrapper-sized:
#
#   STAMP   scripts/HARNESS_DEPLOYED_SHA beside the wrapper (an UNTRACKED,
#           gitignored file): the checkout sha + commit date the tree
#           carries, refreshed after every heal. Written at every sync
#           point this repo controls — the wrapper's boot heal — so a run
#           artifact can always answer what spawned it.
#   COMPARE one `git ls-remote` round trip against the EXPECTED REF: the
#           DEPLOY ref — the tag a detached pin sits on (the keepalive
#           regime — steady state is detached at the pin), else origin's
#           default branch (the clone-once-then-drift shape) — never the
#           incidental branch HEAD sits on (a working branch is a refusal
#           shape, not a compare base). A differing tip is drift.
#   LOUD    every verdict carries `verdict=<token>` on stdout; the wrapper
#           relays it into the boot log's setup group, the boot-tombstone
#           lines, and dsh-run-meta.env (the `wrapper=` field every posted
#           artifact stamps). A refused or degraded heal is loud, never
#           silent, and never fatal: the boot continues on the current tree.
#
# SELF-HEAL GUARDS — the #276 class (never destroy live work), stricter
# than the keepalive's re-pin because this arm runs beside a boot:
#   REFUSE (exit 3, loud note, HEAD + tree kept):
#     - tracked-file modifications (the payload a checkout --force would
#       destroy — exactly re-pin-toolkit.sh's refusal gate 1);
#     - HEAD on a branch OTHER than the expected ref (an agent's or an
#       operator's working branch);
#     - the head is not a strict ANCESTOR of the remote tip: local commits
#       ("ahead") or a diverged head are never auto-moved — a shallow
#       checkout that cannot PROVE ancestry after a fetch (and one
#       best-effort --unshallow retry; this repo is scripts-only, small)
#       refuses too. The only auto-move is a fast-forward.
#   DEGRADE (exit 4, loud note, nothing touched): ls-remote/fetch failure
#     (bounded: GIT_HTTP_LOW_SPEED_* — a wedged egress must not wedge the
#     boot), the expected ref missing on origin, or an unresolvable HEAD.
#   LOCK: an mkdir lock under .git serializes heal against a concurrent
#     boot of the same checkout; a fresh lock refuses (exit 3), a lock
#     older than 10 minutes is stale and taken over.
#
# Network legs inherit the checkout's existing auth (the same one
# `git ls-remote` round trip the node's drift poll runs) — no credentials
# are read, set, or logged here.
#
# REGIME SAFETY with the lane keepalive: the checkout a keepalive pins
# (detached at the moving `v1` tag) compares against that SAME tag and
# heals with the SAME `checkout --force <tag>` the keepalive runs — the
# two arms converge instead of flapping. A main-tracking checkout
# fast-forwards its branch (merge --ff-only, never a merge commit).
#
# Expected-ref override: DSH_HARNESS_DRIFT_REF=<branch-or-tag>. The
# wrapper's enable switch is DSH_HARNESS_DRIFT (the wrapper also skips a
# checkout that is neither on its expected branch nor detached at a tag —
# a PR/merge-ref CI checkout — so gates runs no network legs).
#
# Exit codes:
#   stamp:  0 written/refreshed · 2 usage/not a checkout · 4 HEAD unresolvable
#   check:  0 fresh · 1 drift (differing tip) · 2 usage/not a checkout
#           · 4 unknown (no remote / unresolvable ref / network fail)
#   heal:   0 fresh, healed, or skipped (bare detached HEAD — no own
#             identity; DSH_HARNESS_DRIFT_REF forces it)
#           · 2 usage/not a checkout · 3 refused (dirty / working branch /
#             not-fast-forward / lock busy) · 4 degraded (fetch failed)
#   The LAST stdout line of every outcome is `verdict=<token>`:
#   fresh | drift | healed | refused-dirty | refused-branch |
#   refused-not-fast-forward | refused-lock | diverged | ahead |
#   degraded | skipped-no-remote | skipped-detached | off
#
# Usage: harness-drift.sh <stamp|check|heal> [checkout-dir]
#        (dir defaults to this script's parent checkout)

set -uo pipefail

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CMD="${1:-}"
DIR="${2:-$(cd "$SELF_DIR/.." && pwd)}"
STAMP_REL="scripts/HARNESS_DEPLOYED_SHA"
STAMP_FILE="$DIR/$STAMP_REL"
LOCK_DIR="$DIR/.git/harness-drift.lock"
LOCK_STALE_S=600

# Every git call: explicit safe.directory (the Actions runner's per-job
# HOME/gitconfig handling can trip the ownership guard silently — the
# re-pin-toolkit.sh pattern) and no optional index locks (never take the
# index lock under a concurrently working agent). Network legs add curl
# stall bounds so a wedged egress degrades in seconds, not minutes.
G() {
  GIT_OPTIONAL_LOCKS=0 \
  GIT_HTTP_LOW_SPEED_LIMIT="${GIT_HTTP_LOW_SPEED_LIMIT:-1000}" \
  GIT_HTTP_LOW_SPEED_TIME="${GIT_HTTP_LOW_SPEED_TIME:-15}" \
    git -c safe.directory="$DIR" -C "$DIR" "$@"
}

usage() {
  echo "harness-drift: usage: harness-drift.sh <stamp|check|heal> [checkout-dir]" >&2
  exit 2
}

say() { # verdict token + final line — every outcome ends with verdict=
  echo "verdict=$1"
}

[ -n "$CMD" ] || usage
case "$CMD" in stamp|check|heal) ;; *) usage ;; esac
if [ ! -d "$DIR/.git" ]; then
  echo "harness-drift: $DIR is not a git checkout (.git missing)" >&2
  exit 2
fi

iso_now() { date -u +%Y-%m-%dT%H:%M:%SZ; }

write_stamp() { # <sha> <ref> — the STAMP half; best-effort, loud on failure
  local sha="$1" ref="$2" cdate
  cdate="$(G show -s --format=%cI "$sha" 2>/dev/null || true)"
  if [ -z "$cdate" ]; then
    echo "harness-drift: could not read the commit date of $sha — stamp not written" >&2
    return 1
  fi
  { mkdir -p "$(dirname "$STAMP_FILE")" && printf 'sha=%s\nshort=%s\nref=%s\ncommitted_at=%s\nstamped_at=%s\n' \
      "$sha" "$(printf '%s' "$sha" | cut -c1-7)" "$ref" "$cdate" "$(iso_now)" \
      > "$STAMP_FILE"; } 2>/dev/null || {
    echo "harness-drift: could not write $STAMP_REL — stamp skipped" >&2
    return 1
  }
  return 0
}

resolve_expected_ref() { # prints the ref name (charset-guarded)
  local ref="${DSH_HARNESS_DRIFT_REF:-}"
  if [ -z "$ref" ]; then
    local branch tag default_branch
    # The expected ref is the DEPLOY ref — never the incidental branch HEAD
    # sits on (a working branch is a refusal shape, guard 2; comparing a
    # branch against its own upstream would follow arbitrary agent work).
    branch="$(G symbolic-ref -q --short HEAD 2>/dev/null || true)"
    tag=""
    if [ -z "$branch" ]; then
      # the keepalive regime only: a DETACHED pin's tag names its ref (on a
      # branch, HEAD happening to equal a tag does not change the compare)
      tag="$(G describe --tags --exact-match 2>/dev/null | head -n1 || true)"
    fi
    if [ -n "$tag" ]; then
      ref="$tag"
    else
      default_branch="$(G symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null || true)"
      default_branch="${default_branch#origin/}"
      ref="${default_branch:-main}"
    fi
  fi
  case "$ref" in
    *[!A-Za-z0-9._/-]*) echo "harness-drift: refusing unsafe ref '$ref' (charset)" >&2; return 1 ;;
  esac
  [ -n "$ref" ] || return 1
  printf '%s' "$ref"
}

remote_tip() { # <ref> — the commit the remote ref names (peeled for tags)
  local ref="$1" out peeled
  out="$(G ls-remote origin "refs/heads/$ref" "refs/tags/$ref" "refs/tags/$ref^{}" 2>/dev/null || true)"
  [ -n "$out" ] || return 1
  peeled="$(printf '%s\n' "$out" | awk '$1 != "" && $2 ~ /\^\{\}$/ {print $1; exit}')"
  if [ -n "$peeled" ]; then printf '%s' "$peeled"; return 0; fi
  # no peeled entry: a branch, or a lightweight tag whose sha IS the commit
  printf '%s\n' "$out" | awk 'NR==1 {print $1; exit}'
}

case "$CMD" in

# ------------------------------- STAMP --------------------------------------
stamp)
  HEAD_SHA="$(G rev-parse HEAD 2>/dev/null || true)"
  if [ -z "$HEAD_SHA" ]; then
    echo "harness-drift: cannot resolve HEAD in $DIR — stamp not written" >&2
    say degraded
    exit 4
  fi
  REF="$(resolve_expected_ref)" || { say degraded; exit 4; }
  if write_stamp "$HEAD_SHA" "$REF"; then
    echo "harness-drift: stamped $DIR at ${HEAD_SHA:0:7} (ref $REF)"
    say fresh
    exit 0
  fi
  say degraded
  exit 4
  ;;

# ------------------------------- CHECK --------------------------------------
check)
  HEAD_SHA="$(G rev-parse HEAD 2>/dev/null || true)"
  [ -n "$HEAD_SHA" ] || { echo "harness-drift: cannot resolve HEAD in $DIR" >&2; say degraded; exit 4; }
  if ! G remote get-url origin >/dev/null 2>&1; then
    echo "harness-drift: $DIR has no origin remote — compare impossible" >&2
    say skipped-no-remote
    exit 4
  fi
  REF="$(resolve_expected_ref)" || { say degraded; exit 4; }
  TIP="$(remote_tip "$REF")" || {
    echo "harness-drift: could not reach origin or ref '$REF' not found there (compare unknown)" >&2
    say degraded
    exit 4
  }
  if [ "$HEAD_SHA" = "$TIP" ]; then
    echo "harness-drift: $DIR is fresh at ${HEAD_SHA:0:7} (ref $REF)"
    say fresh
    exit 0
  fi
  echo "harness-drift: DRIFT in $DIR — HEAD ${HEAD_SHA:0:7} != origin/$REF ${TIP:0:7}" >&2
  say drift
  exit 1
  ;;

# -------------------------------- HEAL --------------------------------------
heal)
  HEAD_SHA="$(G rev-parse HEAD 2>/dev/null || true)"
  [ -n "$HEAD_SHA" ] || { echo "harness-drift: cannot resolve HEAD in $DIR" >&2; say degraded; exit 4; }
  if ! G remote get-url origin >/dev/null 2>&1; then
    echo "harness-drift: $DIR has no origin remote — nothing to compare against" >&2
    say skipped-no-remote
    exit 4
  fi
  REF="$(resolve_expected_ref)" || { say degraded; exit 4; }
  BRANCH="$(G symbolic-ref -q --short HEAD 2>/dev/null || true)"

  # REGIME GATE — default-on safety. A heal serves a checkout with an OWN
  # identity: on a branch (the clone-once-then-drift shape — the air16
  # receipt) or detached exactly at a tag (the keepalive pin regime). A
  # BARE detached head has no own identity — a PR merge ref on a CI
  # checkout, a manual experiment — and guessing a ref for it would fire
  # network legs from every gates run; it is skipped quietly unless
  # DSH_HARNESS_DRIFT_REF names the ref (or DSH_HARNESS_DRIFT=1 forces).
  if [ -z "$BRANCH" ] && [ -z "${DSH_HARNESS_DRIFT_REF:-}" ] \
     && [ "$(G describe --tags --exact-match 2>/dev/null | head -n1 || true)" = "" ] \
     && [ "${DSH_HARNESS_DRIFT:-}" != "1" ]; then
    echo "harness-drift: $DIR is a bare detached HEAD (no branch, no exact tag) — heal skipped (set DSH_HARNESS_DRIFT_REF to name the expected ref)" >&2
    say skipped-detached
    exit 0
  fi

  # LOCK — serialize against a concurrent boot healing the same checkout.
  lock_taken=0
  if mkdir "$LOCK_DIR" 2>/dev/null; then
    printf 'pid=%s\nat=%s\n' "$$" "$(iso_now)" > "$LOCK_DIR/owner" 2>/dev/null || true
    lock_taken=1
  else
    lock_age=$(( $(date +%s) - $(stat -f %m "$LOCK_DIR" 2>/dev/null || stat -c %Y "$LOCK_DIR" 2>/dev/null || date +%s) ))
    if [ "$lock_age" -ge "$LOCK_STALE_S" ] 2>/dev/null; then
      rm -rf "$LOCK_DIR" 2>/dev/null || true
      if mkdir "$LOCK_DIR" 2>/dev/null; then
        printf 'pid=%s\nat=%s\n' "$$" "$(iso_now)" > "$LOCK_DIR/owner" 2>/dev/null || true
        lock_taken=1
        echo "harness-drift: took over a stale drift lock (${lock_age}s old)" >&2
      fi
    fi
  fi
  if [ "$lock_taken" != "1" ]; then
    echo "harness-drift: REFUSING heal of $DIR — another boot holds the drift lock (fresh); HEAD kept" >&2
    say refused-lock
    exit 3
  fi
  # trap on exit releases the lock for every outcome below
  trap 'rm -rf "$LOCK_DIR" 2>/dev/null || true' EXIT

  # GUARD 1 — tracked modifications (re-pin-toolkit.sh's refusal gate 1).
  if ! G diff-index --quiet HEAD -- >/dev/null 2>&1; then
    echo "harness-drift: REFUSING heal of $DIR — tracked-file modifications present (live work, issue #276 class); HEAD kept. Modified (first lines):" >&2
    G diff-index --name-only HEAD -- 2>/dev/null | head -5 | sed 's/^/    /' >&2
    say refused-dirty
    exit 3
  fi

  # GUARD 2 — a working branch the expected ref does not own.
  if [ -n "$BRANCH" ] && [ "$BRANCH" != "$REF" ]; then
    echo "harness-drift: REFUSING heal of $DIR — HEAD is on branch '$BRANCH', not the expected ref '$REF' (a working branch, issue #276 class); HEAD kept" >&2
    say refused-branch
    exit 3
  fi

  # COMPARE — fetch the expected ref (objects needed for the ancestry
  # proof), degraded-not-fatal. Branch heads fetch by name; detached heads
  # resolve tags first (the keepalive regime — this is the same fetch the
  # keepalive runs) and fall back to a branch fetch when the expected ref
  # is not a tag on origin.
  if [ -n "$BRANCH" ]; then
    G fetch --quiet --force origin "$REF" >/dev/null 2>&1 || {
      echo "harness-drift: fetch of '$REF' failed — keeping the current tree (degraded)" >&2
      say degraded
      exit 4
    }
    TIP="$(G rev-parse -q --verify "refs/remotes/origin/$REF" 2>/dev/null || G rev-parse FETCH_HEAD 2>/dev/null || true)"
  else
    G fetch --quiet --tags --force origin >/dev/null 2>&1 || {
      echo "harness-drift: fetch (tags) failed — keeping the current tree (degraded)" >&2
      say degraded
      exit 4
    }
    TIP="$(G rev-parse -q --verify "refs/tags/$REF^{commit}" 2>/dev/null || true)"
    if [ -z "$TIP" ] && G ls-remote --exit-code origin "refs/heads/$REF" >/dev/null 2>&1; then
      G fetch --quiet --force origin "$REF" >/dev/null 2>&1 \
        && TIP="$(G rev-parse FETCH_HEAD 2>/dev/null || true)"
    fi
  fi
  if [ -z "$TIP" ]; then
    echo "harness-drift: ref '$REF' unresolvable after fetch — keeping the current tree (degraded)" >&2
    say degraded
    exit 4
  fi
  if [ "$HEAD_SHA" = "$TIP" ]; then
    write_stamp "$HEAD_SHA" "$REF" || true
    say fresh
    exit 0
  fi

  # GUARD 3 — only a fast-forward ever moves. A shallow checkout cannot
  # always prove ancestry; ONE --unshallow retry (this repo is
  # scripts-only) buys the proof, then a still-unprovable head refuses.
  ancestor=0
  if G merge-base --is-ancestor "$HEAD_SHA" "$TIP" >/dev/null 2>&1; then
    ancestor=1
  elif [ "$(G rev-parse --is-shallow-repository 2>/dev/null || echo false)" = "true" ]; then
    echo "harness-drift: shallow checkout cannot prove ancestry — one --unshallow retry" >&2
    if G fetch --quiet --unshallow origin >/dev/null 2>&1 \
       && G merge-base --is-ancestor "$HEAD_SHA" "$TIP" >/dev/null 2>&1; then
      ancestor=1
    fi
  fi
  if [ "$ancestor" != "1" ]; then
    if G merge-base --is-ancestor "$TIP" "$HEAD_SHA" >/dev/null 2>&1; then
      echo "harness-drift: REFUSING heal of $DIR — HEAD ${HEAD_SHA:0:7} is AHEAD of origin/$REF ${TIP:0:7} (local commits); never auto-moved" >&2
      say ahead
    else
      echo "harness-drift: REFUSING heal of $DIR — HEAD ${HEAD_SHA:0:7} has DIVERGED from origin/$REF ${TIP:0:7}; never auto-moved" >&2
      say diverged
    fi
    exit 3
  fi

  # MOVE — fast-forward only.
  if [ -n "$BRANCH" ]; then
    if ! G merge --ff-only "$TIP" >/dev/null 2>&1; then
      echo "harness-drift: fast-forward of '$BRANCH' failed — keeping the current tree (degraded)" >&2
      say degraded
      exit 4
    fi
  elif [ "$(G describe --tags --exact-match 2>/dev/null | head -n1 || true)" = "$REF" ]; then
    # keepalive regime: land on the tag name itself, the keepalive's own
    # steady-state command — the two arms converge, never flap.
    if ! G checkout -q --force "$REF" >/dev/null 2>&1; then
      echo "harness-drift: checkout of tag '$REF' failed — keeping the current tree (degraded)" >&2
      say degraded
      exit 4
    fi
  else
    if ! G checkout -q --detach "$TIP" >/dev/null 2>&1; then
      echo "harness-drift: checkout of ${TIP:0:7} failed — keeping the current tree (degraded)" >&2
      say degraded
      exit 4
    fi
  fi
  NEW_SHA="$(G rev-parse HEAD 2>/dev/null || printf '%s' "$TIP")"
  write_stamp "$NEW_SHA" "$REF" || true
  echo "harness-drift: self-updated $DIR to ${NEW_SHA:0:7} (ref $REF, was ${HEAD_SHA:0:7})"
  say healed
  exit 0
  ;;
esac
