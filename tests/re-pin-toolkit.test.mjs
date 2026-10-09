// re-pin-toolkit.test.mjs — hermetic tests for scripts/re-pin-toolkit.sh
// (issues #276 + #614).
//
// The keepalive's re-pin arm used to run inline in the cron line:
// `git fetch --tags --force && git checkout -q --force v1` — every minute,
// unconditionally, against the SHARED toolkit checkout a lane agent may be
// editing in place. When drift-check advanced v1, the next tick destroyed
// the in-flight work (the #276 receipt: two resets in ~10 minutes on
// seed-L3). These tests pin the guarded behavior with REAL git against a
// local bare origin (no network): the destructive half only runs on a
// clean tree; tracked modifications refuse LOUDLY (exit 3, note to
// stderr) with the tree and HEAD intact — the absolute gate; fetch/
// checkout/stamp failures degrade (exit 4) without touching anything;
// success is QUIET on the steady state.
//
// Issue #614 extends the contract into the standing checkout's
// CONVERGENCE arm: the #276 working-branch refusal parked a drifted box
// FOREVER (the air16 receipt: `dsh/issue-530-c6027819073` [ahead 1,
// behind 6 of origin/main] across a behavior change it never received).
// A CLEAN tree on a working branch is residue, not live work — the pins
// below hold the no-destroy property (the branch ref survives with its
// tip; the unpushed commit stays recoverable) and the loudness property
// (the converge note names the branch, the drift counts, and the
// recovery command), plus the stamp: every landing rewrites the
// untracked `.toolkit-pin-stamp` so a box's drift state is answerable
// on the box.

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

const runScript = (dir, args = []) =>
  spawnSync("bash", [SCRIPT, ...args], { encoding: "utf8", env: { ...HERMETIC_ENV, DSH_AGENT_TOOLKIT_DIR: dir } });

const commitFile = (cwd, name, body) => {
  writeFileSync(path.join(cwd, name), body);
  git(cwd, ["add", name]);
  return git(cwd, ["commit", "-m", `add ${name}`]);
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
  git(seed, ["init", "--quiet", "--initial-branch=main"]);
  commitFile(seed, "settings.zai.yaml", "# template v1\n");
  git(seed, ["clone", "--quiet", "--bare", ".", origin]);
  git(seed, ["push", "--quiet", origin, "main"]);
  git(seed, ["tag", "v1"]);
  git(seed, ["push", "--quiet", origin, "v1"]);
  spawnSync("git", ["clone", "--quiet", origin, box], { encoding: "utf8", env: HERMETIC_ENV });
  const rev = (ref) => git(box, ["rev-parse", ref]).stdout.trim();
  return {
    dir, origin, seed, box,
    revA: rev("v1"),
    advance: () => {
      commitFile(seed, "drift.md", "# next release\n");
      git(seed, ["push", "--quiet", origin, "main"]);
      git(seed, ["tag", "-f", "v1"]);
      git(seed, ["push", "--quiet", "--force", origin, "v1"]);
    },
    detachAtPin: () => git(box, ["checkout", "--quiet", "v1"]),
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
  assert.match(src, /symbolic-ref -q --short HEAD/, "the working-branch snapshot feeding the converge arm");
  assert.match(src, /GIT_OPTIONAL_LOCKS=0/, "never takes the index lock under a working agent");
  assert.match(src, /issue #276/, "the receipt is cited where the behavior lives");
});

test("source pin: the convergence arm + stamp exist and cite issue #614", () => {
  const src = readFileSync(SCRIPT, "utf8");
  assert.match(src, /CONVERGING/, "the converge note is loud (the one LOUD success)");
  assert.match(src, /issue #614/, "the receipt is cited where the converge arm lives");
  assert.match(src, /\.toolkit-pin-stamp/, "the stamp lands at the checkout root");
  assert.match(src, /rev-list --count HEAD\.\.origin\/main/, "the drift poll answers against origin/main (deploy-drift's comparison base)");
  assert.match(src, /decision=\$\{DECISION\}/, "the stamp records the decision");
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
    git(f.box, ["checkout", "--", "settings.zai.yaml"]);
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
    git(f.box, ["add", "settings.zai.yaml"]);
    const res = runScript(f.box);
    assert.equal(res.status, 3, res.stderr);
    assert.match(res.stderr, /REFUSING re-pin/);
    assert.equal(readFileSync(file, "utf8"), "# staged edit\n", "staged work survives");
  } finally {
    f.cleanUp();
  }
});

test("issue #614: a clean working branch CONVERGES loudly; the branch ref survives, nothing discarded", () => {
  const f = fixture();
  try {
    f.detachAtPin();
    git(f.box, ["checkout", "--quiet", "-b", "dsh/issue-276-work"]);
    const res = runScript(f.box);
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stderr, /CONVERGING/, "the converge is the one LOUD success — a HEAD move on the shared checkout must be visible in worker.log");
    assert.match(res.stderr, /dsh\/issue-276-work/, "the note names the branch");
    assert.match(res.stderr, /issue #614/, "the note names the class");
    assert.match(res.stderr, /git -C .*checkout .*dsh\/issue-276-work/, "the note carries the exact recovery command");
    assert.equal(f.onBranch(), "", "detached at the pin, as the keepalive leaves it");
    assert.equal(f.head(), git(f.box, ["rev-parse", "v1"]).stdout.trim(), "HEAD sits exactly at the pin");
    // the no-destroy property: the branch ref survives with its tip —
    // converging moves HEAD only, it discards nothing
    assert.equal(
      git(f.box, ["rev-parse", "refs/heads/dsh/issue-276-work"]).stdout.trim(),
      f.revA,
      "the branch ref survives with exactly the tip the residue left",
    );
    // and the recovery command from the note restores the residue intact
    git(f.box, ["checkout", "--quiet", "dsh/issue-276-work"]);
    assert.equal(f.head(), f.revA, "checking the branch back out restores the residue verbatim");
  } finally {
    f.cleanUp();
  }
});

test("issue #614: the air16 shape — a branch [ahead 1, behind 1] of origin/main converges and the UNPUSHED commit stays recoverable", () => {
  const f = fixture();
  try {
    f.detachAtPin();
    git(f.box, ["checkout", "--quiet", "-b", "dsh/issue-530-c6027819073"]);
    commitFile(f.box, "residue.md", "# local-only work never pushed\n");
    f.advance(); // origin/main + v1 move on; the residue branch stays parked
    const branchTip = git(f.box, ["rev-parse", "HEAD"]).stdout.trim();
    const res = runScript(f.box);
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stderr, /1 commit\(s\) not on origin\/main, 1 behind/, "the note carries the drift counts");
    assert.equal(f.head(), git(f.box, ["rev-parse", "v1"]).stdout.trim(), "HEAD converged onto the fresh pin");
    // the unpushed commit survives on its ref — checkout --force touched
    // only HEAD, so the never-pushed work is one checkout away
    assert.equal(
      git(f.box, ["rev-parse", "refs/heads/dsh/issue-530-c6027819073"]).stdout.trim(),
      branchTip,
      "the branch ref keeps the unpushed commit",
    );
    git(f.box, ["checkout", "--quiet", "dsh/issue-530-c6027819073"]);
    assert.equal(
      readFileSync(path.join(f.box, "residue.md"), "utf8"),
      "# local-only work never pushed\n",
      "the unpushed work is recoverable verbatim",
    );
  } finally {
    f.cleanUp();
  }
});

