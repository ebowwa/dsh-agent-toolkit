// relationships-contract.test.mjs — contract fixtures for the
// issue-relationships protocol (issue #115).
//
// Contract under test: no agent-filed ticket ships orphaned. The prompt
// assembly (scripts/run-dsh-agent.sh) appends the linking rules to every
// task it launches; .agents/README.md is the long-form reference. Two
// surfaces, one protocol — these fixtures pin BOTH and keep them in
// agreement:
//
//   behavioral — a stub agent captures the task it was launched with and
//   the linking rules must be present in it (the driver's whole point is
//   that every dispatched node inherits the protocol through its prompt).
//
//   structural — the driver block and the contract doc each carry the
//   three verified mutations with their exact input field names
//   (introspected + smoke-verified 2026-09-26: addSubIssue's subIssueUrl,
//   addBlockedBy's blockingIssueId, addRelatesTo's relatedIssueId), the
//   "GraphQL only" clause, and the no-orphan acceptance sentence. A drift
//   between the two surfaces, or a revert to unverified shapes (e.g. a
//   REST call, or a made-up input name), goes red here.
//
// Redo of the PR #120 approach against current main (issue #121): main
// gained the issue-#113 discovery protocol in between, so the contract
// doc is a MERGE (this file coexists with tests/agent-contract.test.mjs)
// and the behavioral harness below is the one proven against the current
// driver in tests/run-dsh-agent.test.mjs.

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

// --- behavioral: the dispatched agent's prompt carries the linking rules ---

test("issue #115: the prompt assembly appends the relationships contract to the launched task (stub agent sees it)", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "dsh-relationships-"));
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
  for (const f of readdirSync(bin)) spawnSync("chmod", ["+x", path.join(bin, f)]);

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

  const proc = spawnSync("bash", [SCRIPT, "wiring test task"], { encoding: "utf8", env, timeout: 60_000 });
  assert.equal(proc.status, 0, `driver must succeed (stderr: ${proc.stderr?.slice(-400)})`);

  const argv = readFileSync(capture, "utf8");
  // The task is everything after the first two argv lines
  // (`--profile`, `headless`) — the task itself is multi-line.
  const task = argv.trimEnd().split("\n").slice(2).join("\n");
  assert.match(task, /wiring test task/, "the caller's own task text must survive");

  // The four linking rules, in the agent-facing prose:
  assert.match(task, /AGENT CONTRACT — issue relationships \(issue #115\)/);
  assert.match(task, /PART TICKETS — file each part as a SUB-ISSUE of the parent claim issue/);
  assert.match(task, /When sequencing matters, chain: addBlockedBy/);
  assert.match(task, /DISCOVERIES — a 'found:' ticket/);
  assert.match(task, /addRelatesTo\(input:\{issueId:<found id>, relatedIssueId:<id of the issue\/claim where you observed it>\}\)/);
  assert.match(task, /REDOS \/ follow-ons — a redo or continuation ticket links its predecessor/);
  assert.match(task, /EXIT SUMMARY — the parts table gains a relationship column/);

  // The verified mutation shapes, exactly as the agent must type them:
  assert.match(task, /addSubIssue\(input:\{issueId:<parent id>, subIssueUrl:<part issue URL>\}\)/);
  assert.match(task, /addBlockedBy\(input:\{issueId:<later id>, blockingIssueId:<earlier id>\}\) — B blocked by A/);
  assert.match(task, /addRelatesTo\(input:\{issueId:<redo id>, relatedIssueId:<predecessor id>\}\)/);

  // IDs, not numbers; GraphQL, not REST:
  assert.match(task, /mutations take issue NODE IDs, not numbers/);
  assert.match(task, /GraphQL only \(REST endpoints 404\)/);
  assert.match(task, /--jq \.data\.repository\.issue\.id/);

  // The acceptance sentence (no orphans):
  assert.match(task, /no agent-filed ticket ships orphaned/);

  rmSync(dir, { recursive: true, force: true });
});

// --- structural: driver block placement + both surfaces agree -------------

test("issue #115: the contract block sits in the driver between its markers, after scrub, before launch", () => {
  const src = readFileSync(SCRIPT, "utf8");
  const marker = "# --- standing agent contract: issue relationships (issue #115)";
  const mi = src.indexOf(marker);
  assert.notEqual(mi, -1, "the relationships contract block must exist in the driver");

  // Appended AFTER the input scrub pass: the block is repo-controlled
  // static prose; the scrub exists for thread-supplied text.
  const scrub = src.indexOf('SECRETS_ONLY=1 node "$SCRIPT_DIR/scrub-output.mjs"');
  assert.notEqual(scrub, -1);
  assert.ok(mi > scrub, "the contract block must be appended after the input scrub pass");

  // And BEFORE the launch line consumes TASK. (Not the bare
  // `dsh --profile headless` string — the file header comment mentions it
  // too; pin the actual launch line with its arg expansion.)
  const launch = src.indexOf("dsh --profile headless ${DSH_LAUNCH_ARGS");
  assert.notEqual(launch, -1);
  assert.ok(launch > mi, "TASK must be finalized before the launch line");

  // Escaping pin: the resolver query is stamped inside a double-quoted
  // bash string — the shell variables must stay escaped (\$o) or set -u
  // aborts the driver on launch ("o: unbound variable").
  assert.match(src, /query\(\\\$o:String!,\\\$r:String!,\\\$n:Int!\)/);
});

const MUTATION_SHAPES = [
  ["addSubIssue", /addSubIssue\(input:\{issueId:[^,]+, (?:subIssueId|subIssueUrl)/],
  ["addBlockedBy", /addBlockedBy\(input:\{issueId:[^,]+, blockingIssueId:/],
  ["addRelatesTo", /addRelatesTo\(input:\{issueId:[^,]+, relatedIssueId:/],
];

test("issue #115: driver and contract doc carry the three verified mutations with matching input field names", () => {
  const src = readFileSync(SCRIPT, "utf8");
  const doc = readFileSync(CONTRACT_DOC, "utf8");
  for (const [name, re] of MUTATION_SHAPES) {
    assert.match(src, re, `driver: ${name} must keep its verified input shape`);
    assert.match(doc, re, `contract doc: ${name} must keep its verified input shape`);
  }
  // The doc's verified-API section pins GraphQL-only + the read fields a
  // reviewer uses to verify an edge.
  assert.match(doc, /REST endpoints 404 — GraphQL only/);
  for (const field of ["`relatesTo`", "`blockedBy`", "`blocking`", "`subIssues`"]) {
    assert.match(doc, new RegExp(`Reads on Issue:.*${field}`), `contract doc must list the ${field} read`);
  }
});

test("issue #115: the contract doc carries the four linking rules and the exit-summary receipt format", () => {
  const doc = readFileSync(CONTRACT_DOC, "utf8");
  assert.match(doc, /\*\*PART TICKETS\*\*/);
  assert.match(doc, /\*\*DISCOVERIES\*\*/);
  assert.match(doc, /`found:` tickets/);
  assert.match(doc, /\*\*REDOS \/ follow-ons\*\*/);
  assert.match(doc, /\*\*EXIT SUMMARY\*\*/);
  assert.match(doc, /relationship column/);
  // Live receipts must stay citable: the scratch issues the smoke ran on.
  assert.match(doc, /scratch issues #116\/#117/);
  assert.match(doc, /no agent-filed ticket ships orphaned|whose GraphQL read shows no edges is a contract violation/);
});
