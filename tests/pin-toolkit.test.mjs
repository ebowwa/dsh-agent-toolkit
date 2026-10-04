// pin-toolkit.test.mjs — hermetic tests for scripts/pin-toolkit.sh
// (issue #276).
//
// Contract under test: the keepalive's v1 re-pin may force-check-out the
// moving tag ONLY on a quiescent checkout. The 2026-09-21 incident made
// --force load-bearing (a bare `checkout v1` silently kept local edits
// and shadowed v1.73.0→v1.74.0 for hours); issue #276 is the mirror
// hazard (unconditional --force destroyed an agent's in-flight work on
// seed-L3 twice in ~10 minutes, 2026-10-03). The reconciliation this
// file pins:
//
//   * clean + detached          → re-pin fires (HEAD moves to the new
//     tag position; the release gate keeps working)
//   * tracked modifications     → REFUSE: HEAD stays, edits stay, note
//     out, exit 2 (the sweep runs the previously pinned release)
//   * HEAD on a working branch  → REFUSE: branch stays checked out
//   * untracked files only      → re-pin fires (untracked files are not
//     destroyed by checkout --force, and treating them as dirt would
//     let one stray file shadow the tag forever — the 2026-09-21
//     failure mode resurrected)
//   * fetch failure             → exit 1, previous pin kept (degradation
//     install-worker.sh already designed for)
//
// Everything runs against real local git repos (a bare origin plus a
// clone) — no network, no shims for git itself.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PIN = path.join(ROOT, "scripts", "pin-toolkit.sh");

const run = (cmd, args, opts = {}) =>
  spawnSync(cmd, args, { encoding: "utf8", ...opts });

const git = (dir, ...args) =>
  run("git", ["-c", "user.email=t@t", "-c", "user.name=t", "-C", dir, ...args]);

/** A moving-tag fixture: bare origin whose `v1` tag starts at commit A
 *  (the live clone is detached there — the steady state of a worker
 *  box), then advances to commit B exactly as drift-check's audited
 *  release would move it. */
const fixture = () => {
  const dir = mkdtempSync(path.join(tmpdir(), "pin-toolkit-test-"));
  const origin = path.join(dir, "origin.git");
  const seed = path.join(dir, "seed");
  const live = path.join(dir, "live");

  let r = run("git", ["init", "--bare", "-q", origin]);
  assert.equal(r.status, 0, r.stderr);
  r = run("git", ["clone", "-q", origin, seed]);
  assert.equal(r.status, 0, r.stderr);

  // commit A + tag v1 (= the release the box is pinned at)
  writeFileSync(path.join(seed, "file"), "state-a\n");
  r = git(seed, "add", "-A");
  assert.equal(r.status, 0, r.stderr);
  r = git(seed, "commit", "-q", "-m", "a");
  assert.equal(r.status, 0, r.stderr);
  r = git(seed, "tag", "v1");
  assert.equal(r.status, 0, r.stderr);
  r = git(seed, "push", "-q", "origin", "HEAD", "refs/tags/v1");
  assert.equal(r.status, 0, r.stderr);

  // the live checkout: cloned, then detached at the CURRENT v1 (what
  // install-worker.sh / every prior sweep leaves behind)
  r = run("git", ["clone", "-q", origin, live]);
  assert.equal(r.status, 0, r.stderr);
  const atA = git(live, "rev-parse", "v1").stdout.trim();
  r = git(live, "checkout", "-q", "--detach", atA);
  assert.equal(r.status, 0, r.stderr);

  // the release gate moves v1: commit B in the origin, tag force-updated
  writeFileSync(path.join(seed, "file2"), "state-b\n");
  r = git(seed, "add", "-A");
  assert.equal(r.status, 0, r.stderr);
  r = git(seed, "commit", "-q", "-m", "b");
  assert.equal(r.status, 0, r.stderr);
  r = git(seed, "tag", "-f", "v1");
  assert.equal(r.status, 0, r.stderr);
  r = git(seed, "push", "-q", "--force", "origin", "HEAD", "refs/tags/v1");
  assert.equal(r.status, 0, r.stderr);
  const atB = git(seed, "rev-parse", "v1").stdout.trim();

  return { dir, origin, live, atA, atB };
};

