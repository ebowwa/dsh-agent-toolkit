#!/usr/bin/env bash
# claim-workdir.sh — mint and hold a per-claim workdir (issue #374).
#
# The #333/#374 collision class: concurrent same-box agents working the
# SAME issue mint "unique" workdirs whose entire uniqueness budget is the
# issue number plus one second of epoch
# (`work-<issue>-<repo>-$(date +%s)`), or worse, reuse an existing
# matching dir (`ls -d work-<issue>-* | head -1`). A same-second sibling
# or a glob-reuser lands INSIDE a live tree and silently replaces the
# first agent's confirmed edits — observed live 2026-10-04 (issue #374:
# both files' mtimes restamped after the owner's edits, the owner's test
# block gone, a foreign implementation in place; the concurrent-mint
# multiplier is factory#869).
#
# This helper makes the correct habit a one-liner:
#
#   scripts/claim-workdir.sh mint <parent> <slug> <owner-token>
#       mktemp-mint <parent>/work-<slug>-XXXXXX (a RANDOM suffix — never
#       a bare epoch), stamp the ownership marker .dsh-owner with
#       <owner-token>, print the path on stdout.
#   scripts/claim-workdir.sh assert <dir> <owner-token>
#       exit 0 only when <dir> carries THIS session's marker. Dies loud
#       on a foreign marker (your tree was taken over — or you are the
#       takeover), on a missing marker over a non-empty tree (a tree you
#       did not mint is not yours), and on a missing dir. Adopts (stamps)
#       a marker-less EMPTY dir only.
#
# The owner token is caller-supplied so it survives across shells — a
# fleet session spans many fresh shells, and claim identity is NOT
# unique on this fleet (two siblings share the issue number; that is the
# bug), so the token must carry something a sibling cannot guess. Mint
# one token per session, e.g.:
#     owner="${DSH_FACE_ID:-agent-$$-$(date +%s)-$RANDOM}"
# and pass the SAME value to every assert. A token is REQUIRED and must
# be non-empty.
#
# Pinned by tests/workdir-ownership-contract.test.mjs (behavioral stamp,
# structural placement, and these executable semantics).

set -u

MARKER_NAME=".dsh-owner"

die() { echo "claim-workdir: $*" >&2; exit 2; }

usage() {
  cat >&2 <<'EOF'
usage:
  claim-workdir.sh mint <parent-dir> <slug> <owner-token>
  claim-workdir.sh assert <dir> <owner-token>
EOF
  exit 2
}

[ "$#" -ge 1 ] || usage

case "$1" in
  mint)
    [ "$#" -eq 4 ] || usage
    parent="$2" slug="$3" owner="$4"
    [ -d "$parent" ] || die "mint: parent dir does not exist: $parent"
    case "$slug" in
      */*|.*|'') die "mint: slug must be a plain, path-free, dot-free name — got: $slug" ;;
    esac
    [ -n "$owner" ] || die "mint: owner token must be non-empty — claim identity is not unique on this fleet (issue #374); the token is the only ownership proof"
    dir="$(mktemp -d "$parent/work-${slug}-XXXXXX")" \
      || die "mint: mktemp failed under $parent"
    printf '%s\n' "$owner" > "$dir/$MARKER_NAME" \
      || die "mint: stamped workdir $dir but cannot write the $MARKER_NAME marker"
    printf '%s\n' "$dir"
    ;;
  assert)
    [ "$#" -eq 3 ] || usage
    dir="$2" owner="$3"
    [ -n "$owner" ] || die "assert: owner token must be non-empty"
    if [ ! -d "$dir" ]; then
      die "assert: no such workdir: $dir — mint one; a path you did not mint is never yours to enter"
    fi
    marker="$dir/$MARKER_NAME"
    if [ -f "$marker" ]; then
      held="$(cat "$marker" 2>/dev/null || true)"
      [ "$held" = "$owner" ] || die "assert: $dir is NOT yours — its $MARKER_NAME marker holds a foreign owner (a takeover happened in some direction; issue #374). STOP: do not edit this tree; mint a fresh workdir."
      exit 0
    fi
    # No marker: adopt only a provably-empty tree; a non-empty unmarked
    # tree is by definition one this session did not mint.
    if [ -z "$(ls -A "$dir")" ]; then
      printf '%s\n' "$owner" > "$marker" \
        || die "assert: cannot stamp the $MARKER_NAME marker in $dir"
      exit 0
    fi
    die "assert: $dir has no $MARKER_NAME marker and is not empty — a tree you did not mint is not yours (issue #374); mint a fresh workdir"
    ;;
  *)
    usage
    ;;
esac
