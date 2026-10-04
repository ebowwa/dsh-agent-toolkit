// workdir-hygiene-contract.test.mjs — contract fixtures for the
// workdir-hygiene protocol (issue #333).
//
// Contract under test: zero predictable throwaway workdirs. Concurrent
// fleet agents on one box clone their claim repos into throwaway paths,
// and the standard recipe's bare `rm -rf /tmp/<repo>` re-clone
// precondition re-clones OVER any sibling already at that path —
// observed live 2026-10-04 02:25:39 on the shared mac box: a sibling's
// edited worktree and unpushed branch were replaced by a pristine clone
// carrying a single-entry `clone:` reflog, with zero signal (factory#869
// had armed 14 concurrent agents on one box; the mint double-arming a
// claim is the normal case). The same silent-loss class as issue #276,
// sibling-clone trigger. The contract closes it at MINT time:
//
//   1. a workdir must be MINTED (mktemp -d), never a predictable
//      shared path — a minted suffix cannot collide;
//   2. a path the session did not mint must never be rm -rf'd as a
//      clone precondition;
//   3. a shared box is the DEFAULT assumption, not the exception.
//
// Three surfaces, one protocol (the shape mirrors
// tests/branch-hygiene-contract.test.mjs):
//
//   behavioral — a stub agent captures the task it was launched with and
//   the workdir-hygiene rules must be present in it (every dispatched
//   node inherits the protocol through its prompt).
//
//   structural — the driver block sits after the branch-hygiene block
//   (contracts append in issue order), after the input scrub pass, and
//   before the launch line; the driver and the contract doc keep their
//   operative strings in agreement.
//
//   corpus — no tracked doc teaches the colliding clone recipe: the
//   `rm -rf /tmp/<repo> && gh repo clone` precondition and the
//   fixed-name clone destination (`gh repo clone <target> work`, the
//   exact form .agents/skills/cross-repo-guest/SKILL.md shipped before
//   this contract) stay out of the docs corpus, and the skill that
//   taught the recipe now teaches the mktemp mint.

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
const GUEST_SKILL = path.join(ROOT, ".agents", "skills", "cross-repo-guest", "SKILL.md");

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

  // The contract header and the collision frame:
  assert.match(task, /AGENT CONTRACT — workdir hygiene \(issue #333\)/);
  assert.match(task, /a throwaway clone path is YOURS only if no sibling can predict it/);

  // Rule 1 — the mint, with the exact recipe (shell-escaped in the
  // driver source, clean in the stamped task):
  assert.match(task, /MINT A UNIQUE WORKDIR PER CLAIM — never clone into a predictable shared path/);
  assert.match(task, /mktemp -d "\$\{TMPDIR:-\/tmp\}\/dsh-<repo>-XXXXXX"/);
  assert.match(task, /gh repo clone <owner>\/<repo> "\$workdir"/);
  assert.match(task, /the XXXXXX suffix is minted, not chosen/);

  // Rule 2 — the ban, naming the banned shape:
  assert.match(task, /NEVER rm -rf A PATH YOU DID NOT MINT/);
  assert.match(task, /the bare rm -rf \/tmp\/<repo> && gh repo clone precondition is banned/);

  // Rule 3 — the shared-box default:
  assert.match(task, /SHARED-BOX DEFAULT — assume siblings/);
  assert.match(task, /factory#869/);

  // The acceptance sentence:
  assert.match(task, /every throwaway checkout the session creates rides a mktemp-minted path/);
  assert.match(task, /never writes rm -rf against a path it did not mint itself/);

  rmSync(dir, { recursive: true, force: true });
});

// --- structural: driver block placement + both surfaces agree -------------

test("issue #333: the contract block sits in the driver after the branch-hygiene block, after scrub, before launch", () => {
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
  // hygiene → workdir hygiene.
  const hygiene = src.indexOf("# --- standing agent contract: branch hygiene (issue #127)");
  assert.notEqual(hygiene, -1);
  assert.ok(mi > hygiene, "the workdir-hygiene block appends after the branch-hygiene block");

  // And BEFORE the launch line consumes TASK (pin the actual launch
  // line with its arg expansion, not the header-comment mention).
  const launch = src.indexOf("dsh --profile headless ${DSH_LAUNCH_ARGS");
  assert.notEqual(launch, -1);
  assert.ok(launch > mi, "TASK must be finalized before the launch line");
});

// The driver stamps the rules as numbered plain prose and must escape the
// recipe's shell metacharacters inside its double-quoted TASK append; the
// contract doc carries the same recipe clean in a ```bash fence — same
// rule, two surface spellings, so each surface gets its own pin and the
// agreement pairs below pin the strings that appear on both.
const AGREEMENT_PINS = [
  [
    "the mktemp mint recipe",
    /mktemp -d \\"\\\$\{TMPDIR:-\/tmp\}\/dsh-<repo>-XXXXXX\\"/, // driver source: \" \$ { all escaped
    /mktemp -d "\$\{TMPDIR:-\/tmp\}\/dsh-<repo>-XXXXXX"/, // contract doc: clean fence
  ],
  [
    "the clone into the minted workdir",
    /gh repo clone <owner>\/<repo> \\"\\\$workdir\\"/,
    /gh repo clone <owner>\/<repo> "\$workdir"/,
  ],
  [
    "the acceptance sentence",
    /every throwaway checkout the session creates rides a mktemp-minted path/,
    /every throwaway checkout the\s+session creates rides a mktemp-minted path/,
  ],
  [
    "the rm -rf ban tail",
    /never writes rm -rf against a path it did not mint itself/,
    /never writes\s+`?rm -rf`? against a path it did not mint/,
  ],
];

test("issue #333: driver and contract doc carry the mint recipe, the ban, and the acceptance sentence", () => {
  const src = readFileSync(SCRIPT, "utf8");
  const doc = readFileSync(CONTRACT_DOC, "utf8");
  for (const [name, driverRe, docRe] of AGREEMENT_PINS) {
    assert.match(src, driverRe, `driver: ${name} must keep its operative wording`);
    assert.match(doc, docRe, `contract doc: ${name} must keep its rule`);
  }
  // The doc keeps its receipts: the observed collision and the arming
  // mint that made siblings the default case.
  assert.match(doc, /02:25:39/);
  assert.match(doc, /factory#869/);
  assert.match(doc, /single-entry/);
});

// --- corpus: no tracked doc teaches the colliding clone recipe ------------

/** Every tracked .md under ROOT, skipping .git and node_modules. */
const mdCorpus = (dir) => {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === ".git" || entry.name === "node_modules") continue;
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...mdCorpus(p));
    else if (entry.name.endsWith(".md")) out.push(p);
  }
  return out;
};

test("issue #333: the docs corpus teaches no colliding clone recipe (no rm -rf precondition, no fixed-name destination)", () => {
  const corpus = mdCorpus(ROOT);
  assert.ok(corpus.length > 10, "the corpus scan must find the docs tree");
  for (const f of corpus) {
    const text = readFileSync(f, "utf8");
    assert.doesNotMatch(
      text,
      /rm\s+-rf\s+\/tmp\/\S*\s*&&\s*gh repo clone/,
      `${path.relative(ROOT, f)} teaches the banned rm -rf clone precondition`,
    );
    assert.doesNotMatch(
      text,
      /gh repo clone\s+\S+\s+work\b/,
      `${path.relative(ROOT, f)} teaches a fixed-name clone destination`,
    );
  }
});

test("issue #333: the cross-repo-guest skill teaches the mint, not the fixed-name clone", () => {
  const skill = readFileSync(GUEST_SKILL, "utf8");
  assert.match(skill, /mktemp -d "\$\{TMPDIR:-\/tmp\}\/dsh-<target>-XXXXXX"/);
  assert.match(skill, /gh repo clone <target> "\$workdir"/);
  assert.doesNotMatch(skill, /gh repo clone\s+\S+\s+work\b/);
});
