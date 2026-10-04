// workspace-contract.test.mjs — contract fixtures for the workspace
// protocol (issue #276).
//
// Contract under test: shared lane checkouts are RUNTIME, not
// workspaces. The worker keepalive re-pins the live toolkit checkout to
// the moving v1 tag every minute (checkout --force); unconditional
// --force was measured destroying an agent's in-flight work on seed-L3
// twice in ~10 minutes (2026-10-03). scripts/pin-toolkit.sh now refuses
// to re-pin a dirty or on-branch tree, but the durable rule is
// behavioral and must reach EVERY dispatched node through its prompt:
//
//   * do task work in YOUR OWN clone — never in-place in a shared
//     checkout (~/dsh-agent-toolkit, ~/dsh-bot, any keepalive-pinned
//     checkout);
//   * if you must touch a shared checkout, leave it clean and detached
//     before you exit so the re-pin resumes.
//
// Two surfaces, one protocol (the shape mirrors
// tests/branch-hygiene-contract.test.mjs):
//
//   behavioral — a stub agent captures the task it was launched with
//   and the workspace rule must be present in it.
//
//   structural — the driver block sits after the branch-hygiene block
//   (contracts append in issue order) and before the launch line
//   consumes TASK.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, chmodSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(ROOT, "scripts", "run-dsh-agent.sh");

// --- behavioral: the dispatched agent's prompt carries the rule ---------

test("issue #276: the prompt assembly appends the workspace contract to the launched task (stub agent sees it)", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "dsh-workspace-contract-"));
  const bin = path.join(dir, "bin");
  const runnerTemp = path.join(dir, "runner");
  mkdirSync(bin);
  mkdirSync(runnerTemp);

  // stub harness identical to the branch-hygiene fixture: doppler execs
  // its payload, dsh dumps argv to TASK_CAPTURE, noise tools exit 0.
  writeFileSync(path.join(bin, "doppler"), "#!/bin/sh\nshift; shift\nexec \"$@\"\n");
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
  for (const f of readdirSync(bin)) spawnSync("chmod", ["+x", path.join(bin, f)]);

  const capture = path.join(dir, "task-argv.txt");
  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    HOME: dir,
    RUNNER_TEMP: runnerTemp,
    DOPPLER_SERVICE_TOKEN: "stub-token",
    DSH_KEEP_SESSIONS: "",
    TASK_CAPTURE: capture,
    DSH_RETRY_BACKOFF_S: "0", // tests-lint rule 2: every driver spawn pins the seam
    GH_BIN: path.join(bin, "gh"),
    DOPPLER_BIN: path.join(bin, "doppler"),
    CELL_PROBE_DIRS: "",
  };
  delete env.GH_TOKEN;
  delete env.GITHUB_ENV;
  delete env.DSH_HOME;
  delete env.DSH_PERSISTENT_HOME;
  delete env.DSH_SESSION_PATH_FILE;
  delete env.THREAD_CONTEXT;
  delete env.REPLY_TARGET;

  const proc = spawnSync("bash", [SCRIPT, "workspace contract test task"], { encoding: "utf8", env, timeout: 60_000 });
  assert.equal(proc.status, 0, `driver must succeed (stderr: ${proc.stderr?.slice(-400)})`);

  const argv = readFileSync(capture, "utf8");
  const task = argv.trimEnd().split("\n").slice(2).join("\n");
  assert.match(task, /workspace contract test task/, "the caller's own task text must survive");

  // The contract header and the runtime-not-workspace frame:
  assert.match(task, /AGENT CONTRACT — workspace \(issue #276\)/);
  assert.match(task, /RUNTIME, not a workspace/);

  // The operative rule — own clone, push from there:
  assert.match(task, /Do task work in YOUR OWN clone/);
  assert.match(task, /in-place edits can be discarded without notice/);

  // The exit discipline for a shared checkout that must be touched:
  assert.match(task, /leave it clean and detached/);
  assert.match(task, /so the re-pin resumes/);
  assert.match(task, /force-checks-out the tag every minute/);

  rmSync(dir, { recursive: true, force: true });
});

// --- structural: block placement ------------------------------------------

test("issue #276: the contract block sits in the driver after the branch-hygiene block and before the launch line", () => {
  const src = readFileSync(SCRIPT, "utf8");
  const marker = "# --- standing agent contract: workspace (issue #276)";
  const mi = src.indexOf(marker);
  assert.notEqual(mi, -1, "the workspace contract block must exist in the driver");

  // Contracts append in issue order: discovery → relationships (#115)
  // → hygiene (#127) → workspace (#276).
  const hygiene = src.indexOf("# --- standing agent contract: branch hygiene (issue #127)");
  assert.notEqual(hygiene, -1);
  assert.ok(mi > hygiene, "the workspace block appends after the branch-hygiene block");

  // And BEFORE the launch line consumes TASK.
  const launch = src.indexOf("dsh --profile headless ${DSH_LAUNCH_ARGS");
  assert.notEqual(launch, -1);
  assert.ok(launch > mi, "TASK must be finalized before the launch line");
});

// --- structural: the guard itself shipped (driver prose names it) ---------

test("issue #276: the driver block cites the guard script that implements the safe re-pin", () => {
  const src = readFileSync(SCRIPT, "utf8");
  assert.match(src, /scripts\/pin-toolkit\.sh now refuses to re-pin a dirty or\s+#\s*on-branch tree/, "the contract's rationale names the mechanism");
});
