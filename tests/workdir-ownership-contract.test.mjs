// workdir-ownership-contract.test.mjs — contract fixtures for the
// workdir-ownership protocol (issue #374).
//
// Contract under test: a workdir is yours only if you minted it AND can
// prove it. The #333-era mint discipline ("mktemp a unique workdir")
// still left two silent-loss mechanisms live, observed 2026-10-04 while
// working claim dsh-agent-toolkit#361 (issue #374):
//
//   1. SAME-SECOND MINT — `work-<issue>-<repo>-$(date +%s)` has one
//      second of uniqueness budget; two siblings minting the same issue
//      in the same second land on ONE path.
//   2. GLOB REUSE — `ls -d work-<issue>-* | head -1` enters whatever
//      matching dir exists, at any time: a takeover of a live tree, not
//      a resume of an abandoned one.
//
// ...and no detection belt anywhere: the loser's mid-session replacement
// was SILENT (mtimes restamped, edits replaced, syntax checks validating
// a tree that was no longer the owner's). The contract this file pins:
//
//   MINT RANDOM, NEVER BARE EPOCH · NEVER REUSE A MATCHING DIR ·
//   ASSERT OWNERSHIP BEFORE EDIT BATCHES (.dsh-owner marker)
//
// Three surfaces, one protocol (the shape mirrors
// tests/branch-hygiene-contract.test.mjs):
//
//   behavioral — a stub agent captures the task it was launched with and
//   the workdir-ownership rules must be present in it.
//
//   structural — the driver block sits after the branch-hygiene block
//   and before the launch line; the contract doc and the file map carry
//   the same operative rules, and stay in agreement with the driver.
//
//   executable — scripts/claim-workdir.sh IS the belt, so its semantics
//   are pinned directly: random same-second mints never collide, a
//   foreign marker dies loud, an unmarked non-empty tree dies loud, and
//   only a matching marker (or a provably-empty adoption) passes.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, chmodSync, readdirSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(ROOT, "scripts", "run-dsh-agent.sh");
const BELT = path.join(ROOT, "scripts", "claim-workdir.sh");
const CONTRACT_DOC = path.join(ROOT, ".agents", "README.md");
const FILE_MAP = path.join(ROOT, "README.md");

// --- behavioral: the dispatched agent's prompt carries the rules ----------

