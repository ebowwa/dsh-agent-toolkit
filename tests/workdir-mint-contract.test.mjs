// workdir-mint-contract.test.mjs — contract fixtures for the workdir-mint
// protocol (issue #374).
//
// Contract under test: a per-claim workdir is only yours if its name
// carries a random component YOU minted — never a bare epoch. The #374
// receipts (2026-10-04, shared box): two same-issue siblings both minted
// work-<issue>-<repo>-$(date +%s); the uniqueness budget was the issue
// number plus ONE second of epoch, the later clone landed on the
// identical path, and it silently replaced the earlier agent's confirmed
// edits mid-session — whose receipts then validated a tree that was no
// longer its own. Blast radius is WORSE than the #333 fixed-/tmp class:
// the takeover is silent.
//
// Three leak-path-shaped rules close it:
//
//   1. MINT WITH A RANDOM COMPONENT — mktemp -d "$HOME/dsh-node/
//      work-<issue>-<repo>-XXXXXX"; tags may ride the prefix, bare
//      $(date +%s) is banned (one-second granularity; a factory#869
//      concurrent-mint wave arms same-issue siblings inside it).
//   2. NEVER REUSE A MATCHING DIR — `ls -d work-<issue>-<repo>-* |
//      head -1` enters a sibling's live tree at ANY time.
//   3. VERIFY THE TREE BEFORE YOU EDIT — first batch confirms identity
//      (git log -1 / git status / HEAD vs the claim's base).
//
// Two surfaces, one protocol — these fixtures pin BOTH and keep them in
// agreement (the shape mirrors tests/branch-hygiene-contract.test.mjs):
//
//   behavioral — a stub agent captures the task it was launched with and
//   the workdir-mint rules must be present in it (the driver's whole
//   point is that every dispatched node inherits the protocol through
//   its prompt).
//
//   structural — the driver block and the contract doc each carry the
//   three rules with their operative verbs, the mint recipe, the
//   bare-epoch ban, and the zero-silent-takeover acceptance sentence.
//   A drift between the two surfaces, or a revert of the mint, goes red
//   here.
//
//   corpus — no conduct-corpus file teaches an epoch-suffixed workdir
//   mint as a recipe: every `work-...$(date +%s)` occurrence must carry
//   an inline ban/negation marker (banned / never / collided) on the
//   same line, so prose can cite the defect without teaching it.

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

// --- behavioral: the dispatched agent's prompt carries the rules ----------

