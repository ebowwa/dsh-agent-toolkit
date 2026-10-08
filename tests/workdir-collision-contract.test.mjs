// workdir-collision-contract.test.mjs — contract fixtures for the
// workdir-hygiene protocol (issues #333, #374).
//
// Contract under test: a throwaway workdir is yours only if no sibling
// can predict it, and only while you can prove it. Two silent
// worktree-destruction receipts closed here:
//
//   1. the shared-path class (#333): `rm -rf /tmp/<repo> && gh repo
//      clone` re-clones OVER a sibling already at that path (single-entry
//      clone reflog stamped over an edited tree, 2026-10-04 02:25:39);
//   2. the pseudo-unique class (#374): a bare-epoch mint
//      (`work-<issue>-<repo>-$(date +%s)`) collides for same-issue
//      siblings inside one second — the takeover is SILENT: the first
//      agent's confirmed edits were replaced mid-session and every later
//      check validated a tree that was no longer theirs
//      (work-361-toolkit-1791109240, 2026-10-04 10:20–10:28Z).
//
// ...and the two rules that make the mint survivable even under a
// colliding or reused path: re-entry only via the session's OWN recorded
// path (never `ls -d work-<issue>-* | head -1` glob reuse), and the
// owner-marker belt (`.dsh-workdir-owner` stamped at mint, verified
// before each edit batch).
//
// Rule 4 (tower#1859, 2026-10-08) is the protocol one level down: a
// scratch file a POSTED artifact is read back from must be minted random
// too — two same-box faces drafting `gh pr comment --body-file` bodies
// at one fixed /tmp name cross-posted each other's drafts under the
// shared node identity; the head -1 subject-line belt stops a
// mismatched-body post.
//
// Two surfaces, one protocol — these fixtures pin BOTH and keep them in
// agreement (the shape mirrors tests/branch-hygiene-contract.test.mjs):
//
//   behavioral — a stub agent captures the task it was launched with and
//   the workdir-hygiene rules must be present in it (the driver's whole
//   point is that every dispatched node inherits the protocol through its
//   prompt).
//
//   structural — the driver block and the contract doc each carry the
//   three rules with their operative verbs and the
//   structurally-impossible-collisions acceptance sentence; the driver
//   block sits after scrub, after branch hygiene, before launch; and the
//   docs corpus teaches NO recipe that mints a workdir through a bare
//   epoch suffix or re-enters one through glob reuse, and none that
//   stages through a fixed /tmp path (issue #351 — the #346 class,
//   corpus-wide once #355/#364 healed the last two carriers; the ban
//   text lives in prose — a fenced block carrying these patterns is a
//   recipe re-teaching the collision).

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

// The docs corpus the recipe sweep guards: the contract doc itself, this
// repo's CLAUDE.md/CONTRIBUTING.md, and every taught skill.
const CORPUS_FILES = [
  CONTRACT_DOC,
  path.join(ROOT, "CLAUDE.md"),
  path.join(ROOT, "CONTRIBUTING.md"),
  ...readdirSync(path.join(ROOT, ".agents", "skills"))
    .filter((d) => d.endsWith(".md") === false)
    .map((d) => path.join(ROOT, ".agents", "skills", d, "SKILL.md"))
    .filter((p) => {
      try { readFileSync(p, "utf8"); return true; } catch { return false; }
    }),
];

// --- behavioral: the dispatched agent's prompt carries the rules ----------

