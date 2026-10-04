// pin-toolkit.test.mjs — hermetic tests for scripts/pin-toolkit.sh (issue #276).
//
// The pin threads TWO incidents and these tests pin BOTH arms against a
// REAL local git pair (a bare origin with a moving v1 tag + a checkout —
// no network, no stubs: the guard's whole job is git-state discrimination):
//   - 2026-09-21 (PR #104): detached + dirty (stray edit) MUST be
//     force-moved to the tag — stray edits must never shadow a release;
//   - 2026-10-03 (issue #276): on a BRANCH (an in-place agent's tree) the
//     pin must HOLD — no reset, edits intact, a note left behind — and it
//     must RESUME the moment the branch is left.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PIN = path.join(ROOT, "scripts", "pin-toolkit.sh");

// Real git plumbing with a per-fixture identity (no global config touched).
const git = (cwd, args) =>
  spawnSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=t", "-C", cwd, ...args], {
    encoding: "utf8",
  });
const ok = (res, what) => {
  assert.equal(res.status, 0, `${what} failed:\n${res.stderr}`);
  return res.stdout.trim();
};

// Builds a bare origin with an old v1 tag, plus a clone checked out
// DETACHED at the old tag (the pin state a box idles in), then advances
// the origin: a new commit with the v1 tag FORCE-moved onto it — the
// "moving tag" shape the sweep fetches every minute.
const fixture = () => {
  const dir = mkdtempSync(path.join(tmpdir(), "pin-toolkit-test-"));
  const origin = path.join(dir, "origin.git");
  const work = path.join(dir, "toolkit");
  mkdirSync(origin);
  ok(git(origin, ["init", "--bare", "-q"]), "init origin");
  const seed = path.join(dir, "seed");
  mkdirSync(seed);
  ok(git(seed, ["init", "-q", "--initial-branch=main"]), "init seed");
  writeFileSync(path.join(seed, "file.txt"), "one\n");
  ok(git(seed, ["add", "."]), "add");
  ok(git(seed, ["commit", "-q", "-m", "one"]), "commit one");
  ok(git(seed, ["tag", "v1"]), "tag old v1");
  ok(git(seed, ["remote", "add", "origin", origin]), "wire origin");
  ok(git(seed, ["push", "-q", "origin", "main", "v1"]), "push old");
  // (clone needs no -C: the workdir does not exist yet)
  ok(spawnSync("git", ["clone", "-q", "--branch", "main", origin, work], { encoding: "utf8" }), "clone");
  // idle pin state: detached at the old tag
  ok(git(work, ["checkout", "-q", "--detach", "v1"]), "detach at old v1");
  // advance the origin: new commit, tag force-moved (the moving v1)
  writeFileSync(path.join(seed, "file.txt"), "two\n");
  ok(git(seed, ["commit", "-q", "-am", "two"]), "commit two");
  ok(git(seed, ["tag", "-f", "v1"]), "move v1");
  ok(git(seed, ["push", "-q", "-f", "origin", "main", "v1"]), "push new");
  return { dir, origin, work };
};

const pin = (work, log) =>
  spawnSync("bash", [PIN, work, ...(log ? [log] : [])], { encoding: "utf8" });

test("detached + dirty (stray edit): FORCE-moves to the moved tag (the 2026-09-21 cure stays)", () => {
  const f = fixture();
  try {
    writeFileSync(path.join(f.work, "settings.zai.yaml"), "# stray in-place patch\n");
    const res = pin(f.work);
    assert.equal(res.status, 0, res.stderr);
    // stray edit DISCARDED, tree at the NEW v1 tip
    assert.equal(ok(git(f.work, ["rev-parse", "HEAD"])), ok(git(f.work, ["rev-parse", "v1"])),
      "HEAD must sit on the fetched v1");
    assert.equal(readFileSync(path.join(f.work, "file.txt"), "utf8"), "two\n",
      "the tree must be the new release, not the stale checkout");
    assert.ok(!existsSync(path.join(f.work, ".pin-held")), "no hold note on the detached arm");
    assert.match(res.stderr, /pinned at/, "pins loudly");
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test("on a branch (issue #276): HOLDS — no reset, edits intact, note + log left behind", () => {
  const f = fixture();
  try {
    ok(git(f.work, ["checkout", "-q", "-b", "dsh/issue-276-guarded-toolkit-pin"]), "branch");
    writeFileSync(path.join(f.work, "work-in-progress.txt"), "agent edits\n");
    const log = path.join(f.dir, "worker.log");
    const res = pin(f.work, log);
    assert.equal(res.status, 0, `hold is a steady state, not an error:\n${res.stderr}`);
    // nothing moved, nothing discarded
    assert.match(ok(git(f.work, ["symbolic-ref", "HEAD"])), /dsh\/issue-276-guarded-toolkit-pin$/,
      "HEAD must STILL be on the working branch");
    assert.equal(readFileSync(path.join(f.work, "work-in-progress.txt"), "utf8"), "agent edits\n",
      "the in-place agent's edits must be INTACT (the #276 receipt: twice-discarded work)");
    assert.equal(ok(git(f.work, ["rev-parse", "HEAD"])), ok(git(f.work, ["rev-parse", "v1"])),
      "still at the OLD tip — the sweep must not fetch-move a held tree's HEAD");
    // the note rides the checkout so an arriving agent sees it in git status
    const note = readFileSync(path.join(f.work, ".pin-held"), "utf8");
    assert.match(note, /dsh\/issue-276-guarded-toolkit-pin/, "note names the held branch");
    assert.match(note, /issue #276/, "note cites the incident");
    assert.match(res.stderr, /pin held.*branch dsh\/issue-276/, "hold logged to stderr");
    assert.match(readFileSync(log, "utf8"), /pin held/, "hold logged to the worker log");
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test("resume: once the branch is left, the next pin lands the new tag and clears the note", () => {
  const f = fixture();
  try {
    ok(git(f.work, ["checkout", "-q", "-b", "dsh/some-agent"]), "branch");
    writeFileSync(path.join(f.work, "wip.txt"), "x\n");
    assert.equal(pin(f.work).status, 0, "first pin holds");
    ok(git(f.work, ["checkout", "-q", "--detach", "v1"]), "leave the branch");
    ok(git(f.work, ["branch", "-q", "-D", "dsh/some-agent"]), "clean the branch");
    const res = pin(f.work);
    assert.equal(res.status, 0, res.stderr);
    assert.equal(ok(git(f.work, ["rev-parse", "HEAD"])), ok(git(f.work, ["rev-parse", "v1"])),
      "resumed pin sits on the fetched tag");
    assert.equal(readFileSync(path.join(f.work, "file.txt"), "utf8"), "two\n",
      "the release finally lands");
    assert.ok(!existsSync(path.join(f.work, ".pin-held")), "the hold note clears on resume");
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test("usage: no checkout at the dir fails typed (exit 2), never exit 0", () => {
  const f = fixture();
  try {
    const res = pin(path.join(f.dir, "nope"));
    assert.equal(res.status, 2);
    assert.match(res.stderr, /no toolkit checkout/);
    assert.equal(pin("").status, 2, "empty dir is a usage error too");
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});
