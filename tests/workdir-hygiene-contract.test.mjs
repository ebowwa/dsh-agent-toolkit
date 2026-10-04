// workdir-hygiene-contract.test.mjs — contract fixtures for the
// workdir-hygiene protocol (issue #333).
//
// Contract under test: a checkout path you did not mint is not yours.
// Concurrent fleet agents on one box clone their claim repos into
// throwaway paths; a predictable shared path (`/tmp/<repo>`) plus the
// `rm -rf /tmp/<repo> && gh repo clone` recipe is a worktree-destruction
// mechanism — a sibling starting the same claim later re-clones OVER the
// earlier one's in-flight worktree, silently. Receipt (claim #302,
// 2026-10-04): the loser's clone carried a single-entry `clone:` reflog
// stamped 02:25:39 over an edited tree whose branch was never pushed;
// tested work died with zero signal. /tmp is host-global on the shared
// lane boxes and the bare path carries no session/claim identity — the
// same silent-loss class as #276 (worker re-pin), sibling-clone trigger.
//
// The contract's three rules:
//
//   1. MINT A UNIQUE WORKDIR PER CLAIM — mktemp -d, never a predictable
//      `/tmp/<repo>`;
//   2. NEVER THE SHARED-PATH CLONE RECIPE — the `rm -rf` precondition on
//      a path another in-flight sibling may be working in is banned;
//   3. CLEAN UP ONLY WHAT YOU MINTED — rm -rf only paths this session
//      created.
//
// Three surfaces, one protocol — these fixtures pin ALL of them and keep
// them in agreement (the shape mirrors
// tests/branch-hygiene-contract.test.mjs):
//
//   behavioral — a stub agent captures the task it was launched with and
//   the workdir-hygiene rules must be present in it (the driver's whole
//   point is that every dispatched node inherits the protocol through
//   its prompt).
//
//   structural — the driver block sits between its markers, after the
//   input scrub pass and after the branch-hygiene block (contracts
//   append in issue order), before the launch line; the driver block and
//   the contract doc agree on the operative wording.
//
//   corpus — the skills corpus (`.agents/skills/**`), the copy-paste
//   surface agents actually run recipes from, teaches NO destructive
//   `/tmp` precondition and NO fixed predictable clone destination, and
//   carries the mktemp-minted forms (a revert of the corpus fix goes
//   red here). Line-based by design (the house lint doctrine: catch the
//   observed defect class, not the universe); the README/driver quote
//   the banned shape inside the ban rule itself — a mention, not a
//   teaching — so the corpus scan deliberately covers skills only.

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
const SKILLS_DIR = path.join(ROOT, ".agents", "skills");

/** Every .md file under a directory, recursively (skills corpus). */
const walkMd = (dir) => {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkMd(p));
    else if (entry.name.endsWith(".md")) out.push(p);
  }
  return out;
};

// --- behavioral: the dispatched agent's prompt carries the rules ----------

test("issue #333: the prompt assembly appends the workdir-hygiene contract to the launched task (stub agent sees it)", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "dsh-workdir-hygiene-"));
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

  const proc = spawnSync("bash", [SCRIPT, "workdir hygiene test task"], { encoding: "utf8", env, timeout: 60_000 });
  assert.equal(proc.status, 0, `driver must succeed (stderr: ${proc.stderr?.slice(-400)})`);

  const argv = readFileSync(capture, "utf8");
  // The task is everything after the first two argv lines
  // (`--profile`, `headless`) — the task itself is multi-line.
  const task = argv.trimEnd().split("\n").slice(2).join("\n");
  assert.match(task, /workdir hygiene test task/, "the caller's own task text must survive");

  // The contract header and the ownership frame:
  assert.match(task, /AGENT CONTRACT — workdir hygiene \(issue #333\)/);
  assert.match(task, /a checkout path you did not mint is not yours — never rm -rf it, never clone over it/);
  assert.match(task, /the loser loses uncommitted work with zero signal/);

  // Rule 1 — mint a unique workdir per claim, with the mktemp form:
  assert.match(task, /MINT A UNIQUE WORKDIR PER CLAIM — clone into a path only this session can own/);
  assert.match(task, /mktemp -d/);
  assert.match(task, /dsh-<repo>-XXXXXX/);
  assert.match(task, /a predictable \/tmp\/<repo> is a collision, not a default/);

  // Rule 2 — the shared-path clone recipe is banned:
  assert.match(task, /NEVER THE SHARED-PATH CLONE RECIPE — rm -rf \/tmp\/<repo> && gh repo clone \.\.\. is BANNED/);
  assert.match(task, /a destructive precondition on a path another in-flight sibling may be working in/);

  // Rule 3 — clean up only what you minted:
  assert.match(task, /CLEAN UP ONLY WHAT YOU MINTED — rm -rf only paths THIS session created/);
  assert.match(task, /leave shared checkouts, lane checkouts, and every path you did not mint alone/);

  // The acceptance sentence (structural, not probabilistic):
  assert.match(task, /two same-box agents working the same repo can never collide on a checkout path/);

  rmSync(dir, { recursive: true, force: true });
});

