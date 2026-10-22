// approved-lane.test.mjs — contract pins for scripts/approved-lane.mjs
// (issue #643).
//
// The guard answers ONE question for retire/sweep/custody passes: does
// this PR carry landing-pending approved work (a passing merge-guard
// gates check ON its head SHA, and/or a final APPROVE verdict on its
// review channels) that has not landed on main? The receipts that earned
// it: PRs #495/#544 — APPROVE·MERGE verdict + gates green on the head,
// stale-closed unmerged, heads reaped, reviewed work with no path back
// to main until #521's agent resurrected the files from refs/pull/495.
//
// Pins, the repo's test-as-contract style:
//   1. The #495 shape — closed-unmerged, gates green on the exact head
//      SHA, a final APPROVE verdict comment → approved, exit 0.
//   2. Line-strict verdicts: "## Verdict: APPROVE" IS a verdict (the
//      decoration strips); "…against REVIEW.md — VERDICT: APPROVE ·
//      MERGE" inside a prose line is NOT (review-verdict.mjs owns the
//      parse; the guard delegates, it never re-implements).
//   3. The issue's "and/or": gates green with a SILENT verdict channel is
//      still approved (a CI-graded head is not an idle lane); a final
//      REQUEST CHANGES vetoes even a green head.
//   4. The native review-vote channel (consumer repos with real
//      reviewers): APPROVED vote → approve; the later of vote/comment
//      signals wins across channels.
//   5. merged (mergedAt set) is its own token, exit 1 — the custody
//      half's "the work IS on main" distinction, never conflated with
//      idle.
//   6. Exit-code contract: 0 approved / 1 idle-or-merged / 2
//      unresolvable fail-closed — a broken gh, an unresolvable PR, a
//      failed comments or reviews API, or an unresolvable gates channel
//      (merge-guard rc 2) is NEVER readable as idle.
//   7. Provenance, not bodies: comment/review text never passes through
//      stdout, plain or --json.
//   8. The gates channel is DELEGATED to merge-guard.sh (one
//      implementation of gates-on-head semantics) with MERGE_GUARD_GH
//      pointed at the same gh — the call is on the stub's log.
//
// Hermetic: a stub gh (APPROVED_LANE_GH seam — the pr-verification
// pattern) serves the PR view, reviews, comments, and merge-guard's
// check-runs pages; no network, no real repo.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, chmodSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TOOL = path.join(ROOT, "scripts", "approved-lane.mjs");
const HEAD = "667a2f78d780ce22f564abd67bca4d6221f1af82"; // the real #495 head

/** One check-run row for merge-guard's paged rollup. */
const checkRun = (name, status, conclusion) => ({
  id: 1, name, status, conclusion, head_sha: HEAD,
});

/**
 * Fixture dir: a stub gh serving pr-view.json, reviews.json, comments.json,
 * and (for merge-guard's delegated read) check-runs.json. Every response
 * is selectable per call shape; `fail` names a response to exit 1 on.
 */
