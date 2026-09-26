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
    "#!/usr/bin/env bash\n# test stand-in for the real gh/git: record argv, touch nothing\n" +
      'printf \'%s\\n\' "$@" >> "$SHIM_TEST_CAPTURE"\nexit 0\n',
  );
  fs.chmodSync(real, 0o755);
  return { dir, scrub, capture, real };
}

/** Run one shim with a staged scrubber + recorder. Returns the harness `dir`
 * too, so tests can inspect it (payload files, scrub temp leftovers). */
function runShim(t, shim, scrubBody, argv) {
  const { dir, scrub, capture, real } = stage(t, scrubBody);
  const envKey = shim === GH_SHIM ? "GH_SCRUB_REAL" : "GIT_SCRUB_REAL";
  const res = spawnSync("bash", [shim, ...argv], {
    encoding: "utf8",
    env: {
      ...process.env,
      [envKey]: real,
      SCRUB_SCRIPT: scrub,
      SHIM_TEST_CAPTURE: capture,
      // pin the scrub temp file into the auto-cleaned harness dir
      TMPDIR: dir,
    },
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
// a stdin scrub + exec-time stdin redirect for `-`).

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
  assert.ok(fs.existsSync(capture), "the real gh was exec'd");
  const seen = fs.readFileSync(capture, "utf8").trim().split("\n");
  const fileArgs = seen.filter((a) => a.endsWith("notes.md"));
  assert.equal(fileArgs.length, 0, `the raw payload path must not reach gh — captured: ${seen.join(" | ")}`);
  const scrubbed = fs.readdirSync(dir).filter((f) => f.startsWith("gh-scrubbed."));
  assert.equal(scrubbed.length, 1, `exactly one scrubbed temp handed onward (got: ${scrubbed.join(", ")})`);
  const text = fs.readFileSync(path.join(dir, scrubbed[0]), "utf8");
  assert.ok(text.includes("[redacted:token]"), "scrubbed body content");
  assert.ok(!text.includes("a1B2c3D4e5F6"), "the raw token did not survive");
  assert.ok(text.includes("2026-09-26"), "dates still ride through untouched");
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

test("gh shim: --body-file - stdin payload is scrubbed before exec", (t) => {
  const { res, capture, dir } = runShimWithStdin(
    t, GH_SHIM, fs.readFileSync(REAL_SCRUB, "utf8"),
    ["pr", "create", "--body-file", "-"],
    `stdin token ${SECRET} dated 2026-09-26\n`,
  );
  assert.equal(res.status, 0, `shim must pass through (stderr: ${res.stderr})`);
  assert.ok(fs.existsSync(capture), "the real gh was exec'd");
  // gh still sees the `-` argv it asked for...
  const seen = fs.readFileSync(capture, "utf8").trim().split("\n");
  assert.ok(seen.includes("-"), "`-` reaches gh verbatim as its stdin marker");
  // ...but reads the scrubbed temp, not the raw payload: exactly one scrubbed
  // temp exists in TMPDIR and it is redacted with dates kept.
  const scrubbed = fs.readdirSync(dir).filter((f) => f.startsWith("gh-scrubbed."));
  assert.equal(scrubbed.length, 1, `exactly one scrubbed stdin temp (got: ${scrubbed.join(", ")})`);
  const text = fs.readFileSync(path.join(dir, scrubbed[0]), "utf8");
  assert.ok(text.includes("[redacted:token]"), "the stdin payload was scrubbed");
  assert.ok(!text.includes("a1B2c3D4e5F6"), "the raw token did not survive");
  assert.ok(text.includes("2026-09-26"), "dates still ride through untouched");
});

test("gh shim: equals-form --notes-file=- stdin payload is scrubbed before exec", (t) => {
  const { res, capture, dir } = runShimWithStdin(
    t, GH_SHIM, fs.readFileSync(REAL_SCRUB, "utf8"),
    ["release", "create", "v1.0.0", "--notes-file=-"],
    `notes token ${SECRET}\n`,
  );
  assert.equal(res.status, 0, `shim must pass through (stderr: ${res.stderr})`);
  const seen = fs.readFileSync(capture, "utf8").trim().split("\n");
  assert.ok(seen.includes("--notes-file"), "the equals-form flag rides through for gh's parser");
  assert.ok(seen.includes("-"), "the `-` stdin marker reaches gh verbatim");
  const scrubbed = fs.readdirSync(dir).filter((f) => f.startsWith("gh-scrubbed."));
  assert.equal(scrubbed.length, 1, "exactly one scrubbed stdin temp");
  const text = fs.readFileSync(path.join(dir, scrubbed[0]), "utf8");
  assert.ok(text.includes("[redacted:token]"), "the stdin payload was scrubbed");
  assert.ok(!text.includes("a1B2c3D4e5F6"), "the raw token did not survive");
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
  const res = spawnSync("bash", [shim, ...argv], {
    encoding: "utf8",
    input: stdin,
    env: {
      ...process.env,
      [envKey]: real,
      SCRUB_SCRIPT: scrub,
      SHIM_TEST_CAPTURE: capture,
      TMPDIR: dir,
    },
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
  assert.ok(fs.existsSync(capture), "the real gh was exec'd");
  // gh is handed the scrubbed TEMP path, never the raw payload path...
  const seen = fs.readFileSync(capture, "utf8").trim().split("\n");
  const fileArgs = seen.filter((a) => a.endsWith("notes.md"));
  assert.equal(fileArgs.length, 0, `the raw notes file path must not reach gh — captured: ${seen.join(" | ")}`);
  // ...and exactly one scrubbed temp file, whose CONTENT is redacted
  const scrubbed = fs.readdirSync(dir).filter((f) => f.startsWith("gh-scrubbed."));
  assert.equal(scrubbed.length, 1, `exactly one scrubbed temp handed onward (got: ${scrubbed.join(", ")})`);
  const text = fs.readFileSync(path.join(dir, scrubbed[0]), "utf8");
  assert.ok(text.includes("[redacted:token]"), "scrubbed notes content");
  assert.ok(!text.includes("a1B2c3D4e5F6"), "the raw token did not survive");
  assert.ok(text.includes("2026-09-26"), "dates still ride through untouched");
  assert.ok(seen.includes(path.join(dir, scrubbed[0])), "gh's argv points at the scrubbed temp");
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
