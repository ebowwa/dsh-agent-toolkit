#!/usr/bin/env bash
# merge-guard.sh — the merge-time gates guard (issue #434).
#
# The receipt: PR #422 merged at 2026-10-04T12:17:56Z while its `gates` run
# (37201311833) was still QUEUED — it never ran; zero completed CI runs have
# ever graded the head that landed. Branch protection with required status
# checks is the native backstop; this script is the portable guard for the
# actors that merge from a shell (the gh-scrub-shim gates `gh pr merge`
# through it when the driver arms GH_MERGE_GUARD=on).
#
# Semantics (issue #434's explicit requirement): ONE snapshot of the PR's
# check runs, never a poll-until-green loop. The named check counts ONLY
# when it is `completed` + `success` ON THE PR'S HEAD SHA — queued,
# in_progress, cancelled, failure, neutral, skipped, timed_out, stale and
# absent are all NOT green. A stale green (an older run for a previous head,
# or a check graded before the last push) is not green either: the API is
# queried for the exact head SHA and only same-SHA runs match.
#
# The snapshot is PAGED (issue #566): the check-runs endpoint defaults to
# per_page=30 and silently truncates, so grading page 1 alone let a red
# conclusion beyond page 1 pass ANYGREEN. The guard requests per_page=100
# and follows total_count to exhaustion before computing any verdict.
# Paging IS the taking of the one snapshot, not polling: every page serves
# the same single decision, and the guard never re-fetches to look for a
# newer verdict.
#
# The exhaustion arithmetic has a backstop (issue #627): FETCHED sums raw
# per-page lengths, so pages that overlap or shift mid-snapshot (a check
# run deleted/re-run between two page fetches, a proxy re-serving a page)
# can reach total_count while the merged id map holds a strict subset of
# the runs — the verdict therefore compares UNIQUE id count against
# total_count and refuses unresolvable on a shortfall, in the cap's own
# words: refusing rather than grading a truncated rollup.
#
# Usage:
#   merge-guard.sh check [pr-number|url|branch]   exit 0 iff green; refuse 1/2
#   merge-guard.sh merge [gh pr merge args...]    check, then exec gh pr merge
#
# Env contract:
#   MERGE_GUARD_CHECK   the check-run name that gates merges (default
#                       "gates" — this repo's gates.yml job name; the
#                       check-run name is the JOB name, per the rollup
#                       {"name":"gates"} in the #434 receipts).
#                       EXPLICIT vs DEFAULT is the whole contract since
#                       FleetTower issue #1132: consumer repos name their
#                       gates jobs differently (guard-tests,
#                       notebooks-gist-reconcile), so a hardcoded default
#                       refused EVERY merge on EVERY green head of those
#                       repos. An EXPLICIT name is an assertion — it counts
#                       only when a run carries it, never falling back (the
#                       #1132 workaround `GH_MERGE_GUARD_CHECK=<job>` keeps
#                       all guard semantics intact). The DEFAULT is
#                       repo-agnostic: when NO run named 'gates' grades the
#                       head, the guard grades the head by the #434
#                       semantics that actually matter — at least one
#                       completed+success check run ON THE HEAD SHA and no
#                       red conclusion (failure/cancelled/timed_out/
#                       action_required/startup_failure/stale) anywhere on
#                       it passes, loudly naming what graded the head;
#                       reds-present or nothing-green refuses, naming the
#                       explicit-name escape. Wrong-SHA stays refuse in
#                       every path — a stale green is not green (issue
#                       #434).
#   MERGE_GUARD_GH      gh binary to use. The gh-scrub-shim passes the REAL
#                       gh here so the guard can never recurse into the shim
#                       (inside an agent session PATH resolves `gh` to the
#                       shim); default `command -v gh` for standalone use.
#   MERGE_GUARD_VERIFY  OPT-IN (issue #326): when exactly "on", the guard
#                       ALSO requires a passing gate-verify comment on the
#                       PR — the shared-account fleet cannot post approving
#                       reviews ("Review can not approve your own pull
#                       request"), so independent agent verification rides
#                       the gate-verify marker channel, reported by
#                       scripts/pr-verification.mjs. A fail marker or a
#                       silent channel refuses; an unresolvable channel
#                       refuses fail-closed. Default OFF — gates-only, the
#                       #434 semantics unchanged; comment markers can
#                       never block or green-light a merge silently.
#   MERGE_GUARD_VERIFY_TOOL  override path to pr-verification.mjs (default
#                       the sibling script in this scripts/ dir).
#   GH_TOKEN / GH_CONFIG_DIR  pass through to gh, as usual.
#
# Fail-closed (REVIEW.md): every unresolvable state — no gh, PR not
# resolvable, API failure, check absent — REFUSES non-zero with a typed
# reason on stderr. Refusing is the safe direction; a human who truly must
# merge ungated says so explicitly (GH_MERGE_GUARD=off in the shim, or merge
# without the guard) and owns the loudness.