test("issues #333/#374: the prompt assembly appends the workdir-hygiene contract to the launched task (stub agent sees it)", () => {
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
  assert.match(task, /AGENT CONTRACT — workdir hygiene \(issues #333, #374\)/);
  assert.match(task, /a workdir is yours only if no sibling can predict it, and only while you can prove it/);

  // Rule 1 — random mint, epoch and shared-path bans:
  assert.match(task, /MINT A RANDOM WORKDIR PER CLAIM — a timestamp is NOT uniqueness/);
  assert.match(task, /mktemp -d "\$\{TMPDIR:-\/tmp\}\/dsh-<repo>-XXXXXX"/);
  assert.match(task, /The bare \$\(date \+%s\) suffix is banned/);
  assert.match(task, /same-issue siblings collide inside one second/);
  assert.match(task, /rm -rf is legal only inside a dir YOUR session minted/);

  // Rule 2 — recorded-path re-entry, glob-reuse ban:
  assert.match(task, /RE-ENTER ONLY A PATH YOU RECORDED/);
  assert.match(task, /NEVER via glob reuse \(ls -d work-<issue>-\* \| head -1\)/);
  assert.match(task, /A dir you did not mint is not yours/);

  // Rule 3 — the owner-marker belt, with the exact stamp:
  assert.match(task, /THE OWNER-MARKER BELT — at mint, stamp ownership/);
  assert.match(task, /\.dsh-workdir-owner/);
  assert.match(task, /before each edit batch, re-check the marker matches YOUR session/);
  assert.match(task, /a takeover in progress: stop, do not edit, file it, mint fresh/);

  // Rule 4 — the scratch mint (tower#1859): the posted-artifact body file
  // is minted random and its subject line is belted in the post chain:
  assert.match(task, /MINT EVERY SCRATCH FILE A POSTED ARTIFACT IS READ BACK FROM \(tower#1859\)/);
  assert.match(task, /mktemp "\$\{TMPDIR:-\/tmp\}\/dsh-<claim>-f1-XXXXXX"/);
  // trailing-X only: a suffix after the Xs makes macOS mktemp exit 0 while
  // it mints the LITERAL name (Darwin 25.5.0 probe) — the false-mint recipe
  // must not ride in the stamped task
  assert.match(task, /The Xs must be TRAILING/);
  assert.doesNotMatch(task, /dsh-<claim>-f1-XXXXXX\.md/);
  assert.match(task, /head -1 "\$body_file"/);
  assert.match(task, /a mismatched subject line stops the post/);
  assert.match(task, /cross-post each other's drafts under the shared node identity/);

  // The acceptance sentence (three layers, zero shared worktrees):
  assert.match(task, /Acceptance — structurally impossible collisions: two same-box siblings working the same issue never share a worktree/);
  assert.match(task, /between its compose and its post \(scratch mint, tower#1859\)/);

  rmSync(dir, { recursive: true, force: true });
});

// --- structural: driver block placement + both surfaces agree -------------

test("issues #333/#374: the contract block sits in the driver between its markers, after scrub and after the branch-hygiene block, before launch", () => {
  const src = readFileSync(SCRIPT, "utf8");
  const marker = "# --- standing agent contract: workdir hygiene (issues #333, #374)";
  const mi = src.indexOf(marker);
  assert.notEqual(mi, -1, "the workdir-hygiene contract block must exist in the driver");

  // Appended AFTER the input scrub pass: the block is repo-controlled
  // static prose; the scrub exists for thread-supplied text.
  const scrub = src.indexOf('SECRETS_ONLY=1 node "$SCRIPT_DIR/scrub-output.mjs"');
  assert.notEqual(scrub, -1);
  assert.ok(mi > scrub, "the contract block must be appended after the input scrub pass");

  // And after the branch-hygiene block: the contracts append in issue
  // order, so the launched task reads relationships → branch hygiene →
  // workdir hygiene.
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
// so each surface gets its own pin and the agreement strings below pin
// the text that appears identically on both.
const WORKDIR_RULES = [
  [
    "MINT A RANDOM WORKDIR PER CLAIM",
    /1\. MINT A RANDOM WORKDIR PER CLAIM — a timestamp is NOT uniqueness/,
    /\*\*MINT A RANDOM WORKDIR PER CLAIM\*\* — a timestamp is NOT uniqueness/,
  ],
  [
    "RE-ENTER ONLY A PATH YOU RECORDED",
    /2\. RE-ENTER ONLY A PATH YOU RECORDED/,
    /\*\*RE-ENTER ONLY A PATH YOU RECORDED\*\*/,
  ],
  [
    "THE OWNER-MARKER BELT",
    /3\. THE OWNER-MARKER BELT — at mint, stamp ownership/,
    /\*\*THE OWNER-MARKER BELT\*\* — mint stamps ownership, edit batches verify/,
  ],
  [
    "MINT EVERY SCRATCH FILE A POSTED ARTIFACT IS READ BACK FROM",
    /4\. MINT EVERY SCRATCH FILE A POSTED ARTIFACT IS READ BACK FROM \(tower#1859\)/,
    /\*\*MINT EVERY SCRATCH FILE A POSTED ARTIFACT IS READ BACK FROM\*\*/,
  ],
];

test("issues #333/#374: driver and contract doc both carry the four rules", () => {
  // The driver stamp lives inside a double-quoted shell string, so the
  // recipe's quotes and dollars are backslash-escaped IN SOURCE and
  // expand to their plain forms in the launched task; the contract doc
  // hard-wraps prose at ~72 columns. Un-escape the source's quote/dollar
  // escapes and flatten whitespace on BOTH surfaces so one pattern set
  // pins them together (the behavioral test above pins the EXPANDED
  // task directly, wraps and all).
  const unescape = (s) => s.replace(/\\(["$`])/g, "$1");
  const flat = (s) => unescape(s).replace(/\s+/g, " ");
  const src = flat(readFileSync(SCRIPT, "utf8"));
  const doc = flat(readFileSync(CONTRACT_DOC, "utf8"));
  for (const [name, driverPin, docPin] of WORKDIR_RULES) {
    assert.match(src, driverPin, `driver must carry the ${name} rule`);
    assert.match(doc, docPin, `contract doc must carry the ${name} rule`);
  }
  // The bans and the mint recipe appear on both surfaces:
  for (const surface of [src, doc]) {
    assert.match(surface, /mktemp -d "\$\{TMPDIR:-\/tmp\}\/dsh-<repo>-XXXXXX"/);
    assert.match(surface, /The bare `?\$\(date \+%s\)`? suffix is banned/);
    assert.match(surface, /NEVER via glob reuse \(`?ls -d work-<issue>-\* \| head -1`?\)/i);
    assert.match(surface, /\.dsh-workdir-owner/);
    assert.match(surface, /structurally impossible collisions/i);
    // rule 4 (tower#1859): the scratch mint + the subject-line belt —
    // trailing Xs only (a suffix after them mints the LITERAL name on
    // macOS, exit 0), so the .md-suffixed recipe is banned on both surfaces
    assert.match(surface, /mktemp "\$\{TMPDIR:-\/tmp\}\/dsh-<claim>-f1-XXXXXX"/);
    assert.doesNotMatch(surface, /dsh-<claim>-f1-XXXXXX\.md/);
    assert.match(surface, /head -1 "\$/); // "$F" in the doc, "$body_file" in the driver
    assert.match(surface, /mismatched subject line stops the post/);
  }
});

// --- corpus sweep: no taught recipe mints or re-enters a colliding workdir,
// --- and none stages through a fixed /tmp path (issue #351) ---------------

/** Fenced blocks (contents only) of a markdown text, with 1-based start
 * line of each block's first content line. Prose stays out of scope by
 * design — the docs must stay free to DISCUSS the defect class; only a
 * fenced block re-teaching it is a recipe. */
function fencedBlocks(text) {
  const blocks = [];
  const lines = text.split("\n");
  let inFence = false;
  let fenceStart = 0;
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*```/.test(lines[i])) {
      if (!inFence) { inFence = true; fenceStart = i + 1; }
      else {
        inFence = false;
        blocks.push({ start: fenceStart, body: lines.slice(fenceStart, i).join("\n") });
      }
    }
  }
  return blocks;
}

// The fixed-/tmp staging shapes (issue #351 — the #346 class, corpus-wide).
// Mirrors FIXED_TMP_STAGING_SHAPES in tests/tmp-staging-hygiene.test.mjs:
// a fixed /tmp name used as a staging or proof surface inside a taught
// recipe. Line-based by design (the house lint doctrine: catch the
// observed defect class, not the universe). The "${TMPDIR:-/tmp}" mktemp
// default never matches: its /tmp is preceded by ':' inside the parameter
// expansion, not by a staging operator. Corpus-wide went live only after
// the last two carriers of the class were healed (#355, #364) — before
// that it went red on them by design.
const FIXED_TMP_STAGING_SHAPES = [
  /-o \/tmp\//, // curl ... -o /tmp/app.zip
  /-d \/tmp\//, // unzip ... -d /tmp/app
  /> \/tmp\//, // sort > /tmp/<repo>-wip-baseline.txt
  /- \/tmp\//, // diff - /tmp/<repo>-wip-baseline.txt
  /attach \/tmp\//, // hdiutil attach /tmp/g.dmg
  /cp -R \/tmp\//, // cp -R /tmp/app/<App>.app
];

/** Offending fixed-/tmp lines in one fenced block, as `start+line` offsets. */
function fixedTmpHits(body, start) {
  return body
    .split("\n")
    .map((line, i) => ({ line, n: start + i }))
    .filter(({ line }) => FIXED_TMP_STAGING_SHAPES.some((shape) => shape.test(line)));
}

test("issues #333/#374: the docs corpus teaches no epoch-mint or glob-reuse recipe (ban text lives in prose, never in a fenced block)", () => {
  const offenders = [];
  for (const file of CORPUS_FILES) {
    for (const { start, body } of fencedBlocks(readFileSync(file, "utf8"))) {
      if (/date \+%s/.test(body) && /work-|mktemp/.test(body)) {
        offenders.push(`${path.relative(ROOT, file)}:${start} fenced block mints a workdir through a bare epoch — a timestamp is not uniqueness (#374)`);
      }
      if (/ls -d work-/.test(body)) {
        offenders.push(`${path.relative(ROOT, file)}:${start} fenced block re-enters a workdir through glob reuse (#374)`);
      }
    }
  }
  assert.deepEqual(offenders, [], "every fenced recipe that touches workdir minting/re-entry must be collision-free");
});

// issue #351: the corpus-wide tripwire for the fixed-/tmp staging class.
// The per-skill pins (tests/tmp-staging-hygiene.test.mjs) hold the three
// skills #346 named; this sweep holds the WHOLE corpus, so the next
// skill/recipe that stages through a fixed /tmp name goes red at the
// gates instead of shipping another silent sibling clobber.

test("issue #351: the docs corpus teaches no recipe staging through a fixed /tmp path (the #346 class, corpus-wide)", () => {
  const offenders = [];
  for (const file of CORPUS_FILES) {
    const rel = path.relative(ROOT, file);
    for (const { start, body } of fencedBlocks(readFileSync(file, "utf8"))) {
      for (const { line, n } of fixedTmpHits(body, start)) {
        offenders.push(`${rel}:${n} fenced recipe stages through a fixed /tmp path: ${line.trim()}`);
      }
    }
  }
  assert.deepEqual(offenders, [], "every fenced recipe must stage through a session-unique mktemp dir, never a fixed /tmp name");
});

// --- scanner self-test: the pre-fix receipt lines bite, the mint stays legal

test("issue #351 scanner self-test: every pre-fix receipt line trips a shape, the mktemp mint stays legal", () => {
  const fence = (body) => "```bash\n" + body + "\n```";
  // The exact pre-fix receipt lines (issue #346 receipts; the surface
  // issue #351 quotes) — a scanner that cannot see the class it exists
  // to catch is decoration.
  const receipts = [
    'curl -sL "<app.zip URL>" -o /tmp/app.zip && unzip -oq /tmp/app.zip -d /tmp/app',
    "rm -rf /Applications/<App>.app && cp -R /tmp/app/<App>.app /Applications/",
    "hdiutil attach /tmp/g.dmg -nobrowse -mountpoint /Volumes/G",
    "git status --porcelain | sort > /tmp/<repo>-wip-baseline.txt",
  ];
  const block = fencedBlocks(fence(receipts.join("\n")))[0];
  assert.ok(block, "self-test: the synthetic fence must parse");
  assert.deepEqual(
    fixedTmpHits(block.body, block.start).map(({ n }) => n - block.start + 1),
    [1, 2, 3, 4],
    "every receipt line must trip a shape",
  );

  // The legal forms stay legal: the mktemp mint + "$stage/..." staging.
  const legal = fencedBlocks(
    fence(
      'stage="$(mktemp -d "${TMPDIR:-/tmp}/dsh-<repo>-XXXXXX")"\n' +
        'curl -sL "<url>" -o "$stage/a.zip" && unzip -oq "$stage/a.zip" -d "$stage/a"\n' +
        'cp -R "$stage/a/Bundle.app" /Applications/ && rm -rf "$stage"',
    ),
  )[0];
  assert.deepEqual(fixedTmpHits(legal.body, legal.start), [], "the mktemp mint + \$stage recipe must stay legal");
});
