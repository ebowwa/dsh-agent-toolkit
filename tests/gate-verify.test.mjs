// gate-verify.test.mjs — contract pins for scripts/gate-verify.mjs and the
// gate-verify channel's wiring (issue #326).
//
// The receipt: the fleet mints every PR under one shared account, so
// `gh pr review --approve` fails for ANY agent ("Review can not approve
// your own pull request"); independent verification of a sibling PR was
// comment-only noise the merge decision never saw. The channel: a PR
// comment whose line `gate-verify: pass|fail` IS the verification.
// Pins, in the repo's test-as-contract style:
//
//   1. Line-strict: the marker must be its own line; a marker mentioned
//      inside a prose sentence never qualifies (the review-verdict
//      substring-trap lesson).
//   2. The `gate-verify:` label is REQUIRED — the deliberate contrast with
//      review-verdict.mjs's optional `verdict:` label: a bare `pass` line
//      in free prose must never count, because this channel is a machine
//      marker, not a verdict word a reviewer was told to end with.
//   3. The LAST marker line wins (the drift-verdict lesson).
//   4. Decoration (`**gate-verify:**`, backticks, case) does not hide it;
//      vocabulary normalizes (passed/passing → pass, failed/failing → fail).
//   5. The wiring exists: review-pr.sh consults the channel (markers as
//      claims to check), merge-guard.sh has the OPT-IN arm (default off —
//      the gates-only #434 semantics are byte-identical when unarmed), and
//      the docs carry the rule (REVIEW.md, CONTRIBUTING.md).

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { proseHas } from "./lib/prose.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TOOL = path.join(ROOT, "scripts", "gate-verify.mjs");

const run = (comment) => {
  const dir = mkdtempSync(path.join(tmpdir(), "gate-verify-test-"));
  try {
    const f = path.join(dir, "comment.txt");
    writeFileSync(f, comment ?? "");
    return spawnSync(process.execPath, [TOOL, f], { encoding: "utf8" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

const markerOf = (comment) => run(comment).stdout.trim();

// --- the parse --------------------------------------------------------------

test("the canonical marker line parses both ways", () => {
  assert.equal(markerOf("receipts...\ngate-verify: pass\n"), "PASS");
  assert.equal(markerOf("receipts...\ngate-verify: fail\n"), "FAIL");
});

test("decoration and case do not hide the marker", () => {
  assert.equal(markerOf("**gate-verify:** pass"), "PASS");
  assert.equal(markerOf("`gate-verify: fail`"), "FAIL");
  assert.equal(markerOf("GATE-VERIFY: PASS"), "PASS");
});

test("vocabulary normalizes (passed/passing, failed/failing)", () => {
  assert.equal(markerOf("gate-verify: passed"), "PASS");
  assert.equal(markerOf("gate-verify: passing"), "PASS");
  assert.equal(markerOf("gate-verify: failed"), "FAIL");
  assert.equal(markerOf("gate-verify: failing"), "FAIL");
});

test("label REQUIRED: a bare pass/fail line is NOT a marker (the review-verdict contrast)", () => {
  assert.equal(markerOf("pass\n"), "");
  assert.equal(markerOf("FAIL"), "");
});

test("a marker inside prose never qualifies (the substring trap)", () => {
  assert.equal(markerOf("I'll post gate-verify: pass once the gates finish."), "");
  assert.equal(markerOf("gate-verify: pass pending one rerun"), "");
  assert.equal(markerOf("no marker yet — gate-verify: fail would go here"), "");
});

test("the LAST marker line wins (the drift-verdict lesson)", () => {
  assert.equal(markerOf("gate-verify: pass\n...\ngate-verify: fail\n"), "FAIL");
  assert.equal(markerOf("gate-verify: fail\n...\ngate-verify: pass\n"), "PASS");
});

test("independent vocabulary: a Verdict line is not a marker and vice versa", () => {
  assert.equal(markerOf("## Verdict: APPROVE\ngate-verify: pass\n"), "PASS");
  assert.equal(markerOf("## Verdict: APPROVE\n"), "");
});

test("marker-less and empty comments parse empty, exit 0", () => {
  const none = run("looked great, no findings\n");
  assert.equal(none.stdout.trim(), "");
  assert.equal(none.status, 0);
  const empty = run("");
  assert.equal(empty.stdout.trim(), "");
  assert.equal(empty.status, 0);
});

test("fail-closed usage: missing file and missing argument exit 2", () => {
  assert.equal(spawnSync(process.execPath, [TOOL, "/nonexistent/comment.txt"], { encoding: "utf8" }).status, 2);
  assert.equal(spawnSync(process.execPath, [TOOL], { encoding: "utf8" }).status, 2);
});

// --- the wiring -------------------------------------------------------------

test("review-pr.sh consults the channel (markers surface to the reviewer as claims)", () => {
  const rp = readFileSync(path.join(ROOT, "scripts", "review-pr.sh"), "utf8");
  assert.match(rp, /pr-verification\.mjs/, "the review task must include prior gate-verify markers");
  assert.match(rp, /CLAIMS the reviewer[\s#]*checks/, "markers are claims to check, never truth");
  // Degrade-safe: a failed lookup must degrade to "none", never fail the review.
  assert.match(rp, /pr-verification\.mjs" "\$PR_NUM" 2>\/dev\/null \|\| true/);
  assert.match(rp, /\[ -n "\$VERIFY" \] \|\| VERIFY="none"/);
});

test("merge-guard.sh carries the OPT-IN arm; unarmed default stays gates-only", () => {
  const mg = readFileSync(path.join(ROOT, "scripts", "merge-guard.sh"), "utf8");
  assert.match(mg, /MERGE_GUARD_VERIFY/, "the arm knob must exist");
  assert.match(mg, /\[ "\$\{MERGE_GUARD_VERIFY:-\}" = "on" \] \|\| return 0/,
    "the arm must be opt-in: unset/other = the #434 gates-only behavior");
  assert.match(mg, /pr-verification\.mjs/, "the arm consults the channel via pr-verification.mjs");
  assert.match(mg, /GREEN[^\n]*\n *verify_gate\n/, "the arm is consulted on the gates-green path, after CI is green");
});

test("the docs carry the channel rule and conduct (REVIEW.md, CONTRIBUTING.md)", () => {
  const review = readFileSync(path.join(ROOT, "REVIEW.md"), "utf8");
  assert.ok(proseHas(review, "Independent verification of a sibling PR rides the `gate-verify:` comment channel (issue #326)"),
    "REVIEW.md states the channel");
  assert.ok(proseHas(review, "the merge guard weighs the channel only when explicitly armed (`MERGE_GUARD_VERIFY=on`)"),
    "REVIEW.md states the arm is opt-in");
  const contributing = readFileSync(path.join(ROOT, "CONTRIBUTING.md"), "utf8");
  assert.ok(proseHas(contributing, "When you independently verify a sibling PR"),
    "CONTRIBUTING.md carries the verifying agent's conduct");
  assert.ok(proseHas(contributing, "the LAST marker in the comment wins"),
    "CONTRIBUTING.md states the last-wins contract");
});