const pin = (live, env = {}) =>
  run("bash", [PIN, live], { env: { ...process.env, ...env } });

test("issue #276: quiescent checkout (clean, detached) re-pins to the moved tag", () => {
  const f = fixture();
  try {
    const res = pin(f.live);
    assert.equal(res.status, 0, `stderr: ${res.stderr}`);
    assert.match(res.stdout, /pinned at v1/, "success note with describe output");
    assert.equal(git(f.live, "rev-parse", "HEAD").stdout.trim(), f.atB, "HEAD moved to the new tag position");
    assert.ok(existsSync(path.join(f.live, "file2")), "the new release's files are checked out");
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test("issue #276: tracked modifications are left intact — REFUSE, note, exit 2, HEAD stays", () => {
  const f = fixture();
  try {
    writeFileSync(path.join(f.live, "file"), "agent-edit-must-survive\n");
    const res = pin(f.live);
    assert.equal(res.status, 2, "refusal is exit 2 (the sweep continues on the previous pin)");
    assert.match(res.stdout, /REFUSING re-pin: tracked modifications/);
    assert.match(res.stdout, /issue #276/);
    assert.equal(git(f.live, "rev-parse", "HEAD").stdout.trim(), f.atA, "HEAD did not move");
    assert.equal(
      readFileSync(path.join(f.live, "file"), "utf8"),
      "agent-edit-must-survive\n",
      "the in-flight edit survived the sweep (the #276 receipt — this was destroyed before)",
    );
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test("issue #276: a checked-out working branch blocks the re-pin — branch stays checked out", () => {
  const f = fixture();
  try {
    let r = git(f.live, "checkout", "-q", "-b", "dsh/issue-work");
    assert.equal(r.status, 0, r.stderr);
    const res = pin(f.live);
    assert.equal(res.status, 2);
    assert.match(res.stdout, /REFUSING re-pin: HEAD is on a branch/);
    r = git(f.live, "symbolic-ref", "--short", "HEAD");
    assert.equal(r.stdout.trim(), "dsh/issue-work", "the working branch is still checked out");
    assert.equal(git(f.live, "rev-parse", "HEAD").stdout.trim(), f.atA, "HEAD did not move");
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test("issue #276: untracked files do NOT block the re-pin (stray files must never shadow the tag)", () => {
  const f = fixture();
  try {
    writeFileSync(path.join(f.live, "stray-note.md"), "agent scratch\n");
    const res = pin(f.live);
    assert.equal(res.status, 0, `stderr: ${res.stderr}`);
    assert.equal(git(f.live, "rev-parse", "HEAD").stdout.trim(), f.atB, "re-pin fired");
    assert.ok(existsSync(path.join(f.live, "stray-note.md")), "untracked file survived");
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test("issue #276: fetch failure degrades — exit 1, previous pin kept", () => {
  const f = fixture();
  try {
    let r = git(f.live, "remote", "set-url", "origin", path.join(f.dir, "no-such-origin.git"));
    assert.equal(r.status, 0, r.stderr);
    const res = pin(f.live);
    assert.equal(res.status, 1);
    assert.match(res.stdout, /fetch failed — keeping the previously pinned checkout/);
    assert.equal(git(f.live, "rev-parse", "HEAD").stdout.trim(), f.atA, "HEAD did not move");
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test("issue #276: dir resolution — DSH_AGENT_TOOLKIT_DIR env when no arg is passed", () => {
  const f = fixture();
  try {
    const res = run("bash", [PIN], {
      env: {
        ...process.env,
        DSH_AGENT_TOOLKIT_DIR: f.live,
        HOME: path.join(f.dir, "home-that-does-not-exist"),
      },
    });
    assert.equal(res.status, 0, `stderr: ${res.stderr}`);
    assert.equal(git(f.live, "rev-parse", "HEAD").stdout.trim(), f.atB, "env-var dir was re-pinned");
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});