set -uo pipefail

CHECK="${MERGE_GUARD_CHECK:-gates}"
CHECK_EXPLICIT="${MERGE_GUARD_CHECK:+1}"

refuse() { echo "merge-guard: REFUSED — $*" >&2; exit 1; }
unresolvable() { echo "merge-guard: REFUSED (unresolvable) — $*" >&2; exit 2; }

MODE="${1:-}"
[ -n "$MODE" ] && shift
case "$MODE" in
  check) TARGET="${1:-}";;
  merge) TARGET="";;
  *) unresolvable "usage: merge-guard.sh check [pr|url|branch] | merge [gh pr merge args...] — got '${MODE:-<none>}'";;
esac

GH_BIN="${MERGE_GUARD_GH:-}"
[ -n "$GH_BIN" ] || GH_BIN="$(command -v gh 2>/dev/null || true)"
[ -n "$GH_BIN" ] \
  || unresolvable "gh not found — cannot verify the '$CHECK' check; merging without a verified check is the #422 receipt (issue #434)"
[ -x "$GH_BIN" ] \
  || unresolvable "gh at '$GH_BIN' is missing/not executable — refusing rather than merging unverified (issue #434)"

# merge mode: find the PR target in the `gh pr merge` argv — the first
# non-flag element that is not a consumed value (pr merge's value flags are
# --subject/-t, --body/-b, --match-head-commit). No target found is fine:
# gh resolves the current branch, and so do we — unresolvable THERE refuses.
prev=""
if [ "$MODE" = "merge" ]; then
  for a in "$@"; do
    case "$prev" in
      --subject|-t|--body|-b|--match-head-commit) prev="$a"; continue;;
    esac
    case "$a" in
      -*) ;;
      *) [ -z "$TARGET" ] && TARGET="$a";;
    esac
    prev="$a"
  done
fi

PR_JSON="$("$GH_BIN" pr view ${TARGET:+"$TARGET"} --json number,headRefOid,url 2>&1)" \
  || unresolvable "cannot resolve PR ${TARGET:-<current branch>}: $PR_JSON"
PR_NUM="$(printf '%s' "$PR_JSON" | sed -n 's/.*"number":\([0-9][0-9]*\).*/\1/p' | head -n1)"
PR_SHA="$(printf '%s' "$PR_JSON" | grep -o '"headRefOid":"[0-9a-f]*"' | head -n1 | cut -d'"' -f4)"
PR_URL="$(printf '%s' "$PR_JSON" | grep -o '"url":"[^"]*"' | head -n1 | cut -d'"' -f4)"
[ -n "$PR_NUM" ] && [ -n "$PR_SHA" ] && [ -n "$PR_URL" ] \
  || unresolvable "PR ${TARGET:-<current branch>} resolved to an unusable shape (number/sha/url empty): $PR_JSON"
REPO_PATH="$(printf '%s' "$PR_URL" | sed -n 's#https://github.com/\([^/]*\)/\([^/]*\)/pull/.*#\1/\2#p')"
[ -n "$REPO_PATH" ] || unresolvable "cannot parse owner/repo from PR url '$PR_URL'"

# ONE snapshot of the head's check runs — PAGED to exhaustion (issue #566).
# The endpoint defaults to per_page=30 and silently truncates; the guard
# used to grade the rollup from page 1 alone, so a red beyond page 1 passed
# ANYGREEN. Request per_page=100 and follow total_count, bounded at 20
# pages (2000 runs — beyond real heads, and a cap that REFUSES rather than
# grades a truncated rollup). Each page must parse with a runs array and a
# total_count, or the whole snapshot is unusable (fail-closed, UNPARSEABLE).
PAGE_SEP=$'\001'   # raw 0x01 never occurs in valid JSON text — the page delimiter
RUNS_PAGES=""
FETCHED=0
TOTAL=""
SNAPSHOT_BROKEN=""
for PAGE in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do
  PAGE_JSON="$("$GH_BIN" api "repos/$REPO_PATH/commits/$PR_SHA/check-runs?page=$PAGE&per_page=100" 2>&1)" \
    || unresolvable "check-runs API failed for $REPO_PATH@${PR_SHA:0:7} (page $PAGE):$PAGE_JSON"
  PAGE_FACTS="$(printf '%s' "$PAGE_JSON" | node -e '
let s = "";
process.stdin.on("data", (d) => (s += d)).on("end", () => {
  try {
    const j = JSON.parse(s);
    if (!Array.isArray(j.check_runs) || !Number.isFinite(j.total_count)) { console.log("MALFORMED"); return; }
    console.log("OK " + j.total_count + " " + j.check_runs.length);
  } catch { console.log("MALFORMED"); }
});')"
  case "$PAGE_FACTS" in
    "OK "*) ;;
    *) SNAPSHOT_BROKEN=1; break;;
  esac
  TOTAL="${PAGE_FACTS#OK }"; TOTAL="${TOTAL%% *}"
  PAGE_N="${PAGE_FACTS##* }"
  RUNS_PAGES="${RUNS_PAGES}${PAGE_SEP}${PAGE_JSON}"
  FETCHED=$((FETCHED + PAGE_N))
  [ "$FETCHED" -ge "$TOTAL" ] && break
  [ "$PAGE_N" -eq 0 ] \
    && unresolvable "check-runs pagination for $REPO_PATH@${PR_SHA:0:7} stopped short (total_count=$TOTAL, fetched=$FETCHED, page $PAGE empty) — refusing rather than grading a truncated rollup (issue #566)"
