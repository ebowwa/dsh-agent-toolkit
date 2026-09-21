#!/usr/bin/env bash
# sync-lane-plugins.sh — materialize the CANONICAL per-box sources declared
# in config/lane-plugins.json. Idempotent, bash-3.2-safe, quiet when fresh.
#
# Division of labor (the delegation system):
#   THIS script (keepalive-side): external repos -> the per-box canonical
#     location (~/.dsh/... by default), at the manifest's PINNED ref. Runs
#     right after the v1 tag checkout, so pins advance on tag bump.
#   lane-plugins-consult.py (spawn-side): reads the same manifest, gates by
#     platform/node/probe, and mounts per-job via the runner's seams.
# Nothing here mounts anything into a lane home; nothing there clones.
#
# Usage: sync-lane-plugins.sh [--verify]
#   --verify  check state only (exit 1 if stale/missing), change nothing
# Exit: 0 ok · 1 stale/failed (keepalives run this with `|| true` — loud,
#       never blocking).
set -uo pipefail
TK_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MANIFEST="$TK_ROOT/config/lane-plugins.json"
VERIFY=0
[ "${1:-}" = "--verify" ] && VERIFY=1

command -v python3 >/dev/null 2>&1 || { echo "sync-lane-plugins: python3 required" >&2; exit 1; }
[ -f "$MANIFEST" ] || { echo "sync-lane-plugins: manifest missing ($MANIFEST)" >&2; exit 1; }

FAIL=0
# every external source in EVERY platform set (canonical copies are
# platform-independent materializations; the consult gates by platform)
while IFS="$(printf '\t')" read -r SRC_REPO SRC_PATH SRC_REF DEST; do
  [ -n "${SRC_REPO:-}" ] || continue
  DEST="${DEST/#\~/$HOME}"
  CACHE="$HOME/.dsh-plugin-cache/${SRC_REPO//\//__}"

  if [ "$VERIFY" = "1" ]; then
    if [ ! -f "$DEST/package.json" ]; then
      echo "sync-lane-plugins: VERIFY FAIL — $DEST missing (run without --verify to materialize)" >&2; FAIL=1
    elif [ -d "$CACHE/.git" ] && ! git -C "$CACHE" diff --quiet "$SRC_REF" -- "$SRC_PATH" >/dev/null 2>&1 && [ "$(git -C "$CACHE" rev-parse HEAD 2>/dev/null)" != "$(git -C "$CACHE" rev-parse "$SRC_REF" 2>/dev/null)" ]; then
      echo "sync-lane-plugins: VERIFY NOTE — cache not at $SRC_REF (materializing refreshes it)" >&2
    fi
    continue
  fi

  if [ ! -d "$CACHE/.git" ]; then
    git clone -q "https://github.com/$SRC_REPO.git" "$CACHE" 2>/dev/null \
      || { echo "sync-lane-plugins: clone $SRC_REPO failed" >&2; FAIL=1; continue; }
  fi
  git -C "$CACHE" fetch -q --force 2>/dev/null || true
  git -C "$CACHE" checkout -q --force "$SRC_REF" 2>/dev/null \
    || { echo "sync-lane-plugins: checkout $SRC_REPO@${SRC_REF:0:8} failed" >&2; FAIL=1; continue; }
  [ -d "$CACHE/$SRC_PATH" ] \
    || { echo "sync-lane-plugins: $SRC_PATH missing in $SRC_REPO@${SRC_REF:0:8}" >&2; FAIL=1; continue; }

  if [ -d "$DEST" ] && diff -r "$CACHE/$SRC_PATH" "$DEST" >/dev/null 2>&1; then
    : # fresh — quiet
  else
    rm -rf "$DEST"
    mkdir -p "$(dirname "$DEST")"
    cp -R "$CACHE/$SRC_PATH" "$DEST" \
      && echo "sync-lane-plugins: $DEST <- $SRC_REPO@${SRC_REF:0:8}" \
      || { echo "sync-lane-plugins: copy to $DEST failed" >&2; FAIL=1; }
  fi
done < <(python3 - "$MANIFEST" <<'PYEOF'
import json, sys
m = json.load(open(sys.argv[1]))
for platform, entries in m.items():
    if platform.startswith("_"):
        continue
    for e in entries if isinstance(entries, list) else []:
        s = e.get("source", {})
        if s.get("repo"):
            print("\t".join((s["repo"], s.get("path", ""), s.get("ref", ""), e.get("canonical_dest", ""))))
PYEOF
)

[ "$FAIL" = "0" ] || exit 1
exit 0
