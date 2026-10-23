// harness-drift.test.mjs — hermetic tests for scripts/harness-drift.sh
// (issue #616).
//
// The node home's deploy-drift (FleetTower #776) reconciles the NODE HOME
// only. The HARNESS checkout — the tree whose run-dsh-agent.sh spawns every
// dispatched session — had no stamp, no compare, and no self-heal: air16's
// sat 10 days behind while the node home beside it converged within minutes
// of every main landing, and nothing could answer "what wrapper version
// spawned this session" (the FleetTower#2047 diagnosis needed a node-side
// ssh session to pin it). These tests pin the wrapper-sized contract with
// REAL git against a local bare origin (no network):
//
//   STAMP    scripts/HARNESS_DEPLOYED_SHA beside the wrapper — sha, short,
//            ref, committed_at, stamped_at; refreshed after every heal.
//   COMPARE  one ls-remote round trip against the expected ref: the
//            checkout's branch, or the tag a detached pin sits on (the
//            keepalive regime); a differing tip is drift.
//   HEAL     fast-forward ONLY. Dirty tree, working branch, local commits
//            ("ahead"), diverged head, and a fresh lock all REFUSE (exit 3,
//            loud note, HEAD + tree kept); fetch failures degrade (exit 4);
//            a bare detached HEAD (a CI merge ref — no own identity) is
//            skipped quietly unless DSH_HARNESS_DRIFT_REF names the ref.
//   SURFACES the driver boots the arm before the input scrub, relays the
//            verdict into the setup group, stamps harness_* into
//            boot-tombstones.jsonl and DSH_RUN_HARNESS_* into
//            dsh-run-meta.env, whose wrapper= field rides every posted
//            artifact (post-reply / ship-changes / review-pr).

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, readFileSync, existsSync, utimesSync, cpSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(ROOT, "scripts", "harness-drift.sh");
const DRIVER = path.join(ROOT, "scripts", "run-dsh-agent.sh");

// Hermetic-but-ambient git env (the re-pin-toolkit.test.mjs pattern): the
// lane's PATH `git` may be the driver's scrub shim, so INHERIT the ambient
// environment and neutralize only the git config layering.
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

const runScript = (dir, sub, args = [], extraEnv = {}) =>
  spawnSync("bash", [SCRIPT, sub, dir, ...args], {
    encoding: "utf8",
    env: { ...HERMETIC_ENV, ...extraEnv },
  });

const commitFile = (cwd, name, body) => {
  writeFileSync(path.join(cwd, name), body);
  git(cwd, ["add", name]);
  return git(cwd, ["commit", "-m", `add ${name}`]);
};

const stampPath = (box) => path.join(box, "scripts", "HARNESS_DEPLOYED_SHA");
const readStamp = (box) => {
  const p = stampPath(box);
  if (!existsSync(p)) return null;
  const out = {};
  for (const line of readFileSync(p, "utf8").split("\n")) {
    const m = /^([a-z_]+)=(.*)$/.exec(line);
    if (m) out[m[1]] = m[2];
  }
  return out;
};

/**
 * A box-side fixture: a bare origin (main at A, tag v1 → A) and a clone of
 * it (the harness checkout, sitting on main at A), plus `advance()` which
 * moves origin's main to B and force-moves v1 to B — exactly what a main
 * landing does to every harness box, and what drift-check does to the v1
 * pin on a release.
 */