test("issue #374: the prompt assembly appends the workdir-ownership contract to the launched task (stub agent sees it)", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "dsh-workdir-ownership-"));
  const bin = path.join(dir, "bin");
  const runnerTemp = path.join(dir, "runner");
  mkdirSync(bin);
  mkdirSync(runnerTemp);

  // doppler stub: `doppler run -- <cmd...>` -> exec <cmd...> (token rides
  // the env since the issue-#95 argv fix).
  writeFileSync(path.join(bin, "doppler"), "#!/bin/sh\nshift; shift\nexec \"$@\"\n");
  // dsh stub: answers --version, then dumps its argv (one per line) to
  // $TASK_CAPTURE and exits 0. TASK_CAPTURE is deliberately NOT a DSH_* /
  // *KEY*/*TOKEN* name — dsh strips both classes from the child env.
  writeFileSync(
    path.join(bin, "dsh"),
    [
      "#!/bin/sh",
      'case "$1" in --version) echo "dsh-stub-0.0.0" >&2; exit 0;; esac',
      'for a in "$@"; do printf \'%s\\n\' "$a"; done > "$TASK_CAPTURE"',
      "echo STUB-FINAL-ANSWER",
      "exit 0",
    ].join("\n") + "\n",
  );
  writeFileSync(path.join(bin, "zstd"), "#!/bin/sh\nexit 0\n");
  writeFileSync(path.join(bin, "gh"), "#!/bin/sh\nexit 0\n");
  for (const f of readdirSync(bin)) chmodSync(path.join(bin, f), 0o755);

  const capture = path.join(dir, "task-argv.txt");
  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    HOME: dir,
    RUNNER_TEMP: runnerTemp,
    DOPPLER_SERVICE_TOKEN: "stub-token",
    DSH_KEEP_SESSIONS: "", // default path: transcripts must be cleaned
    TASK_CAPTURE: capture,
    DSH_RETRY_BACKOFF_S: "0", // tests-lint rule 2: every driver spawn pins the seam
    GH_BIN: path.join(bin, "gh"),
    DOPPLER_BIN: path.join(bin, "doppler"),
    CELL_PROBE_DIRS: "",
  };
  delete env.GH_TOKEN; // skip the gh-identity block entirely
  delete env.GITHUB_ENV; // no workflow env file to publish to
  delete env.DSH_HOME; // force the job-scoped home under RUNNER_TEMP
  delete env.DSH_PERSISTENT_HOME;
  delete env.DSH_SESSION_PATH_FILE;
  delete env.THREAD_CONTEXT; // no thread-context wrapper around the task
  delete env.REPLY_TARGET; // dispatched-task mode: the append must be unconditional

  const proc = spawnSync("bash", [SCRIPT, "workdir ownership test task"], { encoding: "utf8", env, timeout: 60_000 });
  assert.equal(proc.status, 0, `driver must succeed (stderr: ${proc.stderr?.slice(-400)})`);

  const argv = readFileSync(capture, "utf8");
  // The task is everything after the first two argv lines
  // (`--profile`, `headless`) — the task itself is multi-line.
  const task = argv.trimEnd().split("\n").slice(2).join("\n");
  assert.match(task, /workdir ownership test task/, "the caller's own task text must survive");

  // The contract header and the ownership frame:
  assert.match(task, /AGENT CONTRACT — workdir ownership \(issue #374\)/);
  assert.match(task, /a workdir is YOURS only if you minted it and can prove it/);
  assert.match(task, /silently replaced the earlier agent's confirmed edits mid-session/);

  // Rule 1 — mint random, never bare epoch (the one-second receipt):
  assert.match(task, /MINT RANDOM, NEVER BARE EPOCH/);
  assert.match(task, /work-<issue>-<repo>-\$\(date \+%s\)/, "the epoch-mint anti-pattern must be named");
  assert.match(task, /two siblings minting in the same second land on one path/);
  assert.match(task, /scripts\/claim-workdir\.sh mint <parent> <slug> <owner-token>/);
  assert.match(task, /mktemp XXXXXX/);

  // Rule 2 — never reuse a matching dir (glob reuse is a takeover):
  assert.match(task, /NEVER REUSE A MATCHING DIR/);
  assert.match(task, /ls -d work-<issue>-\* \| head -1/);
  assert.match(task, /that is a takeover, not a resume/);

  // Rule 3 — assert ownership before edit batches (the belt):
  assert.match(task, /ASSERT OWNERSHIP BEFORE EDIT BATCHES/);
  assert.match(task, /scripts\/claim-workdir\.sh assert <dir> <owner-token>/);
  assert.match(task, /A foreign marker means your tree was replaced/);
  assert.match(task, /STOP either way/);

  // The acceptance sentence:
  assert.match(task, /Acceptance — silent replacement becomes loud/);
  assert.match(task, /\.dsh-owner marker/);

  rmSync(dir, { recursive: true, force: true });
});

// --- structural: driver block placement + all surfaces agree --------------

test("issue #374: the contract block sits in the driver after the branch-hygiene block, after scrub, before launch", () => {
  const src = readFileSync(SCRIPT, "utf8");
  const marker = "# --- standing agent contract: workdir ownership (issue #374)";
  const mi = src.indexOf(marker);
  assert.notEqual(mi, -1, "the workdir-ownership contract block must exist in the driver");

  // Appended AFTER the input scrub pass (repo-controlled static prose).
  const scrub = src.indexOf('SECRETS_ONLY=1 node "$SCRIPT_DIR/scrub-output.mjs"');
  assert.notEqual(scrub, -1);
  assert.ok(mi > scrub, "the contract block must be appended after the input scrub pass");

  // And AFTER the branch-hygiene block: contracts append in issue order
  // (#115 → #127 → #374), so the launched task reads them in order.
  const branch = src.indexOf("# --- standing agent contract: branch hygiene (issue #127)");
  assert.notEqual(branch, -1);
  assert.ok(mi > branch, "the workdir-ownership block appends after the branch-hygiene block");

  // And BEFORE the launch line consumes TASK.
  const launch = src.indexOf("dsh --profile headless ${DSH_LAUNCH_ARGS");
  assert.notEqual(launch, -1);
  assert.ok(mi < launch, "the contract block must precede the launch line");

  // The block stamps the executable belt, not just prose.
  assert.match(src.slice(mi, launch), /scripts\/claim-workdir\.sh/, "the driver block must point at the executable belt");
});

test("issue #374: the long-form contract doc and the file map carry the same operative rules", () => {
  const doc = readFileSync(CONTRACT_DOC, "utf8");
  const si = doc.indexOf("## Standing contract: workdir ownership (issue #374)");
  assert.notEqual(si, -1, "the contract doc must carry the long-form section");
  const section = doc.slice(si, doc.indexOf("## Why this exists", si));

  // The two collision mechanisms, with the receipt:
  assert.match(section, /ONE second of epoch|one second is not a uniqueness budget/, "the one-second uniqueness budget must be named");
  assert.match(section, /glob reuse|ls -d work-<issue>-\* \| head -1/);
  assert.match(section, /silent mid-session replacement|silently replaced/);

  // The three rules, same operative verbs as the driver stamp:
  assert.match(section, /MINT RANDOM, NEVER BARE EPOCH/);
  assert.match(section, /NEVER REUSE A MATCHING DIR/);
  assert.match(section, /ASSERT OWNERSHIP BEFORE EDIT BATCHES/);

  // The belt is executable: mint/assert recipes with the marker.
  assert.match(section, /claim-workdir\.sh mint/);
  assert.match(section, /claim-workdir\.sh assert/);
  assert.match(section, /\.dsh-owner/);

  // The acceptance sentence agrees with the driver's.
  assert.match(section, /Acceptance — silent replacement becomes loud/);

  // The doc's Related list pins this test file.
  assert.match(doc, /tests\/workdir-ownership-contract\.test\.mjs/);

  // The file map documents the helper and the driver's stamp.
  const map = readFileSync(FILE_MAP, "utf8");
  assert.match(map, /`scripts\/claim-workdir\.sh`/, "the file map must document the belt");
  assert.match(map, /issues #113\/#115\/#127\/#374/, "the driver row must list the workdir-ownership contract");
});

// --- executable: the belt itself -------------------------------------------

test("issue #374: mint mints a random-suffixed, marker-stamped workdir — same-second siblings never collide", () => {
  const parent = mkdtempSync(path.join(tmpdir(), "dsh-belt-mint-"));
  const run = (args) => spawnSync("bash", [BELT, ...args], { encoding: "utf8" });

  const r = run(["mint", parent, "374-demo", "owner-a"]);
  assert.equal(r.status, 0, `mint must succeed (stderr: ${r.stderr})`);
  const dir = r.stdout.trim();
  const base = path.basename(dir);
  assert.match(base, /^work-374-demo-[A-Za-z0-9]{6}$/, "the suffix is the mktemp XXXXXX random, not an epoch");
  assert.ok(existsSync(path.join(dir, ".dsh-owner")), "the ownership marker must be stamped at mint");
  assert.equal(readFileSync(path.join(dir, ".dsh-owner"), "utf8").trim(), "owner-a");

  // The #374 receipt, pinned directly: a tight loop of same-second mints
  // (the exact collision window of `work-<issue>-$(date +%s)`) must yield
  // pairwise-distinct paths.
  const paths = new Set([dir]);
  for (let i = 0; i < 8; i++) {
    const m = run(["mint", parent, "374-demo", "owner-a"]);
    assert.equal(m.status, 0, `mint ${i} must succeed (stderr: ${m.stderr})`);
    assert.ok(!paths.has(m.stdout.trim()), `mint ${i} collided with an earlier same-second mint — the #374 bug`);
    paths.add(m.stdout.trim());
  }
  assert.equal(paths.size, 9);

  rmSync(parent, { recursive: true, force: true });
});

test("issue #374: assert passes for the owner, dies loud on a foreign marker (the takeover belt)", () => {
  const parent = mkdtempSync(path.join(tmpdir(), "dsh-belt-assert-"));
  const run = (args) => spawnSync("bash", [BELT, ...args], { encoding: "utf8" });

  const dir = run(["mint", parent, "374-assert", "owner-a"]).stdout.trim();

  const own = run(["assert", dir, "owner-a"]);
  assert.equal(own.status, 0, `own marker must pass (stderr: ${own.stderr})`);

  const foreign = run(["assert", dir, "owner-b"]);
  assert.notEqual(foreign.status, 0, "a foreign marker must die");
  assert.match(foreign.stderr, /NOT yours/, "the diagnostic must name the takeover");
  assert.match(foreign.stderr, /issue #374/);

  rmSync(parent, { recursive: true, force: true });
});

test("issue #374: assert refuses an unmarked non-empty tree (glob reuse is not adoption) and adopts only empties", () => {
  const parent = mkdtempSync(path.join(tmpdir(), "dsh-belt-adopt-"));
  const run = (args) => spawnSync("bash", [BELT, ...args], { encoding: "utf8" });

  // A live sibling tree: non-empty, unmarked (e.g. cloned by hand).
  const foreignTree = path.join(parent, "work-374-foreign-tree");
  mkdirSync(foreignTree);
  writeFileSync(path.join(foreignTree, "edit-in-flight.txt"), "a sibling's confirmed edits");
  const refuse = run(["assert", foreignTree, "owner-a"]);
  assert.notEqual(refuse.status, 0, "an unmarked non-empty tree must die");
  assert.match(refuse.stderr, /a tree you did not mint is not yours|not yours/, "the diagnostic must name the class");

  // A provably-empty dir may be adopted (the marker stamps on first touch).
  const empty = path.join(parent, "work-374-empty");
  mkdirSync(empty);
  const adopt = run(["assert", empty, "owner-a"]);
  assert.equal(adopt.status, 0, `an empty dir must be adoptable (stderr: ${adopt.stderr})`);
  assert.equal(readFileSync(path.join(empty, ".dsh-owner"), "utf8").trim(), "owner-a");
  // ...and once adopted, a different owner is still refused.
  const clash = run(["assert", empty, "owner-b"]);
  assert.notEqual(clash.status, 0, "adoption is ownership — the next sibling is refused");

  rmSync(parent, { recursive: true, force: true });
});

test("issue #374: mint validates its inputs — missing parent, path-bearing slug, and empty owner tokens die", () => {
  const parent = mkdtempSync(path.join(tmpdir(), "dsh-belt-validate-"));
  const run = (args) => spawnSync("bash", [BELT, ...args], { encoding: "utf8" });

  const noParent = run(["mint", path.join(parent, "nope"), "374-x", "owner-a"]);
  assert.notEqual(noParent.status, 0, "a missing parent must die");

  const badSlug = run(["mint", parent, "a/b", "owner-a"]);
  assert.notEqual(badSlug.status, 0, "a path-bearing slug must die");

  const noOwner = run(["mint", parent, "374-x", ""]);
  assert.notEqual(noOwner.status, 0, "an empty owner token must die — claim identity is not unique, the token is the only proof");

  const noDir = run(["assert", path.join(parent, "work-374-absent"), "owner-a"]);
  assert.notEqual(noDir.status, 0, "a missing dir must die, never mint-by-accident");

  rmSync(parent, { recursive: true, force: true });
});
