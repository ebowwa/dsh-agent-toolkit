// branch-hygiene-contract.test.mjs — contract fixtures for the
// branch-hygiene protocol (issue #127).
//
// Contract under test: zero orphan branches. A branch whose work outlives
// the session without a PR is a lost thread — the exact mess HYGIENE.md
// measured as gat's 16-branch `dsh/*` pile ("the single biggest messiness
// item in either repo"). The repos already run auto-delete-on-merge
// (verified live on this repo: `delete_branch_on_merge=true`), so a MERGED
// branch cleans itself up; the contract closes the two leak paths the
// setting cannot reach:
//
//   1. a pushed branch with no PR — SAME-SESSION PR PER BRANCH;
//   2. a PR closed without merging — DELETE ON CLOSE WITHOUT MERGE.
//
// ...and gives the exit summary its machine-checkable receipt: ONE
// `branches-left:` line, comma-space separated branch names, nothing else
// on the line; left nothing — the line is omitted entirely
// (`branches-left: none` is a violation, not an absence).
//
// Two surfaces, one protocol — these fixtures pin BOTH and keep them in
// agreement (the shape mirrors tests/relationships-contract.test.mjs):
//
//   behavioral — a stub agent captures the task it was launched with and
//   the branch-hygiene rules must be present in it (the driver's whole
//   point is that every dispatched node inherits the protocol through its
//   prompt).
//
//   structural — the driver block and the contract doc each carry the two
//   leak-path rules with their operative verbs, the `branches-left:`
//   exact-shape example, the auto-delete-on-merge fact, and the
//   zero-orphan acceptance sentence. A drift between the two surfaces, or
//   a revert of the exit-line shape, goes red here.

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

// The machine-checkable form of the exit-summary shape documented in
// .agents/README.md. Matching is relay-tolerant: a markdown bullet /
// blockquote / bold decoration in front of the label is stripped before
// the check (the reply relay may sit inside markdown), so the RELAYED
// line is validated by the same rules instead of being skipped — but the
// line itself carries nothing but the label and the branch names. The
// placeholder rejection is explicit (unlike
// filed-followups, whose `#\d+` refs reject `none` for free): branch
// names draw from the git-ref charset, and `none`, `N/A` and `-` are all
// valid members of it — the contract's "never write branches-left: none"
// clause must be machine-checkable, not prose.
const BRANCHES_LEFT_LINE = /^branches-left: [A-Za-z0-9._/-]+(, [A-Za-z0-9._/-]+)*$/;
const BRANCHES_LEFT_PLACEHOLDER = /^branches-left:\s*(?:none|n\/a|-)\s*$/i;

// Markdown relay tolerance (issue #141): the reply relay may decorate the
// label with a list bullet / blockquote marker / bold pair — "- branches-left:",
// "**branches-left:**". Strip exactly that decoration before the label
// check so the RELAYED line is VALIDATED by the shape
// rules below — a bullet-relayed `branches-left: none` is a violation,
// not an invisible line (a bare `startsWith` skipped it, which made the
// markdown-relay-safe claim vacuous).
const stripMarkdownRelay = (line) =>
  line.replace(/^[-*\s>]+/, "").replace(/:\*\*(?=\s|$)/, ":");

/** Violations of the exit-summary shape in an agent's final summary. */
const branchesLeftViolations = (summary) => {
  const violations = [];
  const lines = summary.split("\n");
  let seen = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = stripMarkdownRelay(lines[i].trim());
    if (!line.startsWith("branches-left")) continue;
    seen++;
    if (BRANCHES_LEFT_PLACEHOLDER.test(line)) {
      violations.push(`line ${i + 1} is a placeholder, not an absence: ${JSON.stringify(lines[i])}`);
    } else if (!BRANCHES_LEFT_LINE.test(line)) {
      violations.push(`line ${i + 1} is not the documented shape: ${JSON.stringify(lines[i])}`);
    }
  }
  if (seen > 1) violations.push(`${seen} branches-left lines — the contract allows ONE`);
  return violations;
};

// --- behavioral: the dispatched agent's prompt carries the rules ----------