const fixture = () => {
  const dir = mkdtempSync(path.join(tmpdir(), "harness-drift-test-"));
  const origin = path.join(dir, "origin.git");
  const seed = path.join(dir, "seed");
  const box = path.join(dir, "harness");
  mkdirSync(seed, { recursive: true });
  git(seed, ["init", "--quiet", "--initial-branch=main"]);
  commitFile(seed, "run-dsh-agent.sh", "#!/usr/bin/env bash\n# v1\n");
  mkdirSync(path.join(seed, "scripts"));
  writeFileSync(path.join(seed, "scripts", "wrapper.sh"), "#!/bin/sh\n");
  git(seed, ["add", "scripts/wrapper.sh"]);
  git(seed, ["commit", "-m", "add scripts/wrapper.sh"]);
  git(seed, ["clone", "--quiet", "--bare", ".", origin]);
  git(seed, ["push", "--quiet", origin, "main"]);
  git(seed, ["tag", "v1"]);
  git(seed, ["push", "--quiet", origin, "v1"]);
  spawnSync("git", ["clone", "--quiet", origin, box], { encoding: "utf8", env: HERMETIC_ENV });
  const rev = (ref) => git(box, ["rev-parse", ref]).stdout.trim();
  // origin TRUTH resolves from the seed (the box's tags/remote-tracking
  // refs are stale until a fetch moves them — asserting against the box's
  // stale v1 after a heal moved it would compare A to B)
  const seedRev = (ref) => git(seed, ["rev-parse", ref]).stdout.trim();
  return {
    dir, origin, seed, box,
    revA: rev("v1"),
    rev,
    seedRev,
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

// ------------------------------- STAMP ---------------------------------------

test("stamp: writes sha/short/ref/committed_at/stamped_at beside the wrapper; re-stamp refreshes", () => {
  const f = fixture();
  try {
    const r1 = runScript(f.box, "stamp");
    assert.equal(r1.status, 0, `stamp failed: ${r1.stderr}`);
    const s1 = readStamp(f.box);
    assert.equal(s1.sha, f.revA, "stamp records the full checkout sha");
    assert.equal(s1.short, f.revA.slice(0, 7), "stamp records the short sha");
    assert.equal(s1.ref, "main", "stamp records the expected ref (the branch)");
    assert.ok(/^\d{4}-\d{2}-\d{2}T/.test(s1.committed_at), "stamp records the commit date");
    assert.ok(/^\d{4}-\d{2}-\d{2}T/.test(s1.stamped_at), "stamp records the stamp time");
    // re-stamp after a move refreshes to the new head
    f.advance();
    git(f.box, ["fetch", "--quiet", "origin", "main"]);
    git(f.box, ["merge", "--quiet", "--ff-only", "origin/main"]);
    const r2 = runScript(f.box, "stamp");
    assert.equal(r2.status, 0);
    assert.equal(readStamp(f.box).sha, f.head(), "re-stamp records the moved head");
  } finally {
    f.cleanUp();
  }
});

// ------------------------------- CHECK ---------------------------------------

test("check: fresh at tip → exit 0 / verdict=fresh; behind origin → exit 1 / verdict=drift", () => {
  const f = fixture();
  try {
    const r1 = runScript(f.box, "check");
    assert.equal(r1.status, 0);
    assert.match(r1.stdout, /verdict=fresh/);
    f.advance();
    const r2 = runScript(f.box, "check");
    assert.equal(r2.status, 1, "a differing tip is drift");
    assert.match(r2.stderr, /DRIFT/);
    assert.match(r2.stdout, /verdict=drift/);
  } finally {
    f.cleanUp();
  }
});

test("check: unreachable origin degrades (exit 4, verdict=degraded), never lies fresh", () => {
  const f = fixture();
  try {
    git(f.box, ["remote", "set-url", "origin", path.join(f.dir, "vanished.git")]);
    const r = runScript(f.box, "check");
    assert.equal(r.status, 4);
    assert.match(r.stdout, /verdict=degraded/);
  } finally {
    f.cleanUp();
  }
});

// -------------------------------- HEAL — the keepalive (detached-at-tag) regime

test("heal: stale detached-at-tag checkout fast-forwards to the moved tag and re-stamps (the air16 shape, keepalive regime)", () => {
  const f = fixture();
  try {
    f.detachAtPin();
    f.advance();
    // an untracked scratch file survives the heal (checkout --force keeps it)
    writeFileSync(path.join(f.box, "scripts", "scratch.txt"), "untracked\n");
    const r = runScript(f.box, "heal");
    assert.equal(r.status, 0, `heal failed: ${r.stderr}`);
    assert.match(r.stdout, /verdict=healed/);
    assert.match(r.stdout, /self-updated \S+ to [0-9a-f]{7}/);
    assert.equal(f.head(), f.rev("v1"), "HEAD moved to the advanced tag");
    assert.equal(git(f.box, ["describe", "--tags", "--exact-match"]).stdout.trim(), "v1");
    assert.equal(readStamp(f.box).sha, f.head(), "the stamp was refreshed to the new head");
    assert.ok(existsSync(path.join(f.box, "scripts", "scratch.txt")), "untracked files survive");
  } finally {
    f.cleanUp();
  }
});

test("heal: fresh detached-at-tag checkout is a quiet no-op (still stamps)", () => {
  const f = fixture();
  try {
    f.detachAtPin();
    const r = runScript(f.box, "heal");
    assert.equal(r.status, 0);
    assert.match(r.stdout, /verdict=fresh/);
    assert.doesNotMatch(r.stdout, /self-updated/);
    assert.equal(readStamp(f.box).sha, f.revA, "fresh boots bootstrap the stamp");
  } finally {
    f.cleanUp();
  }
});

// -------------------------------- HEAL — the main-branch regime ----------------

test("heal: stale main-tracking checkout fast-forwards the branch (no merge commit) — the clone-once-then-drift shape", () => {
  const f = fixture();
  try {
    f.advance();
    assert.equal(f.onBranch(), "main");
    const r = runScript(f.box, "heal");
    assert.equal(r.status, 0, `heal failed: ${r.stderr}`);
    assert.match(r.stdout, /verdict=healed/);
    assert.equal(f.head(), f.rev("origin/main"));
    const parents = git(f.box, ["log", "--format=%P", "-n", "1", "HEAD"]).stdout.trim();
    assert.ok(!parents.includes(" "), "the fast-forward left no merge commit");
    assert.equal(readStamp(f.box).sha, f.head());
  } finally {
    f.cleanUp();
  }
});

test("heal: a shallow clone still heals (the depth-1 harness checkout shape)", () => {
  const f = fixture();
  try {
    const shallow = path.join(f.dir, "harness-shallow");
    spawnSync("git", ["clone", "--quiet", "--depth", "1", f.origin, shallow], { encoding: "utf8", env: HERMETIC_ENV });
    f.advance();
    const r = runScript(shallow, "heal");
    assert.equal(r.status, 0, `shallow heal failed: ${r.stderr}`);
    assert.match(r.stdout, /verdict=healed/);
    assert.equal(git(shallow, ["rev-parse", "HEAD"]).stdout.trim(), f.seedRev("v1"));
  } finally {
    f.cleanUp();
  }
});

// -------------------------------- HEAL — refusals -----------------------------

test("heal: REFUSES a dirty tree (exit 3, HEAD + modification kept) — the #276 class", () => {
  const f = fixture();
  try {
    f.advance();
    writeFileSync(path.join(f.box, "run-dsh-agent.sh"), "# mid-edit agent work\n");
    const r = runScript(f.box, "heal");
    assert.equal(r.status, 3);
    assert.match(r.stderr, /REFUSING heal[\s\S]*tracked-file modifications/);
    assert.match(r.stdout, /verdict=refused-dirty/);
    assert.equal(f.head(), f.revA, "HEAD was kept");
    assert.match(readFileSync(path.join(f.box, "run-dsh-agent.sh"), "utf8"), /mid-edit agent work/, "the edit was kept");
    assert.equal(readStamp(f.box), null, "a refused heal stamps nothing");
  } finally {
    f.cleanUp();
  }
});

test("heal: REFUSES a working branch (exit 3, HEAD kept)", () => {
  const f = fixture();
  try {
    f.advance();
    git(f.box, ["checkout", "-q", "-b", "agent-work"]);
    const r = runScript(f.box, "heal");
    assert.equal(r.status, 3);
    assert.match(r.stderr, /REFUSING heal[\s\S]*branch 'agent-work'/);
    assert.match(r.stdout, /verdict=refused-branch/);
    assert.equal(f.onBranch(), "agent-work");
    assert.equal(f.head(), f.revA, "HEAD was kept");
  } finally {
    f.cleanUp();
  }
});

test("heal: REFUSES a diverged head (local commit vs advanced origin) and keeps the local commit", () => {
  const f = fixture();
  try {
    commitFile(f.box, "local.md", "local work\n");
    const localHead = f.head();
    f.advance();
    const r = runScript(f.box, "heal");
    assert.equal(r.status, 3);
    assert.match(r.stderr, /DIVERGED/);
    assert.match(r.stdout, /verdict=diverged/);
    assert.equal(f.head(), localHead, "the local commit was kept");
  } finally {
    f.cleanUp();
  }
});

test("heal: REFUSES a head AHEAD of origin (local commits are never auto-moved)", () => {
  const f = fixture();
  try {
    commitFile(f.box, "local.md", "local work\n");
    const localHead = f.head();
    const r = runScript(f.box, "heal");
    assert.equal(r.status, 3);
    assert.match(r.stderr, /AHEAD/);
    assert.match(r.stdout, /verdict=ahead/);
    assert.equal(f.head(), localHead);
  } finally {
    f.cleanUp();
  }
});

// -------------------------------- HEAL — the lock ------------------------------

test("heal: REFUSES while a fresh drift lock is held; takes over a STALE one", () => {
  const f = fixture();
  try {
    f.advance();
    const lockDir = path.join(f.box, ".git", "harness-drift.lock");
    mkdirSync(lockDir, { recursive: true });
    const r1 = runScript(f.box, "heal");
    assert.equal(r1.status, 3);
    assert.match(r1.stderr, /drift lock/);
    assert.match(r1.stdout, /verdict=refused-lock/);
    assert.equal(f.head(), f.revA, "HEAD was kept behind a fresh lock");
    utimesSync(lockDir, new Date(Date.now() - 700_000), new Date(Date.now() - 700_000));
    const r2 = runScript(f.box, "heal");
    assert.equal(r2.status, 0, `stale-lock takeover failed: ${r2.stderr}`);
    assert.match(r2.stdout, /verdict=healed/);
    assert.equal(f.head(), f.seedRev("v1"));
    assert.ok(!existsSync(lockDir), "the lock is released on exit");
  } finally {
    f.cleanUp();
  }
});

// -------------------------------- HEAL — the regime gate -----------------------

test("heal: a BARE detached head (no branch, no exact tag) is skipped quietly; DSH_HARNESS_DRIFT_REF forces it", () => {
  const f = fixture();
  try {
    f.advance();
    // detach at the untagged root commit: no branch, no exact tag
    git(f.box, ["checkout", "--quiet", "--detach", "v1^"]);
    const rootRev = f.rev("HEAD");
    const r1 = runScript(f.box, "heal");
    assert.equal(r1.status, 0, "a skip is not a failure");
    assert.match(r1.stdout, /verdict=skipped-detached/);
    assert.equal(f.head(), rootRev, "nothing moved");
    const r2 = runScript(f.box, "heal", [], { DSH_HARNESS_DRIFT_REF: "main" });
    assert.equal(r2.status, 0, `forced heal failed: ${r2.stderr}`);
    assert.match(r2.stdout, /verdict=healed/);
    assert.equal(f.head(), f.seedRev("main"));
  } finally {
    f.cleanUp();
  }
});

test("heal: an expected ref missing on origin degrades (exit 4), keeping the tree", () => {
  const f = fixture();
  try {
    // bare detached + an explicit ref: the regime gate passes on the
    // override, the branch probe finds nothing, the outcome is degraded —
    // never a silent fresh, never a move
    git(f.box, ["checkout", "--quiet", "--detach", "v1^"]);
    const rootRev = f.rev("HEAD");
    const r = runScript(f.box, "heal", [], { DSH_HARNESS_DRIFT_REF: "no-such-branch" });
    assert.equal(r.status, 4);
    assert.match(r.stdout, /verdict=degraded/);
    assert.equal(f.head(), rootRev);
  } finally {
    f.cleanUp();
  }
});

test("heal: a working branch refuses before any network leg (the compare ref is the deploy ref, never the incidental branch)", () => {
  const f = fixture();
  try {
    git(f.box, ["checkout", "-q", "-b", "agent-work"]);
    const r = runScript(f.box, "heal");
    assert.equal(r.status, 3);
    assert.match(r.stdout, /verdict=refused-branch/);
    assert.equal(f.onBranch(), "agent-work");
    assert.equal(f.head(), f.revA);
  } finally {
    f.cleanUp();
  }
});

// ------------------------------- USAGE ---------------------------------------

test("usage: a bad subcommand or a non-checkout dir is a typed exit 2", () => {
  const f = fixture();
  try {
    assert.equal(runScript(f.box, "explode").status, 2);
    assert.equal(runScript(path.join(f.dir, "not-a-checkout"), "check").status, 2);
  } finally {
    f.cleanUp();
  }
});

// ------------------------------- DRIVER WIRING --------------------------------

// A driver execution against a LOCAL bare origin: the launcher copy carries
// the arm, `base` is a stale clone of the bare origin, every external the
// boot needs is a stub (doppler passes through, dsh fails fast so the
// tombstone path runs). The driver's own network-free needs are stubbed;
// the arm's git legs run REAL against the local origin.
const driverFixture = () => {
  const f = fixture();
  const base = path.join(f.dir, "base");
  const bin = path.join(f.dir, "bin");
  const home = path.join(f.dir, "home");
  const runnerTemp = path.join(f.dir, "runner");
  const argsFile = path.join(f.dir, "dsh-args.txt");
  mkdirSync(bin);
  mkdirSync(runnerTemp);
  mkdirSync(home);
  // the launcher closure (search-compose-mount's list) + the drift arm.
  // CLONE FIRST, overlay second: git refuses to clone into a non-empty
  // dir, so a pre-populated base silently stays a non-checkout and the
  // arm (needing .git) would skip instead of heal.
  spawnSync("git", ["clone", "--quiet", f.origin, base], { encoding: "utf8", env: HERMETIC_ENV });
  mkdirSync(path.join(base, "scripts"), { recursive: true });
  for (const rel of [
    "run-dsh-agent.sh",
    "harness-drift.sh",
    "scrub-output.mjs",
    "settings-write.mjs",
    "settings-normalize.mjs",
    "lane-settings-guard.mjs",
    "dsh-progress.mjs",
  ]) {
    cpSync(path.join(ROOT, "scripts", rel), path.join(base, "scripts", rel));
  }
  mkdirSync(path.join(base, "config"), { recursive: true });
  cpSync(path.join(ROOT, "config", "settings.zai.yaml"), path.join(base, "config", "settings.zai.yaml"));
  f.advance();
  writeFileSync(path.join(bin, "doppler"), "#!/bin/sh\nshift; shift\nexec \"$@\"\n");
  writeFileSync(path.join(bin, "dsh"), [
    "#!/bin/sh",
    'case "$1" in --version) echo "dsh-stub-0.0.0" >&2; exit 0;; esac',
    'printf "%s\\n" "$@" >> "$STUB_ARGS_FILE"',
    'echo "stub dsh dies fast" >&2',
    "exit 7",
  ].join("\n") + "\n");
  writeFileSync(path.join(bin, "gh"), "#!/bin/sh\nexit 0\n");
  writeFileSync(path.join(bin, "zstd"), "#!/bin/sh\nexit 1\n");
  for (const name of readdirSync(bin)) spawnSync("chmod", ["+x", path.join(bin, name)]);
  return {
    ...f, base, bin, home, runnerTemp, argsFile,
    env: () => ({
      ...HERMETIC_ENV,
      PATH: `${bin}:${process.env.PATH}`,
      HOME: f.dir,
      RUNNER_TEMP: runnerTemp,
      DOPPLER_SERVICE_TOKEN: "stub-token",
      DSH_HOME: home,
      DSH_KEEP_SESSIONS: "",
      DSH_RETRY_BACKOFF_S: "0", // tests-lint rule 2: every driver spawn pins the seam
      DSH_SPAWN_ATTEMPTS: "1",
      STUB_ARGS_FILE: argsFile,
      CELL_PROBE_DIRS: "",
      DSH_LANE_PLUGINS_MANIFEST: path.join(ROOT, "tests", "fixtures", "lane-plugins-hermetic.json"),
      GH_BIN: path.join(bin, "gh"),
      DOPPLER_BIN: path.join(bin, "doppler"),
    }),
  };
};

test("integration: the driver boots the arm — stale clone heals, the boot log + meta + tombstone carry the wrapper signature", () => {
  const f = driverFixture();
  try {
    const proc = spawnSync(
      "bash",
      [path.join(f.base, "scripts", "run-dsh-agent.sh"), "implement the drift stamp (issue #616)"],
      {
        encoding: "utf8",
        // tests-lint rule 2: the pin at the spawn site — f.env() already
        // carries it, but the lint resolves only in-file literals
        env: { ...f.env(), DSH_RETRY_BACKOFF_S: "0" },
        timeout: 120_000,
      },
    );
    // the stub dsh dies (exit 7, 1 attempt) — the driver must still surface ITS code
    assert.equal(proc.status, 7, `driver exit: ${proc.status}\nstderr: ${proc.stderr?.slice(-2000)}`);
    // STAMP: the heal moved the stale clone and wrote the stamp beside the wrapper
    const stamp = readStamp(f.base);
    assert.ok(stamp, "the boot wrote the stamp beside the wrapper");
    assert.equal(stamp.sha, f.seedRev("main"), "the stamp records the healed head");
    assert.equal(stamp.ref, "main");
    // LOUD: the boot log relays the verdict + the signature line
    assert.match(proc.stderr, /self-updated \S+ to [0-9a-f]{7}/, "the heal verdict rides the boot log");
    assert.match(proc.stderr, /harness checkout: [0-9a-f]{7} ref=main drift=healed/, "the signature line rides the setup group");
    // the run meta carries the wrapper sha for the posted artifacts
    const meta = readFileSync(path.join(f.runnerTemp, "dsh-run-meta.env"), "utf8");
    assert.match(meta, new RegExp(`DSH_RUN_HARNESS_SHA=${stamp.sha}`));
    assert.match(meta, /DSH_RUN_HARNESS_REF=main/);
    assert.match(meta, /DSH_RUN_HARNESS_DRIFT=healed/);
    // the boot tombstone carries the harness signature (real JSON)
    const tomb = readFileSync(path.join(f.home, "boot-tombstones.jsonl"), "utf8").trim().split("\n");
    assert.equal(tomb.length, 1, "one failed attempt → one tombstone");
    const rec = JSON.parse(tomb[0]);
    assert.equal(rec.exit_code, 7);
    assert.equal(rec.harness_sha, stamp.sha);
    assert.equal(rec.harness_ref, "main");
    assert.equal(rec.harness_drift, "healed");
  } finally {
    f.cleanUp();
  }
});

test("source pin: the driver boots the arm BEFORE the input scrub and surfaces the stamp", () => {
  const src = readFileSync(DRIVER, "utf8");
  const armAt = src.indexOf('harness-drift.sh" heal');
  const scrubAt = src.indexOf('scrub-output.mjs"');
  assert.ok(armAt > 0, "the driver must call the heal arm");
  assert.ok(scrubAt > armAt, "the heal must run before anything spawns scripts from the tree (input scrub)");
  assert.match(src, /DSH_HARNESS_DRIFT:-1}" = "0"/, "DSH_HARNESS_DRIFT=0 disables the arm");
  assert.match(src, /harness checkout: /, "the boot log carries the harness signature line");
  assert.match(src, /DSH_RUN_HARNESS_SHA=/, "dsh-run-meta.env carries the wrapper sha");
  assert.match(src, /"harness_sha":"%s","harness_ref":"%s","harness_drift":"%s"/, "boot-tombstones carry the harness signature");
});

test("source pin: the arm keeps its fast-forward-only contract and loud refusals", () => {
  const src = readFileSync(SCRIPT, "utf8");
  assert.match(src, /merge --ff-only/, "branch heals fast-forward only");
  assert.match(src, /merge-base --is-ancestor/, "the ancestry proof gates every move");
  assert.match(src, /refused-dirty/, "the dirty-tree refusal is a named verdict");
  assert.match(src, /refused-branch/, "the working-branch refusal is a named verdict");
  assert.match(src, /say diverged/, "a diverged head refuses under its own name");
  assert.match(src, /say refused-lock/, "a contended lock refuses under its own name");
  assert.match(src, /GIT_OPTIONAL_LOCKS=0/, "never takes the index lock under a working agent");
  assert.match(src, /GIT_HTTP_LOW_SPEED/, "network legs carry stall bounds (a wedged egress must not wedge the boot)");
  assert.doesNotMatch(src, /checkout -q --force "\$TIP"/, "no blind force-checkout at a fetched sha — only the tag name or a proven fast-forward");
});

test("source pin: the posted artifacts stamp the wrapper sha", () => {
  for (const [file, marker] of [
    ["post-reply.sh", /wrapper: \$\{DSH_RUN_HARNESS_SHA:-unknown\}/],
    ["ship-changes.sh", /wrapper=\$\{DSH_RUN_HARNESS_SHA:-unknown\}/],
    ["review-pr.sh", /wrapper: \$\{DSH_RUN_HARNESS_SHA:-unknown\}/],
  ]) {
    const src = readFileSync(path.join(ROOT, "scripts", file), "utf8");
    assert.match(src, marker, `${file} must carry the wrapper= stamp (issue #616)`);
  }
});

test("the stamp is gitignored runtime state, never repo content", () => {
  const gi = readFileSync(path.join(ROOT, ".gitignore"), "utf8");
  assert.match(gi, /^scripts\/HARNESS_DEPLOYED_SHA$/m, ".gitignore must ignore the per-checkout stamp");
  const st = spawnSync("git", ["-C", ROOT, "check-ignore", "-q", "scripts/HARNESS_DEPLOYED_SHA"], { encoding: "utf8" });
  assert.equal(st.status, 0, "git check-ignore confirms the stamp never dirties a harness checkout");
});

test("harness-drift.sh parses (bash -n)", () => {
  const r = spawnSync("bash", ["-n", SCRIPT], { encoding: "utf8" });
  assert.equal(r.status, 0, `bash -n failed: ${r.stderr}`);
});

test("source pin: the driver guards the arm by -f (the arm ships 644, bash-invoked)", () => {
  // an exec-bit probe on a 644-committed script silently disables the arm
  // on every fresh checkout — the guard must be file-existence, and the
  // invocation must stay `bash <script>` (re-pin-toolkit.sh's convention)
  const src = readFileSync(DRIVER, "utf8");
  assert.match(src, /\[ -f "\$SCRIPT_DIR\/harness-drift\.sh" \]/, "the arm is guarded by -f, not -x");
  assert.doesNotMatch(src, /\[ -x "\$SCRIPT_DIR\/harness-drift\.sh" \]/, "no -x guard on a 644-committed script");
  const st = statSync(SCRIPT);
  assert.ok(!(st.mode & 0o111), "the arm ships non-executable like its sibling re-pin-toolkit.sh (bash-invoked)");
});
