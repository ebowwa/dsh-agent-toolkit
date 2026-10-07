// scrub-shims.test.mjs — fail-closed contract pin for the transport shims.
// REVIEW.md: "Scrubbing is fail-closed: if the scrubber cannot run, the
// pipeline must abort rather than pass unscrubbed text onward. Any change
// that makes a scrub failure non-fatal is rejected."
//
// Regression: both shims' scrub helpers were fail-OPEN —
//   scrub_text() { ... node "$SCRUB" <<<"$1" 2>/dev/null || printf '%s' "$1"; }
//   scrub_file() { ... node "$SCRUB" <"$1" >"$out" 2>/dev/null || cp "$1" "$out"; }
// — so a scrubber outage (node missing, module gone, crash) silently handed
// the RAW text to the real gh/git, and 2>/dev/null hid the failure. These
// tests mint a FAILING SCRUB_SCRIPT and a recording stand-in for the real
// binary, then assert the shim aborts non-zero and the recorder never runs:
// the secret-bearing payload never crosses the shim line.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import assert from "node:assert/strict";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const GH_SHIM = path.join(ROOT, "scripts", "gh-scrub-shim");
const GIT_SHIM = path.join(ROOT, "scripts", "git-scrub-shim");
const REAL_SCRUB = path.join(ROOT, "scripts", "scrub-output.mjs");

// Synthetic token shape (same construction the scrubber's own suite uses —
// never a real credential).
const SECRET = "ghp_" + "a1B2c3D4e5F6g7H8i9J0k1L2m3";

/** A temp dir (auto-cleaned) holding a scrub script with the given body and
 * a recording stand-in for the real gh/git: it appends its argv to
 * $SHIM_TEST_CAPTURE and exits 0. The shims exec $GH_SCRUB_REAL/$GIT_SCRUB_REAL
 * by absolute path, so no PATH shadowing is needed — the ambient PATH only
 * has to still resolve `node` for the scrubber itself. */
function stage(t, scrubBody) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scrub-shim-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const scrub = path.join(dir, "scrub-under-test.mjs");
  fs.writeFileSync(scrub, scrubBody);
  const capture = path.join(dir, "captured-argv.txt");
  const real = path.join(dir, "record-real");
  fs.writeFileSync(
    real,
    "#!/usr/bin/env bash\n# test stand-in for the real gh/git: record argv, every handed scrub temp's content, and stdin — touch nothing else\n" +
      'printf \'%s\\n\' "$@" >> "$SHIM_TEST_CAPTURE"\n' +
      // The shim hands gh/git scrubbed TEMP paths (or redirects stdin from
      // one); snapshot their CONTENT during the run — after the run the shim
      // unlinks them (issue #154), so a post-run read can no longer verify
      // what the real binary was handed.
      'for a in "$@"; do\n' +
      '  case "$a" in */gh-scrubbed.*|*/git-scrubbed.*) cat "$a" >> "$SHIM_TEST_CAPTURE.content";; esac\n' +
      'done\n' +
      'cat >> "$SHIM_TEST_CAPTURE.stdin"\n' +
      "exit 0\n",
  );
  fs.chmodSync(real, 0o755);
  return { dir, scrub, capture, real };
}

/** Run one shim with a staged scrubber + recorder. Returns the harness `dir`
 * too, so tests can inspect it (payload files, scrub temp leftovers). */
function runShim(t, shim, scrubBody, argv, opts = {}) {
  const { dir, scrub, capture, real } = stage(t, scrubBody);
  const envKey = shim === GH_SHIM ? "GH_SCRUB_REAL" : "GIT_SCRUB_REAL";
  const env = {
    ...process.env,
    [envKey]: real,
    SCRUB_SCRIPT: scrub,
    SHIM_TEST_CAPTURE: capture,
    // pin the scrub temp file into the auto-cleaned harness dir
    TMPDIR: dir,
  };
  // These tests exercise the UNARMED shim; an ambient GH_MERGE_GUARD=on on a
  // lane arms the merge-guard hook on `pr merge` argv through the
  // process.env spread and refuses fail-closed (issue #479 — the
  // env-construction flavor of the REVIEW.md lane-leak class). "Unset" must
  // mean unset on every machine.
  delete env.GH_MERGE_GUARD;
  // The guard's verify leg is the second front (issue #558, the seventh
  // carrier — the same shape the stdin-form helper closed in its #551 fix):
  // the shim's guard invocation only PREFIXES assignments to the inherited
  // env (assignments add, they never strip — the #490 receipt), so an
  // ambient MERGE_GUARD_VERIFY=on / MERGE_GUARD_VERIFY_TOOL rides this
  // spread into any future armed merge leg's guard call and arms the verify
  // leg under the stubbed fixture. Inert today (every current argv through
  // this helper is a non-scrub or scrub-pinned leg and the hook never arms
  // through it), but "unset must mean unset" for every name the shim/guard
  // chain reads, not only the currently load-bearing one.
  delete env.MERGE_GUARD_VERIFY;
  delete env.MERGE_GUARD_VERIFY_TOOL;
  // Same belt for the check-run name pair (the #551 fix shape, applied to
  // this helper): GH_MERGE_GUARD_CHECK is the #1132 explicit-name
  // passthrough (the shim forwards it -> MERGE_GUARD_CHECK only under an
  // armed hook, where an explicit name is an assertion that never falls
  // back) and MERGE_GUARD_CHECK is the name merge-guard.sh itself reads — an
  // ambient explicit name flips CHECK_EXPLICIT and turns a future armed
  // merge leg's rollup fallback into a hard ABSENT refusal (the #553 receipt
  // shape).
  delete env.GH_MERGE_GUARD_CHECK;
  delete env.MERGE_GUARD_CHECK;
  const res = spawnSync("bash", [shim, ...argv], {
    encoding: "utf8",
    cwd: opts.cwd,
    env,
  });
  return { res, capture, dir };
}

/** The fail-closed assertion bundle: non-zero exit, the real binary never
 * exec'd, and the secret nowhere on disk in the harness dir. */
function assertAborted({ res, capture }, why) {
  assert.notEqual(
    res.status, 0,
    `${why}: shim must exit non-zero on scrubber failure (stderr: ${res.stderr})`,
  );
  assert.ok(
    !fs.existsSync(capture),
    `${why}: the real binary was exec'd anyway — captured: ${fs.existsSync(capture) ? fs.readFileSync(capture, "utf8") : ""}`,
  );
  assert.match(res.stderr, /fail-closed/, "the abort is loud, not silent");
  assert.ok(!res.stderr.includes(SECRET), "the abort never echoes the payload");
}

const FAIL_EXIT1 = "import 'nonexistent-scrub-module.mjs';\n";
const CRASH_AFTER_PARTIAL = [
  "process.stdout.write('partial');",
  "process.stderr.write('scrubber boom');",
  "process.exit(3);",
  "",
].join("\n");

// --- gh shim: every text-bearing call-site shape ---------------------------

test("gh shim: scrubber failure aborts --body= (real gh never exec'd)", (t) => {
  assertAborted(
    runShim(t, GH_SHIM, FAIL_EXIT1, ["pr", "comment", "12", `--body=token ${SECRET} landed`]),
    "exit-1 scrubber on --body=",
  );
});

test("gh shim: crashing scrubber (partial write, exit 3) aborts --body=", (t) => {
  assertAborted(
    runShim(t, GH_SHIM, CRASH_AFTER_PARTIAL, ["pr", "comment", "12", `--body=partialsecret ${SECRET}`]),
    "partial-write scrubber on --body=",
  );
});

test("gh shim: scrubber failure aborts the separate-arg --body form", (t) => {
  assertAborted(
    runShim(t, GH_SHIM, FAIL_EXIT1, ["pr", "comment", "12", "--body", `token ${SECRET}`]),
    "exit-1 scrubber on --body <value>",
  );
});

test("gh shim: scrubber failure aborts -f body= (api fields)", (t) => {
  assertAborted(
    runShim(t, GH_SHIM, FAIL_EXIT1, ["api", "repos/o/r/issues/1/comments", "-f", `body=token ${SECRET}`]),
    "exit-1 scrubber on -f body=",
  );
});

test("gh shim: scrubber failure aborts --body-file (raw file never copied onward)", (t) => {
  const { res, capture } = (() => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scrub-shim-file-"));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const bodyFile = path.join(dir, "body.md");
    fs.writeFileSync(bodyFile, `token ${SECRET} in a file\n`);
    const scrub = path.join(dir, "scrub-under-test.mjs");
    fs.writeFileSync(scrub, FAIL_EXIT1);
    const capture = path.join(dir, "captured-argv.txt");
    const real = path.join(dir, "record-real");
    fs.writeFileSync(
      real,
      "#!/usr/bin/env bash\nprintf '%s\\n' \"$@\" >> \"$SHIM_TEST_CAPTURE\"\nexit 0\n",
    );
    fs.chmodSync(real, 0o755);
    const r = spawnSync("bash", [GH_SHIM, "pr", "create", "--body-file", bodyFile], {
      encoding: "utf8",
      env: {
        ...process.env,
        GH_SCRUB_REAL: real,
        SCRUB_SCRIPT: scrub,
        SHIM_TEST_CAPTURE: capture,
        TMPDIR: dir,
      },
    });
    return { res: r, capture };
  })();
  assertAborted({ res, capture }, "exit-1 scrubber on --body-file");
  // No half-scrubbed temp file may linger either: the failure path unlinks it.
  const leftovers = fs.readdirSync(path.dirname(capture)).filter((f) => f.startsWith("gh-scrubbed."));
  assert.equal(leftovers.length, 0, "no scrub temp file survives the abort");
});

// --- gh shim: equals-form file flags + `-` stdin form (issue #157/#167) -----
// `--body-file=`/`--title-file=` equals-form spellings fell through the
// `[ -f "$1" ]` file branch to the catch-all, and a `-` value rode raw as gh's
// stdin form — both shipped secret-bearing payloads unscrubbed. The shim now
// routes every *-file value through one guard (scrub_file for a real path,
// a stdin scrub + run-time stdin redirect for `-`).

test("gh shim: scrubber failure aborts --body-file= (equals-form file)", (t) => {
  const { file } = stageNotesFile(t, `token ${SECRET} in a file\n`);
  const { res, capture, dir } = runShim(t, GH_SHIM, FAIL_EXIT1, [
    "pr", "create", `--body-file=${file}`,
  ]);
  assertAborted({ res, capture }, "exit-1 scrubber on --body-file=");
  const leftovers = fs.readdirSync(dir).filter((f) => f.startsWith("gh-scrubbed."));
  assert.equal(leftovers.length, 0, "no scrub temp file survives the abort");
});

test("gh shim: scrubber failure aborts --title-file= (equals-form file)", (t) => {
  const { file } = stageNotesFile(t, `title ${SECRET}\n`);
  assertAborted(
    runShim(t, GH_SHIM, CRASH_AFTER_PARTIAL, ["issue", "create", `--title-file=${file}`]),
    "crashing scrubber on --title-file=",
  );
});

test("gh shim: equals-form --body-file= reaches gh as a scrubbed temp file", (t) => {
  const { file } = stageNotesFile(t, `token ${SECRET} dated 2026-09-26\n`);
  const { res, capture, dir } = runShim(t, GH_SHIM, fs.readFileSync(REAL_SCRUB, "utf8"), [
    "pr", "create", `--body-file=${file}`,
  ]);
  assert.equal(res.status, 0, `shim must pass through (stderr: ${res.stderr})`);
  assert.ok(fs.existsSync(capture), "the real gh was run");
  const seen = fs.readFileSync(capture, "utf8").trim().split("\n");
  const fileArgs = seen.filter((a) => a.endsWith("notes.md"));
  assert.equal(fileArgs.length, 0, `the raw payload path must not reach gh — captured: ${seen.join(" | ")}`);
  // gh's argv pointed at a scrubbed temp in TMPDIR...
  const tempArg = seen.find((a) => a.startsWith(path.join(dir, "gh-scrubbed.")));
  assert.ok(tempArg, `gh's argv must point at a gh-scrubbed.* temp — captured: ${seen.join(" | ")}`);
  // ...whose content (snapshotted by the recorder DURING the run) is
  // redacted with dates kept...
  const text = fs.readFileSync(`${capture}.content`, "utf8");
  assert.ok(text.includes("[redacted:token]"), "scrubbed body content");
  assert.ok(!text.includes("a1B2c3D4e5F6"), "the raw token did not survive");
  assert.ok(text.includes("2026-09-26"), "dates still ride through untouched");
  // ...and once gh is done the temp is GONE — no gh-scrubbed.* residue in
  // TMPDIR after a successful run (issue #154: the old exec tail leaked one
  // copy of the post-scrub body per *-file call, for the life of the box).
  const leftovers = fs.readdirSync(dir).filter((f) => f.startsWith("gh-scrubbed."));
  assert.equal(leftovers.length, 0, `no scrub temp survives a successful run (got: ${leftovers.join(", ")})`);
});

test("gh shim: scrubber failure aborts --body-file - (stdin form, real gh never exec'd)", (t) => {
  const { res, capture, dir } = runShimWithStdin(
    t, GH_SHIM, FAIL_EXIT1,
    ["pr", "create", "--body-file", "-"],
    `stdin token ${SECRET}\n`,
  );
  assertAborted({ res, capture }, "exit-1 scrubber on --body-file -");
  const leftovers = fs.readdirSync(dir).filter((f) => f.startsWith("gh-scrubbed."));
  assert.equal(leftovers.length, 0, "no scrub temp file survives the abort");
});

test("gh shim: scrubber failure aborts --title-file= - (equals-form stdin)", (t) => {
  const { res, capture } = runShimWithStdin(
    t, GH_SHIM, CRASH_AFTER_PARTIAL,
    ["issue", "create", "--title-file=-"],
    `title ${SECRET}\n`,
  );
  assertAborted({ res, capture }, "crashing scrubber on --title-file=-");
});