done

if [ -n "$SNAPSHOT_BROKEN" ]; then
  VERDICT="UNPARSEABLE"
elif [ -n "$TOTAL" ] && [ "$FETCHED" -lt "$TOTAL" ]; then
  unresolvable "check-runs pagination for $REPO_PATH@${PR_SHA:0:7} hit the 20-page cap at $FETCHED of total_count=$TOTAL runs — refusing rather than grading a truncated rollup (issue #566)"
else
# ONE decision from the merged pages, filtered to (check name == head SHA)
# pairs; the highest id wins if the check was re-run on this head (latest
# attempt is the truth). Pages may straddle a run mid-paging — the id map
# gives each run exactly one vote.
# FleetTower issue #1132: when NO run carries the default name, the verdict
# falls back to the head-wide rollup grade (see the env contract above); an
# EXPLICIT name never falls back.
VERDICT="$(printf '%s' "$RUNS_PAGES" | MERGE_GUARD_TOTAL="$TOTAL" MERGE_GUARD_CHECK="$CHECK" MERGE_GUARD_SHA="$PR_SHA" MERGE_GUARD_EXPLICIT="$CHECK_EXPLICIT" node -e '
let s = "";
process.stdin.on("data", (d) => (s += d)).on("end", () => {
  let all;
  try {
    all = s.split("\u0001").filter((p) => p.trim().length).map((p) => {
      const j = JSON.parse(p);
      if (!Array.isArray(j.check_runs)) throw new Error("page without check_runs");
      return j.check_runs;
    }).flat();
  } catch { console.log("UNPARSEABLE"); return; }
  const byId = new Map();
  for (const r of all) byId.set(r.id, r);
  // issue #627: FETCHED counts raw page entries; only the UNIQUE count of
  // the id map can prove the snapshot covered total_count. A shortfall
  // means the pages overlapped or shifted mid-snapshot (a run deleted or
  // re-run between fetches, a proxy re-serving a page) — grade nothing.
  const claimed = Number(process.env.MERGE_GUARD_TOTAL);
  if (Number.isFinite(claimed) && byId.size < claimed) {
    console.log("TRUNCATED unique=" + byId.size + " claimed=" + claimed);
    return;
  }
  const runs = [...byId.values()].filter(
    (r) => r.head_sha === process.env.MERGE_GUARD_SHA,
  );
  const named = runs.filter((r) => r.name === process.env.MERGE_GUARD_CHECK);
  if (named.length) {
    const latest = named.reduce((a, b) => (b.id > a.id ? b : a));
    console.log("NAMED " + (latest.status || "?") + " " + (latest.conclusion || "none"));
    return;
  }
  if (process.env.MERGE_GUARD_EXPLICIT === "1") { console.log("ABSENT"); return; }
  const RED = new Set(["failure", "cancelled", "timed_out", "action_required", "startup_failure", "stale"]);
  const greens = runs.filter((r) => r.status === "completed" && r.conclusion === "success");
  const reds = runs.filter((r) => RED.has(r.conclusion));
  const detail = runs.map((r) => (r.name || "?") + "=" + (r.status || "?") + "/" + (r.conclusion || "none")).join(" ");
  if (greens.length && !reds.length) {
    console.log("ANYGREEN " + greens.map((r) => r.name).join(","));
    return;
  }
  if (reds.length) { console.log("ROLLUPRED " + detail); return; }
  console.log("ABSENT " + detail);
});')"
fi