const fixture = (t, {
  pr = {},
  reviews = [],
  comments = [],
  checkRuns = [checkRun("gates", "completed", "success")],
  fail = null,
} = {}) => {
  const dir = mkdtempSync(path.join(tmpdir(), "approved-lane-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(path.join(dir, "pr-view.json"), JSON.stringify({
    number: 495,
    headRefOid: HEAD,
    url: "https://github.com/owner/repo/pull/495",
    state: "CLOSED",
    mergedAt: null,
    ...pr,
  }));
  writeFileSync(path.join(dir, "reviews.json"), JSON.stringify(reviews));
  writeFileSync(path.join(dir, "comments.json"), JSON.stringify(comments));
  writeFileSync(path.join(dir, "check-runs.json"), JSON.stringify({
    total_count: checkRuns.length, check_runs: checkRuns,
  }));
  writeFileSync(path.join(dir, "gh"), `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$AL_STUB_DIR/gh.log"
if [ "$1" = "--version" ]; then echo "stub gh"; exit 0; fi
if [ "$1" = "pr" ] && [ "$2" = "view" ]; then
  [ "$AL_STUB_FAIL" = pr ] && { echo "stub: pr view fails" >&2; exit 1; }
  cat "$AL_STUB_DIR/pr-view.json"
  exit 0
fi
if [ "$1" = "api" ]; then
  case "$*" in
    *pulls/495/reviews*)
      [ "$AL_STUB_FAIL" = reviews ] && { echo "stub: reviews fails" >&2; exit 1; }
      cat "$AL_STUB_DIR/reviews.json"; exit 0 ;;
    *issues/495/comments*)
      [ "$AL_STUB_FAIL" = comments ] && { echo "stub: comments fails" >&2; exit 1; }
      cat "$AL_STUB_DIR/comments.json"; exit 0 ;;
    *check-runs*)
      [ "$AL_STUB_FAIL" = checks ] && { echo "stub: check-runs fails" >&2; exit 1; }
      cat "$AL_STUB_DIR/check-runs.json"; exit 0 ;;
  esac
fi
echo "stub: unexpected call: $*" >&2
exit 64
`);
  chmodSync(path.join(dir, "gh"), 0o755);
  return dir;
};

const comment = (id, login, body, created_at = `2026-10-07T03:22:2${id % 10}Z`) => ({
  id, user: { login }, body, created_at,
  html_url: `https://github.com/owner/repo/pull/495#issuecomment-${id}`,
});

const vote = (id, login, state, submitted_at) => ({
  id, user: { login }, state, submitted_at,
  html_url: `https://github.com/owner/repo/pull/495#pullrequestreview-${id}`,
});

const run = (dir, args = [], env = {}) =>
  spawnSync(process.execPath, [TOOL, "495", ...args], {
    encoding: "utf8",
    env: {
      ...process.env, ...env,
      APPROVED_LANE_GH: path.join(dir, "gh"),
      AL_STUB_DIR: dir,
    },
  });

test("the #495 receipt shape — closed-unmerged, gates green on the head, final APPROVE verdict comment → approved, exit 0", (t) => {
  const dir = fixture(t, {
    comments: [
      comment(1, "tower", "## Review of PR #495 head `667a2f7` against REVIEW.md — VERDICT: APPROVE · **MERGE**\n\nBlocking findings: **none.**\n"),
      comment(2, "worker", "The review, re-derived from git ground truth.\n\n## Verdict: APPROVE\n"),
    ],
  });
  const r = run(dir);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^approved pr#495 gates=green verdict=approve\n$/);
});

test("a prose-embedded VERDICT line is NOT a verdict (line-strict) — a comment carrying only prose stays verdict=none", (t) => {
  const dir = fixture(t, {
    comments: [comment(1, "tower", "## Review of PR #495 against REVIEW.md — VERDICT: APPROVE · **MERGE**\n")],
  });
  // gates green + silent verdict channel = still approved per the issue's
  // and/or — but the verdict WORD must report none, not approve.
  const r = run(dir);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /^approved pr#495 gates=green verdict=none\n$/);
});

test("gates green with a silent verdict channel is approved (the issue's and/or — a CI-graded head is not an idle lane)", (t) => {
  const dir = fixture(t, { comments: [], reviews: [] });
  const r = run(dir);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /^approved pr#495 gates=green verdict=none\n$/);
});

test("a final REQUEST CHANGES verdict vetoes even a green head → idle, exit 1", (t) => {
  const dir = fixture(t, {
    comments: [
      comment(1, "worker", "## Verdict: APPROVE\n"),
      comment(2, "worker", "Reopened one blocking finding.\n\n## Verdict: REQUEST CHANGES\n"),
    ],
  });
  const r = run(dir);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /^idle pr#495 gates=green verdict=request-changes\n$/);
});

