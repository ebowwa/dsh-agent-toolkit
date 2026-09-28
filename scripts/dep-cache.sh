#!/usr/bin/env bash
# dep-cache.sh — per-repo node_modules cache keyed on the lockfile hash.
#
# Claim checkouts (worktrees from the shared store) ship without
# node_modules, so every claim paid a full install before any work started
# (issue #189, transcript-audit finding 2026-09-28). This script closes
# that tax:
#
#   scripts/dep-cache.sh key <checkout>      print the cache key (lockfile
#                                            hash) — testable, no I/O side
#                                            effects beyond reading
#   scripts/dep-cache.sh restore <checkout>  restore node_modules from the
#                                            cache; on a miss, run the
#                                            package manager install and
#                                            populate the cache
#
# The cache key is sha256 over each supported lockfile present at the
# checkout root (bun.lock, bun.lockb, package-lock.json, pnpm-lock.yaml,
# yarn.lock), sorted by filename — so any lockfile change invalidates the
# entry and any identical lockfile reuses it. Restore prefers `cp -al`
# (hardlinks: near-zero disk, instant) and falls back to `cp -a` where
# hardlinks are unsupported.
#
# Cache root: $DSH_DEP_CACHE_DIR (default: ~/.cache/dsh/dep-cache).
# Set DSH_DEP_CACHE=off to disable (restore then does nothing).
# Set DSH_DEP_INSTALL_CMD to override the install command (default: bun
# install --frozen-lockfile when bun exists, else npm ci).
#
# restore is BEST-EFFORT by contract: it never fails the claim — on any
# error the claim simply pays the install itself, as it always did.

set -u

CACHE_ROOT="${DSH_DEP_CACHE_DIR:-$HOME/.cache/dsh/dep-cache}"

die() { echo "dep-cache: $*" >&2; exit 2; }

# lockfiles <checkout> — newline-separated paths of supported lockfiles
lockfiles() {
  local dir="$1" f
  for f in bun.lock bun.lockb package-lock.json pnpm-lock.yaml yarn.lock; do
    [ -f "$dir/$f" ] && printf '%s\n' "$f"
  done
}

# key <checkout> — sha256 over the sorted lockfile names + contents
cmd_key() {
  local dir="$1" found="" f
  for f in $(lockfiles "$dir"); do
    found="$found $f"
  done
  [ -n "$found" ] || die "no supported lockfile in $dir"
  # hash in a stable order; note WHICH lockfiles feed the key so two
  # different lockfile sets can never collide on one entry
  for f in $(lockfiles "$dir" | sort); do
    printf '%s:%s\n' "$f" "$(sha256sum < "$dir/$f" | cut -d' ' -f1)"
  done | sha256sum | cut -d' ' -f1
}

# materialize <src> <dst> — copy node_modules into place (hardlink first)
materialize() {
  local src="$1" dst="$2"
  rm -rf "$dst"
  if cp -al "$src" "$dst" 2>/dev/null; then
    return 0
  fi
  cp -a "$src" "$dst"
}

cmd_restore() {
  local dir="$1" key entry t0
  [ "${DSH_DEP_CACHE:-on}" = "off" ] && { echo "dep-cache: disabled (DSH_DEP_CACHE=off)"; return 0; }
  [ -f "$dir/package.json" ] || { echo "dep-cache: no package.json in $dir — nothing to do"; return 0; }
  key="$(cmd_key "$dir")" || return 0   # no lockfile: nothing to key on
  entry="$CACHE_ROOT/$key/node_modules"
  mkdir -p "$CACHE_ROOT/$key"

  if [ -d "$entry" ] && [ -n "$(ls -A "$entry" 2>/dev/null)" ]; then
    t0=$(date +%s%N 2>/dev/null || date +%s)
    if materialize "$entry" "$dir/node_modules"; then
      echo "dep-cache: cache HIT ($key) — node_modules restored into $dir"
      return 0
    fi
    echo "dep-cache: cache hit but restore failed — falling through to install" >&2
  fi

  # MISS (or dead entry): install in the checkout, then populate the cache
  echo "dep-cache: cache MISS ($key) — running the install"
  local cmd=()
  if [ -n "${DSH_DEP_INSTALL_CMD:-}" ]; then
    # shellcheck disable=SC2206 — words are intended
    cmd=($DSH_DEP_INSTALL_CMD)
  elif command -v bun >/dev/null 2>&1; then
    cmd=(bun install --frozen-lockfile)
  else
    cmd=(npm ci)
  fi
  t0=$(date +%s%N 2>/dev/null || date +%s)
  (cd "$dir" && "${cmd[@]}") || { echo "dep-cache: install failed — leaving it to the claim" >&2; return 0; }
  if [ -d "$dir/node_modules" ]; then
    rm -rf "$entry"
    cp -a "$dir/node_modules" "$entry" \
      || echo "dep-cache: cache populate failed (install still succeeded)" >&2
  fi
  echo "dep-cache: cache WARMED ($key)"
  return 0
}

case "${1:-}" in
  key)     [ $# -eq 2 ] || die "usage: dep-cache.sh key <checkout>"; cmd_key "$2" ;;
  restore) [ $# -eq 2 ] || die "usage: dep-cache.sh restore <checkout>"; cmd_restore "$2" ;;
  *) die "usage: dep-cache.sh {key|restore} <checkout-dir>" ;;
esac