test("gh shim: --body-file - stdin payload is scrubbed before gh reads it", (t) => {
  const { res, capture, dir } = runShimWithStdin(
    t, GH_SHIM, fs.readFileSync(REAL_SCRUB, "utf8"),
    ["pr", "create", "--body-file", "-"],
    `stdin token ${SECRET} dated 2026-09-26\n`,
  );
  assert.equal(res.status, 0, `shim must pass through (stderr: ${res.stderr})`);
  assert.ok(fs.existsSync(capture), "the real gh was run");
  // gh still sees the `-` argv it asked for...
  const seen = fs.readFileSync(capture, "utf8").trim().split("\n");
  assert.ok(seen.includes("-"), "`-` reaches gh verbatim as its stdin marker");
  // ...but reads the scrubbed temp on stdin (snapshotted by the recorder
  // DURING the run): redacted, dates kept.
  const text = fs.readFileSync(`${capture}.stdin`, "utf8");
  assert.ok(text.includes("[redacted:token]"), "the stdin payload was scrubbed");
  assert.ok(!text.includes("a1B2c3D4e5F6"), "the raw token did not survive");
  assert.ok(text.includes("2026-09-26"), "dates still ride through untouched");
  // No gh-scrubbed.* residue in TMPDIR after the successful run (issue #154).
  const leftovers = fs.readdirSync(dir).filter((f) => f.startsWith("gh-scrubbed."));
  assert.equal(leftovers.length, 0, `no scrub temp survives a successful run (got: ${leftovers.join(", ")})`);
});

test("gh shim: equals-form --notes-file=- stdin payload is scrubbed before gh reads it", (t) => {
  const { res, capture, dir } = runShimWithStdin(
    t, GH_SHIM, fs.readFileSync(REAL_SCRUB, "utf8"),
    ["release", "create", "v1.0.0", "--notes-file=-"],
    `notes token ${SECRET}\n`,
  );
  assert.equal(res.status, 0, `shim must pass through (stderr: ${res.stderr})`);
  const seen = fs.readFileSync(capture, "utf8").trim().split("\n");
  assert.ok(seen.includes("--notes-file"), "the equals-form flag rides through for gh's parser");
  assert.ok(seen.includes("-"), "the `-` stdin marker reaches gh verbatim");
  const text = fs.readFileSync(`${capture}.stdin`, "utf8");
  assert.ok(text.includes("[redacted:token]"), "the stdin payload was scrubbed");
  assert.ok(!text.includes("a1B2c3D4e5F6"), "the raw token did not survive");
  // No gh-scrubbed.* residue in TMPDIR after the successful run (issue #154).
  const leftovers = fs.readdirSync(dir).filter((f) => f.startsWith("gh-scrubbed."));
  assert.equal(leftovers.length, 0, `no scrub temp survives a successful run (got: ${leftovers.join(", ")})`);
});

// --- gh shim: release-notes call-site shapes (issue #155) -------------------
// -n/--notes and --notes-file were absent from is_value_flag()/the file
// branch, so `gh release create --notes "..."` exec'd the raw notes body and
// `--notes-file <f>` handed gh the raw file — while the shim header claimed
// release-notes coverage.

test("gh shim: scrubber failure aborts --notes (release notes body)", (t) => {
  assertAborted(
    runShim(t, GH_SHIM, FAIL_EXIT1, ["release", "create", "v1.0.0", "--notes", `token ${SECRET}`]),
    "exit-1 scrubber on --notes <value>",
  );
});

test("gh shim: scrubber failure aborts -n (release notes shorthand)", (t) => {
  assertAborted(
    runShim(t, GH_SHIM, CRASH_AFTER_PARTIAL, ["release", "create", "v1.0.0", "-n", `token ${SECRET}`]),
    "crashing scrubber on -n <value>",
  );
});

test("gh shim: scrubber failure aborts --notes= (release notes equals-form)", (t) => {
  assertAborted(
    runShim(t, GH_SHIM, FAIL_EXIT1, ["release", "create", "v1.0.0", `--notes=token ${SECRET}`]),
    "exit-1 scrubber on --notes=",
  );
});

/** Run one shim with a staged scrubber + recorder AND a stdin payload
 * (the `*-file -` stdin form). Everything else matches runShim. */
function runShimWithStdin(t, shim, scrubBody, argv, stdin) {
  const { dir, scrub, capture, real } = stage(t, scrubBody);
  const envKey = shim === GH_SHIM ? "GH_SCRUB_REAL" : "GIT_SCRUB_REAL";
  const env = {
    ...process.env,
    [envKey]: real,
    SCRUB_SCRIPT: scrub,
    SHIM_TEST_CAPTURE: capture,
    TMPDIR: dir,
  };
  // Same hermeticity as runShim above (issue #483, the residual #479
  // carrier): every current argv through this helper is a non-merge verb so
  // an ambient GH_MERGE_GUARD=on is inert — but one future `pr merge` test
  // routed through here would arm the merge-guard hook through the
  // process.env spread and re-open the #479 red-on-armed-lane class. "Unset"
  // must mean unset on every machine.
  delete env.GH_MERGE_GUARD;
  // The guard's verify leg is the second front (issue #551, the #490 carrier
  // pair): the shim's guard invocation only PREFIXES assignments to the
  // inherited env (assignments add, they never strip — the #490 receipt), so
  // an ambient MERGE_GUARD_VERIFY=on / MERGE_GUARD_VERIFY_TOOL rides this
  // spread into any future armed merge leg's guard call and arms the verify
  // leg under the stubbed fixture. Inert today (the hook above never arms
  // through this helper), but "unset must mean unset" for every name the
  // shim/guard chain reads, not only the currently load-bearing one.
  delete env.MERGE_GUARD_VERIFY;
  delete env.MERGE_GUARD_VERIFY_TOOL;
  // Same belt for the check-run name pair (the #551 fix shape asks this belt
  // be considered): GH_MERGE_GUARD_CHECK is the #1132 explicit-name
  // passthrough (the shim forwards it -> MERGE_GUARD_CHECK only under an
  // armed hook, where an explicit name is an assertion that never falls
  // back) and MERGE_GUARD_CHECK is the name merge-guard.sh itself reads — an
  // ambient explicit name flips CHECK_EXPLICIT and turns a future armed
  // merge leg's rollup fallback into a hard ABSENT refusal (the #553 receipt
  // shape, on the sibling helper).
  delete env.GH_MERGE_GUARD_CHECK;
  delete env.MERGE_GUARD_CHECK;
  const res = spawnSync("bash", [shim, ...argv], {
    encoding: "utf8",
    input: stdin,
    env,
  });
  return { res, capture, dir };
}

/** A notes payload file in its own temp dir (auto-cleaned), so the argv can
 * carry the real path before the shim runs. */
function stageNotesFile(t, contents) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scrub-shim-notes-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "notes.md");
  fs.writeFileSync(file, contents);
  return { dir, file };
}

test("gh shim: scrubber failure aborts --notes-file (raw file never copied onward)", (t) => {
  const { file } = stageNotesFile(t, `token ${SECRET} in a file\n`);
  const { res, capture, dir } = runShim(t, GH_SHIM, FAIL_EXIT1, [
    "release", "create", "v1.0.0", "--notes-file", file,
  ]);
  assertAborted({ res, capture }, "exit-1 scrubber on --notes-file");
  const leftovers = fs.readdirSync(dir).filter((f) => f.startsWith("gh-scrubbed."));
  assert.equal(leftovers.length, 0, "no scrub temp file survives the abort");
});

test("gh shim: scrubber failure aborts --notes-file= (equals-form file)", (t) => {
  const { file } = stageNotesFile(t, `partial ${SECRET} in a file\n`);
  const { res, capture, dir } = runShim(t, GH_SHIM, CRASH_AFTER_PARTIAL, [
    "release", "create", "v1.0.0", `--notes-file=${file}`,
  ]);
  assertAborted({ res, capture }, "crashing scrubber on --notes-file=");
  const leftovers = fs.readdirSync(dir).filter((f) => f.startsWith("gh-scrubbed."));
  assert.equal(leftovers.length, 0, "no scrub temp file survives the abort");
});

// --- gh shim: leading-dash next-arg values (issue #159) ---------------------
// The catch-all guard `[ "${1#-}" = "$1" ]` never consumed a next-arg value
// starting with `-`, so `gh release create --notes "- dash ghp_…"` exec'd the
// raw notes body: gh really does send a leading-dash separate-arg value
// (verified in the issue receipts). These flags can never be boolean in gh's
// CLI, so the shim now consume-and-scrubs — while boolean-only flags like
// `gh pr merge -m` stay untouched.

test("gh shim: leading-dash next-arg --notes value is scrubbed before exec", (t) => {
  const { res, capture } = runShim(t, GH_SHIM, fs.readFileSync(REAL_SCRUB, "utf8"), [
    "release", "create", "v1.0.0", "--notes", `- dash ${SECRET}`,
  ]);
  assert.equal(res.status, 0, `shim must pass through (stderr: ${res.stderr})`);
  assert.ok(fs.existsSync(capture), "the real gh was exec'd");
  const seen = fs.readFileSync(capture, "utf8");
  assert.ok(seen.includes("[redacted:token]"), "the leading-dash notes value was scrubbed");
  assert.ok(!seen.includes("a1B2c3D4e5F6"), "the raw token did not reach gh");
  assert.ok(seen.includes("- dash"), "the non-secret shape of the value rides through");
});

test("gh shim: leading-dash next-arg --notes value fails closed on scrubber failure", (t) => {
  assertAborted(
    runShim(t, GH_SHIM, FAIL_EXIT1, ["release", "create", "v1.0.0", "--notes", `- dash ${SECRET}`]),
    "exit-1 scrubber on a leading-dash --notes value",
  );
});

test("gh shim: equals-form leading-dash --notes= remains scrubbed", (t) => {
  const { res, capture } = runShim(t, GH_SHIM, fs.readFileSync(REAL_SCRUB, "utf8"), [
    "release", "create", "v1.0.0", `--notes=- dash ${SECRET}`,
  ]);
  assert.equal(res.status, 0, `shim must pass through (stderr: ${res.stderr})`);
  const seen = fs.readFileSync(capture, "utf8");
  assert.ok(seen.includes("[redacted:token]"), "the equals-form value was scrubbed");
  assert.ok(!seen.includes("a1B2c3D4e5F6"), "the raw token did not reach gh");
});

test("gh shim: boolean-style flag use is untouched (gh pr merge -m keeps working)", (t) => {
  const { res, capture } = runShim(t, GH_SHIM, fs.readFileSync(REAL_SCRUB, "utf8"), [
    "pr", "merge", "12", "-m",
  ]);
  assert.equal(res.status, 0, `shim must pass through (stderr: ${res.stderr})`);
  assert.equal(
    fs.readFileSync(capture, "utf8").trim().split("\n").pop(), "-m",
    "-m reaches gh verbatim, never consumed as a value",
  );
});

test("gh shim: an ambient GH_MERGE_GUARD=on cannot arm through the harness (issue #479 pin)", (t) => {
  // The #479 defect only bites where the lane exports GH_MERGE_GUARD=on —
  // the merge-guard hook armed through the process.env spread and refused
  // fail-closed on the boolean-flag pin above. Arm the lane INSIDE this
  // process so the harness env's hermeticity is graded on every machine,
  // not just on armed lanes. Save-and-RESTORE in the finally, never delete
  // (issue #490's restore rule, applied to this file's arm pins by #551): a
  // delete here would permanently scrub an armed lane's export out of this
  // test process and launder every later leg de-armed — on a clean box the
  // restore IS a delete.
  const savedHookArm = process.env.GH_MERGE_GUARD;
  process.env.GH_MERGE_GUARD = "on";
  try {
    const { res, capture } = runShim(t, GH_SHIM, fs.readFileSync(REAL_SCRUB, "utf8"), [
      "pr", "merge", "12", "-m",
    ]);
    assert.equal(res.status, 0, `harness env must stay unarmed under the ambient arm (stderr: ${res.stderr})`);
    assert.equal(
      fs.readFileSync(capture, "utf8").trim().split("\n").pop(), "-m",
      "-m reaches gh verbatim under the harness env too",
    );
  } finally {
    if (savedHookArm === undefined) delete process.env.GH_MERGE_GUARD;
    else process.env.GH_MERGE_GUARD = savedHookArm;
  }
});

test("gh shim: ambient GH_MERGE_GUARD=on cannot arm the stdin-form helper either (issue #483 pin)", (t) => {
  // The #483 residual: runShimWithStdin carries no delete, so one future
  // `pr merge` test routed through the stdin form re-opens the #479
  // red-on-armed-lane class. This pin routes the merge verb through that
  // helper under an in-process armed lane, so the helper's env hermeticity
  // is graded today — without the delete in runShimWithStdin this leg takes
  // the armed branch and refuses, on any machine. Save-and-RESTORE in the
  // finally, never delete (issue #490's restore rule, applied to this file's
  // arm pins by #551) — on a clean box the restore IS a delete.
  const savedHookArm = process.env.GH_MERGE_GUARD;
  process.env.GH_MERGE_GUARD = "on";
  try {
    const { res, capture } = runShimWithStdin(
      t, GH_SHIM, fs.readFileSync(REAL_SCRUB, "utf8"),
      ["pr", "merge", "12", "-m"], "",
    );
    assert.equal(res.status, 0, `stdin-form helper env must stay unarmed too (stderr: ${res.stderr})`);
    assert.equal(
      fs.readFileSync(capture, "utf8").trim().split("\n").pop(), "-m",
      "the merge argv reaches gh verbatim through the stdin-form helper",
    );
  } finally {
    if (savedHookArm === undefined) delete process.env.GH_MERGE_GUARD;
    else process.env.GH_MERGE_GUARD = savedHookArm;
  }
});

