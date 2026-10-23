#!/usr/bin/env bash
# carrier-census.sh — the open-PR carrier census at claim time (issue #549).
#
# The receipt (issue #549): 25 identical `/dsh` triggers landed on #398
# while its fix sat in an open, green, mergeable carrier PR (#495), and
# every trigger still minted a full agent round. The #414 carrier dedup is
# agent-side PROSE — a claim preamble the agent is told to follow — nothing
# on the MACHINE enqueue/claim path ever asks "does an open carrier PR
# already hold this issue?". This script is that machine half: ONE census
# the worker runs at claim time (scripts/dsh-worker.sh, right after the
# queued-label claim), so the decision no longer depends on the agent
# choosing to look.
#
# Usage:
#   carrier-census.sh <owner/repo> <issue-number>
#
# Prints ONE JSON line on stdout:
#   {"verdict":"green|red|pending|none|unresolved",
#    "carrier":<pr-number|null>,"head":"<head-sha|","reason":"..."}
#
# Semantics (pinned by tests/carrier-census.test.mjs):
#   green      an open PR references the issue (the `#N` token in its title
#              or body) and its head SHA is graded green by the SAME rollup
#              merge-guard applies — >=1 completed+success check run on the
#              head and no red conclusion (failure/cancelled/timed_out/
#              action_required/startup_failure/stale) on it. The worker
#              stand-downs: the mint degrades to a typed no-op naming the
#              carrier — no agent round.
#   red        an open carrier exists and its head carries a red check run.
#              The worker still MINTS — the census must not mask a broken
#              carrier — but the task names the carrier.
#   pending    an open carrier exists but nothing grades its head green or
#              red yet (checks queued/in-progress, or no checks at all).
#              Mint, carrier named: an in-flight carrier is not a green one.
#   none       no open PR references the issue. Mint plain.
#   unresolved the census itself failed (gh missing, API error, unparseable
#              answer). Mint plain (or with the carrier named when one was
#              seen before the failure). FAIL-OPEN BY CONTRACT: a broken
#              census must never eat a task. This is merge-guard's law run
#              in reverse — the guard refuses a merge fail-closed because
#              landing unreviewed code is the unacceptable direction; here
#              a swallowed task is the unacceptable direction, so the
#              census never blocks a mint, it only ever shapes one.
#
# Multiple carriers (the #414 receipt: one ticket carried up to 8 open
# PRs): the LOWEST number is named — the oldest carrier is the canonical
# one a stand-down should point at.
#
# Exit: 0 whenever a verdict was produced (every verdict above); 2 only on
# a usage error (missing/unnumbered arguments).

set -uo pipefail

REPO="${1:-}"
NUM="${2:-}"
if [ -z "$REPO" ] || [ -z "$NUM" ] || ! printf '%s' "$NUM" | grep -qE '^[0-9]+$'; then
  echo "usage: carrier-census.sh <owner/repo> <issue-number>" >&2
  exit 2
fi

# emit <verdict> <carrier|null> <head> <reason> — one JSON line, exit 0.
# The reason is prose from check-run names: quotes/backslashes are stripped
# so the line always parses.
emit() {
  local verdict="$1" carrier="$2" head="$3" reason="$4"
  reason="$(printf '%s' "$reason" | tr -d '"\\' | tr '\n' ' ' | cut -c1-240)"
  printf '{"verdict":"%s","carrier":%s,"head":"%s","reason":"%s"}\n' \
    "$verdict" "$carrier" "$head" "$reason"
  exit 0
}

command -v gh >/dev/null 2>&1 \
  || emit unresolved null "" "gh not found — census unresolvable, mint"

# 1. The carrier scan: open PRs whose title or body carries the `#N` token.
PRS="$(gh pr list --repo "$REPO" --state open --limit 200 \
        --json number,title,body,headRefOid 2>/dev/null)" \
  || emit unresolved null "" "pr list failed — census unresolvable, mint"

