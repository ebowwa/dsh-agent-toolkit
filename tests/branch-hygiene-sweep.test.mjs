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
//
// The pins: (1) a branch listed in the gh census is PROTECTED — never
// listed as an orphan, never deleted; (2) an unreadable census (gh exit
// 1) REFUSES the sweep with exit 1 — deleting blind is the accident the
// tool exists to prevent; (3) sweep without --yes is a dry run — prints,
// never touches; (4) a push failure halts the sweep mid-way (fail-loud,
// nothing further deleted).

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(ROOT, "scripts", "orphan-branch-sweep.sh");

// makeDir -> { dir, bin }: a hermetic shim dir with gh and git stubs.
// Fixtures live at:
//   bin/census.json   the gh pr list --json headRefName output (default "[]")
//   bin/refs.txt      one remote branch name per line (default: empty)
//   bin/fail-refs.txt branch names whose deletion push refuses (default: none)
const makeDir = () => {
  const dir = mkdtempSync(path.join(tmpdir(), "dsh-sweep-"));
  const bin = path.join(dir, "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(path.join(bin, "refs.txt"), "");
  writeFileSync(path.join(bin, "census.json"), "[]");
  writeFileSync(path.join(bin, "fail-refs.txt"), "");

  // gh: `pr list` prints bin/census.json when it exists (exit 0), else
  // exits 1 (unreadable census).
  writeFileSync(
    path.join(bin, "gh"),
    [
      "#!/bin/sh",
      '[ -f "$(dirname "$0")/census.json" ] || exit 1',
      "cat \"$(dirname \"$0\")/census.json\"",
      "exit 0",
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
    env: { ...process.env, GH_BIN: path.join(bin, "gh"), PATH: `${bin}:${process.env.PATH}` },
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