# Independent verification (issue #326) — OPT-IN via MERGE_GUARD_VERIFY=on.
# Consulted ONLY after the gates check is green: the gate-verify channel is
# a SECOND signal on an already-green head, never a substitute for CI. A
# fail marker or a silent channel refuses (exit 1); an unresolvable
# channel refuses fail-closed (exit 2, the typed reason rides through).
verify_gate() {
  [ "${MERGE_GUARD_VERIFY:-}" = "on" ] || return 0
  local tool out rc
  tool="${MERGE_GUARD_VERIFY_TOOL:-"$(dirname "$0")/pr-verification.mjs"}"
  [ -f "$tool" ] \
    || unresolvable "MERGE_GUARD_VERIFY=on but the verification tool is missing at '$tool' (issue #326)"
  out="$(node "$tool" "$PR_NUM" 2>&1)"
  rc=$?
  case "$rc" in
    0) echo "merge-guard: independent verification GREEN — $out";;
    1) refuse "gate-verify channel on PR #$PR_NUM is NOT pass (${out:-empty}) — a fail marker or a silent channel does not pass the armed verify gate (issue #326)";;
    *) unresolvable "gate-verify channel unresolvable for PR #$PR_NUM: ${out:-<no output>} (issue #326)";;
  esac
}

case "$VERDICT" in
  "NAMED completed success")
    echo "merge-guard: GREEN — '$CHECK' completed/success on PR #$PR_NUM head ${PR_SHA:0:7}"
    verify_gate
    [ "$MODE" = "check" ] && exit 0
    exec "$GH_BIN" pr merge "$@"
    ;;
  ANYGREEN\ *)
    echo "merge-guard: GREEN — no '$CHECK' check run graded head ${PR_SHA:0:7} of PR #$PR_NUM (this repo's gates jobs do not carry the default name — the FleetTower #1132 class), but the head IS graded green by: ${VERDICT#ANYGREEN } — completed/success ON this head SHA, no red on it (issue #434 semantics)"
    verify_gate
    [ "$MODE" = "check" ] && exit 0
    exec "$GH_BIN" pr merge "$@"
    ;;
  ROLLUPRED\ *)
    refuse "no '$CHECK' check run graded head ${PR_SHA:0:7} of PR #$PR_NUM and the head carries red check run(s): ${VERDICT#ROLLUPRED } — a red head is not a green one (the #784 class); if the red job is advisory and a green sibling is the real gate, assert it explicitly with MERGE_GUARD_CHECK=<green job> — an explicit name never falls back (FleetTower issue #1132)";;
  TRUNCATED\ *)
    unresolvable "check-runs snapshot for PR #$PR_NUM head ${PR_SHA:0:7} covered only ${VERDICT#TRUNCATED } — pages overlapped or shifted mid-snapshot and FETCHED arithmetic reached total_count over a strict subset of runs; refusing rather than grading a truncated rollup (issue #627)";;
  UNPARSEABLE)
    unresolvable "check-runs response for PR #$PR_NUM head ${PR_SHA:0:7} did not parse — refusing rather than trusting an unreadable rollup (issue #434)";;
  NAMED\ *)
    refuse "'$CHECK' on PR #$PR_NUM head ${PR_SHA:0:7} is {status=$(printf '%s' "$VERDICT" | cut -d' ' -f2) conclusion=$(printf '%s' "$VERDICT" | cut -d' ' -f3)} — queued/in-progress/cancelled/failed/absent are NOT green (issue #434); the guard takes ONE snapshot and does NOT poll until green";;
  ABSENT*)
    ABSENT_DETAIL="${VERDICT#ABSENT}"
    refuse "no '$CHECK' check run graded head ${PR_SHA:0:7} of PR #$PR_NUM and no other check graded it green either${ABSENT_DETAIL:+ [${ABSENT_DETAIL}]} — the workflow never ran green on this head; landing it is exactly the #422 receipt (issue #434)";;
  *)
    unresolvable "verdict '$VERDICT' is not a shape this guard knows — refusing rather than guessing (issue #434)";;
esac
