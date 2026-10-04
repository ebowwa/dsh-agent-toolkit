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
# Platform-skip audit (issue #190): bun — the default install command here
# — silently OMITS a platform-mismatched MANDATORY dep (zero exit, no
# warning) where npm hard-errors (`notsup Unsupported platform`). A green
# install therefore proves nothing about platform coverage: the tree is
# silently incomplete and the failure only surfaces later as a runtime
# missing-binary. After every restore that materialized node_modules
# (cache HIT or fresh install), the mandatory direct deps (dependencies +
# devDependencies, minus optionalDependencies) are compared against the
# tree and every absent one is named in a WARNING. The audit is
# best-effort like restore itself: warnings never fail the claim.
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

# audit_platform_skips <checkout> — name every mandatory direct dep the
# install silently omitted (the bun-vs-npm divergence, issue #190). npm
# refuses a platform-mismatched mandatory dep (`notsup Unsupported
# platform`); bun omits it with exit 0 and no output. Best-effort: any
# doubt (no package.json, no tree, no node binary, unparseable JSON)
# exits silently — a diagnostic must never fail a claim.
audit_platform_skips() {
  local dir="$1"
  [ -f "$dir/package.json" ] || return 0
  [ -d "$dir/node_modules" ] || return 0
  command -v node >/dev/null 2>&1 || return 0
  node -e '
const fs = require("fs");
const path = require("path");
const dir = process.argv[1];
let pkg;
try { pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")); }
catch { process.exit(0); }
// optionalDependencies mark a dep platform-gated BY CONTRACT — npm and
// bun both legally skip those. Only their absence from the MANDATORY
// sets is the silent-skip signature.
const optional = new Set(Object.keys(pkg.optionalDependencies || {}));
const mandatory = new Map();
for (const sec of ["dependencies", "devDependencies"])
  for (const [name, spec] of Object.entries(pkg[sec] || {}))
    if (!optional.has(name)) mandatory.set(name, spec);
const missing = [...mandatory.keys()].filter((n) =>
  !fs.existsSync(path.join(dir, "node_modules", ...n.split("/"))));
for (const n of missing)
  console.log("dep-cache: WARNING (issue #190): mandatory dep " + n + "@" +
    mandatory.get(n) + " is ABSENT from node_modules after a zero-exit install" +
    " — bun silently omits platform-mismatched deps where npm hard-errors" +
    " (notsup); the tree is incomplete and this surfaces as a runtime" +
    " missing-binary. Cross-platform leg: DSH_DEP_INSTALL_CMD=\"npm ci\"" +
    " restores the loud install-time failure, or mark the dep optional.");
if (missing.length)
  console.log("dep-cache: " + missing.length +
    " mandatory dep(s) silently skipped by the install — audited per" +
    " issue #190 (best-effort: NOT failing the claim)");
' "$dir"
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
      # a hit restores the tree the cache was warmed with — audit it too,
      # so a poisoned entry cannot keep replaying a silently-incomplete
      # tree across claims (issue #190)
      audit_platform_skips "$dir"
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
  # a zero-exit install is NOT proof of coverage (issue #190): bun exits 0
  # while omitting platform-mismatched mandatory deps — name them
  audit_platform_skips "$dir"
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
