// claim-dedup-contract.test.mjs — contract fixtures for the claim-time
// carrier-dedup protocol (issue #414).
//
// Contract under test: picking a ticket is not claiming it. The lane
// pass ranks open agent-todo tickets by fleet priority, but concurrent
// cells resolve the SAME highest-priority ticket — without a carrier
// check each ships its own PR (measured 2026-10-04 on this repo:
// ~60 open PRs, #361→8 carriers, #330→7, #358→5, while unclaimed
// tickets sat idle). Each duplicate costs a full review pass and a
// pile-gate slot, so the check belongs at CLAIM time, not review time.
//
// This is the claim-step sibling of two existing contracts: the
// discovery protocol's pre-file search (issue #320 dedups FILING)
// and the branch-hygiene unique-name rule (issue #327 dedups the
// BRANCH MINT). This one dedups CLAIMING.
//
// Two surfaces, one protocol (the shape mirrors
// tests/branch-hygiene-contract.test.mjs):
//
//   behavioral — a stub agent booted on the no-arg maintenance roam
//   captures the DEFAULT_TASK it was launched with, and the carrier
//   check must be present in it (the roam is the exact mint that armed
//   the duplicate-PR races — factory#869: 14 concurrent
//   identical-prompt agents off one routine-maintenance claim).
//
//   structural — the driver's DEFAULT_TASK claim preamble and the
//   .agents/README.md standing-contract section each carry the rule's
//   operative wording, and the word-for-word strings that appear
//   identically on both surfaces keep them in agreement. A revert of
//   the rule on either surface goes red here.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, chmodSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(ROOT, "scripts", "run-dsh-agent.sh");
const CONTRACT_DOC = path.join(ROOT, ".agents", "README.md");

const HERMETIC_LANE_PLUGINS = path.join(ROOT, "tests", "fixtures", "lane-plugins-hermetic.json");

// Hermetic base env (issue #131): an agent job's ambient dsh-agent
// exports leak into driver spawns and drive real behavior — strip them
// so the roam boots the same inside a dsh job and on a bare runner.
const HERMETIC_ENV = (() => {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key === "RUNNER_NAME" || key.startsWith("DSH_")) delete env[key];
  }
  env.DSH_LANE_PLUGINS_MANIFEST = HERMETIC_LANE_PLUGINS;
  return env;
})();

// --- behavioral: the maintenance roam's DEFAULT_TASK carries the rule ---