test("gh shim: ambient guard envs cannot reach the stdin-form helper's child env (issue #551 pin)", (t) => {
  // The #551 residual, graded on a clean machine: the helper scrubbed only
  // the hook arm (GH_MERGE_GUARD, issue #483), so MERGE_GUARD_VERIFY /
  // MERGE_GUARD_VERIFY_TOOL rode its spread undeleted — the #551 receipt's
  // "two fronts at once" arm (the hook arms AND the guard's verify leg
  // arms). Arm every guard name INSIDE this process (the verify tool at a
  // path that cannot exist; both check-run names set — the #1132
  // explicit-assertion shape) and route the merge verb through the helper.
  // The scrubber runs INSIDE the child, so it dumps the child env the
  // helper actually built: each delete is graded directly, on any machine,
  // not just on a mis-configured lane (the #479/#483 pin shape). A merge
  // leg through this helper is the #551 fix shape's named pin vehicle.
  // Save-and-RESTORE in the finally, never delete (issue #490's restore
  // rule) — a delete here would launder an armed lane's exports out of
  // this process for every later leg; on a clean box the restore IS a
  // delete.
  const saved = {
    hook: process.env.GH_MERGE_GUARD,
    verify: process.env.MERGE_GUARD_VERIFY,
    tool: process.env.MERGE_GUARD_VERIFY_TOOL,
    check: process.env.MERGE_GUARD_CHECK,
    ghCheck: process.env.GH_MERGE_GUARD_CHECK,
  };
  process.env.GH_MERGE_GUARD = "on";
  process.env.MERGE_GUARD_VERIFY = "on";
  process.env.MERGE_GUARD_VERIFY_TOOL = "/nonexistent/pr-verification.mjs";
  process.env.MERGE_GUARD_CHECK = "not-this-repos-gates";
  process.env.GH_MERGE_GUARD_CHECK = "not-this-repos-gates";
  try {
    // A payload VALUE the shim definitely scrubs (equals-form --body=, the
    // shim's first scrub case; `pr merge -m` is boolean-only and rides raw
    // by design) so the scrubber runs inside the child — the dump below is
    // written by the scrubber itself.
    const { res, dir } = runShimWithStdin(
      t,
      GH_SHIM,
      [
        "import fs from 'node:fs';",
        "import path from 'node:path';",
        "fs.writeFileSync(",
        "  path.join(process.env.TMPDIR, 'child-env.json'),",
        "  JSON.stringify(process.env),",
        ");",
        "process.stdout.write('scrubbed');",
      ].join("\n"),
      ["pr", "merge", "12", "--body=merge message", "-m"],
      "",
    );
    assert.equal(
      res.status, 0,
      `the ambient guard arm must not flip the helper's merge leg (stderr: ${res.stderr})`,
    );
    // The UNARMED merge leg is supposed to say so explicitly (the shim's
    // #434 INACTIVE notice) — its presence is the unarmed signature; the
    // armed/refused/verify-run shapes below are the failure modes this pin
    // forbids.
    assert.match(
      res.stderr,
      /merge guard INACTIVE \(GH_MERGE_GUARD unset\)/,
      "the merge leg must take the shim's unarmed branch under the helper's env",
    );
    assert.doesNotMatch(
      `${res.stdout}${res.stderr}`,
      /fail-closed|merge guard armed|misarmed|merge REFUSED|verification tool is missing|independent verification/i,
      "neither the guard hook nor its verify leg may run under the helper's env",
    );
    const dump = path.join(dir, "child-env.json");
    assert.ok(fs.existsSync(dump), `the scrubber must have dumped the child env (stderr: ${res.stderr})`);
    const childEnv = JSON.parse(fs.readFileSync(dump, "utf8"));
    for (const name of [
      "GH_MERGE_GUARD",
      "MERGE_GUARD_VERIFY",
      "MERGE_GUARD_VERIFY_TOOL",
      "MERGE_GUARD_CHECK",
      "GH_MERGE_GUARD_CHECK",
    ]) {
      assert.ok(
        !(name in childEnv),
        `ambient ${name} must not reach the shim's child env through the stdin-form helper (issue #551 belt)`,
      );
    }
  } finally {
    for (const [name, value] of Object.entries({
      GH_MERGE_GUARD: saved.hook,
      MERGE_GUARD_VERIFY: saved.verify,
      MERGE_GUARD_VERIFY_TOOL: saved.tool,
      MERGE_GUARD_CHECK: saved.check,
      GH_MERGE_GUARD_CHECK: saved.ghCheck,
    })) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test("gh shim: ambient guard envs cannot reach the plain-form helper's child env (issue #558 pin)", (t) => {
  // The #558 residual, graded on a clean machine — the plain-form runShim is
  // the SEVENTH env-construction carrier (its stdin-form sibling closed the
  // same gap in the #551 fix): it scrubbed only the hook arm (GH_MERGE_GUARD,
  // issue #479), so the other four guard names rode its spread undeleted.
  // Arm all five names INSIDE this process (the verify tool at a path that
  // cannot exist; both check-run names set — the #1132 explicit-assertion
  // shape) and route the merge verb through the helper. The scrubber runs
  // INSIDE the child, so it dumps the child env the helper actually built:
  // each delete is graded directly, on any machine. A merge leg through this
  // helper is the #551 fix shape's named pin vehicle; the payload VALUE is
  // equals-form --body= (`pr merge -m` is boolean-only and rides raw by
  // design) so the scrubber runs inside the child. Save-and-RESTORE in the
  // finally, never delete (issue #490's restore rule).
  const saved = {
    hook: process.env.GH_MERGE_GUARD,
    verify: process.env.MERGE_GUARD_VERIFY,
    tool: process.env.MERGE_GUARD_VERIFY_TOOL,
    check: process.env.MERGE_GUARD_CHECK,
    ghCheck: process.env.GH_MERGE_GUARD_CHECK,
  };
  process.env.GH_MERGE_GUARD = "on";
  process.env.MERGE_GUARD_VERIFY = "on";
  process.env.MERGE_GUARD_VERIFY_TOOL = "/nonexistent/pr-verification.mjs";
  process.env.MERGE_GUARD_CHECK = "not-this-repos-gates";
  process.env.GH_MERGE_GUARD_CHECK = "not-this-repos-gates";
  try {
    const { res, dir } = runShim(
      t,
      GH_SHIM,
      [
        "import fs from 'node:fs';",
        "import path from 'node:path';",
        "fs.writeFileSync(",
        "  path.join(process.env.TMPDIR, 'child-env.json'),",
        "  JSON.stringify(process.env),",
        ");",
        "process.stdout.write('scrubbed');",
      ].join("\n"),
      ["pr", "merge", "12", "--body=merge message", "-m"],
    );
    assert.equal(
      res.status, 0,
      `the ambient guard arm must not flip the helper's merge leg (stderr: ${res.stderr})`,
    );
    assert.match(
      res.stderr,
      /merge guard INACTIVE \(GH_MERGE_GUARD unset\)/,
      "the merge leg must take the shim's unarmed branch under the helper's env",
    );
    assert.doesNotMatch(
      `${res.stdout}${res.stderr}`,
      /fail-closed|merge guard armed|misarmed|merge REFUSED|verification tool is missing|independent verification/i,
      "neither the guard hook nor its verify leg may run under the helper's env",
    );
    const dump = path.join(dir, "child-env.json");
    assert.ok(fs.existsSync(dump), `the scrubber must have dumped the child env (stderr: ${res.stderr})`);
    const childEnv = JSON.parse(fs.readFileSync(dump, "utf8"));
    for (const name of [
      "GH_MERGE_GUARD",
      "MERGE_GUARD_VERIFY",
      "MERGE_GUARD_VERIFY_TOOL",
      "MERGE_GUARD_CHECK",
      "GH_MERGE_GUARD_CHECK",
    ]) {
      assert.ok(
        !(name in childEnv),
        `ambient ${name} must not reach the shim's child env through the plain-form helper (issue #558 belt)`,
      );
    }
  } finally {
    for (const [name, value] of Object.entries({
      GH_MERGE_GUARD: saved.hook,
      MERGE_GUARD_VERIFY: saved.verify,
      MERGE_GUARD_VERIFY_TOOL: saved.tool,
      MERGE_GUARD_CHECK: saved.check,
      GH_MERGE_GUARD_CHECK: saved.ghCheck,
    })) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test("gh shim: `--` after a value flag is not eaten as the value", (t) => {
  const { res, capture } = runShim(t, GH_SHIM, fs.readFileSync(REAL_SCRUB, "utf8"), [
    "release", "create", "--notes", "--", "v1.0.0",
  ]);
  assert.equal(res.status, 0, `shim must pass through (stderr: ${res.stderr})`);
  const seen = fs.readFileSync(capture, "utf8").trim().split("\n");
  assert.ok(seen.includes("--"), "`--` rides through for gh's positional parsing");
  assert.ok(seen.includes("v1.0.0"), "the `--` follower reaches gh as a positional");
});

// --- git shim ---------------------------------------------------------------

test("git shim: scrubber failure aborts commit -m (real git never exec'd)", (t) => {
  assertAborted(
    runShim(t, GIT_SHIM, FAIL_EXIT1, ["commit", "-m", `landed token ${SECRET}`]),
    "exit-1 scrubber on git commit -m",
  );
});

test("git shim: scrubber failure aborts --message= form", (t) => {
  assertAborted(
    runShim(t, GIT_SHIM, CRASH_AFTER_PARTIAL, ["commit", `--message=token ${SECRET}`]),
    "crashing scrubber on git commit --message=",
  );
});

// --- git shim: message-FILE forms -F/--file= + `-` stdin (issue #169) --------
// `git commit/tag/notes -F <file>` and `-F -` carry a commit MESSAGE through a
// file or stdin; the shim's catch-all forwarded both raw (exit 0, payload
// untouched — the #157/#167 ride-through class, git side of PR 168). The
// guard routes every message-file value through one path: scrub_file for a
// real path (git is handed the scrubbed TEMP path, never the raw file), a
// stdin scrub + exec-time stdin redirect for `-` — failing closed before the
// real git is exec'd. The guard is subcommand-gated: `git log`/`git grep -F`
// and `git config --file` mean something else and must ride byte-identical.

test("git shim: scrubber failure aborts commit -F <file> (raw file never copied onward)", (t) => {
  const { file } = stageNotesFile(t, `msg token ${SECRET} in a file\n`);
  const { res, capture, dir } = runShim(t, GIT_SHIM, FAIL_EXIT1, ["commit", "-F", file]);
  assertAborted({ res, capture }, "exit-1 scrubber on git commit -F <file>");
  const leftovers = fs.readdirSync(dir).filter((f) => f.startsWith("git-scrubbed."));
  assert.equal(leftovers.length, 0, "no scrub temp file survives the abort");
});

test("git shim: commit -F <file> reaches git as a scrubbed temp file", (t) => {
  const { file } = stageNotesFile(t, `msg token ${SECRET} dated 2026-09-26\n`);
  const { res, capture, dir } = runShim(t, GIT_SHIM, fs.readFileSync(REAL_SCRUB, "utf8"), [
    "commit", "-F", file,
  ]);
  assert.equal(res.status, 0, `shim must pass through (stderr: ${res.stderr})`);
  assert.ok(fs.existsSync(capture), "the real git was run");
  const seen = fs.readFileSync(capture, "utf8").trim().split("\n");
  const rawArgs = seen.filter((a) => a.endsWith("notes.md"));
  assert.equal(rawArgs.length, 0, `the raw payload path must not reach git — captured: ${seen.join(" | ")}`);
  // git's argv pointed at a scrubbed temp in TMPDIR, whose content
  // (snapshotted by the recorder DURING the run) is redacted with dates kept
  const tempArg = seen.find((a) => a.startsWith(path.join(dir, "git-scrubbed.")));
  assert.ok(tempArg, `git's argv must point at a git-scrubbed.* temp — captured: ${seen.join(" | ")}`);
  const text = fs.readFileSync(`${capture}.content`, "utf8");
  assert.ok(text.includes("[redacted:token]"), "scrubbed message content");
  assert.ok(!text.includes("a1B2c3D4e5F6"), "the raw token did not survive");
  assert.ok(text.includes("2026-09-26"), "dates still ride through untouched");
  // ...and once git is done the temp is GONE — no git-scrubbed.* residue in
  // TMPDIR after a successful run (issue #180: the old exec tail leaked one
  // copy of the post-scrub commit message per message-file call, forever).
  const leftovers = fs.readdirSync(dir).filter((f) => f.startsWith("git-scrubbed."));
  assert.equal(leftovers.length, 0, `the post-scrub temp leaked into TMPDIR (got: ${leftovers.join(", ")})`);
});

test("git shim: scrubber failure aborts tag -F <file>", (t) => {
  const { file } = stageNotesFile(t, `tag msg ${SECRET}\n`);
  assertAborted(
    runShim(t, GIT_SHIM, CRASH_AFTER_PARTIAL, ["tag", "-a", "v1.0.0", "-F", file]),
    "crashing scrubber on git tag -F <file>",
  );
});

test("git shim: notes -F <file> reaches git as a scrubbed temp file", (t) => {
  const { file } = stageNotesFile(t, `notes msg token ${SECRET}\n`);
  const { res, capture, dir } = runShim(t, GIT_SHIM, fs.readFileSync(REAL_SCRUB, "utf8"), [
    "notes", "add", "-F", file,
  ]);
  assert.equal(res.status, 0, `shim must pass through (stderr: ${res.stderr})`);
  const seen = fs.readFileSync(capture, "utf8").trim().split("\n");
  const tempArg = seen.find((a) => a.startsWith(path.join(dir, "git-scrubbed.")));
  assert.ok(tempArg, `git's argv must point at a git-scrubbed.* temp — captured: ${seen.join(" | ")}`);
  const text = fs.readFileSync(`${capture}.content`, "utf8");
  assert.ok(text.includes("[redacted:token]"), "the notes message file was scrubbed");
  assert.ok(!text.includes("a1B2c3D4e5F6"), "the raw token did not reach git");
  const leftovers = fs.readdirSync(dir).filter((f) => f.startsWith("git-scrubbed."));
  assert.equal(leftovers.length, 0, `the post-scrub temp leaked into TMPDIR (got: ${leftovers.join(", ")})`);
});

test("git shim: scrubber failure aborts commit --file= (equals-form file)", (t) => {
  const { file } = stageNotesFile(t, `msg token ${SECRET} in a file\n`);
  const { res, capture, dir } = runShim(t, GIT_SHIM, FAIL_EXIT1, ["commit", `--file=${file}`]);
  assertAborted({ res, capture }, "exit-1 scrubber on git commit --file=");
  const leftovers = fs.readdirSync(dir).filter((f) => f.startsWith("git-scrubbed."));
  assert.equal(leftovers.length, 0, "no scrub temp file survives the abort");
});

test("git shim: equals-form --file= reaches git as a scrubbed temp file", (t) => {
  const { file } = stageNotesFile(t, `msg token ${SECRET} dated 2026-09-26\n`);
  const { res, capture, dir } = runShim(t, GIT_SHIM, fs.readFileSync(REAL_SCRUB, "utf8"), [
    "commit", `--file=${file}`,
  ]);
  assert.equal(res.status, 0, `shim must pass through (stderr: ${res.stderr})`);
  const seen = fs.readFileSync(capture, "utf8").trim().split("\n");
  const tempArg = seen.find((a) => a.startsWith(path.join(dir, "git-scrubbed.")));
  assert.ok(tempArg, `git's argv must point at a git-scrubbed.* temp — captured: ${seen.join(" | ")}`);
  const text = fs.readFileSync(`${capture}.content`, "utf8");
  assert.ok(text.includes("[redacted:token]"), "scrubbed message content");
  assert.ok(!text.includes("a1B2c3D4e5F6"), "the raw token did not survive");
  const leftovers = fs.readdirSync(dir).filter((f) => f.startsWith("git-scrubbed."));
  assert.equal(leftovers.length, 0, `the post-scrub temp leaked into TMPDIR (got: ${leftovers.join(", ")})`);
});

test("git shim: scrubber failure aborts commit -F - (stdin form, real git never exec'd)", (t) => {
  const { res, capture, dir } = runShimWithStdin(
    t, GIT_SHIM, FAIL_EXIT1,
    ["commit", "-F", "-"],
    `stdin msg ${SECRET}\n`,
  );
  assertAborted({ res, capture }, "exit-1 scrubber on git commit -F -");
  const leftovers = fs.readdirSync(dir).filter((f) => f.startsWith("git-scrubbed."));
  assert.equal(leftovers.length, 0, "no scrub temp file survives the abort");
});

test("git shim: commit -F - stdin payload is scrubbed before git reads it", (t) => {
  const { res, capture, dir } = runShimWithStdin(
    t, GIT_SHIM, fs.readFileSync(REAL_SCRUB, "utf8"),
    ["commit", "-F", "-"],
    `stdin msg token ${SECRET} dated 2026-09-26\n`,
  );
  assert.equal(res.status, 0, `shim must pass through (stderr: ${res.stderr})`);
  assert.ok(fs.existsSync(capture), "the real git was run");
  const seen = fs.readFileSync(capture, "utf8").trim().split("\n");
  assert.ok(seen.includes("-"), "`-` reaches git verbatim as its stdin marker");
  // git reads the scrubbed temp on stdin (snapshotted by the recorder DURING
  // the run): redacted, dates kept.
  const gotStdin = fs.readFileSync(`${capture}.stdin`, "utf8");
  assert.ok(gotStdin.includes("[redacted:token]"), "the real git read the scrubbed payload on stdin");
  assert.ok(!gotStdin.includes("a1B2c3D4e5F6"), "the raw stdin payload did not survive");
  assert.ok(gotStdin.includes("2026-09-26"), "dates still ride through untouched");
  // No git-scrubbed.* residue in TMPDIR after the successful run (issue #180).
  const leftovers = fs.readdirSync(dir).filter((f) => f.startsWith("git-scrubbed."));
  assert.equal(leftovers.length, 0, `the post-scrub stdin temp leaked into TMPDIR (got: ${leftovers.join(", ")})`);
});

// --- git shim: scrubbed-temp cleanup on EVERY path (issue #180) --------------
// The old tail `exec`-ed the real git, replacing the shim shell — so a scrub
// temp outlived the call even when git FAILED: `git commit -F <file>` with a
// non-zero git exit (hook rejection, bad author, ...) still left the
// post-scrub message in TMPDIR forever. The shim now runs git as a child,
// forwards its exit status unchanged, and unlinks every registered temp via
// an EXIT trap — success, abort, or git failure. These pins exercise the
// FAILURE path specifically (the success path is pinned above).

// a stand-in git that fails the way git can (exit 128) AFTER reading the
// scrubbed temp it was handed
const FAILING_REAL = "#!/usr/bin/env bash\n" +
  'for a in "$@"; do case "$a" in */git-scrubbed.*) cat "$a" >> "$SHIM_TEST_CAPTURE.content";; esac; done\n' +
  'cat >> "$SHIM_TEST_CAPTURE.stdin"\nprintf \'%s\\n\' "$@" >> "$SHIM_TEST_CAPTURE"\nexit 128\n';

function runGitShimFailingReal(t, argv, { stdin } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scrub-shim-git-fail-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const scrub = path.join(dir, "scrub-under-test.mjs");
  fs.writeFileSync(scrub, fs.readFileSync(REAL_SCRUB, "utf8"));
  const capture = path.join(dir, "captured-argv.txt");
  const real = path.join(dir, "record-real");
  fs.writeFileSync(real, FAILING_REAL);
  fs.chmodSync(real, 0o755);
  const res = spawnSync("bash", [GIT_SHIM, ...argv], {
    encoding: "utf8",
    input: stdin,
    env: {
      ...process.env,
      GIT_SCRUB_REAL: real,
      SCRUB_SCRIPT: scrub,
      SHIM_TEST_CAPTURE: capture,
      TMPDIR: dir,
    },
  });
  return { res, capture, dir };
}

test("git shim: git's non-zero exit propagates — and the scrub temp still unlinks (file form, issue #180)", (t) => {
  const { file } = stageNotesFile(t, `msg token ${SECRET} dated 2026-09-26\n`);
  const { res, capture, dir } = runGitShimFailingReal(t, ["commit", "-F", file]);
  assert.equal(
    res.status, 128,
    `git's non-zero status must reach the shim's caller unchanged (got ${res.status}; stderr: ${res.stderr})`,
  );
  // git DID read the scrubbed temp before failing...
  const text = fs.readFileSync(`${capture}.content`, "utf8");
  assert.ok(text.includes("[redacted:token]"), "git read the scrubbed content before failing");
  // ...and the EXIT trap still unlinked it: no residue on the failure path.
  const leftovers = fs.readdirSync(dir).filter((f) => f.startsWith("git-scrubbed."));
  assert.equal(leftovers.length, 0, `the scrub temp survived a non-zero git exit (got: ${leftovers.join(", ")})`);
});

test("git shim: git's non-zero exit propagates — and the scrub temp still unlinks (stdin form, issue #180)", (t) => {
  const { res, capture, dir } = runGitShimFailingReal(
    t, ["commit", "-F", "-"], { stdin: `stdin msg token ${SECRET}\n` },
  );
  assert.equal(
    res.status, 128,
    `git's non-zero status must reach the shim's caller unchanged (got ${res.status}; stderr: ${res.stderr})`,
  );
  const gotStdin = fs.readFileSync(`${capture}.stdin`, "utf8");
  assert.ok(gotStdin.includes("[redacted:token]"), "git read the scrubbed stdin payload before failing");
  const leftovers = fs.readdirSync(dir).filter((f) => f.startsWith("git-scrubbed."));
  assert.equal(leftovers.length, 0, `the scrubbed stdin temp survived a non-zero git exit (got: ${leftovers.join(", ")})`);
});

test("git shim: scrubber failure still aborts with no residue (EXIT trap coexists with the fail-closed path)", (t) => {
  const { file } = stageNotesFile(t, `msg token ${SECRET} in a file\n`);
  const { res, capture, dir } = runShim(t, GIT_SHIM, CRASH_AFTER_PARTIAL, ["commit", "-F", file]);
  assertAborted({ res, capture }, "crashing scrubber on git commit -F <file>");
  const leftovers = fs.readdirSync(dir).filter((f) => f.startsWith("git-scrubbed."));
  assert.equal(leftovers.length, 0, "no scrub temp file survives the abort");
});

test("git shim: -F/--file ride byte-identical outside the message-file subcommands", (t) => {
  for (const argv of [
    ["log", "-F", "--grep=needle"],
    ["grep", "-F", "needle"],
    ["config", "--file", "other.cfg", "user.name", "bob"],
    ["checkout", "--", "-F"],
  ]) {
    const { res, capture, dir } = runShim(t, GIT_SHIM, fs.readFileSync(REAL_SCRUB, "utf8"), argv);
    assert.equal(res.status, 0, `shim must pass through (stderr: ${res.stderr})`);
    const seen = fs.readFileSync(capture, "utf8").trim().split("\n");
    assert.deepEqual(seen, argv, `${argv.join(" ")}: argv must be untouched`);
    const scrubbed = fs.readdirSync(dir).filter((f) => f.startsWith("git-scrubbed."));
    assert.equal(scrubbed.length, 0, `${argv.join(" ")}: no scrub temp may be created`);
  }
});

// --- git shim: message-FILE forms under commit-tree --------------------------
// `git commit-tree -F <file>` also signs prose into history, but the
// subcommand gate only armed commit/tag/notes/merge — a secret-bearing
// message file reached the real git unscrubbed (the shim header's contract:
// an unscrubbed message is not signed into history). commit-tree arms the
// same gate; merge's `-F`/`-m` pins live in the issue-#200 block below.
// NOTE: `pull` is deliberately NOT armed — git-pull(1) has no -m/--message= or
// -F on any git version (PR #203 review finding): arming it would gate flags
// git rejects anyway, so `pull -F` must ride byte-identical.

test("git shim: commit-tree -F <file> reaches git as a scrubbed temp file", (t) => {
  {
    const sub = "commit-tree";
    const { file } = stageNotesFile(t, `msg token ${SECRET} dated 2026-09-26\n`);
    const { res, capture, dir } = runShim(t, GIT_SHIM, fs.readFileSync(REAL_SCRUB, "utf8"), [
      sub, "-F", file,
    ]);
    assert.equal(res.status, 0, `${sub} -F: shim must pass through (stderr: ${res.stderr})`);
    const seen = fs.readFileSync(capture, "utf8").trim().split("\n");
    assert.ok(
      !seen.includes(file),
      `${sub} -F: the raw payload path must not reach git — captured: ${seen.join(" | ")}`,
    );
    const tempArg = seen.find((a) => a.startsWith(path.join(dir, "git-scrubbed.")));
    assert.ok(tempArg, `${sub} -F: git's argv must point at a git-scrubbed.* temp — captured: ${seen.join(" | ")}`);
    const text = fs.readFileSync(`${capture}.content`, "utf8");
    assert.ok(text.includes("[redacted:token]"), `${sub} -F: scrubbed message content`);
    assert.ok(!text.includes("a1B2c3D4e5F6"), `${sub} -F: the raw token did not survive`);
    assert.ok(text.includes("2026-09-26"), `${sub} -F: dates still ride through untouched`);
    const leftovers = fs.readdirSync(dir).filter((f) => f.startsWith("git-scrubbed."));
    assert.equal(leftovers.length, 0, `${sub} -F: no scrub temp survives the run`);
  }
});

test("git shim: commit-tree --message= scrubs like commit's (merge -m: the #196 pin)", (t) => {
  {
    const argv = ["commit-tree", `--message=tree msg ${SECRET}`];
    const { res, capture } = runShim(t, GIT_SHIM, fs.readFileSync(REAL_SCRUB, "utf8"), argv);
    assert.equal(res.status, 0, `shim must pass through (stderr: ${res.stderr})`);
    const seen = fs.readFileSync(capture, "utf8");
    assert.ok(seen.includes("[redacted:token]"), `${argv.join(" ")}: scrubbed value reached git`);
    assert.ok(!seen.includes("a1B2c3D4e5F6"), `${argv.join(" ")}: the raw token did not survive`);
  }
});

// --- git shim: the BARE stdin message form of commit-tree (issue #213) -------
// `git commit-tree <tree>` with NO -m/-F flag is documented to read the commit
// log message from standard input. The flag scan arms nothing there, so a
// secret-bearing stdin payload used to reach the real git byte-identical and
// was signed into history unscrubbed — the same under-scrub class #206/#208
// closed for `-m`/`-F`. The shim now scrubs non-tty stdin on a flagless
// commit-tree and redirects git's stdin from the scrubbed temp (fail-closed,
// temp unlinked after git exits).

test("git shim: bare commit-tree <tree> stdin message is scrubbed before git reads it", (t) => {
  const { res, capture, dir } = runShimWithStdin(
    t, GIT_SHIM, fs.readFileSync(REAL_SCRUB, "utf8"),
    ["commit-tree", "HEAD^{tree}"],
    `stdin msg token ${SECRET} dated 2026-09-26\n`,
  );
  assert.equal(res.status, 0, `shim must pass through (stderr: ${res.stderr})`);
  const seen = fs.readFileSync(capture, "utf8").trim().split("\n");
  assert.deepStrictEqual(seen, ["commit-tree", "HEAD^{tree}"],
    "argv reaches git untouched — only stdin is rerouted");
  const text = fs.readFileSync(`${capture}.stdin`, "utf8");
  assert.ok(text.includes("[redacted:token]"), "the stdin payload was scrubbed");
  assert.ok(!text.includes("a1B2c3D4e5F6"), "the raw token did not survive");
  assert.ok(text.includes("2026-09-26"), "dates still ride through untouched");
  const leftovers = fs.readdirSync(dir).filter((f) => f.startsWith("git-scrubbed."));
  assert.equal(leftovers.length, 0, "no scrub temp survives the run");
});

test("git shim: bare commit-tree stdin scrub failure aborts (real git never exec'd)", (t) => {
  const { res, capture } = runShimWithStdin(
    t, GIT_SHIM, FAIL_EXIT1, ["commit-tree", "HEAD^{tree}"], `msg token ${SECRET}\n`,
  );
  assertAborted({ res, capture }, "bare commit-tree stdin form");
});

test("git shim: flagless non-commit-tree message subcommand stdin rides byte-identical", (t) => {
  // commit/tag/notes/merge do not read a log message from bare stdin — the
  // shim must not consume their stdin (only commit-tree arms the bare-stdin
  // scrub), and their payload passes through verbatim.
  const { res, capture } = runShimWithStdin(
    t, GIT_SHIM, fs.readFileSync(REAL_SCRUB, "utf8"),
    ["commit"], `not-a-message token ${SECRET}\n`,
  );
  assert.equal(res.status, 0, `shim must pass through (stderr: ${res.stderr})`);
  const text = fs.readFileSync(`${capture}.stdin`, "utf8");
  assert.equal(text, `not-a-message token ${SECRET}\n`, "stdin crossed untouched");
});

test("git shim: commit-tree -m <msg> scrubs the value (issue #225: -m scrubs, stdin untouched)", (t) => {
  // The landed #203 behavior for the short flag form: the -m VALUE is
  // scrubbed before git sees it, while git's stdin stays untouched (pinned
  // by the sibling test below). Without this pin the sibling alone would
  // pass even if the -m value crossed byte-identical.
  const { res, capture } = runShim(t, GIT_SHIM, fs.readFileSync(REAL_SCRUB, "utf8"), [
    "commit-tree", "HEAD^{tree}", "-m", `flag msg token ${SECRET}`,
  ]);
  assert.equal(res.status, 0, `shim must pass through (stderr: ${res.stderr})`);
  const seen = fs.readFileSync(capture, "utf8");
  assert.ok(seen.includes("[redacted:token]"), "commit-tree -m: scrubbed value reached git");
  assert.ok(!seen.includes("a1B2c3D4e5F6"), "commit-tree -m: the raw token did not survive");
});

test("git shim: commit-tree WITH a message flag does not consume stdin", (t) => {
  // -m carries the message; git's stdin is not the message channel, so the
  // bare-stdin scrub must not fire and the payload crosses untouched.
  const { res, capture } = runShimWithStdin(
    t, GIT_SHIM, fs.readFileSync(REAL_SCRUB, "utf8"),
    ["commit-tree", "HEAD^{tree}", "-m", `msg token ${SECRET}`],
    `not-the-message\n`,
  );
  assert.equal(res.status, 0, `shim must pass through (stderr: ${res.stderr})`);
  const text = fs.readFileSync(`${capture}.stdin`, "utf8");
  assert.equal(text, "not-the-message\n", "stdin crossed untouched when -m carries the message");
});

test("git shim: commit-tree -F - (stdin value) message is scrubbed before git reads it", (t) => {
  // issue #224: the `-F -` spelling under commit-tree rides the SAME armed
  // MSG_CMD/file_msg_value path as `commit -F -` — git reads the message from
  // stdin, so the shim stdin-scrubs once, keeps `-` in git's argv, and
  // redirects git's stdin from the scrubbed temp. Before commit-tree armed
  // the message gate (PR #220) this spelling crossed RAW — the third
  // under-scrub entry of the #206/#213 class.
  const { res, capture, dir } = runShimWithStdin(
    t, GIT_SHIM, fs.readFileSync(REAL_SCRUB, "utf8"),
    ["commit-tree", "HEAD^{tree}", "-F", "-"],
    `stdin msg token ${SECRET} dated 2026-09-26\n`,
  );
  assert.equal(res.status, 0, `shim must pass through (stderr: ${res.stderr})`);
  const seen = fs.readFileSync(capture, "utf8").trim().split("\n");
  assert.deepStrictEqual(seen, ["commit-tree", "HEAD^{tree}", "-F", "-"],
    "git's argv keeps -F - verbatim — only stdin is rerouted");
  const text = fs.readFileSync(`${capture}.stdin`, "utf8");
  assert.ok(text.includes("[redacted:token]"), "the stdin message payload was scrubbed");
  assert.ok(!text.includes("a1B2c3D4e5F6"), "the raw token did not survive");
  assert.ok(text.includes("2026-09-26"), "dates still ride through untouched");
  const leftovers = fs.readdirSync(dir).filter((f) => f.startsWith("git-scrubbed."));
  assert.equal(leftovers.length, 0, "no scrub temp survives the run");
});

test("git shim: commit-tree -F - stdin scrub failure aborts (real git never exec'd)", (t) => {
  // fail-closed: a scrubber outage on the -F - message channel must abort,
  // not sign the raw payload into history.
  const { res, capture } = runShimWithStdin(
    t, GIT_SHIM, FAIL_EXIT1, ["commit-tree", "HEAD^{tree}", "-F", "-"], `msg token ${SECRET}\n`,
  );
  assertAborted({ res, capture }, "commit-tree -F - stdin form");
});

// --- the OTHER spellings of the same stdin-value channel (issue #232) --------
// `--file=-` (equals form) and `-F-` (attached form) route through the SAME
// file_msg_value `-` branch as the separate-arg `-F -` spelling pinned above:
// git's parse-options accepts all three, so a refactor that breaks the
// equals/attached argv parse must not silently drop the stdin scrub (the
// #157/#172 spelling-specific under-scrub class).

test("git shim: commit-tree --file=- (equals-form stdin value) message is scrubbed before git reads it", (t) => {
  const { res, capture, dir } = runShimWithStdin(
    t, GIT_SHIM, fs.readFileSync(REAL_SCRUB, "utf8"),
    ["commit-tree", "HEAD^{tree}", "--file=-"],
    `stdin msg token ${SECRET} dated 2026-09-26\n`,
  );
  assert.equal(res.status, 0, `shim must pass through (stderr: ${res.stderr})`);
  const seen = fs.readFileSync(capture, "utf8").trim().split("\n");
  assert.deepStrictEqual(seen, ["commit-tree", "HEAD^{tree}", "--file", "-"],
    "equals form is split so git sees --file - verbatim — only stdin is rerouted");
  const text = fs.readFileSync(`${capture}.stdin`, "utf8");
  assert.ok(text.includes("[redacted:token]"), "the stdin message payload was scrubbed");
  assert.ok(!text.includes("a1B2c3D4e5F6"), "the raw token did not survive");
  assert.ok(text.includes("2026-09-26"), "dates still ride through untouched");
  const leftovers = fs.readdirSync(dir).filter((f) => f.startsWith("git-scrubbed."));
  assert.equal(leftovers.length, 0, "no scrub temp survives the run");
});

test("git shim: commit-tree --file=- stdin scrub failure aborts (real git never exec'd)", (t) => {
  const { res, capture } = runShimWithStdin(
    t, GIT_SHIM, FAIL_EXIT1, ["commit-tree", "HEAD^{tree}", "--file=-"], `msg token ${SECRET}\n`,
  );
  assertAborted({ res, capture }, "commit-tree --file=- stdin form");
});

test("git shim: commit-tree -F- (attached stdin value) message is scrubbed before git reads it", (t) => {
  const { res, capture, dir } = runShimWithStdin(
    t, GIT_SHIM, fs.readFileSync(REAL_SCRUB, "utf8"),
    ["commit-tree", "HEAD^{tree}", "-F-"],
    `stdin msg token ${SECRET} dated 2026-09-26\n`,
  );
  assert.equal(res.status, 0, `shim must pass through (stderr: ${res.stderr})`);
  const seen = fs.readFileSync(capture, "utf8").trim().split("\n");
  assert.deepStrictEqual(seen, ["commit-tree", "HEAD^{tree}", "-F", "-"],
    "attached form is split so git sees -F - verbatim — only stdin is rerouted");
  const text = fs.readFileSync(`${capture}.stdin`, "utf8");
  assert.ok(text.includes("[redacted:token]"), "the stdin message payload was scrubbed");
  assert.ok(!text.includes("a1B2c3D4e5F6"), "the raw token did not survive");
  assert.ok(text.includes("2026-09-26"), "dates still ride through untouched");
  const leftovers = fs.readdirSync(dir).filter((f) => f.startsWith("git-scrubbed."));
  assert.equal(leftovers.length, 0, "no scrub temp survives the run");
});

test("git shim: commit-tree -F- stdin scrub failure aborts (real git never exec'd)", (t) => {
  const { res, capture } = runShimWithStdin(
    t, GIT_SHIM, FAIL_EXIT1, ["commit-tree", "HEAD^{tree}", "-F-"], `msg token ${SECRET}\n`,
  );
  assertAborted({ res, capture }, "commit-tree -F- stdin form");
});

// the same two spellings under `commit` — the armed branch is shared, but the
// subcommand gate is per-invocation, so pin the channel where it is used most.
test("git shim: commit --file=- and -F- (stdin value) messages are scrubbed before git reads them", (t) => {
  for (const argv of [["commit", "--file=-"], ["commit", "-F-"]]) {
    const { res, capture } = runShimWithStdin(
      t, GIT_SHIM, fs.readFileSync(REAL_SCRUB, "utf8"),
      argv, `stdin msg token ${SECRET} dated 2026-09-26\n`,
    );
    assert.equal(res.status, 0, `${argv.join(" ")}: shim must pass through (stderr: ${res.stderr})`);
    const text = fs.readFileSync(`${capture}.stdin`, "utf8");
    assert.ok(text.includes("[redacted:token]"), `${argv.join(" ")}: the stdin message payload was scrubbed`);
    assert.ok(!text.includes("a1B2c3D4e5F6"), `${argv.join(" ")}: the raw token did not survive`);
  }
});

test("git shim: commit --file=- and -F- stdin scrub failure aborts (real git never exec'd)", (t) => {
  for (const argv of [["commit", "--file=-"], ["commit", "-F-"]]) {
    const { res, capture } = runShimWithStdin(
      t, GIT_SHIM, FAIL_EXIT1, argv, `msg token ${SECRET}\n`,
    );
    assertAborted({ res, capture }, `commit ${argv[1]} stdin form`);
  }
});

test("git shim: `pull -F <file>` rides byte-identical — pull is not armed (PR #203 review)", (t) => {
  const { file } = stageNotesFile(t, `msg token ${SECRET} pull\n`);
  const { res, capture, dir } = runShim(t, GIT_SHIM, fs.readFileSync(REAL_SCRUB, "utf8"), [
    "pull", "-F", file,
  ]);
  assert.equal(res.status, 0, `shim must pass through (stderr: ${res.stderr})`);
  const seen = fs.readFileSync(capture, "utf8").trim().split("\n");
  assert.ok(seen.includes(file), "the raw path reaches git verbatim — pull arms no message gate");
  const scrubbed = fs.readdirSync(dir).filter((f) => f.startsWith("git-scrubbed."));
  assert.equal(scrubbed.length, 0, "no scrub temp for an unarmed subcommand");
});

test("git shim: commit -F <missing-file> rides through (git's own error path)", (t) => {
  const { res, capture, dir } = runShim(t, GIT_SHIM, fs.readFileSync(REAL_SCRUB, "utf8"), [
    "commit", "-F", path.join("no", "such", "msg.txt"),
  ]);
  assert.equal(res.status, 0, `shim must pass through (stderr: ${res.stderr})`);
  const seen = fs.readFileSync(capture, "utf8").trim().split("\n");
  assert.ok(seen.includes(path.join("no", "such", "msg.txt")), "the missing path reaches git verbatim");
  const scrubbed = fs.readdirSync(dir).filter((f) => f.startsWith("git-scrubbed."));
  assert.equal(scrubbed.length, 0, "no scrub temp for a nonexistent file");
});

// --- git shim: ATTACHED short forms -m<msg> / -F<file> (issue #172) ----------
// git's parse-options also accepts the ATTACHED short spelling — the value in
// the SAME argv element as the flag (`-m"<msg>"`, `-m<msg>`, `-F<file>`).
// Those elements are longer than the bare flag, so they fell through the
// exact `-m|--message` / `-F|--file` matches to the catch-all and rode raw
// (exit 0, payload untouched — the #157/#167/#169 ride-through class). The
// shim now scrubs the attached value through the same guards and keeps the
// separate-arg behavior byte-for-byte. Shell note: `-m'x y'` and `-mx y`
// differ only in the source text — at exec time both are the single argv
// element `-mx y`, so the attached pins below cover both spellings.

test("git shim: scrubber failure aborts the attached -m<msg> form", (t) => {
  assertAborted(
    runShim(t, GIT_SHIM, FAIL_EXIT1, ["commit", `-mtoken ${SECRET}`]),
    "exit-1 scrubber on git commit -m<msg>",
  );
});

test("git shim: scrubber failure aborts the attached -F<file> form", (t) => {
  const { file } = stageNotesFile(t, `msg token ${SECRET} in a file\n`);
  const { res, capture, dir } = runShim(t, GIT_SHIM, FAIL_EXIT1, ["commit", `-F${file}`]);
  assertAborted({ res, capture }, "exit-1 scrubber on git commit -F<file>");
  const leftovers = fs.readdirSync(dir).filter((f) => f.startsWith("git-scrubbed."));
  assert.equal(leftovers.length, 0, "no scrub temp file survives the abort");
});

test("git shim: attached -m'<secret>' is scrubbed in place (stays ONE argv element)", (t) => {
  const { res, capture } = runShim(t, GIT_SHIM, fs.readFileSync(REAL_SCRUB, "utf8"), [
    "commit", `-mtoken ${SECRET} dated 2026-09-26`,
  ]);
  assert.equal(res.status, 0, `shim must pass through (stderr: ${res.stderr})`);
  assert.ok(fs.existsSync(capture), "the real git was exec'd");
  const seen = fs.readFileSync(capture, "utf8").trim().split("\n");
  const attached = seen.filter((a) => a.startsWith("-m"));
  assert.equal(attached.length, 1, `the message must stay one attached argv element — captured: ${seen.join(" | ")}`);
  assert.ok(attached[0].includes("[redacted:token]"), "the attached message was scrubbed before exec");
  assert.ok(!attached[0].includes("a1B2c3D4e5F6"), "the raw token did not survive");
  assert.ok(attached[0].includes("2026-09-26"), "dates still ride through untouched");
  assert.ok(!seen.includes("-m"), "the attached spelling must not degenerate into a bare -m");
});

test("git shim: attached -m<msg> with no space is scrubbed too", (t) => {
  const { res, capture } = runShim(t, GIT_SHIM, fs.readFileSync(REAL_SCRUB, "utf8"), [
    "commit", `-m${SECRET}`,
  ]);
  assert.equal(res.status, 0, `shim must pass through (stderr: ${res.stderr})`);
  const seen = fs.readFileSync(capture, "utf8").trim().split("\n");
  const attached = seen.filter((a) => a.startsWith("-m"));
  assert.equal(attached.length, 1, `one attached element expected — captured: ${seen.join(" | ")}`);
  assert.ok(attached[0].includes("[redacted:token]"), "the attached value was scrubbed");
  assert.ok(!attached[0].includes("a1B2c3D4e5F6"), "the raw token did not reach git");
});

test("git shim: attached -F<file> reaches git as a scrubbed temp file", (t) => {
  const { file } = stageNotesFile(t, `msg token ${SECRET} dated 2026-09-26\n`);
  const { res, capture, dir } = runShim(t, GIT_SHIM, fs.readFileSync(REAL_SCRUB, "utf8"), [
    "commit", `-F${file}`,
  ]);
  assert.equal(res.status, 0, `shim must pass through (stderr: ${res.stderr})`);
  assert.ok(fs.existsSync(capture), "the real git was run");
  const seen = fs.readFileSync(capture, "utf8").trim().split("\n");
  const rawArgs = seen.filter((a) => a.endsWith("notes.md"));
  assert.equal(rawArgs.length, 0, `the raw payload path must not reach git — captured: ${seen.join(" | ")}`);
  const tempArg = seen.find((a) => a.startsWith(path.join(dir, "git-scrubbed.")));
  assert.ok(tempArg, `git's argv must point at a git-scrubbed.* temp — captured: ${seen.join(" | ")}`);
  const text = fs.readFileSync(`${capture}.content`, "utf8");
  assert.ok(text.includes("[redacted:token]"), "the attached -F payload was scrubbed before git read it");
  assert.ok(!text.includes("a1B2c3D4e5F6"), "the raw token did not survive");
  assert.ok(text.includes("2026-09-26"), "dates still ride through untouched");
  const leftovers = fs.readdirSync(dir).filter((f) => f.startsWith("git-scrubbed."));
  assert.equal(leftovers.length, 0, `the post-scrub temp leaked into TMPDIR (got: ${leftovers.join(", ")})`);
});

test("git shim: attached -F<missing-file> rides through (git's own error path)", (t) => {
  const { res, capture, dir } = runShim(t, GIT_SHIM, fs.readFileSync(REAL_SCRUB, "utf8"), [
    "commit", "-Fno-such-msg.txt",
  ]);
  assert.equal(res.status, 0, `shim must pass through (stderr: ${res.stderr})`);
  const seen = fs.readFileSync(capture, "utf8").trim().split("\n");
  assert.ok(seen.includes("no-such-msg.txt"), "the missing path reaches git verbatim");
  const scrubbed = fs.readdirSync(dir).filter((f) => f.startsWith("git-scrubbed."));
  assert.equal(scrubbed.length, 0, "no scrub temp for a nonexistent file");
});

// --- git shim: the gate reads git's SUBCOMMAND POSITION (issue #175) ---------
// The old gate matched the bare WORDS commit/tag/notes ANYWHERE in argv, so a
// pattern/pathspec/option VALUE equal to one of those words armed MSG_CMD and
// a -F/--file in the same invocation was consumed-and-rewritten: with a file
// named `tag` in cwd, `git grep -F tag` had its PATTERN replaced by a
// scrub-temp path (zero matches + exit 1 where raw git matched). The gate now
// derives the subcommand from the first argv element that is not a global
// option or its value.

/** A workdir containing a file named exactly `tag`, so a bare argv element
 * `tag` also resolves as that file (the #175 false-positive setup). */
function stageTagNamedFile(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scrub-shim-tagfile-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, "tag"), "tag:tag two\n");
  return dir;
}

test("git shim: `git grep -F tag` with a file named `tag` keeps its PATTERN (issue #175)", (t) => {
  const cwd = stageTagNamedFile(t);
  const argv = ["grep", "-F", "tag"];
  const { res, capture, dir } = runShim(t, GIT_SHIM, fs.readFileSync(REAL_SCRUB, "utf8"), argv, { cwd });
  assert.equal(res.status, 0, `shim must pass through (stderr: ${res.stderr})`);
  const seen = fs.readFileSync(capture, "utf8").trim().split("\n");
  assert.deepEqual(seen, argv, `the fixed-strings PATTERN must reach git verbatim — captured: ${seen.join(" | ")}`);
  const scrubbed = fs.readdirSync(dir).filter((f) => f.startsWith("git-scrubbed."));
  assert.equal(scrubbed.length, 0, "no scrub temp may be created — grep never meant a message file");
});

test("git shim: `git log -F tag` with a file named `tag` rides byte-identical (issue #175)", (t) => {
  const cwd = stageTagNamedFile(t);
  const argv = ["log", "-F", "tag", "--", "notes"];
  const { res, capture, dir } = runShim(t, GIT_SHIM, fs.readFileSync(REAL_SCRUB, "utf8"), argv, { cwd });
  assert.equal(res.status, 0, `shim must pass through (stderr: ${res.stderr})`);
  const seen = fs.readFileSync(capture, "utf8").trim().split("\n");
  assert.deepEqual(seen, argv, `argv must be untouched — captured: ${seen.join(" | ")}`);
  const scrubbed = fs.readdirSync(dir).filter((f) => f.startsWith("git-scrubbed."));
  assert.equal(scrubbed.length, 0, "no scrub temp may be created");
});

test("git shim: global options before the subcommand do not hide the gate (issue #175)", (t) => {
  const { file } = stageNotesFile(t, `msg token ${SECRET} in a file\n`);
  const { res, capture, dir } = runShim(t, GIT_SHIM, fs.readFileSync(REAL_SCRUB, "utf8"), [
    "-c", "user.name=bob", "-C", ".", "commit", "-F", file,
  ]);
  assert.equal(res.status, 0, `shim must pass through (stderr: ${res.stderr})`);
  assert.ok(fs.existsSync(capture), "the real git was run");
  const seen = fs.readFileSync(capture, "utf8").trim().split("\n");
  const tempArg = seen.find((a) => a.startsWith(path.join(dir, "git-scrubbed.")));
  assert.ok(tempArg, `the message file must still be scrubbed — captured: ${seen.join(" | ")}`);
  const scrubbed = fs.readdirSync(dir).filter((f) => f.startsWith("git-scrubbed."));
  assert.equal(scrubbed.length, 0, "no scrub temp survives the run");
});

// --- git shim: hidden value-taking globals in SEPARATE form (issue #199) -----
// `git --shallow-file <path>` is a real (hidden) value-taking global. Left out
// of `subcommand_of`'s value-consumer list, its VALUE fell into the boolean
// `-*` catch-all and was returned as git's subcommand, so a genuine
// `commit -F` after it never armed MSG_CMD and the message file rode raw.

test("git shim: --shallow-file <value> before `commit -F` does not hide the gate (issue #199)", (t) => {
  const { file } = stageNotesFile(t, `msg token ${SECRET} in a file\n`);
  const { res, capture, dir } = runShim(t, GIT_SHIM, fs.readFileSync(REAL_SCRUB, "utf8"), [
    "--shallow-file", "/tmp/alt-alternates", "commit", "-F", file,
  ]);
  assert.equal(res.status, 0, `shim must pass through (stderr: ${res.stderr})`);
  assert.ok(fs.existsSync(capture), "the real git was run");
  const seen = fs.readFileSync(capture, "utf8").trim().split("\n");
  assert.ok(
    seen.includes("/tmp/alt-alternates"),
    `the --shallow-file value must reach git verbatim — captured: ${seen.join(" | ")}`,
  );
  const tempArg = seen.find((a) => a.startsWith(path.join(dir, "git-scrubbed.")));
  assert.ok(tempArg, `the message file must still be scrubbed — captured: ${seen.join(" | ")}`);
  const scrubbed = fs.readdirSync(dir).filter((f) => f.startsWith("git-scrubbed."));
  assert.equal(scrubbed.length, 0, "no scrub temp survives the run");
});

test("git shim: attached --shallow-file=<value> before `commit -F` does not hide the gate (issue #199)", (t) => {
  const { file } = stageNotesFile(t, `msg token ${SECRET} in a file\n`);
  const { res, capture, dir } = runShim(t, GIT_SHIM, fs.readFileSync(REAL_SCRUB, "utf8"), [
    "--shallow-file=/tmp/alt-alternates", "commit", "-F", file,
  ]);
  assert.equal(res.status, 0, `shim must pass through (stderr: ${res.stderr})`);
  const seen = fs.readFileSync(capture, "utf8").trim().split("\n");
  const tempArg = seen.find((a) => a.startsWith(path.join(dir, "git-scrubbed.")));
  assert.ok(tempArg, `the message file must still be scrubbed — captured: ${seen.join(" | ")}`);
  const scrubbed = fs.readdirSync(dir).filter((f) => f.startsWith("git-scrubbed."));
  assert.equal(scrubbed.length, 0, "no scrub temp survives the run");
});

test("git shim: attached -F<value> outside a message subcommand rides byte-identical", (t) => {
  const argv = ["grep", "-Fneedle"];
  const { res, capture, dir } = runShim(t, GIT_SHIM, fs.readFileSync(REAL_SCRUB, "utf8"), argv);
  assert.equal(res.status, 0, `shim must pass through (stderr: ${res.stderr})`);
  const seen = fs.readFileSync(capture, "utf8").trim().split("\n");
  assert.deepEqual(seen, argv, `${argv.join(" ")}: argv must be untouched`);
  const scrubbed = fs.readdirSync(dir).filter((f) => f.startsWith("git-scrubbed."));
  assert.equal(scrubbed.length, 0, `${argv.join(" ")}: no scrub temp may be created`);
});

test("git shim: an emptied attached -m value falls back to the separate form (a bare -m must not eat the next arg)", (t) => {
  // A scrubber that returns empty output must not leave a BARE `-m` in argv:
  // git would then consume the NEXT argument (here --allow-empty) as the
  // message. The separate form `(-m, "")` keeps the empty string the message.
  const SWALLOW_ALL = "process.exit(0);\n";
  const { res, capture } = runShim(t, GIT_SHIM, SWALLOW_ALL, [
    "commit", "-mval", "--allow-empty",
  ]);
  assert.equal(res.status, 0, `shim must pass through (stderr: ${res.stderr})`);
  const seen = fs.readFileSync(capture, "utf8").trim().split("\n");
  assert.deepEqual(
    seen,
    ["commit", "-m", "", "--allow-empty"],
    "the emptied value stays the message; --allow-empty stays a flag",
  );
});
// --- git shim: the -m/--message gate reads the SAME subcommand position -----
// (issue #196) — `-m` is not a message flag everywhere: `git checkout -m
// <branch>` / `git switch -m <branch>` (merge-strategy) and `git cherry-pick
// -m <mainline-number> <sha>` carry non-prose values. The old handlers ran
// unconditionally: a rewriting scrubber rewrote the VALUE (silent argv
// drift), and a scrubber outage abort-failed a command that never carried a
// message. Under commit/tag/notes the scrubbing must keep working.

test("git shim: `checkout -m mybranch` rides byte-identical — the branch is not prose (issue #196)", (t) => {
  const argv = ["checkout", "-m", "mybranch"];
  const { res, capture, dir } = runShim(t, GIT_SHIM, fs.readFileSync(REAL_SCRUB, "utf8"), argv);
  assert.equal(res.status, 0, `shim must pass through (stderr: ${res.stderr})`);
  const seen = fs.readFileSync(capture, "utf8").trim().split("\n");
  assert.deepEqual(seen, argv, `the branch name must reach git verbatim — captured: ${seen.join(" | ")}`);
  const scrubbed = fs.readdirSync(dir).filter((f) => f.startsWith("git-scrubbed."));
  assert.equal(scrubbed.length, 0, "no scrub temp may be created — no message is present");
});

test("git shim: `cherry-pick -m 1 abc123` survives a scrubber OUTAGE (nothing message-like to protect, issue #196)", (t) => {
  const argv = ["cherry-pick", "-m", "1", "abc123"];
  const FAILING = "process.exit(3);\n";
  const { res, capture } = runShim(t, GIT_SHIM, FAILING, argv);
  assert.equal(res.status, 0, `a non-message subcommand must not fail closed — status ${res.status}, stderr: ${res.stderr}`);
  const seen = fs.readFileSync(capture, "utf8").trim().split("\n");
  assert.deepEqual(seen, argv, "the mainline number and sha must reach git verbatim");
});

test("git shim: attached -m<value> outside a message subcommand rides byte-identical (issue #196)", (t) => {
  const argv = ["checkout", "-mmybranch"];
  const { res, capture, dir } = runShim(t, GIT_SHIM, fs.readFileSync(REAL_SCRUB, "utf8"), argv);
  assert.equal(res.status, 0, `shim must pass through (stderr: ${res.stderr})`);
  const seen = fs.readFileSync(capture, "utf8").trim().split("\n");
  assert.deepEqual(seen, argv, `argv must be untouched — captured: ${seen.join(" | ")}`);
  const scrubbed = fs.readdirSync(dir).filter((f) => f.startsWith("git-scrubbed."));
  assert.equal(scrubbed.length, 0, "no scrub temp may be created");
});

test("git shim: --message=<value> outside a message subcommand rides byte-identical (issue #196)", (t) => {
  const argv = ["checkout", "--message=mybranch"];
  const { res, capture, dir } = runShim(t, GIT_SHIM, fs.readFileSync(REAL_SCRUB, "utf8"), argv);
  assert.equal(res.status, 0, `shim must pass through (stderr: ${res.stderr})`);
  const seen = fs.readFileSync(capture, "utf8").trim().split("\n");
  assert.deepEqual(seen, argv, `argv must be untouched — captured: ${seen.join(" | ")}`);
  const scrubbed = fs.readdirSync(dir).filter((f) => f.startsWith("git-scrubbed."));
  assert.equal(scrubbed.length, 0, "no scrub temp may be created");
});

test("git shim: `tag -m <msg>` is still scrubbed — the gate keeps the real message forms (issue #196)", (t) => {
  const { res, capture } = runShim(t, GIT_SHIM, fs.readFileSync(REAL_SCRUB, "utf8"), [
    "tag", "-m", `release token ${SECRET} prose`,
  ]);
  assert.equal(res.status, 0, `shim must pass through (stderr: ${res.stderr})`);
  const seen = fs.readFileSync(capture, "utf8").trim().split("\n");
  const msgArg = seen[seen.indexOf("-m") + 1];
  assert.ok(msgArg.includes("[redacted:token]"), `the tag message must be scrubbed — captured: ${seen.join(" | ")}`);
  assert.ok(!msgArg.includes("a1B2c3D4e5F6"), "the raw token must NOT reach git");
});

test("git shim: `notes -m <msg>` and `commit --message=<msg>` are still scrubbed (issue #196)", (t) => {
  const { res: r1, capture: c1 } = runShim(t, GIT_SHIM, fs.readFileSync(REAL_SCRUB, "utf8"), ["notes", "-m", `token ${SECRET}`]);
  assert.equal(r1.status, 0, `notes: shim must pass through (stderr: ${r1.stderr})`);
  const seen1 = fs.readFileSync(c1, "utf8").trim().split("\n");
  assert.ok(seen1[seen1.indexOf("-m") + 1].includes("[redacted:token]"), "notes message was scrubbed");
  const { res: r2, capture: c2 } = runShim(t, GIT_SHIM, fs.readFileSync(REAL_SCRUB, "utf8"), ["commit", `--message=token ${SECRET}`]);
  assert.equal(r2.status, 0, `commit: shim must pass through (stderr: ${r2.stderr})`);
  const seen2 = fs.readFileSync(c2, "utf8").trim().split("\n");
  const eq = seen2.find((a) => a.startsWith("--message="));
  assert.ok(eq && eq.includes("[redacted:token]"), "commit --message= was scrubbed");
  assert.ok(!eq.includes("a1B2c3D4e5F6"), "the raw token did not reach git");
});


// --- positive control: the same harness passes scrubbed text through --------

test("positive control: with the REAL scrubber the shim execs gh with redacted text", (t) => {
  const { res, capture } = runShim(t, GH_SHIM, fs.readFileSync(REAL_SCRUB, "utf8"), [
    "pr", "comment", "12", `--body=token ${SECRET} dated 2026-09-26`,
  ]);
  assert.equal(
    res.status, 0,
    `working scrubber must pass through (stderr: ${res.stderr})`,
  );
  assert.ok(fs.existsSync(capture), "the real gh was exec'd");
  const seen = fs.readFileSync(capture, "utf8");
  assert.ok(seen.includes("[redacted:token]"), "scrubbed text reached the real gh");
  assert.ok(!seen.includes("a1B2c3D4e5F6"), "the raw token did not");
  assert.ok(seen.includes("2026-09-26"), "dates still ride through untouched");
});

test("positive control: --notes-file reaches gh as a scrubbed temp file", (t) => {
  const { file } = stageNotesFile(t, `token ${SECRET} dated 2026-09-26\n`);
  const { res, capture, dir } = runShim(t, GH_SHIM, fs.readFileSync(REAL_SCRUB, "utf8"), [
    "release", "create", "v1.0.0", "--notes-file", file,
  ]);
  assert.equal(
    res.status, 0,
    `working scrubber must pass through (stderr: ${res.stderr})`,
  );
  assert.ok(fs.existsSync(capture), "the real gh was run");
  // gh is handed the scrubbed TEMP path, never the raw payload path...
  const seen = fs.readFileSync(capture, "utf8").trim().split("\n");
  const fileArgs = seen.filter((a) => a.endsWith("notes.md"));
  assert.equal(fileArgs.length, 0, `the raw notes file path must not reach gh — captured: ${seen.join(" | ")}`);
  const tempArg = seen.find((a) => a.startsWith(path.join(dir, "gh-scrubbed.")));
  assert.ok(tempArg, `gh's argv points at the scrubbed temp — captured: ${seen.join(" | ")}`);
  // ...its content (snapshotted by the recorder DURING the run) is redacted...
  const text = fs.readFileSync(`${capture}.content`, "utf8");
  assert.ok(text.includes("[redacted:token]"), "scrubbed notes content");
  assert.ok(!text.includes("a1B2c3D4e5F6"), "the raw token did not survive");
  assert.ok(text.includes("2026-09-26"), "dates still ride through untouched");
  // ...and no gh-scrubbed.* residue stays in TMPDIR after the run (issue #154).
  const leftovers = fs.readdirSync(dir).filter((f) => f.startsWith("gh-scrubbed."));
  assert.equal(leftovers.length, 0, `no scrub temp survives a successful run (got: ${leftovers.join(", ")})`);
});

// --- gh shim: success-path scrubbed-temp cleanup (issue #154) ----------------
// scrub_file/scrub_stdin mint "$TMPDIR/gh-scrubbed.XXXXXX" and hand the path
// to the real gh; the old tail `exec`-ed gh, REPLACING the shim shell, so
// nothing could unlink the temp after gh read it — every *-file call left a
// copy of the post-scrub body in TMPDIR for the life of the box (shared lanes
// accumulated a transcript of fleet posts). The shim now runs gh as a child
// (exit status forwarded unchanged) and unlinks every registered temp on the
// way out. These pins ride the runShim harness — TMPDIR IS the auto-cleaned
// harness dir, so readdir-ing it for gh-scrubbed.* after the run is exactly
// the residue check.

test("gh shim: NO gh-scrubbed.* residue after a successful separate-arg --body-file run (issue #154)", (t) => {
  const { file } = stageNotesFile(t, `body token ${SECRET} dated 2026-09-26\n`);
  const { res, capture, dir } = runShim(t, GH_SHIM, fs.readFileSync(REAL_SCRUB, "utf8"), [
    "pr", "create", "--body-file", file,
  ]);
  assert.equal(res.status, 0, `shim must pass through (stderr: ${res.stderr})`);
  assert.ok(fs.existsSync(capture), "the real gh was run");
  const text = fs.readFileSync(`${capture}.content`, "utf8");
  assert.ok(text.includes("[redacted:token]"), "gh read scrubbed content");
  assert.ok(!text.includes("a1B2c3D4e5F6"), "the raw token did not survive");
  const leftovers = fs.readdirSync(dir).filter((f) => f.startsWith("gh-scrubbed."));
  assert.equal(leftovers.length, 0, `the post-scrub temp leaked into TMPDIR (got: ${leftovers.join(", ")})`);
});

test("gh shim: multi-file flags hand over distinct temps and leave NO residue (issue #154)", (t) => {
  const title = stageNotesFile(t, `title token ${SECRET}\n`);
  const body = stageNotesFile(t, `body token ${SECRET} dated 2026-09-26\n`);
  const { res, capture, dir } = runShim(t, GH_SHIM, fs.readFileSync(REAL_SCRUB, "utf8"), [
    "pr", "create", `--title-file=${title.file}`, `--body-file=${body.file}`,
  ]);
  assert.equal(res.status, 0, `shim must pass through (stderr: ${res.stderr})`);
  const seen = fs.readFileSync(capture, "utf8").trim().split("\n");
  const tempArgs = seen.filter((x) => x.startsWith(path.join(dir, "gh-scrubbed.")));
  assert.equal(tempArgs.length, 2, `both file flags get their own scrubbed temp — captured: ${seen.join(" | ")}`);
  assert.notEqual(tempArgs[0], tempArgs[1], "the two temps are distinct files");
  assert.ok(
    fs.readFileSync(`${capture}.content`, "utf8").includes("[redacted:token]"),
    "both temps carried scrubbed content",
  );
  const leftovers = fs.readdirSync(dir).filter((f) => f.startsWith("gh-scrubbed."));
  assert.equal(leftovers.length, 0, `EVERY registered temp must be unlinked after the run (got: ${leftovers.join(", ")})`);
});

test("gh shim: the real gh's exit status propagates through the run-as-child tail — and its temp still unlinks", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scrub-shim-ghrc-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const scrub = path.join(dir, "scrub-under-test.mjs");
  fs.writeFileSync(scrub, fs.readFileSync(REAL_SCRUB, "utf8"));
  const capture = path.join(dir, "captured-argv.txt");
  const real = path.join(dir, "record-real");
  // the stand-in gh fails the way gh can (exit 7) AFTER being handed a temp
  fs.writeFileSync(real, "#!/usr/bin/env bash\nprintf '%s\\n' \"$@\" >> \"$SHIM_TEST_CAPTURE\"\nexit 7\n");
  fs.chmodSync(real, 0o755);
  const bodyFile = path.join(dir, "body.md");
  fs.writeFileSync(bodyFile, `token ${SECRET}\n`);
  const res = spawnSync("bash", [GH_SHIM, "pr", "create", "--body-file", bodyFile], {
    encoding: "utf8",
    env: {
      ...process.env,
      GH_SCRUB_REAL: real,
      SCRUB_SCRIPT: scrub,
      SHIM_TEST_CAPTURE: capture,
      TMPDIR: dir,
    },
  });
  assert.equal(
    res.status, 7,
    `gh's non-zero status must reach the shim's caller unchanged (got ${res.status}; stderr: ${res.stderr})`,
  );
  const leftovers = fs.readdirSync(dir).filter((f) => f.startsWith("gh-scrubbed."));
  assert.equal(leftovers.length, 0, "the scrubbed temp is unlinked even when gh itself fails");
});

// --- source pin: the fail-open shapes can never return ----------------------

test("source pin: neither shim carries a fail-open scrub fallback or stderr swallow", () => {
  for (const [shim, name] of [[GH_SHIM, "gh-scrub-shim"], [GIT_SHIM, "git-scrub-shim"]]) {
    const src = fs.readFileSync(shim, "utf8");
    const lines = src.split("\n").map((l, i) => ({ l, i: i + 1 }));
    for (const { l, i } of lines) {
      if (!l.includes('node "$SCRUB"')) continue;
      assert.ok(
        !/2>\s*\/dev\/null/.test(l),
        `${name}:${i}: the scrubber's stderr must not be swallowed (a silent scrubber outage is how fail-open ships)`,
      );
      assert.ok(
        !/\|\|/.test(l.replace(/^(.*?)node "\$SCRUB"/, "")),
        `${name}:${i}: no fallback after the scrubber invocation — failure must abort, not pass raw text (REVIEW.md fail-closed)`,
      );
    }
  }
});

// --- git shim: merge is a MESSAGE subcommand for -m (follow-up to #198) -----
// The #196 gate left MSG_CMD at commit|tag|notes — but the pre-gate shim
// scrubbed `git merge -m <msg>` unconditionally, so gating alone REGRESSED
// it: `merge -m "secret msg"` reached real git raw (the fail-open direction
// on a real message form). `merge` joins the set; pinned both directions.

test("git shim: `merge -m <msg>` is still scrubbed (join-the-set pin, issue #196)", (t) => {
  const { res, capture } = runShim(t, GIT_SHIM, fs.readFileSync(REAL_SCRUB, "utf8"), [
    "merge", "-m", `token ${SECRET} merge`,
  ]);
  assert.equal(res.status, 0, `shim must pass through (stderr: ${res.stderr})`);
  const captured = fs.readFileSync(capture, "utf8");
  assert.ok(captured.includes("[redacted:token]"), "merge -m msg must be scrubbed");
  assert.ok(!captured.includes(SECRET), "the raw token did not survive");
});

test("git shim: scrubber failure still aborts `merge -m` (fail-closed pin, issue #196)", (t) => {
  assertAborted(
    runShim(t, GIT_SHIM, FAIL_EXIT1, ["merge", "-m", `token ${SECRET}`]),
    "exit-1 scrubber on git merge -m",
  );
});

// --- git shim: `merge -F <file>` rides the MSG_CMD gate too (issue #200) -----
// `merge` arming MSG_CMD covers the -F/--file forms as well: git merge takes
// `-F, --file <file>` ("read message from file") just like commit. Left
// unpinned, a future "narrow the set" change would scrub merge -m but let
// merge -F <file> ride the raw file — the asymmetric half-open gate #169
// closed for commit/tag/notes. The negatives are pinned too: git grep/log -F
// (boolean --fixed-strings) must still ride byte-identical.

test("git shim: `merge -F <file>` reaches git as a scrubbed temp file (issue #200)", (t) => {
  const { file } = stageNotesFile(t, `msg token ${SECRET} dated 2026-09-26\n`);
  const { res, capture, dir } = runShim(t, GIT_SHIM, fs.readFileSync(REAL_SCRUB, "utf8"), [
    "merge", "-F", file,
  ]);
  assert.equal(res.status, 0, `shim must pass through (stderr: ${res.stderr})`);
  const seen = fs.readFileSync(capture, "utf8").trim().split("\n");
  assert.ok(
    !seen.includes(file),
    `the raw payload path must not reach git — captured: ${seen.join(" | ")}`,
  );
  const tempArg = seen.find((a) => a.startsWith(path.join(dir, "git-scrubbed.")));
  assert.ok(tempArg, `git's argv must point at a git-scrubbed.* temp — captured: ${seen.join(" | ")}`);
  const text = fs.readFileSync(`${capture}.content`, "utf8");
  assert.ok(text.includes("[redacted:token]"), "scrubbed merge message content");
  assert.ok(!text.includes("a1B2c3D4e5F6"), "the raw token did not survive");
  assert.ok(text.includes("2026-09-26"), "dates still ride through untouched");
  const leftovers = fs.readdirSync(dir).filter((f) => f.startsWith("git-scrubbed."));
  assert.equal(leftovers.length, 0, "no scrub temp residue after a successful merge -F");
});

test("git shim: scrubber failure aborts `merge -F <file>` (fail-closed pin, issue #200)", (t) => {
  const { file } = stageNotesFile(t, `msg token ${SECRET} in a file\n`);
  const { res, capture, dir } = runShim(t, GIT_SHIM, FAIL_EXIT1, ["merge", "-F", file]);
  assertAborted({ res, capture }, "exit-1 scrubber on git merge -F <file>");
  const leftovers = fs.readdirSync(dir).filter((f) => f.startsWith("git-scrubbed."));
  assert.equal(leftovers.length, 0, "no scrub temp file survives the abort");
});

test("git shim: `merge --file=<file>` and attached `-F<file>` are scrubbed too (issue #200)", (t) => {
  for (const argv of [["merge", "--file=PLACEHOLDER"], ["merge", "-FPLACEHOLDER"]]) {
    const staged = stageNotesFile(t, `msg token ${SECRET}\n`);
    const filled = argv.map((a) => (a.endsWith("PLACEHOLDER") ? a.replace("PLACEHOLDER", staged.file) : a));
    const { res, capture, dir } = runShim(
      t, GIT_SHIM, fs.readFileSync(REAL_SCRUB, "utf8"), filled,
    );
    assert.equal(res.status, 0, `shim must pass through (stderr: ${res.stderr})`);
    const seen = fs.readFileSync(capture, "utf8").trim().split("\n");
    assert.ok(
      !seen.includes(staged.file),
      `${filled.join(" ")}: raw payload path must not reach git — captured: ${seen.join(" | ")}`,
    );
    assert.ok(
      seen.some((a) => a.startsWith(path.join(dir, "git-scrubbed."))),
      `${filled.join(" ")}: git must be handed a scrubbed temp`,
    );
    assert.ok(
      !fs.readFileSync(`${capture}.content`, "utf8").includes("a1B2c3D4e5F6"),
      `${filled.join(" ")}: the raw token did not survive`,
    );
    const leftovers = fs.readdirSync(dir).filter((f) => f.startsWith("git-scrubbed."));
    assert.equal(leftovers.length, 0, `${filled.join(" ")}: no scrub temp residue`);
  }
});

test("git shim: `git grep -F` / `git log -F` still ride byte-identical with merge in the set (issue #200)", (t) => {
  for (const argv of [
    ["grep", "-F", "needle"],
    ["log", "-F", "--grep=needle"],
    ["cherry-pick", "-m", "1", "abc123"],
  ]) {
    const { res, capture, dir } = runShim(t, GIT_SHIM, fs.readFileSync(REAL_SCRUB, "utf8"), argv);
    assert.equal(res.status, 0, `shim must pass through (stderr: ${res.stderr})`);
    const seen = fs.readFileSync(capture, "utf8").trim().split("\n");
    assert.deepEqual(seen, argv, `${argv.join(" ")}: argv must be untouched`);
    const scrubbed = fs.readdirSync(dir).filter((f) => f.startsWith("git-scrubbed."));
    assert.equal(scrubbed.length, 0, `${argv.join(" ")}: no scrub temp may be created`);
  }
});

// issue #214: the message-flag scan must stop at the first `--`. After the
// end-of-options separator git guarantees every element is a PATHSPEC, never
// a flag — a file literally named `-F` (legal on disk) after `--` used to be
// consumed as a message flag: the `-F` pathspec vanished and the NEXT
// pathspec was scrubbed-and-replaced by a temp path that no longer exists
// once the trap unlinks it.

test("git shim: `commit -- -F msgfile` rides byte-identical — pathspecs after `--` are never flags (issue #214)", (t) => {
  // the on-disk world the receipt staged: files literally named `-F` and
  // `msgfile`, both pathspecs, neither a message flag
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scrub-shim-214-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, "-F"), "pathspec\n");
  fs.writeFileSync(path.join(dir, "msgfile"), "pathspec\n");
  const argv = ["commit", "--", "-F", "msgfile", "other"];
  const { res, capture, dir: harness } = runShim(
    t, GIT_SHIM, fs.readFileSync(REAL_SCRUB, "utf8"), argv, { cwd: dir },
  );
  assert.equal(res.status, 0, `shim must pass through (stderr: ${res.stderr})`);
  const seen = fs.readFileSync(capture, "utf8").trim().split("\n");
  assert.deepEqual(seen, argv, `everything after \`--\` must reach git byte-identical — captured: ${seen.join(" | ")}`);
  const scrubbed = fs.readdirSync(harness).filter((f) => f.startsWith("git-scrubbed."));
  assert.equal(scrubbed.length, 0, `no pathspec may be scrubbed into a temp (got: ${scrubbed.join(", ")})`);
});

test("git shim: `commit -F msgfile -- other` still scrubs — a flag BEFORE `--` keeps the guard (issue #214)", (t) => {
  const { file } = stageNotesFile(t, `msg token ${SECRET} dated 2026-09-28\n`);
  const { res, capture, dir } = runShim(t, GIT_SHIM, fs.readFileSync(REAL_SCRUB, "utf8"), [
    "commit", "-F", file, "--", "other",
  ]);
  assert.equal(res.status, 0, `shim must pass through (stderr: ${res.stderr})`);
  const seen = fs.readFileSync(capture, "utf8").trim().split("\n");
  const tempArg = seen.find((a) => a.startsWith(path.join(dir, "git-scrubbed.")));
  assert.ok(tempArg, `the message file before \`--\` must still be scrubbed — captured: ${seen.join(" | ")}`);
  assert.ok(seen.includes("--") && seen.includes("other"), "the `--` and trailing pathspec ride verbatim");
  const text = fs.readFileSync(`${capture}.content`, "utf8");
  assert.ok(text.includes("[redacted:token]"), "the message file was scrubbed");
  assert.ok(!text.includes("a1B2c3D4e5F6"), "the raw token did not reach git");
  const leftovers = fs.readdirSync(dir).filter((f) => f.startsWith("git-scrubbed."));
  assert.equal(leftovers.length, 0, `no scrub temp residue (got: ${leftovers.join(", ")})`);
});

// --- git shim: hidden value-taking globals in SEPARATE form (issue #235) ----
// `--attr-source <treeish>` is a value-taking global (git 2.32+). Left out of
// `subcommand_of`'s value-consumer list, its VALUE fell into the boolean
// `-*` catch-all and was returned as git's subcommand, so a genuine
// `commit -F` after it never armed MSG_CMD and the message file rode raw
// (same bypass class as the #199 `--shallow-file` fix).

test("git shim: --attr-source <value> before `commit -F` does not hide the gate (issue #235)", (t) => {
  const { file } = stageNotesFile(t, `msg token ${SECRET} in a file\n`);
  const { res, capture, dir } = runShim(t, GIT_SHIM, fs.readFileSync(REAL_SCRUB, "utf8"), [
    "--attr-source", "HEAD", "commit", "-F", file,
  ]);
  assert.equal(res.status, 0, `shim must pass through (stderr: ${res.stderr})`);
  assert.ok(fs.existsSync(capture), "the real git was run");
  const seen = fs.readFileSync(capture, "utf8").trim().split("\n");
  assert.ok(
    seen.includes("HEAD"),
    `the --attr-source value must reach git verbatim — captured: ${seen.join(" | ")}`,
  );
  const tempArg = seen.find((a) => a.startsWith(path.join(dir, "git-scrubbed.")));
  assert.ok(tempArg, `the message file must still be scrubbed — captured: ${seen.join(" | ")}`);
  const scrubbed = fs.readdirSync(dir).filter((f) => f.startsWith("git-scrubbed."));
  assert.equal(scrubbed.length, 0, "no scrub temp survives the run");
});

test("git shim: attached --attr-source=<value> before `commit -F` does not hide the gate (issue #235)", (t) => {
  const { file } = stageNotesFile(t, `msg token ${SECRET} in a file\n`);
  const { res, capture, dir } = runShim(t, GIT_SHIM, fs.readFileSync(REAL_SCRUB, "utf8"), [
    "--attr-source=HEAD", "commit", "-F", file,
  ]);
  assert.equal(res.status, 0, `shim must pass through (stderr: ${res.stderr})`);
  const seen = fs.readFileSync(capture, "utf8").trim().split("\n");
  const tempArg = seen.find((a) => a.startsWith(path.join(dir, "git-scrubbed.")));
  assert.ok(tempArg, `the message file must still be scrubbed — captured: ${seen.join(" | ")}`);
  const scrubbed = fs.readdirSync(dir).filter((f) => f.startsWith("git-scrubbed."));
  assert.equal(scrubbed.length, 0, "no scrub temp survives the run");
});

// --- env-contract degradation (issue #251) ----------------------------------
// The shims used to hard-exit 1 on a missing GH_SCRUB_REAL/GIT_SCRUB_REAL
// (`${:?}`). The shim dir can leak onto a LATER workflow step's PATH (the
// sqeakd main runs 36580443907 / 36584054876: the fallback reply step died
// "gh shim: GH_SCRUB_REAL not set", PR_STATE=LOOKUP_FAILED never posted).
// The contract now degrades loudly to the real binary found on PATH outside
// the shim dirs. A scrub FAILURE with the contract PRESENT stays fatal —
// that is the fail-closed rule above and it is untouched by this section.

/** Run one shim with the env contract ABSENT and the real binary staged on
 * PATH at $dir/bin (never a dsh-shim.* dir). */
function runShimNoContract(t, shim, argv) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scrub-shim-contract-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const capture = path.join(dir, "captured-argv.txt");
  const bin = path.join(dir, "bin");
  fs.mkdirSync(bin);
  const real = path.join(bin, shim === GH_SHIM ? "gh" : "git");
  fs.writeFileSync(
    real,
    "#!/usr/bin/env bash\n# test stand-in for the real gh/git\n" +
      'printf \'%s\\n\' "$@" >> "$SHIM_TEST_CAPTURE"\nexit 0\n',
  );
  fs.chmodSync(real, 0o755);
  const envKey = shim === GH_SHIM ? "GH_SCRUB_REAL" : "GIT_SCRUB_REAL";
  const res = spawnSync("bash", [shim, ...argv], {
    encoding: "utf8",
    env: { ...process.env, [envKey]: "", SCRUB_SCRIPT: "", SHIM_TEST_CAPTURE: capture, PATH: `${bin}:${process.env.PATH}` },
  });
  return { res, capture };
}

