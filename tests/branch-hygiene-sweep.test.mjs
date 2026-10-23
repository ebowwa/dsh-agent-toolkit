// branch-hygiene-sweep.test.mjs — pins scripts/orphan-branch-sweep.sh
// (issue #453, the sweep half of the branch-hygiene contract #127).
//
// The contract (#127) is the SESSION-side rule: zero orphan branches, a
// branch whose work outlives the session without a PR is a lost thread,
// delete-on-close-without-merge. Sessions leak anyway — a dead cell before
// the PR step, an unmerged close without --delete-branch, a supersede the
// refile did not reap (the receipts on #453: PR #384's head still live,
// PR #396's sibling still live, ~60 remote dsh/issue branches against a
// main whose PR merges auto-clean — the exact mess the contract exists to
// prevent). The sweep reaps the residue: a remote dsh/issue-* branch with
// NO OPEN PR behind it is a confirmed orphan and gets deleted.
//
// These tests are hermetic: gh and git are stubbed with fixed fixtures
// (census JSON in bin/census.json, remote refs in bin/refs.txt, optional
// fail-refs in bin/fail-refs.txt) so the census reading, the
// protected/confirmed split, and the delete verb never touch the network.
// Issue #643 adds the approved-lane consult: the closed-PR census is
// served from bin/closed-census.json, and the consult itself is stubbed
// via the APPROVED_LANE_TOOL seam (the merge-guard MERGE_GUARD_VERIFY_TOOL
// pattern) — a fake guard keyed by per-PR fixture files, so the SWEEP's
// contract is pinned here while scripts/approved-lane.mjs's channel logic
// is pinned in its own suite.
//
// The pins: (1) a branch listed in the gh census is PROTECTED — never
// listed as an orphan, never deleted; (2) an unreadable census (gh exit
// 1) REFUSES the sweep with exit 1 — deleting blind is the accident the
// tool exists to prevent; (3) sweep without --yes is a dry run — prints,
// never touches; (4) a push failure halts the sweep mid-way (fail-loud,
// nothing further deleted); (5) issue #643 — a candidate whose newest
// closed-unmerged PR is APPROVED is PROTECTED with a loud line naming the
// PR (the head is the reviewed work's only independent copy), an
// unresolvable consult REFUSES the sweep, and only not-approved
// candidates reap.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, chmodSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(ROOT, "scripts", "orphan-branch-sweep.sh");

