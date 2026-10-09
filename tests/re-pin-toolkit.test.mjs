// re-pin-toolkit.test.mjs — hermetic tests for scripts/re-pin-toolkit.sh
// (issue #276).
//
// The keepalive's re-pin arm used to run inline in the cron line:
// `git fetch --tags --force && git checkout -q --force v1` — every minute,
// unconditionally, against the SHARED toolkit checkout a lane agent may be
// editing in place. When drift-check advanced v1, the next tick destroyed
// the in-flight work (the #276 receipt: two resets in ~10 minutes on
// seed-L3). These tests pin the guarded behavior with REAL git against a
// local bare origin (no network): the destructive half only runs on a
// clean, non-working-branch tree; every live-work state refuses LOUDLY
// (exit 3, note to stderr) with the tree and HEAD intact; fetch/checkout
// failures degrade (exit 4) without touching anything; success is QUIET
// (steady state adds nothing to worker.log).

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(ROOT, "scripts", "re-pin-toolkit.sh");

// Hermetic-but-ambient git env: the lane's PATH `git` may be the driver's
// scrub shim (it resolves the real git through GIT_SCRUB_REAL from the
// ambient environment — a stripped env kills every git call on this
// lane), so INHERIT the ambient environment and neutralize only the git
// config layering (a user gitconfig with e.g. commit.gpgsign would flake
// CI lanes; GIT_CONFIG_GLOBAL=/dev/null covers it wherever git runs).
const HERMETIC_ENV = {
  ...process.env,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
};

const git = (cwd, args) =>
  spawnSync("git", ["-C", cwd, "-c", "user.email=t@example.com", "-c", "user.name=t", ...args], {
    encoding: "utf8",
    env: HERMETIC_ENV,
  });

// issue #582/#621: spawnSync NEVER throws — a failed fixture-CONSTRUCTION
// call used to resolve silently (commitFile()'s discarded result meant a
// failed add/commit swapped the checkout topology the re-pin guard is graded
// against while every assert stayed green). Construction asserts (the PR
// #589 gitSetup shape): non-zero exit or spawn error throws with the failed
// argv + captured stderr. Runtime probes that READ state for the asserts
// (rev, head, onBranch) keep the plain `git` helper.
const gitSetup = (cwd, args) => {
  const r = git(cwd, args);
  if (r.error || r.status !== 0) {
    throw new Error(
      `fixture setup failed: git -C ${cwd} ${args.join(" ")} (exit ${r.status ?? "?"})\n${r.error ?? r.stderr}`,
    );
  }
  return r;
};

const runScript = (dir, args = []) =>
  spawnSync("bash", [SCRIPT, ...args], { encoding: "utf8", env: { ...HERMETIC_ENV, DSH_AGENT_TOOLKIT_DIR: dir } });

const commitFile = (cwd, name, body) => {
  writeFileSync(path.join(cwd, name), body);
  gitSetup(cwd, ["add", name]);
  return gitSetup(cwd, ["commit", "-m", `add ${name}`]);
};

/**
 * A box-side fixture: a bare origin (main at A, moving tag v1 → A) and a
 * clone of it (the shared toolkit checkout), plus `advance()` which moves
 * origin's main to B and FORCE-moves v1 to B — exactly what drift-check
 * does to every lane box on a release.
 */
const fixture = () => {
  const dir = mkdtempSync(path.join(tmpdir(), "re-pin-toolkit-test-"));
  const origin = path.join(dir, "origin.git");
  const seed = path.join(dir, "seed");
  const box = path.join(dir, "toolkit");
  mkdirSync(seed, { recursive: true });
  gitSetup(seed, ["init", "--quiet", "--initial-branch=main"]);
  commitFile(seed, "settings.zai.yaml", "# template v1\n");
  gitSetup(seed, ["clone", "--quiet", "--bare", ".", origin]);
  gitSetup(seed, ["push", "--quiet", origin, "main"]);
  gitSetup(seed, ["tag", "v1"]);
  gitSetup(seed, ["push", "--quiet", origin, "v1"]);
  gitSetup(dir, ["clone", "--quiet", origin, box]);
  const rev = (ref) => git(box, ["rev-parse", ref]).stdout.trim();
  return {
    dir, origin, seed, box,
    revA: rev("v1"),
    advance: () => {
      commitFile(seed, "drift.md", "# next release\n");
      gitSetup(seed, ["push", "--quiet", origin, "main"]);
      gitSetup(seed, ["tag", "-f", "v1"]);
      gitSetup(seed, ["push", "--quiet", "--force", origin, "v1"]);
    },
    detachAtPin: () => gitSetup(box, ["checkout", "--quiet", "v1"]),
    head: () => rev("HEAD"),
    onBranch: () => git(box, ["symbolic-ref", "--short", "-q", "HEAD"]).stdout.trim(),
    cleanUp: () => rmSync(dir, { recursive: true, force: true }),
  };
};