test("gh shim: env contract absent (GH_SCRUB_REAL unset) degrades to real gh on PATH, exit 0 (issue #251)", (t) => {
  const { res, capture } = runShimNoContract(t, GH_SHIM, ["pr", "comment", "12", "--body", "fallback reply text"]);
  assert.equal(res.status, 0, `fallback reply step must run green with the shim present and GH_SCRUB_REAL unset (stderr: ${res.stderr})`);
  assert.ok(fs.existsSync(capture), "the real gh was exec'd");
  const seen = fs.readFileSync(capture, "utf8").trim().split("\n");
  assert.deepEqual(seen, ["pr", "comment", "12", "--body", "fallback reply text"], "argv rides through raw on the degrade path");
  assert.match(res.stderr, /WARNING.*env contract absent.*issue #251/s, "the degradation is loud, not silent");
});

test("gh shim: GH_SCRUB_REAL set but SCRUB_SCRIPT unset also degrades loudly (issue #251)", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scrub-shim-contract-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const capture = path.join(dir, "captured-argv.txt");
  const bin = path.join(dir, "bin");
  fs.mkdirSync(bin);
  const real = path.join(bin, "gh");
  fs.writeFileSync(real, `#!/usr/bin/env bash\nprintf '%s\\n' "$@" >> "${capture}"\nexit 0\n`);
  fs.chmodSync(real, 0o755);
  const res = spawnSync("bash", [GH_SHIM, "pr", "view", "1"], {
    encoding: "utf8",
    env: { ...process.env, GH_SCRUB_REAL: real, SCRUB_SCRIPT: "", SHIM_TEST_CAPTURE: capture, PATH: `${bin}:${process.env.PATH}` },
  });
  assert.equal(res.status, 0, `partial contract must degrade, not exit 1 (stderr: ${res.stderr})`);
  assert.match(res.stderr, /WARNING.*env contract absent/s, "the degradation is loud");
});