// makeDir -> { dir, bin }: a hermetic shim dir with gh, git, and the
// approved-lane consult stubs. Fixtures live at:
//   bin/census.json        the gh pr list --json headRefName output (default "[]")
//   bin/closed-census.json the gh pr list --state closed output (default "[]")
//   bin/closed-fail        present => the closed census exits 1 (unreadable)
//   bin/refs.txt           one remote branch name per line (default: empty)
//   bin/fail-refs.txt      branch names whose deletion push refuses (default: none)
//   bin/approved-<N>       present => the consult says PR #N is APPROVED (rc 0)
//   bin/unresolvable-<N>   present => the consult is UNRESOLVABLE for PR #N (rc 2)
//   (absent both => the consult says not-approved: rc 1 — the reap path)
const makeDir = () => {
  const dir = mkdtempSync(path.join(tmpdir(), "dsh-sweep-"));
  const bin = path.join(dir, "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(path.join(bin, "refs.txt"), "");
  writeFileSync(path.join(bin, "census.json"), "[]");
  writeFileSync(path.join(bin, "closed-census.json"), "[]");
  writeFileSync(path.join(bin, "fail-refs.txt"), "");

  // gh: `pr list` serves the open census (bin/census.json, missing file
  // = unreadable = exit 1) or, with --state closed, the closed census
  // (bin/closed-census.json; bin/closed-fail = unreadable).
  writeFileSync(
    path.join(bin, "gh"),
    [
      "#!/bin/sh",
      "BIN=\"$(dirname \"$0\")\"",
      'if [ "$1" = "pr" ] && [ "$2" = "list" ]; then',
      '  if [ "$3" = "--state" ] && [ "$4" = "closed" ]; then',
      '    [ -f "$BIN/closed-fail" ] && { echo "stub: closed census fails" >&2; exit 1; }',
      '    cat "$BIN/closed-census.json"',
      "    exit 0",
      "  fi",
      '  [ -f "$BIN/census.json" ] || exit 1',
      '  cat "$BIN/census.json"',
      "  exit 0",
      "fi",
      'echo "stub gh: unexpected call: $*" >&2',
      "exit 64",
    ].join("\n") + "\n",
  );
  // approved-lane consult stub (the APPROVED_LANE_TOOL seam — a NODE
  // script path, the merge-guard MERGE_GUARD_VERIFY_TOOL convention):
  // keyed by per-PR fixture files, logs every consult to lane.log for
  // assertions. rc 0 approved / rc 1 not-approved / rc 2 unresolvable.
  writeFileSync(
    path.join(bin, "approved-lane.mjs"),
    [
      "import { appendFileSync, existsSync } from 'node:fs';",
      "import path from 'node:path';",
      "const bin = path.dirname(process.argv[1]);",
      "appendFileSync(path.join(bin, 'lane.log'), `consult:${process.argv[2]}\\n`);",
      "const n = process.argv[2];",
      "if (existsSync(path.join(bin, `unresolvable-${n}`))) {",
      "  console.error('approved-lane: REFUSED (unresolvable) — stubbed channel failure');",
      "  process.exit(2);",
      "}",
      "if (existsSync(path.join(bin, `approved-${n}`))) {",
      "  console.log(`approved pr#${n} gates=green verdict=approve`);",
      "  process.exit(0);",
      "}",
      "console.log(`idle pr#${n} gates=not-green verdict=none`);",
      "process.exit(1);",
    ].join("\n") + "\n",
  );
  // git: `ls-remote <remote> <pattern>` prints the refs.txt names as
  // sha+refs/heads/ rows; `push <remote> refs/heads/X --delete` records
  // PUSH_DELETE:X on stderr, refused when X is in fail-refs.txt.
  writeFileSync(
    path.join(bin, "git"),
    [
      "#!/bin/sh",
      'BIN="$(dirname "$0")"',
      'if [ "$1" = "ls-remote" ]; then',
      '  while IFS= read -r b; do',
      '    [ -n "$b" ] || continue',
      '    printf "0000000000000000000000000000000000000000\\trefs/heads/%s\\n" "$b"',
      '  done < "$BIN/refs.txt"',
      "  exit 0",
      "fi",
      'if [ "$1" = "push" ]; then',
      '  ref="$3"',
      '  name="${ref#refs/heads/}"',
      '  echo "PUSH_DELETE:$name" >&2',
      '  if grep -qx "$name" "$BIN/fail-refs.txt"; then exit 1; fi',
      "  exit 0",
      "fi",
      "exit 0",
    ].join("\n") + "\n",
  );
  for (const f of ["gh", "git"]) chmodSync(path.join(bin, f), 0o755);
  return { dir, bin };
};

const run = (bin, args) =>
  spawnSync("bash", [SCRIPT, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      GH_BIN: path.join(bin, "gh"),
      APPROVED_LANE_TOOL: path.join(bin, "approved-lane.mjs"),
      PATH: `${bin}:${process.env.PATH}`,
    },
  });

test("list with an empty census and empty refs is a clean zero", () => {
  const { dir, bin } = makeDir();
  const proc = run(bin, ["list"]);
  assert.equal(proc.status, 0, proc.stderr);
  assert.equal(proc.stdout.trim(), "");
  rmSync(dir, { recursive: true, force: true });
});

