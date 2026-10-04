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
//   epoch suffix, re-enters one through glob reuse, or clones into a
//   fixed bare destination (#333 — `gh repo clone <target> work`). The
//   ban text lives in the contract doc's prose, so a fenced block or an
//   inline code recipe carrying these patterns is a recipe re-teaching
//   the collision — the taught skills get both scans (the #333 receipt
//   itself was an inline code step, not a fence), the contract doc gets
//   the fence scan (its inline code IS the ban citation).

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

  // The acceptance sentence (three layers, zero shared worktrees):
  assert.match(task, /Acceptance — structurally impossible collisions: two same-box siblings working the same issue never share a worktree/);

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
];

test("issues #333/#374: driver and contract doc both carry the three rules", () => {
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
  }
});

// --- corpus sweep: no taught recipe mints, re-enters, or clones into a
// colliding workdir ---------------------------------------------------------

// A fenced block teaches a colliding clone when its `gh repo clone` /
// `git clone` line passes a FIXED bare destination (no `$`, not `.`):
// `gh repo clone <target> work` is the #333 receipt — every guest in the
// checkout lands on the same path, and a sibling's `rm -rf` precondition
// wipes it. A destination that rides a shell variable (`"$workdir"`) or
// a destination-less clone into the session's own minted cwd is
// collision-free.
const VALUE_FLAGS = new Set([
  "--branch", "-b", "--depth", "--reference", "--reference-if-able",
  "--origin", "-o", "--upstream-remote", "-u", "--template",
  "--separate-git-dir", "-c",
]);

function fixedBareCloneDest(block) {
  for (const raw of block.split("\n")) {
    const m = raw.match(/\b(?:gh repo clone|git clone)\b/);
    if (!m) continue;
    // One command segment at a time: comments and chain operators end it.
    const seg = raw.slice(m.index + m[0].length).split(/#|&&|\|\||;|\|/)[0];
    const tokens = seg.trim().split(/\s+/).filter(Boolean);
    const positionals = [];
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i];
      if (t.startsWith("--")) { if (!t.includes("=") && VALUE_FLAGS.has(t)) i++; continue; }
      if (t.startsWith("-") && t.length > 1) { if (VALUE_FLAGS.has(t)) i++; continue; }
      positionals.push(t);
    }
    if (positionals.length < 2) continue; // destination-less: basename lands in the session's own cwd
    const dest = positionals[positionals.length - 1];
    if (!dest.includes("$") && dest !== ".") return dest;
  }
  return null;
}

test("issues #333/#374: the docs corpus teaches no epoch-mint, glob-reuse, or fixed-destination recipe (fenced or inline — ban text lives in the contract doc's prose)", () => {
  const offenders = [];
  for (const file of CORPUS_FILES) {
    const text = readFileSync(file, "utf8");
    const lines = text.split("\n");
    // The contract doc cites the bans in prose (its inline code IS the
    // ban citation), so it is exempt from the inline-span scan only; the
    // taught skills get both scans — the #333 receipt itself was an
    // inline code step, not a fence.
    const inlineExempt = file === CONTRACT_DOC;
    let inFence = false;
    let fenceStart = 0;
    for (let i = 0; i < lines.length; i++) {
      if (/^\s*```/.test(lines[i])) {
        if (!inFence) { inFence = true; fenceStart = i + 1; }
        else {
          inFence = false;
          const block = lines.slice(fenceStart, i).join("\n");
          if (/date \+%s/.test(block) && /work-|mktemp/.test(block)) {
            offenders.push(`${path.relative(ROOT, file)}:${fenceStart} fenced block mints a workdir through a bare epoch — a timestamp is not uniqueness (#374)`);
          }
          if (/ls -d work-/.test(block)) {
            offenders.push(`${path.relative(ROOT, file)}:${fenceStart} fenced block re-enters a workdir through glob reuse (#374)`);
          }
          const fixedDest = fixedBareCloneDest(block);
          if (fixedDest) {
            offenders.push(`${path.relative(ROOT, file)}:${fenceStart} fenced block clones into the fixed bare destination \`${fixedDest}\` — the destination is the session's minted path (#333)`);
          }
        }
        continue;
      }
      if (inFence || inlineExempt) continue;
      for (const span of lines[i].match(/`[^`]*`/g) ?? []) {
        const inlineDest = fixedBareCloneDest(span.slice(1, -1));
        if (inlineDest) {
          offenders.push(`${path.relative(ROOT, file)}:${i + 1} inline code recipe clones into the fixed bare destination \`${inlineDest}\` — the destination is the session's minted path (#333)`);
        }
      }
    }
  }
  assert.deepEqual(offenders, [], "every taught recipe that touches workdir minting/re-entry/cloning must be collision-free");
});