test("issue #374: the prompt assembly appends the workdir-mint contract to the launched task (stub agent sees it)", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "dsh-workdir-mint-"));
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

  const proc = spawnSync("bash", [SCRIPT, "workdir mint test task"], { encoding: "utf8", env, timeout: 60_000 });
  assert.equal(proc.status, 0, `driver must succeed (stderr: ${proc.stderr?.slice(-400)})`);

  const argv = readFileSync(capture, "utf8");
  // The task is everything after the first two argv lines
  // (`--profile`, `headless`) — the task itself is multi-line.
  const task = argv.trimEnd().split("\n").slice(2).join("\n");
  assert.match(task, /workdir mint test task/, "the caller's own task text must survive");

  // The contract header and the ownership frame:
  assert.match(task, /AGENT CONTRACT — workdir mint \(issue #374\)/);
  assert.match(task, /a per-claim workdir is only yours if its name carries a random component YOU minted — never a bare epoch/);
  assert.match(task, /collided at one-second granularity/);

  // Rule 1 — the random-component mint, with the exact recipe:
  assert.match(task, /1\. MINT WITH A RANDOM COMPONENT — workdir="\$\(mktemp -d "\$HOME\/dsh-node\/work-<issue>-<repo>-XXXXXX"\)"/);
  assert.match(task, /issue\/repo tags may ride the prefix, but the uniqueness must be random/);
  assert.match(task, /\$\(date \+%s\) alone is BANNED: epoch resolves at one-second granularity/);

  // Rule 2 — no reuse of a matching dir:
  assert.match(task, /2\. NEVER REUSE A MATCHING DIR — ls -d work-<issue>-<repo>-\* \| head -1 enters a sibling's live tree at ANY time/);
  assert.match(task, /a matching name is not yours until YOU minted it/);

  // Rule 3 — verify the tree before editing:
  assert.match(task, /3\. VERIFY THE TREE BEFORE YOU EDIT — the first command batch in a fresh workdir confirms identity/);
  assert.match(task, /A tree whose contents are not what you cloned is a sibling's — leave it and mint your own/);

  // The acceptance sentence (zero silent takeovers):
  assert.match(task, /Acceptance — zero silent takeovers: every workdir this session creates carries a random component in its name/);
  assert.match(task, /never edits a tree whose mint it does not own/);

  rmSync(dir, { recursive: true, force: true });
});

// --- structural: driver block placement + both surfaces agree -------------

test("issue #374: the contract block sits in the driver between its markers, after branch hygiene, before launch", () => {
  const src = readFileSync(SCRIPT, "utf8");
  const marker = "# --- standing agent contract: workdir mint (issue #374)";
  const mi = src.indexOf(marker);
  assert.notEqual(mi, -1, "the workdir-mint contract block must exist in the driver");

  // Appended AFTER the input scrub pass: the block is repo-controlled
  // static prose; the scrub exists for thread-supplied text.
  const scrub = src.indexOf('SECRETS_ONLY=1 node "$SCRIPT_DIR/scrub-output.mjs"');
  assert.notEqual(scrub, -1);
  assert.ok(mi > scrub, "the contract block must be appended after the input scrub pass");

  // And after the branch-hygiene block: the contracts append in issue
  // order, so the launched task reads discovery → relationships →
  // branch hygiene → workdir mint.
  const branchHygiene = src.indexOf("# --- standing agent contract: branch hygiene (issue #127)");
  assert.notEqual(branchHygiene, -1);
  assert.ok(mi > branchHygiene, "the workdir-mint block appends after the branch-hygiene block");

  // And BEFORE the launch line consumes TASK. (Not the bare
  // `dsh --profile headless` string — the file header comment mentions it
  // too; pin the actual launch line with its arg expansion.)
  const launch = src.indexOf("dsh --profile headless ${DSH_LAUNCH_ARGS");
  assert.notEqual(launch, -1);
  assert.ok(launch > mi, "TASK must be finalized before the launch line");

  // The stamped segment carries NO backticks: the block is a shell
  // double-quoted string, where a backtick is command substitution — a
  // backtick sneaking into the prose would execute at prompt-assembly
  // time, not print.
  const segmentEnd = src.indexOf("# Per-job harness home by default", mi);
  assert.notEqual(segmentEnd, -1, "the block must sit before the harness-home section");
  const segment = src.slice(mi, segmentEnd);
  assert.ok(!segment.includes("`"), "the stamped workdir-mint prose must not contain backticks (double-quoted shell string)");
});

// The driver stamps the rules as numbered plain prose; the contract doc
// bolds the rule names (house style) — same rule, two surface spellings,
// so each surface gets its own pin and the agreement test below pins the
// word-for-word strings that appear identically on both. The driver-side
// regexes match the SCRIPT SOURCE, where the stamped prose carries its
// shell escaping (`\$`, `\"`) — the behavioral test above pins the same
// strings post-expansion, so both spellings stay covered.
const MINT_RULES = [
  [
    "MINT WITH A RANDOM COMPONENT",
    /1\. MINT WITH A RANDOM COMPONENT — workdir=\\"\\\$\(mktemp -d \\"\\\$HOME\/dsh-node\/work-<issue>-<repo>-XXXXXX\\"\)\\"/,
    /\*\*MINT WITH A RANDOM COMPONENT\*\*[\s\S]*?Bare `\$\(date \+%s\)` is banned/,
  ],
  [
    "NEVER REUSE A MATCHING DIR",
    /2\. NEVER REUSE A MATCHING DIR — ls -d work-<issue>-<repo>-\* \| head -1 enters a sibling's live tree at ANY time/,
    /\*\*NEVER REUSE A MATCHING DIR\*\*/,
  ],
  [
    "VERIFY THE TREE BEFORE YOU EDIT",
    /3\. VERIFY THE TREE BEFORE YOU EDIT — the first command batch in a fresh workdir confirms identity/,
    /\*\*VERIFY THE TREE BEFORE YOU EDIT\*\*/,
  ],
];

test("issue #374: driver and contract doc carry the three workdir-mint rules", () => {
  const src = readFileSync(SCRIPT, "utf8");
  const doc = readFileSync(CONTRACT_DOC, "utf8");
  for (const [name, driverRe, docRe] of MINT_RULES) {
    assert.match(src, driverRe, `driver: ${name} must keep its operative wording`);
    assert.match(doc, docRe, `contract doc: ${name} must keep its rule heading`);
  }
  // Word-for-word on BOTH surfaces (markdown-tolerant: the doc wraps
  // lines and backticks its commands, the driver stamps plain prose with
  // its shell escaping — `\\?` absorbs the backslash, `\s+` the wraps):
  for (const re of [
    /mktemp -d [\\"]*\$HOME\/dsh-node\/work-<issue>-<repo>-XXXXXX[\\")]*/,
    /\\?\$\(date \+%s\)/,
    /a matching name is not yours until YOU minted\s+it/,
    /Acceptance — zero silent takeovers:\*{0,2} every workdir this session\s+creates carries a random component in its name/,
    /never\s+edits a tree whose mint it does not own/,
  ]) {
    assert.match(src, re, `driver must keep: ${re}`);
    assert.match(doc, re, `contract doc must keep: ${re}`);
  }
});

// --- corpus: no conduct surface teaches an epoch-suffixed workdir mint ----

// A workdir template whose terminal uniqueness is a bare epoch:
// `work-<whatever>-$(date +%s)`. The char class admits the placeholder
// grammar the docs use (`<issue>-<repo>`) plus the shell-name charset.
const EPOCH_MINT = /work[A-Za-z0-9<>._-]*\$\(date \+%s\)/;
// An inline ban/negation marker: the line CITES the defect rather than
// teaching it. Prose is allowed to name the banned recipe as the thing
// that is banned; a recipe line never carries the marker.
const BAN_MARKER = /banned|never|collided/i;
// Shell comment lines are explanations, not stamped/taught recipes — the
// corpus scan measures what an agent is HANDED (stamped TASK prose,
// markdown conduct), and a `#` line reaches no prompt.
const SHELL_COMMENT = /^\s*#/;

/** Conduct-corpus files: every surface an agent is handed or copies a
 *  recipe from. Skills ride along as directories of SKILL.md. */
const corpusFiles = () => {
  const files = [
    path.join(ROOT, "CONTRIBUTING.md"),
    CONTRACT_DOC,
    SCRIPT,
    path.join(ROOT, "CLAUDE.md"),
    path.join(ROOT, "README.md"),
    path.join(ROOT, "HYGIENE.md"),
  ];
  const docsDir = path.join(ROOT, "docs");
  for (const e of readdirSync(docsDir, { withFileTypes: true }))
    if (e.isFile() && e.name.endsWith(".md")) files.push(path.join(docsDir, e.name));
  const skillsDir = path.join(ROOT, ".agents", "skills");
  for (const e of readdirSync(skillsDir, { withFileTypes: true }))
    if (e.isDirectory())
      files.push(path.join(skillsDir, e.name, "SKILL.md"));
  return files.filter((f) => {
    try { return readFileSync(f, "utf8") !== undefined; } catch { return false; }
  });
};

test("issue #374: the conduct corpus teaches no epoch-suffixed workdir mint", () => {
  const violations = [];
  for (const file of corpusFiles()) {
    const isShell = file.endsWith(".sh");
    const lines = readFileSync(file, "utf8").split("\n");
    lines.forEach((line, i) => {
      if (isShell && SHELL_COMMENT.test(line)) return;
      if (!EPOCH_MINT.test(line)) return;
      if (BAN_MARKER.test(line)) return;
      violations.push(`${path.relative(ROOT, file)}:${i + 1}: epoch-suffixed workdir mint with no inline ban marker: ${JSON.stringify(line.trim())}`);
    });
  }
  assert.deepEqual(violations, [], "every work-...-$(date +%s) occurrence must cite the ban, not teach the recipe");
});