test("issue #127: the prompt assembly appends the branch-hygiene contract to the launched task (stub agent sees it)", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "dsh-branch-hygiene-"));
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

  const proc = spawnSync("bash", [SCRIPT, "branch hygiene test task"], { encoding: "utf8", env, timeout: 60_000 });
  assert.equal(proc.status, 0, `driver must succeed (stderr: ${proc.stderr?.slice(-400)})`);

  const argv = readFileSync(capture, "utf8");
  // The task is everything after the first two argv lines
  // (`--profile`, `headless`) — the task itself is multi-line.
  const task = argv.trimEnd().split("\n").slice(2).join("\n");
  assert.match(task, /branch hygiene test task/, "the caller's own task text must survive");

  // The contract header and the zero-orphan frame:
  assert.match(task, /AGENT CONTRACT — branch hygiene \(issue #127\)/);
  assert.match(task, /zero orphan branches/);
  assert.match(task, /a branch whose work outlives the session without a PR is a lost thread/);

  // Rule 1 — same-session PR per branch:
  assert.match(task, /SAME-SESSION PR PER BRANCH — every branch your work lands on gets its PR opened in the SAME session that pushed it/);
  assert.match(task, /A pushed branch with no PR is an orphan/);

  // Rule 2 — delete on close without merge, with the exact commands:
  assert.match(task, /DELETE ON CLOSE WITHOUT MERGE — when a PR of yours closes WITHOUT merging \(superseded, wrong approach, duplicate\), delete its branch in the same breath/);
  assert.match(task, /gh pr close NUMBER --delete-branch/);
  assert.match(task, /git push origin --delete BRANCH/);
  assert.match(task, /Merged branches are auto-deleted by the repo setting — never restore one/);

  // Rule 3 — the branches-left exit line, with its exact shape:
  assert.match(task, /BRANCHES-LEFT EXIT LINE — reference every remote branch your session leaves behind \(open PRs waiting on review\) on ONE branches-left: line/);
  assert.match(task, /branches-left: dsh\/issue-127-c5844082078, dsh\/issue-128-nextticket/);
  assert.match(task, /never write branches-left: none/);

  // The acceptance sentence (zero orphans, three states) and the
  // auto-delete-on-merge fact it leans on:
  assert.match(task, /Acceptance — zero orphans: at exit, every branch the session pushed is in exactly one of three states/);
  assert.match(task, /auto-delete-on-merge/);

  rmSync(dir, { recursive: true, force: true });
});

// --- structural: driver block placement + both surfaces agree -------------

test("issue #127: the contract block sits in the driver between its markers, after scrub and after the relationships block, before launch", () => {
  const src = readFileSync(SCRIPT, "utf8");
  const marker = "# --- standing agent contract: branch hygiene (issue #127)";
  const mi = src.indexOf(marker);
  assert.notEqual(mi, -1, "the branch-hygiene contract block must exist in the driver");

  // Appended AFTER the input scrub pass: the block is repo-controlled
  // static prose; the scrub exists for thread-supplied text.
  const scrub = src.indexOf('SECRETS_ONLY=1 node "$SCRIPT_DIR/scrub-output.mjs"');
  assert.notEqual(scrub, -1);
  assert.ok(mi > scrub, "the contract block must be appended after the input scrub pass");

  // And after the relationships block: the contracts append in issue
  // order, so the launched task reads discovery → relationships → hygiene.
  const relationships = src.indexOf("# --- standing agent contract: issue relationships (issue #115)");
  assert.notEqual(relationships, -1);
  assert.ok(mi > relationships, "the branch-hygiene block appends after the relationships block");

  // And BEFORE the launch line consumes TASK. (Not the bare
  // `dsh --profile headless` string — the file header comment mentions it
  // too; pin the actual launch line with its arg expansion.)
  const launch = src.indexOf("dsh --profile headless ${DSH_LAUNCH_ARGS");
  assert.notEqual(launch, -1);
  assert.ok(launch > mi, "TASK must be finalized before the launch line");
});

// The driver stamps the rules as numbered plain prose; the contract doc
// bolds the rule names (house style) — same rule, two surface spellings,
// so each surface gets its own pin and the agreement test below pins the
// word-for-word strings that appear identically on both.
const HYGIENE_RULES = [
  [
    "SAME-SESSION PR PER BRANCH",
    /1\. SAME-SESSION PR PER BRANCH — every branch your work lands on gets its PR opened in the SAME session that pushed it/,
    /\*\*SAME-SESSION PR PER BRANCH\*\*/,
  ],
  [
    "DELETE ON CLOSE WITHOUT MERGE",
    /2\. DELETE ON CLOSE WITHOUT MERGE — when a PR of yours closes WITHOUT merging/,
    /\*\*DELETE ON CLOSE WITHOUT MERGE\*\*/,
  ],
  [
    "BRANCHES-LEFT EXIT LINE",
    /3\. BRANCHES-LEFT EXIT LINE — reference every remote branch your session leaves behind/,
    /\*\*BRANCHES-LEFT EXIT LINE\*\*/,
  ],
];