test("source pin: the guarded arm keeps the audited flags and the refusal gates", () => {
  const src = readFileSync(SCRIPT, "utf8");
  assert.match(src, /fetch --tags --force/, "force-moves the moving tag (plain fetch clobbers: \"would clobber existing tag\")");
  assert.match(src, /checkout -q --force v1/, "--force stays (a bare checkout silently keeps local mods — 2026-09-21) but only runs behind the gate");
  assert.match(src, /diff-index --quiet HEAD/, "tracked-modification gate (the payload checkout --force would destroy)");
  assert.match(src, /symbolic-ref -q --short HEAD/, "working-branch gate");
  assert.match(src, /GIT_OPTIONAL_LOCKS=0/, "never takes the index lock under a working agent");
  assert.match(src, /issue #276/, "the receipt is cited where the behavior lives");
});

test("clean detached tree re-pins to the force-moved tag, quietly", () => {
  const f = fixture();
  try {
    f.advance();
    f.detachAtPin(); // steady state: detached at the previous pin
    const res = runScript(f.box);
    assert.equal(res.status, 0, res.stderr);
    assert.equal(res.stdout, "", "success is quiet (steady state adds nothing to worker.log)");
    assert.equal(res.stderr, "", "success is quiet on stderr too");
    assert.notEqual(f.head(), f.revA, "HEAD moved off the previous pin");
    assert.equal(f.head(), git(f.box, ["rev-parse", "v1"]).stdout.trim(), "HEAD sits exactly at the force-moved v1 tag");
  } finally {
    f.cleanUp();
  }
});

test("the #276 receipt: tracked modifications REFUSE the re-pin and survive it", () => {
  const f = fixture();
  try {
    f.detachAtPin();
    const file = path.join(f.box, "settings.zai.yaml");
    writeFileSync(file, "# agent mid-edit marker DSH-276\n");
    f.advance(); // drift-check advances v1 under the mid-edit tree
    const res = runScript(f.box);
    assert.equal(res.status, 3, "refused (exit 3), never a destroy");
    assert.match(res.stderr, /REFUSING re-pin/, "the refusal is loud");
    assert.match(res.stderr, /issue #276/, "the note names the class");
    assert.match(res.stderr, /settings\.zai\.yaml/, "the receipt lists the at-risk file");
    assert.equal(readFileSync(file, "utf8"), "# agent mid-edit marker DSH-276\n", "the mid-edit work SURVIVES");
    assert.equal(f.head(), f.revA, "HEAD kept at the previous pin");
    // and the cure works: once the tree is clean, the same script re-pins
    gitSetup(f.box, ["checkout", "--", "settings.zai.yaml"]);
    const again = runScript(f.box);
    assert.equal(again.status, 0, again.stderr);
    assert.notEqual(f.head(), f.revA, "resumed re-pins after the tree was cleaned");
  } finally {
    f.cleanUp();
  }
});

test("a STAGED modification refuses too (diff-index sees the index, not just the worktree)", () => {
  const f = fixture();
  try {
    f.detachAtPin();
    const file = path.join(f.box, "settings.zai.yaml");
    writeFileSync(file, "# staged edit\n");
    gitSetup(f.box, ["add", "settings.zai.yaml"]);
    const res = runScript(f.box);
    assert.equal(res.status, 3, res.stderr);
    assert.match(res.stderr, /REFUSING re-pin/);
    assert.equal(readFileSync(file, "utf8"), "# staged edit\n", "staged work survives");
  } finally {
    f.cleanUp();
  }
});

test("a working branch (not main) refuses; the branch stays checked out", () => {
  const f = fixture();
  try {
    f.detachAtPin();
    gitSetup(f.box, ["checkout", "--quiet", "-b", "dsh/issue-276-work"]);
    const res = runScript(f.box);
    assert.equal(res.status, 3, res.stderr);
    assert.match(res.stderr, /REFUSING re-pin/);
    assert.match(res.stderr, /dsh\/issue-276-work/, "the note names the branch");
    assert.equal(f.onBranch(), "dsh/issue-276-work", "HEAD still on the working branch");
    assert.equal(f.head(), f.revA, "HEAD unmoved");
  } finally {
    f.cleanUp();
  }
});

test("a clean tree ON main re-pins (the fresh-clone state is movable)", () => {
  const f = fixture();
  try {
    f.advance();
    assert.equal(f.onBranch(), "main", "clone sits on main");
    const res = runScript(f.box);
    assert.equal(res.status, 0, res.stderr);
    assert.equal(f.onBranch(), "", "detached at the pin, as the keepalive leaves it");
    assert.equal(f.head(), git(f.box, ["rev-parse", "v1"]).stdout.trim());
  } finally {
    f.cleanUp();
  }
});

test("untracked files never block the re-pin and survive it", () => {
  const f = fixture();
  try {
    f.detachAtPin();
    const scratch = path.join(f.box, "gate-evidence.txt");
    writeFileSync(scratch, "scratch\n");
    const res = runScript(f.box);
    assert.equal(res.status, 0, res.stderr);
    assert.ok(existsSync(scratch), "checkout --force does not touch untracked files");
    assert.equal(readFileSync(scratch, "utf8"), "scratch\n");
  } finally {
    f.cleanUp();
  }
});

test("fetch failure degrades (exit 4, previous pin kept, tree untouched)", () => {
  const f = fixture();
  try {
    f.detachAtPin();
    gitSetup(f.box, ["remote", "set-url", "origin", path.join(f.dir, "no-such-origin.git")]);
    const res = runScript(f.box);
    assert.equal(res.status, 4, res.stderr);
    assert.match(res.stderr, /fetch failed/);
    assert.equal(f.head(), f.revA, "previous pin kept");
  } finally {
    f.cleanUp();
  }
});

test("usage failures are typed (exit 2): no dir, and not a git checkout", () => {
  const f = fixture();
  try {
    const noDir = spawnSync("bash", [SCRIPT], {
      encoding: "utf8",
      env: { ...HERMETIC_ENV, DSH_AGENT_TOOLKIT_DIR: "" },
    });
    assert.equal(noDir.status, 2, noDir.stderr);
    assert.match(noDir.stderr, /no toolkit dir/);

    const notGit = spawnSync("bash", [SCRIPT, f.dir], { encoding: "utf8", env: HERMETIC_ENV });
    assert.equal(notGit.status, 2, notGit.stderr);
    assert.match(notGit.stderr, /not a git checkout/);
  } finally {
    f.cleanUp();
  }
});