test("the gh open-PR census drives the protected/confirmed split", () => {
  const { dir, bin } = makeDir();
  writeFileSync(
    path.join(bin, "census.json"),
    '[{"headRefName":"dsh/issue-111-open"},{"headRefName":"dsh/issue-222-open"}]',
  );
  writeFileSync(
    path.join(bin, "refs.txt"),
    "dsh/issue-111-open\ndsh/issue-333-orphan\ndsh/issue-222-open\n",
  );

  // list prints ONLY the confirmed orphan.
  const list = run(bin, ["list"]);
  assert.equal(list.status, 0, list.stderr);
  assert.deepEqual(
    list.stdout.trim().split("\n").filter(Boolean),
    ["dsh/issue-333-orphan"],
    `orphan list should hold only the unprotected branch, got: ${list.stdout}`,
  );

  // sweep without --yes = dry run: prints, deletes nothing.
  const dry = run(bin, ["sweep"]);
  assert.equal(dry.status, 0, dry.stderr);
  assert.match(dry.stderr, /dry run/, "sweep without --yes must be a dry run");
  assert.doesNotMatch(dry.stderr, /PUSH_DELETE/, "dry run must not delete");

  // sweep --yes: exactly one deletion, the orphan.
  const sweep = run(bin, ["sweep", "--yes"]);
  assert.equal(sweep.status, 0, sweep.stderr);
  assert.match(sweep.stderr, /deleted dsh\/issue-333-orphan/);
  assert.doesNotMatch(sweep.stderr, /111-open/, "protected branches must never be deleted");
  assert.doesNotMatch(sweep.stderr, /222-open/, "protected branches must never be deleted");

  rmSync(dir, { recursive: true, force: true });
});

test("an unreadable open-PR census REFUSES the sweep (never delete blind)", () => {
  const { dir, bin } = makeDir();
  writeFileSync(path.join(bin, "refs.txt"), "dsh/issue-999-orphan\n");
  rmSync(path.join(bin, "census.json")); // gh exits 1 without its fixture
  const proc = run(bin, ["sweep", "--yes"]);
  assert.equal(proc.status, 1, "refusal must be exit 1");
  assert.match(proc.stderr, /refusing to delete blind/);
  assert.doesNotMatch(proc.stderr, /PUSH_DELETE/, "nothing may be deleted on an unreadable census");
  rmSync(dir, { recursive: true, force: true });
});

test("a push failure halts the sweep mid-way (fail-loud, no partial continuation)", () => {
  const { dir, bin } = makeDir();
  writeFileSync(path.join(bin, "refs.txt"), "dsh/issue-a-orphan\ndsh/issue-b-orphan\n");
  writeFileSync(path.join(bin, "fail-refs.txt"), "dsh/issue-b-orphan\n");
  const proc = run(bin, ["sweep", "--yes"]);
  assert.equal(proc.status, 1, "a push refusal must fail the sweep");
  assert.match(proc.stderr, /REFUSED deleting dsh\/issue-b-orphan/);
  assert.match(proc.stderr, /nothing further deleted/);
  assert.match(proc.stderr, /deleted dsh\/issue-a-orphan/, "the first orphan deletes before the halt");
  rmSync(dir, { recursive: true, force: true });
});

test("a full 1000-row census page is REFUSED (truncation — heads past the page would be misclassified)", () => {
  const { dir, bin } = makeDir();
  writeFileSync(path.join(bin, "refs.txt"), "dsh/issue-999-orphan\n");
  // A census that fills its page: 1000 headRefName rows.
  const rows = Array.from({ length: 1000 }, (_, i) => `{"headRefName":"dsh/issue-trunc-${i}"}`);
  writeFileSync(path.join(bin, "census.json"), `[${rows.join(",")}]`);
  const proc = run(bin, ["sweep", "--yes"]);
  assert.equal(proc.status, 1, "a truncated census must refuse, not classify the tail as orphans");
  assert.match(proc.stderr, /truncated census refused/);
  assert.doesNotMatch(proc.stderr, /PUSH_DELETE/, "nothing may be deleted on a truncated census");
  rmSync(dir, { recursive: true, force: true });
});