test("gh shim: contract absent AND no real gh outside the shim dirs fails loud, non-zero (issue #251)", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scrub-shim-contract-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  // Hermetic PATH of prepared dirs only (no system dir, ambient not
  // re-included — the tests-lint PATH rule): an empty bin dir constructs a
  // cell with genuinely no gh anywhere on PATH, so the degrade has nothing
  // to resolve and must fail loud.
  const emptyBin = path.join(dir, "empty-bin");
  fs.mkdirSync(emptyBin);
  const res = spawnSync("/bin/bash", [GH_SHIM, "pr", "view", "1"], {
    encoding: "utf8",
    env: { ...process.env, GH_SCRUB_REAL: "", SCRUB_SCRIPT: "", PATH: emptyBin },
  });
  assert.notEqual(res.status, 0, "nothing to degrade to — must not limp on");
  assert.match(res.stderr, /cannot degrade/, "the failure names the contract");
});

test("git shim: env contract absent (GIT_SCRUB_REAL unset) degrades to real git on PATH, exit 0 (issue #251)", (t) => {
  const { res, capture } = runShimNoContract(t, GIT_SHIM, ["commit", "-m", "msg"]);
  assert.equal(res.status, 0, `later steps must run green with the shim present and GIT_SCRUB_REAL unset (stderr: ${res.stderr})`);
  assert.ok(fs.existsSync(capture), "the real git was exec'd");
  assert.match(res.stderr, /WARNING.*env contract absent.*issue #251/s, "the degradation is loud");
});

test("run-dsh-agent.sh: persists the shim env contract to GITHUB_ENV (issue #251 pin)", () => {
  const driver = fs.readFileSync(path.join(ROOT, "scripts", "run-dsh-agent.sh"), "utf8");
  for (const name of ["GH_SCRUB_REAL", "GIT_SCRUB_REAL", "SCRUB_SCRIPT"]) {
    assert.match(
      driver,
      new RegExp(`printf '${name}=%s\\\\n' .*>> "\\$GITHUB_ENV"`),
      `the driver must carry ${name} onto GITHUB_ENV so later steps inheriting the shim dir stay fully scrubbed (issue #251)`,
    );
  }
});