test("gates not-green and no verdict anywhere → idle, exit 1", (t) => {
  const dir = fixture(t, {
    checkRuns: [checkRun("gates", "completed", "failure")],
    comments: [], reviews: [],
  });
  const r = run(dir);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /^idle pr#495 gates=not-green verdict=none\n$/);
});

test("the native review-vote channel: an APPROVED vote is an approve signal (consumer repos with real reviewers)", (t) => {
  const dir = fixture(t, {
    reviews: [vote(10, "human", "APPROVED", "2026-10-05T00:00:00Z")],
    comments: [],
  });
  const r = run(dir);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /^approved pr#495 gates=green verdict=approve\n$/);
  const j = JSON.parse(run(dir, ["--json"]).stdout);
  assert.equal(j.review.source, "review-vote");
  assert.equal(j.review.author, "human");
});

test("across channels the LATER signal wins — an approve vote followed by a later REQUEST CHANGES comment is refused", (t) => {
  const dir = fixture(t, {
    reviews: [vote(10, "human", "APPROVED", "2026-10-05T00:00:00Z")],
    comments: [comment(20, "worker", "Found the blocker on re-read.\n\n## Verdict: REQUEST CHANGES\n", "2026-10-06T00:00:00Z")],
  });
  const r = run(dir);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /^idle pr#495 gates=green verdict=request-changes\n$/);
});

test("a CHANGES_REQUESTED vote that is the latest review word vetoes (reconsidered review)", (t) => {
  const dir = fixture(t, {
    reviews: [
      vote(10, "human", "APPROVED", "2026-10-05T00:00:00Z"),
      vote(11, "human", "CHANGES_REQUESTED", "2026-10-06T00:00:00Z"),
    ],
    comments: [],
  });
  const r = run(dir);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /^idle pr#495 gates=green verdict=request-changes\n$/);
});

test("a COMMENTED review carries no verdict — it never shadows a real signal", (t) => {
  const dir = fixture(t, {
    reviews: [
      vote(10, "human", "APPROVED", "2026-10-05T00:00:00Z"),
      vote(11, "human", "COMMENTED", "2026-10-06T00:00:00Z"),
    ],
    comments: [],
  });
  const r = run(dir);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /^approved pr#495 gates=green verdict=approve\n$/);
});

test("merged (mergedAt set) is its own token, exit 1 — the custody half's \"the work IS on main\" answer", (t) => {
  const dir = fixture(t, {
    pr: { state: "MERGED", mergedAt: "2026-10-07T00:00:00Z" },
    comments: [comment(1, "worker", "## Verdict: APPROVE\n")],
  });
  const r = run(dir);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /^merged pr#495 gates=green verdict=approve\n$/);
  const j = JSON.parse(run(dir, ["--json"]).stdout);
  assert.equal(j.verdict, "merged");
  assert.equal(j.merged, true);
  assert.equal(j.mergedAt, "2026-10-07T00:00:00Z");
});

test("--json is the tooling surface (verdict, head, state, gates receipt, review provenance)", (t) => {
  const dir = fixture(t, {
    comments: [comment(7, "worker", "## Verdict: APPROVE\n", "2026-10-07T03:22:26Z")],
  });
  const j = JSON.parse(run(dir, ["--json"]).stdout);
  assert.equal(j.verdict, "approved");
  assert.equal(j.pr, 495);
  assert.equal(j.head, HEAD);
  assert.equal(j.state, "CLOSED");
  assert.equal(j.merged, false);
  assert.equal(j.gates.green, true);
  assert.match(j.gates.receipt, /merge-guard: GREEN/, "the delegated guard's own typed line is the receipt");
  assert.deepEqual(j.review, {
    verdict: "approve", source: "comment", id: 7, author: "worker",
    url: "https://github.com/owner/repo/pull/495#issuecomment-7",
    at: "2026-10-07T03:22:26Z",
  });
});