test("issue #414: the no-arg maintenance roam boots a DEFAULT_TASK that carries the claim-time carrier check (stub agent sees it)", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "dsh-claim-dedup-"));
  const bin = path.join(dir, "bin");
  const runnerTemp = path.join(dir, "runner");
  mkdirSync(bin);
  mkdirSync(runnerTemp);

  // doppler stub: `doppler run -- <cmd...>` -> exec <cmd...>.
  writeFileSync(path.join(bin, "doppler"), "#!/bin/sh\nshift; shift\nexec \"$@\"\n");
  // dsh stub: answers --version, then dumps its argv (one per line) to
  // $TASK_CAPTURE and exits 0.
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
    ...HERMETIC_ENV,
    PATH: `${bin}:${process.env.PATH}`,
    HOME: dir,
    RUNNER_TEMP: runnerTemp,
    DOPPLER_SERVICE_TOKEN: "stub-token",
    DSH_KEEP_SESSIONS: "",
    DSH_RETRY_BACKOFF_S: "0", // tests-lint rule 2: every driver spawn pins the seam
    TASK_CAPTURE: capture,
    GH_BIN: path.join(bin, "gh"),
    DOPPLER_BIN: path.join(bin, "doppler"),
    CELL_PROBE_DIRS: "",
  };
  delete env.GH_TOKEN;
  delete env.GITHUB_ENV;
  delete env.DSH_HOME;
  delete env.DSH_PERSISTENT_HOME;
  delete env.DSH_SESSION_PATH_FILE;
  delete env.DEFAULT_TASK; // pin the in-script default, not an ambient override

  // NO task argument: the scheduled no-arg boot path — the maintenance
  // roam whose DEFAULT_TASK is the surface this contract rides on.
  const proc = spawnSync("bash", [SCRIPT], { encoding: "utf8", env, timeout: 60_000 });
  assert.equal(proc.status, 0, `driver must succeed (stderr: ${proc.stderr?.slice(-400)})`);
  assert.match(proc.stdout, /STUB-FINAL-ANSWER/, "the agent must run");

  const argv = readFileSync(capture, "utf8");
  // The task is everything after the first two argv lines
  // (`--profile`, `headless`) — the task itself is multi-line.
  const task = argv.trimEnd().split("\n").slice(2).join("\n");
  assert.match(task, /Routine maintenance task: work ONLY repositories owned by the github\.com\/ebowwa account/, "the booted task must be the in-script DEFAULT_TASK");

  // The carrier check, its command, and both outcomes:
  assert.match(task, /CLAIM-TIME CARRIER CHECK \(issue #414\)/);
  assert.match(task, /gh pr list --repo <repo> --state open/);
  assert.match(task, /match the #N ref in the PR titles\/bodies/);
  assert.match(task, /skip to the next qualifying ticket and say so in the exit summary/);
  assert.match(task, /only when every matching carrier is stale or absent may you claim #N yourself/);

  rmSync(dir, { recursive: true, force: true });
});

// --- structural: the rule lives in the DEFAULT_TASK preamble, in order ---

test("issue #414: the DEFAULT_TASK claim preamble carries the carrier check between the pick and the implement", () => {
  const src = readFileSync(SCRIPT, "utf8");
  // The DEFAULT_TASK assignment is one long line; pin the sentence
  // order — the check must sit BETWEEN "pick the highest-priority one"
  // and "implement it", because a check after the work instruction is
  // prose, not a gate.
  const pick = src.indexOf("pick the highest-priority one by that order");
  const check = src.indexOf("CLAIM-TIME CARRIER CHECK (issue #414)");
  const implement = src.indexOf("If the fix is clear, implement it, test it, and open a pull request");
  assert.notEqual(pick, -1, "the pick sentence must exist");
  assert.notEqual(check, -1, "the carrier-check rule must exist in the preamble");
  assert.notEqual(implement, -1, "the implement sentence must exist");
  assert.ok(pick < check, "the carrier check must come after the pick");
  assert.ok(check < implement, "the carrier check must come before the implement instruction");
});

// --- structural: the standing-contract doc carries the same rule -------

test("issue #414: .agents/README.md carries the claim-time carrier-dedup standing contract", () => {
  const doc = readFileSync(CONTRACT_DOC, "utf8");
  assert.match(doc, /## Standing contract: claim-time carrier dedup \(issue #414\)/);
  assert.match(doc, /\*\*Picking a ticket is not claiming it\.\*\*/);
  // The three rules, with their operative wording:
  assert.match(doc, /1\. \*\*Carrier check\*\* — before ANY work starts on ticket/);
  assert.match(doc, /2\. \*\*Live carrier ⇒ skip\*\*/);
  assert.match(doc, /3\. \*\*Stale or absent ⇒ claimable\*\*/);
  // The sibling-contract framing (the dedup family: file / claim / branch):
  assert.match(doc, /#320 dedups \*filing\*; this dedups \*claiming\*/);
  assert.match(doc, /#327 dedups the \*branch mint\*/);
  // The receipts that motivate the rule stay in the doc:
  assert.match(doc, /#361→8 carriers/);
  assert.match(doc, /~60 open PRs/);
});

// --- structural: both surfaces agree on the word-for-word strings ------

test("issue #414: driver preamble and contract doc agree word-for-word on the operative strings", () => {
  const src = readFileSync(SCRIPT, "utf8");
  const doc = readFileSync(CONTRACT_DOC, "utf8");
  // Markdown-tolerant (the doc wraps lines and backticks its commands,
  // the preamble stamps plain prose):
  for (const re of [
    /gh pr list --repo <repo> --state open/,
    /skip to the next\s+qualifying ticket and say so in the exit summary/,
    /updated within\s+the last ~2 days/,
  ]) {
    assert.match(src, re, "driver preamble drift");
    assert.match(doc, re, "contract doc drift");
  }
});
