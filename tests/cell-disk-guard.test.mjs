// cell-disk-guard.test.mjs — contract pins for scripts/cell-disk-guard.sh
// (issue #478: the seed cell's burst spawner had NO free-space admission
// control — a couple of concurrent `seed-burst-*` mints pushed the shared
// root fs to 100% — and its reap preserves every runner's `_diag` into
// `_diag-archive/` unbounded, 2718 dirs on 2026-10-04).
//
// The pins:
//   1. `admit` carries the gates pre-step's EXACT floor semantics
//      (PR #477, issue #474): default 2048 MiB, env-overridable, df -kP,
//      numbers printed, nonzero + loud under floor — so a spawner that
//      refuses on this guard refuses on the same floor the gates job grades.
//   2. `rotate` prunes the diag archive oldest-first (keep-N union
//      max-age), never outside the archive dir, refuses a dir that is
//      really a minted runner body, and reports root-owned BLOCKED entries
//      loudly (exit 1) instead of silently skipping them — rotation that
//      is not landing is exactly the state worth a red run.
//   3. `schedule` emits the root-side units — the archive is chowned
//      root:root by the spawner's reap, so a runner-side rotation alone
//      cannot be the whole story.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readdirSync, utimesSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const GUARD = path.join(ROOT, "scripts", "cell-disk-guard.sh");
const scriptText = () => readFileSync(GUARD, "utf8");

const run = (args, env = {}) =>
  spawnSync("bash", [GUARD, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });

const DAY_MS = 24 * 60 * 60 * 1000;
const ageEntry = (p, daysOld) =>
  utimesSync(p, new Date(Date.now() - daysOld * DAY_MS), new Date(Date.now() - daysOld * DAY_MS));

// A fake archive: `names` entries (dirs, one _diag-style file inside each);
// the first `agedCount` entries carry old mtimes (rotate's max-age leg).
const archiveFixture = (names, agedCount = 0) => {
  const dir = mkdtempSync(path.join(tmpdir(), "cdg-test-"));
  const archive = path.join(dir, "_diag-archive");
  mkdirSync(archive, { recursive: true });
  for (const [i, name] of names.entries()) {
    mkdirSync(path.join(archive, name), { recursive: true });
    writeFileSync(path.join(archive, name, "Worker_2026-10-04.log"), "diag\n");
    if (i < agedCount) ageEntry(path.join(archive, name), 30);
  }
  return { dir, archive };
};

test("admit passes above the floor and prints the numbers (gates-pre-step shape)", () => {
  const res = run(["admit", "--floor-mb", "1"]);
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /free space: \d+ MiB — floor: 1 MiB/);
  assert.match(res.stdout, /mint may proceed/);
});