test("provenance, not bodies: comment and review text NEVER passes through stdout", (t) => {
  const dir = fixture(t, {
    reviews: [vote(3, "human", "APPROVED", "2026-10-04T00:00:00Z")],
    comments: [comment(4, "worker", "internal host dsh-runner-internal.local receipts\n\n## Verdict: APPROVE\n")],
  });
  const r = run(dir);
  assert.equal(r.status, 0);
  assert.ok(!r.stdout.includes("dsh-runner-internal.local"), "unscrubbed comment text must not leak");
  const j = JSON.parse(run(dir, ["--json"]).stdout);
  assert.ok(!JSON.stringify(j).includes("dsh-runner-internal.local"), "the json surface leaks nothing either");
});

test("unresolvable PR (pr view fails) exits 2, never readable as idle", (t) => {
  const dir = fixture(t, {});
  const r = run(dir, [], { AL_STUB_FAIL: "pr" });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /REFUSED \(unresolvable\)/);
});

test("unresolvable reviews API exits 2 (a broken read is never \"no signal\")", (t) => {
  const dir = fixture(t, {});
  const r = run(dir, [], { AL_STUB_FAIL: "reviews" });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /reviews API failed/);
});

test("unresolvable comments API exits 2", (t) => {
  const dir = fixture(t, {});
  const r = run(dir, [], { AL_STUB_FAIL: "comments" });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /comments API failed/);
});

test("unresolvable gates channel (merge-guard rc 2 — check-runs API failed) exits 2", (t) => {
  const dir = fixture(t, {});
  const r = run(dir, [], { AL_STUB_FAIL: "checks" });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /gates channel unresolvable|REFUSED \(unresolvable\)/);
});

test("missing gh exits 2 (the fail-closed direction — silence is not idle)", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "approved-lane-test-"));
  const r = spawnSync(process.execPath, [TOOL, "495"], {
    encoding: "utf8",
    env: { ...process.env, APPROVED_LANE_GH: path.join(dir, "absent-gh") },
  });
  rmSync(dir, { recursive: true, force: true });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /APPROVED_LANE_GH/);
});

test("a BARE gh name resolves through PATH to an absolute path before the merge-guard handoff (the live-found seam)", (t) => {
  // APPROVED_LANE_GH unset => the tool must resolve `gh` via PATH itself
  // and hand merge-guard an ABSOLUTE path (its [ -x ] check is a
  // filesystem test — a bare name refuses there, found live on the first
  // real run). The stub dir fronts PATH, so "gh" resolves to the stub.
  const dir = fixture(t, { comments: [comment(1, "worker", "## Verdict: APPROVE\n")] });
  const envWithoutSeam = { ...process.env };
  delete envWithoutSeam.APPROVED_LANE_GH;
  const r = spawnSync(process.execPath, [TOOL, "495"], {
    encoding: "utf8",
    env: {
      ...envWithoutSeam,
      AL_STUB_DIR: dir,
      PATH: `${dir}:${process.env.PATH}`,
    },
  });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^approved pr#495 gates=green verdict=approve\n$/);
  // The stub served the calls end-to-end through the resolved path.
  const log = readFileSync(path.join(dir, "gh.log"), "utf8");
  assert.ok(log.length > 0, "the resolved gh served the calls");
});

test("the gates read is DELEGATED to merge-guard.sh through the same gh (one implementation of the semantics)", (t) => {
  const dir = fixture(t, { comments: [] });
  run(dir);
  const log = readFileSync(path.join(dir, "gh.log"), "utf8");
  assert.match(log, /check-runs\?per_page=100&page=1/, "merge-guard's paged rollup ran against the stub");
  assert.match(log, /pulls\/495\/reviews/, "the votes channel is read to exhaustion");
  assert.match(log, /issues\/495\/comments/, "the comment channel is read to exhaustion");
});