test("only dsh/issue-* refs are candidates — other refs are ignored entirely", () => {
  const { dir, bin } = makeDir();
  writeFileSync(
    path.join(bin, "refs.txt"),
    "dsh/issue-orphan-only\ndsh/other-kind\nmain\nrelease/v1\n",
  );
  const list = run(bin, ["list"]);
  assert.equal(list.status, 0, list.stderr);
  assert.deepEqual(
    list.stdout.trim().split("\n").filter(Boolean),
    ["dsh/issue-orphan-only"],
    "non dsh/issue-* refs must be invisible to the sweep",
  );
  rmSync(dir, { recursive: true, force: true });
});

// --- the issue #643 protected class: approved-unmerged PRs -------------------
//
// The receipts: PRs #495/#544 — review-approved, gates green on the
// head, stale-closed UNMERGED, heads then reaped; the reviewed work kept
// no path back to main. A candidate orphan whose newest closed-unmerged
// PR is approved is PROTECTED, loudly; only not-approved candidates reap.

test("a candidate behind an APPROVED-unmerged closed PR is PROTECTED — never listed, never deleted, loud line naming the PR (issue #643)", () => {
  const { dir, bin } = makeDir();
  writeFileSync(path.join(bin, "refs.txt"), "dsh/issue-495-head\ndsh/issue-plain-orphan\n");
  writeFileSync(
    path.join(bin, "closed-census.json"),
    JSON.stringify([
      { headRefName: "dsh/issue-495-head", number: 495, mergedAt: null },
      { headRefName: "dsh/issue-plain-orphan", number: 500, mergedAt: null },
    ]),
  );
  writeFileSync(path.join(bin, "approved-495"), "1"); // the consult says approved

  const list = run(bin, ["list"]);
  assert.equal(list.status, 0, list.stderr);
  assert.deepEqual(
    list.stdout.trim().split("\n").filter(Boolean),
    ["dsh/issue-plain-orphan"],
    "the approved-unmerged branch must NOT be a confirmed orphan",
  );
  assert.match(list.stderr, /PROTECTED dsh\/issue-495-head — approved-unmerged PR #495/);
  assert.match(list.stderr, /issue #643/);

  const sweep = run(bin, ["sweep", "--yes"]);
  assert.equal(sweep.status, 0, sweep.stderr);
  assert.match(sweep.stderr, /deleted dsh\/issue-plain-orphan/);
  assert.doesNotMatch(sweep.stderr, /PUSH_DELETE:dsh\/issue-495-head/, "the approved branch is never deleted");
  assert.match(sweep.stderr, /PROTECTED dsh\/issue-495-head/);
  rmSync(dir, { recursive: true, force: true });
});

test("a candidate behind a NOT-approved closed-unmerged PR reaps as before (the retire lane is unchanged)", () => {
  const { dir, bin } = makeDir();
  writeFileSync(path.join(bin, "refs.txt"), "dsh/issue-544-head\n");
  writeFileSync(
    path.join(bin, "closed-census.json"),
    JSON.stringify([{ headRefName: "dsh/issue-544-head", number: 544, mergedAt: null }]),
  );
  // no approved-544 fixture => the consult says idle (rc 1)
  const sweep = run(bin, ["sweep", "--yes"]);
  assert.equal(sweep.status, 0, sweep.stderr);
  assert.match(sweep.stderr, /deleted dsh\/issue-544-head/);
  rmSync(dir, { recursive: true, force: true });
});

test("a candidate whose newest closed PR MERGED reaps without an approval consult (auto-delete residue, not the #643 class)", () => {
  const { dir, bin } = makeDir();
  writeFileSync(path.join(bin, "refs.txt"), "dsh/issue-merged-residue\n");
  writeFileSync(
    path.join(bin, "closed-census.json"),
    JSON.stringify([{ headRefName: "dsh/issue-merged-residue", number: 490, mergedAt: "2026-10-01T00:00:00Z" }]),
  );
  const sweep = run(bin, ["sweep", "--yes"]);
  assert.equal(sweep.status, 0, sweep.stderr);
  assert.match(sweep.stderr, /deleted dsh\/issue-merged-residue/);
  const logPath = path.join(bin, "lane.log");
  const log = existsSync(logPath) ? readFileSync(logPath, "utf8") : ""; // no consult => no log
  assert.doesNotMatch(log, /consult:490/, "a merged-newest head is ordinary orphan residue — no consult");
  rmSync(dir, { recursive: true, force: true });
});

test("an UNRESOLVABLE approval consult REFUSES the sweep — never delete blind on the approval channel (issue #643)", () => {
  const { dir, bin } = makeDir();
  writeFileSync(path.join(bin, "refs.txt"), "dsh/issue-x-orphan\ndsh/issue-y-orphan\n");
  writeFileSync(
    path.join(bin, "closed-census.json"),
    JSON.stringify([
      { headRefName: "dsh/issue-x-orphan", number: 501, mergedAt: null },
      { headRefName: "dsh/issue-y-orphan", number: 502, mergedAt: null },
    ]),
  );
  writeFileSync(path.join(bin, "unresolvable-501"), "1");
  const proc = run(bin, ["sweep", "--yes"]);
  assert.equal(proc.status, 1, "an unresolvable consult must refuse the sweep");
  assert.match(proc.stderr, /approval consult UNRESOLVABLE for dsh\/issue-x-orphan/);
  assert.doesNotMatch(proc.stderr, /PUSH_DELETE/, "nothing may be deleted on an unreadable approval channel");
  rmSync(dir, { recursive: true, force: true });
});

test("an unreadable closed-PR census REFUSES the sweep (the fail-closed census contract extends to the #643 consult)", () => {
  const { dir, bin } = makeDir();
  writeFileSync(path.join(bin, "refs.txt"), "dsh/issue-999-orphan\n");
  writeFileSync(path.join(bin, "closed-fail"), "1");
  const proc = run(bin, ["sweep", "--yes"]);
  assert.equal(proc.status, 1);
  assert.match(proc.stderr, /closed-PR census unreadable/);
  assert.doesNotMatch(proc.stderr, /PUSH_DELETE/);
  rmSync(dir, { recursive: true, force: true });
});

test("a clean repo (no candidates) never calls the closed census (zero extra API cost)", () => {
  const { dir, bin } = makeDir();
  writeFileSync(path.join(bin, "refs.txt"), "dsh/issue-111-open\n");
  writeFileSync(path.join(bin, "census.json"), '[{"headRefName":"dsh/issue-111-open"}]');
  writeFileSync(path.join(bin, "closed-fail"), "1"); // would refuse if called
  const proc = run(bin, ["list"]);
  assert.equal(proc.status, 0, proc.stderr);
  assert.doesNotMatch(proc.stderr, /closed-PR census unreadable/, "the closed census must be lazy");
  rmSync(dir, { recursive: true, force: true });
});

test("the newest closed PR per head decides — an older approved PR superseded by a newer not-approved one reaps", () => {
  const { dir, bin } = makeDir();
  writeFileSync(path.join(bin, "refs.txt"), "dsh/issue-sup-head\n");
  writeFileSync(
    path.join(bin, "closed-census.json"),
    JSON.stringify([
      { headRefName: "dsh/issue-sup-head", number: 480, mergedAt: null }, // older, approved
      { headRefName: "dsh/issue-sup-head", number: 520, mergedAt: null }, // newest, not approved
    ]),
  );
  writeFileSync(path.join(bin, "approved-480"), "1");
  const sweep = run(bin, ["sweep", "--yes"]);
  assert.equal(sweep.status, 0, sweep.stderr);
  assert.match(sweep.stderr, /deleted dsh\/issue-sup-head/);
  const log = readFileSync(path.join(bin, "lane.log"), "utf8");
  assert.match(log, /consult:520/, "the NEWEST closed-unmerged PR is the consult target");
  assert.doesNotMatch(log, /consult:480/);
  rmSync(dir, { recursive: true, force: true });
});