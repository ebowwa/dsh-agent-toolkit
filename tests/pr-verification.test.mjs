// pr-verification.test.mjs — contract pins for scripts/pr-verification.mjs
// (issue #326).
//
// The aggregator turns the gate-verify channel into a machine-readable
// per-PR surface for whatever weighs independent verification into a merge
// decision. Pins, in the repo's test-as-contract style:
//
//   1. LAST marker wins, by COMMENT ORDER (ascending id — the thread's
//      final word), not by array order from the API (sorting is ours).
//   2. Exit-code contract: 0 pass / 1 no passing verification (fail or
//      none — the stdout token names which) / 2 unresolvable fail-closed.
//   3. Provenance, not bodies: the comment body (unscrubbed agent text)
//      never passes through stdout — only verdict + id/author/URL.
//   4. --json is the tooling surface (merge-guard/review-pr consult it).
//   5. A marker-parse failure or a non-marker comment never masquerades
//      as a verdict.
//
// Hermetic: a stub gh (PR_VERIFICATION_GH seam — the merge-guard pattern)
// serves the PR view and the comments; no network, no real repo.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, chmodSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TOOL = path.join(ROOT, "scripts", "pr-verification.mjs");
const HEAD = "0123456789abcdef0123456789abcdef01234567";

const comment = (id, login, body, over = {}) => ({
  id, user: { login }, body, html_url: `https://github.com/owner/repo/pull/7#issuecomment-${id}`, ...over,
});

/** Fixture dir: a stub gh serving pr-view.json + comments.json. */
const fixture = (t, comments, { prFail = false, apiFail = false } = {}) => {
  const dir = mkdtempSync(path.join(tmpdir(), "pr-verification-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(path.join(dir, "pr-view.json"), JSON.stringify({
    number: 7, headRefOid: HEAD, url: "https://github.com/owner/repo/pull/7",
  }));
  writeFileSync(path.join(dir, "comments.json"), JSON.stringify(comments));
  writeFileSync(path.join(dir, "gh"), `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$PV_STUB_DIR/gh.log"
if [ "$1" = "--version" ]; then echo "stub gh"; exit 0; fi
if [ "$1" = "pr" ] && [ "$2" = "view" ]; then
  [ -f "$PV_STUB_DIR/pr-fail" ] && { echo "stub: pr view fails" >&2; exit 1; }
  cat "$PV_STUB_DIR/pr-view.json"
  exit 0
fi
if [ "$1" = "api" ]; then
  [ -f "$PV_STUB_DIR/api-fail" ] && { echo "stub: api fails" >&2; exit 1; }
  cat "$PV_STUB_DIR/comments.json"
  exit 0
fi
echo "stub: unexpected call: $*" >&2
exit 64
`);
  chmodSync(path.join(dir, "gh"), 0o755);
  if (prFail) writeFileSync(path.join(dir, "pr-fail"), "1");
  if (apiFail) writeFileSync(path.join(dir, "api-fail"), "1");
  return dir;
};

const run = (dir, args = [], env = {}) =>
  spawnSync(process.execPath, [TOOL, "7", ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env, PR_VERIFICATION_GH: path.join(dir, "gh"), PV_STUB_DIR: dir },
  });

test("a passing marker reports pass + provenance, exit 0", (t) => {
  const dir = fixture(t, [comment(1, "sibling", "ran the gates: 443/443 pass\ngate-verify: pass\n")]);
  const r = run(dir);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /^pass https:\/\/github\.com\/owner\/repo\/pull\/7#issuecomment-1 sibling\n$/);
});

test("the LAST marker wins BY COMMENT ORDER, not API array order", (t) => {
  // ids deliberately out of order: id 30 is the thread's final word (FAIL)
  // even though the API returned it first.
  const dir = fixture(t, [
    comment(30, "sibling", "gate-verify: fail\n"),
    comment(10, "sibling", "gate-verify: pass\n"),
    comment(20, "sibling", "gate-verify: pass\n"),
  ]);
  const r = run(dir);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /^fail https:\/\/github\.com\/owner\/repo\/pull\/7#issuecomment-30 sibling\n$/);
});

test("a fail marker reports fail, exit 1 (no passing verification to weigh)", (t) => {
  const dir = fixture(t, [comment(5, "sibling", "gates red: 2 fail\ngate-verify: fail\n")]);
  const r = run(dir);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /^fail /);
});

test("no marker anywhere reports none, exit 1", (t) => {
  const dir = fixture(t, [comment(1, "someone", "just noise, no marker\n"), comment(2, "other", "also noise")]);
  const r = run(dir);
  assert.equal(r.status, 1);
  assert.equal(r.stdout, "none\n");
});

test("an empty comment list reports none, exit 1", (t) => {
  const dir = fixture(t, []);
  const r = run(dir);
  assert.equal(r.status, 1);
  assert.equal(r.stdout, "none\n");
});

test("--json is the tooling surface (verdict, pr, head, comment provenance)", (t) => {
  const dir = fixture(t, [comment(9, "sibling", "gate-verify: pass\n")]);
  const r = run(dir, ["--json"]);
  assert.equal(r.status, 0);
  const j = JSON.parse(r.stdout);
  assert.equal(j.verdict, "pass");
  assert.equal(j.pr, 7);
  assert.equal(j.head, HEAD);
  assert.equal(j.markers, 1);
  assert.deepEqual(j.comment, { id: 9, author: "sibling", url: "https://github.com/owner/repo/pull/7#issuecomment-9" });
});

test("provenance, not bodies: the comment body NEVER passes through stdout", (t) => {
  const dir = fixture(t, [comment(1, "sibling", "internal host dsh-runner-internal.local receipts\ngate-verify: pass\n")]);
  const r = run(dir);
  assert.equal(r.status, 0);
  assert.ok(!r.stdout.includes("dsh-runner-internal.local"), "unscrubbed comment text must not leak into the report");
  const j = JSON.parse(run(dir, ["--json"]).stdout);
  assert.ok(!JSON.stringify(j).includes("dsh-runner-internal.local"), "the json surface leaks nothing either");
});

test("a non-marker or malformed comment never masquerades as a verdict", (t) => {
  const dir = fixture(t, [
    comment(1, "a", "gate-verify: pass pending rerun\n"),
    comment(2, "b", ""),
    comment(3, "c", null),
    comment(4, "d", "gate-verify: pass\n"),
  ]);
  const r = run(dir);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /issuecomment-4/, "the last REAL marker (id 4) wins");
});

test("unresolvable PR (pr view fails) exits 2 with a typed reason", (t) => {
  const dir = fixture(t, [], { prFail: true });
  const r = run(dir);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /REFUSED \(unresolvable\)/);
});

test("unresolvable comments API exits 2, never readable as none", (t) => {
  const dir = fixture(t, [], { apiFail: true });
  const r = run(dir);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /comments API failed/);
});

test("missing gh exits 2 (the fail-closed direction — silence is not none)", (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "pr-verification-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const r = spawnSync(process.execPath, [TOOL, "7"], {
    encoding: "utf8",
    env: { ...process.env, PR_VERIFICATION_GH: path.join(dir, "absent-gh") },
  });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /PR_VERIFICATION_GH/);
});

test("log shows the paginated comments call (an early-page marker must never be shadowed)", (t) => {
  const dir = fixture(t, [comment(1, "sibling", "gate-verify: pass\n")]);
  run(dir);
  const log = readFileSync(path.join(dir, "gh.log"), "utf8");
  assert.match(log, /api --paginate repos\/owner\/repo\/issues\/7\/comments/);
});