test("admit refuses under the floor loudly, with the mint-refusal wording", () => {
  const res = run(["admit", "--floor-mb", "999999999"]);
  assert.equal(res.status, 1);
  const out = res.stdout + res.stderr;
  assert.match(out, /::error::/);
  assert.match(out, /under floor — \d+ MiB free < \d+ MiB floor/);
  assert.match(out, /refuse mint/);
  assert.match(out, /issue #478/);
});

test("admit carries the gates pre-step's floor semantics: 2048 default, env override, argv beats env", () => {
  // the default IS the gates default (PR #477's GATES_DISK_FLOOR_MB || 2048)
  assert.match(scriptText(), /CELL_DISK_FLOOR_DEFAULT_MB=2048/);
  assert.match(scriptText(), /GATES_DISK_FLOOR_MB/); // the parity is named, not accidental
  // env override trips the guard
  const viaEnv = run(["admit", "--path", process.cwd()], { CELL_DISK_FLOOR_MB: "999999999" });
  assert.equal(viaEnv.status, 1);
  // argv beats env
  const argvWins = run(["admit", "--floor-mb", "1"], { CELL_DISK_FLOOR_MB: "999999999" });
  assert.equal(argvWins.status, 0, argvWins.stderr);
});

test("rotate keeps the newest N and drops the stale, counting the union once", () => {
  const names = ["seed-burst-ft-a", "seed-burst-ft-b", "seed-burst-ft-c", "seed-burst-ft-d", "seed-burst-ft-e", "seed-burst-ft-f"];
  const f = archiveFixture(names, 4); // a–d are 30d old
  const sibling = path.join(f.dir, "DO-NOT-TOUCH");
  writeFileSync(sibling, "outside the archive\n");
  try {
    // keep 2 + max-age 7: e,f are over-keep; a–d are stale AND over-keep —
    // the union is exactly a–d + e,f… keep-2 protects e,f, so removed = a–d
    const res = run(["rotate", "--archive", f.archive, "--keep", "2", "--max-age-days", "7"]);
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /removed 4 of 4 candidates/);
    assert.deepEqual(readdirSync(f.archive).sort(), ["seed-burst-ft-e", "seed-burst-ft-f"]);
    assert.equal(existsSync(sibling), true, "entries outside the archive dir are never touched");
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test("rotate max-age alone prunes only the aged entries", () => {
  const f = archiveFixture(["old-one", "fresh-one"], 1);
  try {
    const res = run(["rotate", "--archive", f.archive, "--keep", "100", "--max-age-days", "7"]);
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /removed 1 of 1 candidates/);
    assert.deepEqual(readdirSync(f.archive), ["fresh-one"]);
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test("rotate --dry-run reports the plan and removes nothing", () => {
  const f = archiveFixture(["e1", "e2", "e3"], 0);
  try {
    const res = run(["rotate", "--archive", f.archive, "--keep", "1", "--dry-run"]);
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /dry-run: would remove 2 of 3 entries/);
    assert.equal(readdirSync(f.archive).length, 3, "dry-run removed nothing");
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test("rotate reports root-owned BLOCKED entries loudly and exits 1 (rotation not landing)", () => {
  if (typeof process.getuid === "function" && process.getuid() === 0) return; // root bypasses perms — the shape is unbuildable
  const dir = mkdtempSync(path.join(tmpdir(), "cdg-blocked-"));
  const archive = path.join(dir, "_diag-archive");
  const sudoBin = path.join(dir, "no-sudo-here"); // the BIN seam: construct "no escalation available"
  mkdirSync(archive, { recursive: true });
  // plain FILES inside the archive: with the parent dir unwritable, an
  // unlink cannot succeed and rm has nothing to descend into
  for (const name of ["f1", "f2", "f3", "f4"]) writeFileSync(path.join(archive, name), "diag\n");
  try {
    // the parent archive dir loses write: unlink inside it fails for a
    // non-root owner (the spawner's reap chowns the archive root:root)
    const res0 = spawnSync("chmod", ["0555", archive]);
    assert.equal(res0.status, 0);
    const res = run(["rotate", "--archive", archive, "--keep", "1"], { CELL_DISK_GUARD_SUDO: sudoBin });
    assert.equal(res.status, 1, "blocked entries must fail the rotation loudly");
    const out = res.stdout + res.stderr;
    assert.match(out, /BLOCKED — could not remove/);
    assert.match(out, /rotation incomplete/);
    assert.match(out, /schedule/); // points at the root-side fix
    assert.equal(readdirSync(archive).length, 4, "blocked rotation removed nothing");
  } finally {
    spawnSync("chmod", ["0755", archive]);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("rotate refuses a minted runner body and the filesystem root", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "cdg-refuse-"));
  const body = path.join(dir, "seed-burst-ft-live");
  mkdirSync(body, { recursive: true });
  writeFileSync(path.join(body, "run.sh"), "#!/bin/sh\n");
  writeFileSync(path.join(body, "config.sh"), "#!/bin/sh\n");
  try {
    const resBody = run(["rotate", "--archive", body]);
    assert.equal(resBody.status, 2);
    assert.match(resBody.stderr, /minted runner body/);
    const resRoot = run(["rotate", "--archive", "/"]);
    assert.equal(resRoot.status, 2);
    assert.match(resRoot.stderr, /refusing to operate on \//);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("rotate on a cell without the archive is a green nothing-to-rotate", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "cdg-empty-"));
  try {
    const res = run(["rotate", "--archive", path.join(dir, "absent-archive")]);
    assert.equal(res.status, 0);
    assert.match(res.stdout, /nothing to rotate/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("schedule emits the root-side units: timer, rotate invocation, crontab fallback", () => {
  const res = run(["schedule"]);
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /OnCalendar=/);
  assert.match(res.stdout, /cell-disk-guard\.sh rotate/);
  assert.match(res.stdout, /crontab fallback/);
  assert.match(res.stdout, /root:root/); // says WHY it must run as root
});