test("issue #127: driver and contract doc carry the two leak-path rules and the exit-line rule", () => {
  const src = readFileSync(SCRIPT, "utf8");
  const doc = readFileSync(CONTRACT_DOC, "utf8");
  for (const [name, driverRe, docRe] of HYGIENE_RULES) {
    assert.match(src, driverRe, `driver: ${name} must keep its operative wording`);
    assert.match(doc, docRe, `contract doc: ${name} must keep its rule heading`);
  }
  // Word-for-word on BOTH surfaces (markdown-tolerant: the doc wraps
  // lines and backticks its commands, the driver stamps plain prose):
  for (const re of [
    /branches-left: dsh\/issue-127-c5844082078, dsh\/issue-128-nextticket/,
    /never write `?branches-left: none`?/,
    /auto-delete-on-merge/,
    /every branch the session pushed is\s+in exactly one of three states/,
    /pushed branch with no PR is an orphan/,
    /gh pr close NUMBER --delete-branch/,
    /git push origin --delete BRANCH/,
  ]) {
    assert.match(src, re, "driver block drift");
    assert.match(doc, re, "contract doc drift");
  }
  // The doc keeps its receipts: the HYGIENE.md measurement that motivates
  // the contract, and the verified repo setting.
  assert.match(doc, /16-branch/);
  assert.match(doc, /delete_branch_on_merge=true/);
});

// --- the exit-summary shape (fixtures) -------------------------------------

test("exit-summary shape: a single left-behind branch", () => {
  assert.deepEqual(branchesLeftViolations("What changed: fixed the boot race.\n\nbranches-left: dsh/issue-127-c5844082078\n"), []);
});

test("exit-summary shape: multiple branches, comma-space separated", () => {
  assert.deepEqual(branchesLeftViolations("branches-left: dsh/issue-127-c5844082078, dsh/issue-128-nextticket, dsh/hotfix-lane\n"), []);
});

test("exit-summary shape: underscored and dotted branch names are branch names", () => {
  assert.deepEqual(branchesLeftViolations("branches-left: dsh/my_branch.v2\n"), []);
});

test("exit-summary shape: trim-tolerant (markdown-relay safe), still strict on content", () => {
  assert.deepEqual(branchesLeftViolations("- branches-left: dsh/issue-127-c5844082078\n"), []);
});

test("exit-summary shape: markdown-relayed lines are VALIDATED, not skipped (issue #141)", () => {
  // Valid relayed forms stay valid under every decoration the reply
  // relay actually emits:
  for (const good of [
    "- branches-left: dsh/issue-127-c5844082078",
    "* branches-left: dsh/a, dsh/b",
    "> branches-left: dsh/a",
    "**branches-left:** dsh/a",
  ]) {
    assert.deepEqual(branchesLeftViolations(`${good}\n`), [], `expected zero violations for: ${good}`);
  }
  // ...and the relayed form is VALIDATED: a placeholder or a malformed
  // list behind a bullet is a violation, not an invisible line.
  for (const bad of [
    "- branches-left: none",
    "**branches-left:** none",
    "- branches-left: N/A",
    "- branches-left: dsh/a (see PR #9)",
    "- branches-left: dsh/a,dsh/b",
  ]) {
    assert.equal(branchesLeftViolations(`${bad}\n`).length, 1, `expected exactly one violation for: ${bad}`);
  }
  // The relayed form counts toward the ONE-line rule too.
  const violations = branchesLeftViolations("branches-left: dsh/a\n- branches-left: dsh/b\n");
  assert.equal(violations.length, 1);
  assert.match(violations[0], /ONE/);
});

test("exit-summary shape: left nothing — the line is absent, zero violations", () => {
  assert.deepEqual(branchesLeftViolations("What changed: the diff is complete. Every branch merged (auto-deleted on merge).\n"), []);
});

test("exit-summary shape violations: padded placeholders are violations, not absences", () => {
  for (const bad of ["branches-left: none", "branches-left: N/A", "branches-left:", "branches-left: -"]) {
    assert.equal(branchesLeftViolations(`${bad}\n`).length, 1, `expected exactly one violation for: ${bad}`);
  }
});

test("exit-summary shape violations: malformed ref lists", () => {
  for (const bad of [
    "branches-left: dsh/a,dsh/b", // missing comma-space
    "branches-left: dsh/a dsh/b", // missing comma
    "branches-left: #114", // an issue ref is not a branch name
    "branches-left: dsh/a (open PR #9)", // trailing prose
    "branches-left: dsh/a, dsh/b open for review", // trailing prose after the list
  ]) {
    assert.equal(branchesLeftViolations(`${bad}\n`).length, 1, `expected exactly one violation for: ${bad}`);
  }
});

test("exit-summary shape violations: TWO branches-left lines (the contract allows ONE)", () => {
  const violations = branchesLeftViolations("branches-left: dsh/a\nsome prose\nbranches-left: dsh/b\n");
  assert.equal(violations.length, 1);
  assert.match(violations[0], /ONE/);
});
