// workdir-contract.test.mjs — contract fixtures for the workdir-hygiene
// protocol (issue #333).
//
// Contract under test: one claim, ONE unique workdir. Concurrent fleet
// agents on one box habitually clone their claim repos into the SAME
// predictable throwaway path (`/tmp/<repo>` via the standard
// `rm -rf /tmp/<repo> && gh repo clone` recipe, or a fixed relative dir —
// `gh repo clone <target> work`); a sibling minted the same claim later
// runs the same recipe into the same path and destroys the earlier
// sibling's in-flight worktree, silently (receipt: a single-entry clone
// reflog stamped over an edited tree, 2026-10-04 — issue #333; the
// concurrent-mint multiplier is factory#869). The contract closes the
// three leak paths:
//
//   1. a predictable clone target — MINT A UNIQUE WORKDIR PER CLAIM
//      (mktemp -d with an XXXXXX suffix);
//   2. the destructive shared-path precondition — NO SHARED-PATH rm -rf
//      PRECONDITION;
//   3. the fixed relative clone dir — FIXED CLONE DIRS COLLIDE TOO.
//
// Two surfaces, one protocol — these fixtures pin BOTH and keep them in
// agreement (the shape mirrors
// tests/branch-hygiene-contract.test.mjs):
//
//   behavioral — a stub agent captures the task it was launched with and
//   the workdir-hygiene rules must be present in it (the driver's whole
//   point is that every dispatched node inherits the protocol through its
//   prompt).
//
//   structural — the driver block and the contract doc each carry the
//   three rules with their operative verbs, the mktemp recipe, the ban
//   sentence, and the impossible-collisions acceptance sentence. A drift
//   between the two surfaces, or a revert of the recipe, goes red here.
//
//   corpus — the fenced code blocks this repo teaches (root *.md,
//   docs/**, .agents/**) never re-teach the collision: no fenced
//   `rm -rf` + `/tmp` combo, no fenced fixed-dir clone; and the
//   cross-repo-guest skill (the doc that taught `gh repo clone <target>
//   work`) carries the unique-workdir form. Ban PROSE may still NAME the
//   forbidden recipe inline (naming a banned form is not teaching it) —
//   the fence scope is what makes that distinction machine-checkable.

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

  // The contract header and the one-claim-one-workdir frame:
  assert.match(task, /AGENT CONTRACT — workdir hygiene \(issue #333\)/);
  assert.match(task, /one claim, ONE unique workdir — never a shared predictable clone path/);
  assert.match(task, /silently destroys an in-flight sibling's worktree/);

  // Rule 1 — the unique-workdir recipe, rendered copy-pasteable (the
  // driver's \$ escapes resolve to real $ in the launched task; the
  // template's closing quote comes BEFORE the substitution's closing
  // paren — XXXXXX") — exactly what an agent pastes):
  assert.match(task, /MINT A UNIQUE WORKDIR PER CLAIM — before the first clone/);
  assert.match(task, /workdir="\$\(mktemp -d "\$\{TMPDIR:-\/tmp\}\/dsh-<repo>-XXXXXX"\)/);
  assert.match(task, /gh repo clone OWNER\/REPO "\$workdir" && cd "\$workdir"/);
  assert.match(task, /The XXXXXX suffix is the collision guard — two same-box siblings mint different dirs/);

  // Rule 2 — the shared-path rm -rf ban:
  assert.match(task, /NO SHARED-PATH rm -rf PRECONDITION/);
  assert.match(task, /recipe is BANNED: on a shared box it deletes whatever an in-flight sibling has there/);
  assert.match(task, /rm -rf is legal only inside a dir YOUR session minted/);

  // Rule 3 — fixed clone dirs collide too:
  assert.match(task, /FIXED CLONE DIRS COLLIDE TOO/);
  assert.match(task, /any two guests in one checkout land on one path/);

  // The acceptance sentence:
  assert.match(task, /Acceptance — structurally impossible collisions: two same-box siblings working the same repo NEVER share a worktree path/);

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
  // hygiene → workdir.
  const hygiene = src.indexOf("# --- standing agent contract: branch hygiene (issue #127)");
  assert.notEqual(hygiene, -1);
  assert.ok(mi > hygiene, "the workdir-hygiene block appends after the branch-hygiene block");

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
    /1\. MINT A UNIQUE WORKDIR PER CLAIM — before the first clone/,
    /\*\*MINT A UNIQUE WORKDIR PER CLAIM\*\*/,
  ],
  [
    "NO SHARED-PATH rm -rf PRECONDITION",
    /2\. NO SHARED-PATH rm -rf PRECONDITION/,
    /\*\*NO SHARED-PATH rm -rf PRECONDITION\*\*/,
  ],
  [
    "FIXED CLONE DIRS COLLIDE TOO",
    /3\. FIXED CLONE DIRS COLLIDE TOO/,
    /\*\*FIXED CLONE DIRS COLLIDE TOO\*\*/,
  ],
];

test("issue #333: driver and contract doc carry the three collision rules and the recipe", () => {
  const src = readFileSync(SCRIPT, "utf8");
  const doc = readFileSync(CONTRACT_DOC, "utf8");
  for (const [name, driverRe, docRe] of WORKDIR_RULES) {
    assert.match(src, driverRe, `driver: ${name} must keep its operative wording`);
    assert.match(doc, docRe, `contract doc: ${name} must keep its rule heading`);
  }
  // The doc keeps its standing-contract section heading:
  assert.match(doc, /## Standing contract: workdir hygiene \(issue #333\)/);
  // The recipe itself is surface-specific spelling, pinned per surface:
  // the driver SOURCE carries it escaped (inside TASK="..." a raw $(...)\
  // would execute at stamp time), the doc carries it raw in a fence.
  assert.match(src, /mktemp -d \\"\\\$\{TMPDIR:-\/tmp\}\/dsh-<repo>-XXXXXX\\"/, "driver: the escaped recipe must stay paste-safe");
  assert.match(doc, /mktemp -d "\$\{TMPDIR:-\/tmp\}\/dsh-<repo>-XXXXXX"/, "doc: the fenced recipe must stay raw");
  // Word-for-word on BOTH surfaces (markdown-tolerant: the doc wraps
  // lines and backticks its commands, the driver stamps plain prose):
  for (const re of [
    /`?XXXXXX`? suffix is the collision guard/,
    /two same-box siblings\s+mint different dirs/,
    /rm -rf`?\s+is\s+legal\s+only\s+inside\s+a\s+dir\s+YOUR\s+session\s+minted/,
    /any two guests in\s+one checkout land on one path/,
    /structurally impossible collisions/,
  ]) {
    assert.match(src, re, "driver block drift");
    assert.match(doc, re, "contract doc drift");
  }
  // The doc keeps its receipts: the reflog mechanism and the mint
  // multiplier that motivated the contract.
  assert.match(doc, /single-entry clone reflog/);
  assert.match(doc, /factory#869/);
});

// --- corpus: the taught recipes never re-teach the collision --------------

/** Every fenced code block in a markdown text (indented fences included). */
const fencedBlocks = (text) => {
  const blocks = [];
  const lines = text.split("\n");
  let inFence = false;
  let cur = null;
  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      if (inFence) blocks.push(cur.join("\n"));
      else cur = [];
      inFence = !inFence;
      continue;
    }
    if (inFence) cur.push(line);
  }
  return blocks;
};

/** Recursively every .md file under a dir (non-hidden roots only). */
const markdownFiles = (dir) => {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...markdownFiles(p));
    else if (entry.isFile() && entry.name.endsWith(".md")) out.push(p);
  }
  return out;
};

const CORPUS_DIRS = ["docs", ".agents"].map((d) => path.join(ROOT, d));
const CORPUS_FILES = [CONTRACT_DOC, GUEST_SKILL, path.join(ROOT, "CLAUDE.md"), path.join(ROOT, "CONTRIBUTING.md"), path.join(ROOT, "README.md"), path.join(ROOT, "REVIEW.md"), path.join(ROOT, "HYGIENE.md")];

const corpus = () => {
  const files = [...CORPUS_FILES];
  for (const d of CORPUS_DIRS) files.push(...markdownFiles(d));
  return files.map((f) => ({ file: path.relative(ROOT, f), text: readFileSync(f, "utf8") }));
};

test("issue #333 corpus: no fenced recipe re-teaches the shared-path rm -rf re-clone precondition", () => {
  // Scope: the CLONE-recipe class #333 names — a destructive rm -rf
  // precondition composed with a clone. Fixed-/tmp release recipes
  // (curl staging paths) are a different surface, filed separately.
  for (const { file, text } of corpus()) {
    for (const block of fencedBlocks(text)) {
      assert.doesNotMatch(
        block,
        /rm\s+-rf[^\n]*&&[^\n]*(?:gh repo clone|git clone)|(?:gh repo clone|git clone)[^\n]*&&[^\n]*rm\s+-rf/,
        `${file}: a fenced block teaches the destructive shared-path re-clone precondition (issue #333) — the unique-workdir recipe makes it unnecessary`,
      );
    }
  }
});

test("issue #333 corpus: no fenced recipe teaches a fixed predictable clone dir", () => {
  for (const { file, text } of corpus()) {
    for (const block of fencedBlocks(text)) {
      assert.doesNotMatch(
        block,
        /(?:gh repo clone|git clone)\s+[^\n]*\swork\s*(?:&&|$)/m,
        `${file}: a fenced block clones into the fixed shared dir 'work' (issue #333) — clone into a mktemp-unique workdir instead`,
      );
    }
  }
});

test("issue #333: the cross-repo-guest skill teaches the unique-workdir clone, not the fixed 'work' dir", () => {
  const skill = readFileSync(GUEST_SKILL, "utf8");
  // The old taught form is gone entirely (prose included — this skill
  // TEACHES the recipe; naming-the-ban lives in .agents/README.md):
  assert.doesNotMatch(skill, /gh repo clone <target> work/, "the fixed-dir clone form must not appear in the guest skill");
  // The unique form is present, copy-pasteable:
  assert.match(skill, /mktemp -d "\$\{TMPDIR:-\/tmp\}\/dsh-<target>-XXXXXX"/);
  assert.match(skill, /gh repo clone <target> "\$workdir" && cd "\$workdir"/);
});