test("the absolute gate holds on a working branch too: tracked modifications refuse BEFORE any converge", () => {
  const f = fixture();
  try {
    f.detachAtPin();
    git(f.box, ["checkout", "--quiet", "-b", "dsh/issue-614-dirty"]);
    const file = path.join(f.box, "settings.zai.yaml");
    writeFileSync(file, "# mid-edit on a branch\n");
    const res = runScript(f.box);
    assert.equal(res.status, 3, res.stderr);
    assert.match(res.stderr, /REFUSING re-pin/, "the refusal is loud");
    assert.equal(f.onBranch(), "dsh/issue-614-dirty", "HEAD kept on the working branch");
    assert.equal(readFileSync(file, "utf8"), "# mid-edit on a branch\n", "the mid-edit work SURVIVES");
    assert.ok(!existsSync(path.join(f.box, ".toolkit-pin-stamp")), "a refused sweep stamps nothing (the landing never happened)");
  } finally {
    f.cleanUp();
  }
});

test("issue #614: every landing writes the pin stamp — re-pinned and converged both, with the drift counts", () => {
  const f = fixture();
  const stampPath = () => path.join(f.box, ".toolkit-pin-stamp");
  const readStamp = () =>
    Object.fromEntries(
      readFileSync(stampPath(), "utf8")
        .trim()
        .split("\n")
        .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
    );
  try {
    f.detachAtPin(); // steady state: detached at the previous pin
    f.advance(); // origin/main + v1 move on; HEAD stays at the old pin
    let res = runScript(f.box);
    assert.equal(res.status, 0, res.stderr);
    let stamp = readStamp();
    assert.equal(stamp.decision, "re-pinned");
    assert.equal(stamp.head, git(f.box, ["rev-parse", "v1"]).stdout.trim(), "head == the landed pin (deploy-drift's 'is the remote tip landed' answer)");
    assert.equal(stamp.prev_head, f.revA, "the previous pin is recorded");
    assert.equal(stamp.pin_v1, git(f.box, ["rev-parse", "v1"]).stdout.trim());
    assert.match(stamp.at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/, "the stamp is UTC");

    // the air16 shape again: converge stamps the residue state. The
    // fixture's advance() writes a FIXED content — a second call would be
    // an empty no-op commit — so this leg advances origin with fresh
    // content explicitly.
    git(f.box, ["checkout", "--quiet", "-b", "dsh/issue-530-x"]);
    commitFile(f.box, "residue.md", "# local-only\n");
    writeFileSync(path.join(f.seed, "drift.md"), "# second release\n");
    git(f.seed, ["add", "drift.md"]);
    git(f.seed, ["commit", "--quiet", "-m", "second release"]);
    git(f.seed, ["push", "--quiet", f.origin, "main"]);
    git(f.seed, ["tag", "-f", "v1"]);
    git(f.seed, ["push", "--quiet", "--force", f.origin, "v1"]);
    res = runScript(f.box);
    assert.equal(res.status, 0, res.stderr);
    stamp = readStamp();
    assert.equal(stamp.decision, "converged");
    assert.equal(stamp.branch, "dsh/issue-530-x", "the stamp names the residue branch");
    assert.equal(stamp.prev_head, git(f.box, ["rev-parse", "refs/heads/dsh/issue-530-x"]).stdout.trim());
    assert.equal(stamp.behind_main, "1", "behind origin/main");
    assert.equal(stamp.ahead_main, "1", "ahead of origin/main");

    // the stamp is untracked: a later sweep neither blocks on it nor
    // removes it — it just gets rewritten
    const third = runScript(f.box);
    assert.equal(third.status, 0, third.stderr);
    assert.equal(readStamp().decision, "re-pinned", "the stamp survives its own next write");
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
    git(f.box, ["remote", "set-url", "origin", path.join(f.dir, "no-such-origin.git")]);
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