# 2. Pick the carrier: lowest open PR number whose title/body references
#    the issue. `(#[0-9]+)` token match — `#4050` never matches issue 405.
CARRIER_JSON="$(printf '%s' "$PRS" | NUM="$NUM" node -e '
let s = "";
process.stdin.on("data", (d) => (s += d)).on("end", () => {
  const num = process.env.NUM;
  // an issue ref: " #" + num not followed by a digit (and not preceded by
  // a word char — "#405" inside "x#405" is not a GitHub autolink)
  const re = new RegExp("(^|[^0-9A-Za-z_])#" + num + "(?![0-9])");
  let best = null;
  try {
    for (const pr of JSON.parse(s)) {
      const hay = (pr.title || "") + "\n" + (pr.body || "");
      if (!re.test(hay)) continue;
      if (best === null || pr.number < best.number) best = pr;
    }
  } catch { console.log("UNPARSEABLE"); return; }
  console.log(best === null ? "NONE" : JSON.stringify({
    number: best.number, head: best.headRefOid || "",
  }));
});')" || CARRIER_JSON=""
case "$CARRIER_JSON" in
  ""|NONE)        emit none null "" "no open PR references #$NUM — nothing carried" ;;
  UNPARSEABLE)    emit unresolved null "" "pr list output unparseable — census unresolvable, mint" ;;
esac
CARRIER_NUM="$(printf '%s' "$CARRIER_JSON" | node -e 'process.stdout.write(String(JSON.parse(require("fs").readFileSync(0,"utf8")).number ?? ""))' 2>/dev/null || true)"
CARRIER_SHA="$(printf '%s' "$CARRIER_JSON" | node -e 'process.stdout.write(String(JSON.parse(require("fs").readFileSync(0,"utf8")).head ?? ""))' 2>/dev/null || true)"
[ -n "$CARRIER_NUM" ] || emit unresolved null "" "carrier scan produced an unusable shape — census unresolvable, mint"

# 3. Grade the carrier head: the merge-guard rollup (issue #434 semantics),
#    read-only. Any red conclusion on the head = red; >=1 completed+success
#    and no red = green; otherwise (queued/in-progress/no checks) = pending.
RUNS="$(gh api "repos/$REPO/commits/$CARRIER_SHA/check-runs" 2>/dev/null)" \
  || emit unresolved "$CARRIER_NUM" "$CARRIER_SHA" "check-runs API failed for carrier #$CARRIER_NUM — census unresolvable, mint (carrier named)"

VERDICT="$(printf '%s' "$RUNS" | node -e '
let s = "";
process.stdin.on("data", (d) => (s += d)).on("end", () => {
  const RED = new Set(["failure", "cancelled", "timed_out", "action_required", "startup_failure", "stale"]);
  let runs;
  try { runs = JSON.parse(s).check_runs || []; } catch { console.log("UNPARSEABLE"); return; }
  const reds   = runs.filter((r) => RED.has(r.conclusion));
  const greens = runs.filter((r) => r.status === "completed" && r.conclusion === "success");
  const detail = runs.map((r) => (r.name || "?") + "=" + (r.status || "?") + "/" + (r.conclusion || "none")).join(", ") || "no check runs graded this head";
  if (reds.length)   { console.log("red " + detail); return; }
  if (greens.length) { console.log("green " + greens.map((r) => r.name).join(",")); return; }
  console.log("pending " + detail);
});')" || VERDICT=""

case "$VERDICT" in
  red*)    emit red "$CARRIER_NUM" "$CARRIER_SHA" "carrier #$CARRIER_NUM head is RED (${VERDICT#red })" ;;
  green*)  emit green "$CARRIER_NUM" "$CARRIER_SHA" "carrier #$CARRIER_NUM head is green (${VERDICT#green })" ;;
  pending*) emit pending "$CARRIER_NUM" "$CARRIER_SHA" "carrier #$CARRIER_NUM head is not graded yet (${VERDICT#pending })" ;;
  *)       emit unresolved "$CARRIER_NUM" "$CARRIER_SHA" "check-runs output unparseable — census unresolvable, mint (carrier named)" ;;
esac
