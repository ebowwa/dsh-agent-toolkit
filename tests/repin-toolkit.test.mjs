// repin-toolkit.test.mjs — behavioral tests for scripts/repin-toolkit.sh,
// the GUARDED v1 re-pin extracted from the keepalive cron line (issue
// #276). Real git, offline: a local bare remote stands in for origin, so
// the moving-tag fetch runs for real.
//
// Regression anchor: issue #276. The bare cron-line form
// `git fetch --tags --force && git checkout -q --force v1` moved HEAD off
// a working agent's branch and cleaned the tree mid-edit — twice in ten
// minutes on seed-L3, silently discarding in-flight work. Delete the
// guard arms in repin-toolkit.sh (back to an unconditional checkout) and
// the two SKIP tests below go red.
//
// The guard also PRESERVES the 2026-09-21 semantics on purpose: on the
// detached pin (the steady state), --force still discards stray local
// edits — an in-place patch of settings.zai.yaml once left every box's
// checkout dirty and shadowed v1.73.0→v1.74.0 for hours. The tension is
// resolved by HEAD state, not by dirt alone: an in-place WORKER is on a
// branch (protected); the pin is detached (tag-only, --force).

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REPIN = path.join(ROOT, "scripts", "repin-toolkit.sh");

const git = (cwd, ...args) =>
  spawnSync("git", args, { cwd, encoding: "utf8" });
const okGit = (cwd, ...args) => {
  const r = git(cwd, ...args);
  assert.equal(r.status, 0, `git ${args.join(" ")} in ${cwd}:\n${r.stderr}`);
  return r.stdout.trim();
};

/** Local bare remote + `work` clone at v1 (commit one) + `pusher` clone
 *  used to advance the moving tag. Offline: origin is a file path. */
const fixture = () => {
  const dir = mkdtempSync(path.join(tmpdir(), "repin-test-"));
  const remote = path.join(dir, "remote.git");
  assert.equal(git(dir, "init", "--bare", "-q", "--initial-branch=main", remote).status, 0);
  const pusher = path.join(dir, "pusher");
  assert.equal(git(dir, "clone", "-q", remote, pusher).status, 0);
  writeFileSync(path.join(pusher, "file.txt"), "one\n");
  okGit(pusher, "add", ".");
  okGit(pusher, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "one");
  okGit(pusher, "tag", "v1");
  okGit(pusher, "push", "-q", "origin", "main", "--tags");
  const work = path.join(dir, "work");
  assert.equal(git(dir, "clone", "-q", remote, work).status, 0);
  return { dir, remote, pusher, work };
};

/** Advance the remote: commit `two`, force-move v1 onto it. */
const advance = (pusher) => {
  writeFileSync(path.join(pusher, "file.txt"), "two\n");
  okGit(pusher, "add", ".");
  okGit(pusher, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "two");
  okGit(pusher, "tag", "-f", "v1");
  okGit(pusher, "push", "-q", "-f", "origin", "main", "--tags");
};

const repin = (work) => spawnSync("bash", [REPIN, work], { encoding: "utf8" });
const headIsV1 = (work) => okGit(work, "rev-parse", "HEAD") === okGit(work, "rev-parse", "v1");
const branch = (work) => git(work, "symbolic-ref", "-q", "--short", "HEAD").stdout.trim();

test("detached pin: advances to the moved tag and DISCARDS stray edits (2026-09-21 semantics preserved)", () => {
  const f = fixture();
  try {
    okGit(f.work, "checkout", "-q", "v1"); // detached at commit one
    writeFileSync(path.join(f.work, "file.txt"), "stray local edit\n"); // the door-switch class
    advance(f.pusher);
    const r = repin(f.work);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /repin: pinned at/, "reports the pin");
    assert.ok(headIsV1(f.work), "HEAD advanced to the moved v1 tag");
    assert.equal(readFileSync(path.join(f.work, "file.txt"), "utf8"), "two\n",
      "stray edits on the DETACHED pin are discarded — the template channel is tag-only");
    assert.equal(branch(f.work), "", "steady state is detached, not on a branch");
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test("working branch: REFUSES to move HEAD — uncommitted in-place edits survive (the #276 receipt)", () => {
  const f = fixture();
  try {
    okGit(f.work, "checkout", "-q", "-b", "dsh/issue-42-inplace");
    writeFileSync(path.join(f.work, "file.txt"), "in-flight agent edit\n");
    const before = okGit(f.work, "rev-parse", "HEAD");
    advance(f.pusher);
    const r = repin(f.work);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /repin: SKIP/, "the skip leaves its note (the observable half of #276)");
    assert.match(r.stdout, /dsh\/issue-42-inplace/, "the note names the branch holding the checkout");
    assert.equal(branch(f.work), "dsh/issue-42-inplace", "HEAD never moved off the working branch");
    assert.equal(okGit(f.work, "rev-parse", "HEAD"), before, "the working branch tip is untouched");
    assert.equal(readFileSync(path.join(f.work, "file.txt"), "utf8"), "in-flight agent edit\n",
      "uncommitted in-place work SURVIVES the sweep — the exact loss #276 receipts");
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test("working branch, clean tree: still refuses (moving HEAD under an in-place worker breaks its context)", () => {
  const f = fixture();
  try {
    okGit(f.work, "checkout", "-q", "-b", "dsh/issue-43-clean");
    const before = okGit(f.work, "rev-parse", "HEAD");
    advance(f.pusher);
    const r = repin(f.work);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /repin: SKIP/);
    assert.equal(branch(f.work), "dsh/issue-43-clean", "a clean working branch is still occupancy");
    assert.equal(okGit(f.work, "rev-parse", "HEAD"), before);
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test("dirty default branch: REFUSES to force-move the tag over in-flight edits", () => {
  const f = fixture();
  try {
    writeFileSync(path.join(f.work, "file.txt"), "stray main edit\n"); // fresh clone sits on main
    const before = okGit(f.work, "rev-parse", "HEAD");
    advance(f.pusher);
    const r = repin(f.work);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /repin: SKIP/);
    assert.match(r.stdout, /dirty/, "the note says the tree is dirty");
    assert.equal(okGit(f.work, "rev-parse", "HEAD"), before, "main tip untouched");
    assert.equal(readFileSync(path.join(f.work, "file.txt"), "utf8"), "stray main edit\n",
      "dirty-main edits survive");
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test("clean default branch (first-install leg): pins to the moving v1 tag", () => {
  const f = fixture();
  try {
    advance(f.pusher); // fresh clone on clean main, tag already advanced
    const r = repin(f.work);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /repin: pinned at/);
    assert.ok(headIsV1(f.work), "a clean main pins to v1 (detaches — the steady state)");
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test("fetch failure degrades: non-zero exit, checkout left on the previous pin", () => {
  const f = fixture();
  try {
    okGit(f.work, "checkout", "-q", "v1");
    const before = okGit(f.work, "rev-parse", "HEAD");
    okGit(f.work, "remote", "set-url", "origin", path.join(f.dir, "nope-absent.git"));
    const r = repin(f.work);
    assert.notEqual(r.status, 0, "a failed fetch must exit non-zero so the cron line notes the degrade");
    assert.equal(okGit(f.work, "rev-parse", "HEAD"), before, "HEAD untouched on degrade");
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});