// --- structural: driver block placement + both surfaces agree -------------

test("issue #333: the contract block sits in the driver between its markers, after scrub and after the branch-hygiene block, before launch", () => {
  const src = readFileSync(SCRIPT, "utf8");
  const marker = "# --- standing agent contract: workdir hygiene (issue #333)";
  const mi = src.indexOf(marker);
  assert.notEqual(mi, -1, "the workdir-hygiene contract block must exist in the driver");

  // Appended AFTER the input scrub pass: the block is repo-controlled
  // static prose; the scrub exists for thread-supplied text.
  const scrub = src.indexOf('SECRETS_ONLY=1 node "$SCRIPT_DIR/scrub-output.mjs"');
  assert.notEqual(scrub, -1);
  assert.ok(mi > scrub, "the contract block must be appended after the input scrub pass");

  // And after the branch-hygiene block: the contracts append in issue
  // order, so the launched task reads discovery → relationships →
  // hygiene (#127) → hygiene (#333).
  const branchHygiene = src.indexOf("# --- standing agent contract: branch hygiene (issue #127)");
  assert.notEqual(branchHygiene, -1);
  assert.ok(mi > branchHygiene, "the workdir-hygiene block appends after the branch-hygiene block");

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
const WORKDIR_RULES = [
  [
    "MINT A UNIQUE WORKDIR PER CLAIM",
    /1\. MINT A UNIQUE WORKDIR PER CLAIM — clone into a path only this session can own/,
    /\*\*MINT A UNIQUE WORKDIR PER CLAIM\*\*/,
  ],
  [
    "NEVER THE SHARED-PATH CLONE RECIPE",
    /2\. NEVER THE SHARED-PATH CLONE RECIPE — rm -rf \/tmp\/<repo> && gh repo clone/,
    /\*\*NEVER THE SHARED-PATH CLONE RECIPE\*\*/,
  ],
  [
    "CLEAN UP ONLY WHAT YOU MINTED",
    /3\. CLEAN UP ONLY WHAT YOU MINTED — rm -rf only paths THIS session created/,
    /\*\*CLEAN UP ONLY WHAT YOU MINTED\*\*/,
  ],
];

test("issue #333: driver and contract doc carry the three rules with the operative wording", () => {
  const src = readFileSync(SCRIPT, "utf8");
  const doc = readFileSync(CONTRACT_DOC, "utf8");
  for (const [name, driverRe, docRe] of WORKDIR_RULES) {
    assert.match(src, driverRe, `driver: ${name} must keep its operative wording`);
    assert.match(doc, docRe, `contract doc: ${name} must keep its rule heading`);
  }
  // Word-for-word on BOTH surfaces (markdown- and shell-escape-tolerant:
  // the doc wraps lines and backticks its commands, the driver stamps the
  // same command inside a double-quoted TASK append, so its source form
  // carries `\"`/`\$` escapes — `\\?` absorbs them for both spellings):
  for (const re of [
    /a checkout path you did not mint is not yours/i,
    /mktemp -d \\?"\\?\$\{TMPDIR:-\/tmp\}\/dsh-<repo>-XXXXXX/,
    /a predictable `?\/tmp\/<repo>?`? is a\s+collision, not a default/,
    /destructive precondition\s+on a path another in-flight sibling may be working in/,
    /two same-box agents\s+working the same repo can never collide on a checkout path/,
  ]) {
    assert.match(src, re, "driver block drift");
    assert.match(doc, re, "contract doc drift");
  }
  // The doc keeps its receipts: the observed loss (#302) that motivates
  // the contract, and the same-silent-loss-class cousin (#276).
  assert.match(doc, /#302/);
  assert.match(doc, /#276/);
});

// --- corpus: the skills teach no shared-path clone recipe ------------------

// A violation is a skills line that TEACHES the observed defect class:
//   A. a destructive `rm -rf /tmp/...` precondition — the recipe's killing
//      edge, on any line (in the copy-paste corpus there is no legitimate
//      reason to rm -rf a fixed /tmp path);
//   B. a clone whose destination is a fixed predictable path — a `/tmp/`
//      literal with no mktemp/XXXXXX randomness on the line, or the bare
//      fixed relative name the old cross-repo-guest recipe used
//      (`gh repo clone <target> work`).
// The README/driver quote the banned shape inside the ban rule itself —
// a mention, not a teaching — so the corpus scan covers skills only.
// Line-based by design (the house lint doctrine); wrapped teachings
// across lines are out of scope here, same as scripts/tests-lint.mjs.
const corpusViolations = (files) => {
  const violations = [];
  for (const file of files) {
    const rel = path.relative(ROOT, file);
    const lines = readFileSync(file, "utf8").split("\n");
    lines.forEach((line, i) => {
      const n = i + 1;
      if (/rm\s+-rf\s+\/tmp\//.test(line)) {
        violations.push(`${rel}:${n} destructive /tmp precondition: ${line.trim().slice(0, 90)}`);
      }
      if (/(gh\s+repo\s+clone|git\s+clone)/.test(line)) {
        if (/\/tmp\//.test(line) && !/(mktemp|XXXXXX)/.test(line)) {
          violations.push(`${rel}:${n} clone into a fixed /tmp path: ${line.trim().slice(0, 90)}`);
        }
        if (/(gh\s+repo\s+clone|git\s+clone)\s+\S+\s+work\b/.test(line)) {
          violations.push(`${rel}:${n} clone into the fixed relative name 'work': ${line.trim().slice(0, 90)}`);
        }
      }
    });
  }
  return violations;
};

test("issue #333 corpus: no skill teaches a destructive /tmp precondition or a fixed predictable clone destination", () => {
  const files = walkMd(SKILLS_DIR);
  assert.ok(files.length > 5, "the skills corpus must actually be scanned");
  assert.deepEqual(corpusViolations(files), []);
});

test("issue #333 corpus: the touched skills carry the mktemp-minted forms (a revert goes red)", () => {
  const crossRepo = readFileSync(path.join(SKILLS_DIR, "cross-repo-guest", "SKILL.md"), "utf8");
  assert.match(crossRepo, /mktemp -d "\$\{TMPDIR:-\/tmp\}\/dsh-<target>-XXXXXX"/);
  assert.match(crossRepo, /gh repo clone <target> "\$workdir"/);
  assert.doesNotMatch(crossRepo, /gh repo clone <target> work\b/);

  const worktree = readFileSync(path.join(SKILLS_DIR, "worktree-over-stash", "SKILL.md"), "utf8");
  assert.match(worktree, /mktemp "\$\{TMPDIR:-\/tmp\}\/<repo>-wip-baseline\.XXXXXX"/);
  assert.match(worktree, /sort > "\$baseline"/);
  assert.doesNotMatch(worktree, /\/tmp\/<repo>-wip-baseline\.txt/);

  const ghCli = readFileSync(path.join(SKILLS_DIR, "gh-cli-techniques", "SKILL.md"), "utf8");
  assert.match(ghCli, /git clone --depth 5 --branch <dominant> <url> "\$\(mktemp -d /);
});

// Sanity: the corpus scanner itself catches the observed teachings (the
// pre-fix corpus shapes are violations — otherwise the pins above are
// vacuous). Fixture lines reproduced from the pre-#333 corpus.
test("issue #333 corpus scanner: the pre-fix recipe shapes are violations, minted forms are not", () => {
  const bad = [
    "1. `gh repo clone <target> work && cd work`",
    "1. Baseline before touching anything: `git status --porcelain | sort > /tmp/<repo>-wip-baseline.txt`",
    "rm -rf /tmp/dsh-agent-toolkit && gh repo clone ebowwa/dsh-agent-toolkit /tmp/dsh-agent-toolkit",
  ];
  const good = [
    '1. `workdir="$(mktemp -d "${TMPDIR:-/tmp}/dsh-<target>-XXXXXX")" && gh repo clone <target> "$workdir" && cd "$workdir"`',
    "2. `git fetch origin`; pick base (usually `origin/main`).",
    "rm -rf ~/Library/Application Support/Gauge/plugins/<Name>.gaugeplugin", // not a /tmp path, not a clone
  ];
  const fixture = path.join(tmpdir(), "dsh-corpus-fixture-" + process.pid + ".md");
  writeFileSync(fixture, [...bad, ...good].join("\n") + "\n");
  const violations = corpusViolations([fixture]);
  rmSync(fixture, { force: true });
  assert.equal(violations.length, bad.length, `expected exactly the ${bad.length} pre-fix shapes flagged: ${JSON.stringify(violations)}`);
});
