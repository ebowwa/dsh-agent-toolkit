// tests-lint.test.mjs — tests for scripts/tests-lint.mjs.
//
// Regression anchor: gates run 32933615526 (PR #27, commit 8557fb5).
// The "no doppler CLI on the runner falls back" test constructed
// doppler's absence with `PATH: `${dir}:/usr/bin:/bin`` — sound on a
// dev machine (doppler sits in /opt/homebrew/bin, outside that PATH),
// unsound on the dsh lanes (doppler is installed in a system dir the
// restricted PATH traverses): command -v doppler succeeded there, the
// resolver took the live-fetch branch, and the assertion demanded the
// no-CLI branch's message. Gates failed ON THE LANE ONLY; nothing that
// runs on a dev machine could catch the pattern before it shipped.
// PR #27 fixed its own test with the DOPPLER_BIN seam (7dd6d21); this
// lint keeps the CLASS out: any test that hard-codes system dirs into
// a PATH it controls, without re-including the ambient PATH, is
// rejected wherever `node --test` runs — dev machines included. These
// tests fail without the fix: revert the linter and the corpus scan
// below goes blind; re-land the 8557fb5 pattern and it stays red.
//
// Rule 2 (driver-spawn backoff seam) regression anchor: the throttle-
// wave retry (PR #85) made the driver's failure path walk 180s+600s of
// backoff; a test whose stub fails cannot complete inside any spawn
// budget — spawnSync killed the driver, status came back null, and
// gates went red four times (34748403843, 34788769043, 34795917609,
// and 34803136058, where the failure-path contract test itself died).
// PR #88 added the DSH_RETRY_BACKOFF_S seam; this lint's rule 2 keeps
// the class out — every spawn of the driver pins the seam. The corpus
// scan below failed on exactly four shipped spawn sites before this
// rule's pins landed (run-dsh-agent.test.mjs soft-gh / runLauncher /
// doppler-isolation, driver-token-guard.test.mjs) — that red is the
// fails-without-the-fix proof.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { lintTests } from "../scripts/tests-lint.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TOOL = path.join(ROOT, "scripts", "tests-lint.mjs");
const TESTS_DIR = path.join(ROOT, "tests");

const runTool = (args) =>
  spawnSync(process.execPath, [TOOL, ...args], { encoding: "utf8" });

// Fixtures that the lint must FLAG are assembled at runtime from pieces
// whose source lines are themselves clean: the revert-guard test below
// scans THIS file too, so a plainly-written defective PATH line would
// trip the very guard that must stay green. The pieces join into the
// exact 8557fb5 geometry.
const DEFECT_LINE = [
  "    PATH: `${dir}",
  "/usr/bin",
  "/bin`,",
].join(":");

// The 8557fb5 defect, distilled: shim dir + system dirs, no ambient
// PATH — the lane's doppler rides back in through /usr/bin:/bin.
const DEFECT_SOURCE = [
  'import { test } from "node:test";',
  'const dir = mkdtempSync("/tmp/shims-");',
  "test(\"no doppler CLI on the runner falls back\", () => {",
  DEFECT_LINE,
  "  spawnSync(\"bash\", [SCRIPT], { env });",
  "});",
  "",
].join("\n");

test("the run-32933615526 defect is rejected: restricted PATH does not construct CLI absence", () => {
  const errors = lintTests(DEFECT_SOURCE, "defect.test.mjs");
  assert.equal(errors.length, 1);
  assert.equal(errors[0].line, 4);
  assert.match(errors[0].message, /32933615526/);
  assert.match(errors[0].message, /'\/usr\/bin', '\/bin'/);
  assert.match(errors[0].message, /BIN seam/);
});

test("the seam fix (PR #27 7dd6d21 pattern) lints clean", () => {
  const source = [
    'import { test } from "node:test";',
    "test(\"no doppler CLI on the runner falls back\", () => {",
    "  const { r } = runResolver(repo, {",
    '    DOPPLER_BIN: "/nonexistent/doppler-for-test",',
    "  });",
    "});",
    "",
  ].join("\n");
  assert.deepEqual(lintTests(source, "seam.test.mjs"), []);
});

test("shim-prepend presence construction stays green (no false positive)", () => {
  const source = [
    "const env = {",
    "  ...process.env,",
    "  PATH: `${bin}:${process.env.PATH}`,",
    "};",
    "",
  ].join("\n");
  assert.deepEqual(lintTests(source, "prepend.test.mjs"), []);
});

test("ambient passthrough stays green (PATH: process.env.PATH)", () => {
  const source = 'const dumpEnv = { ...process.env, PATH: process.env.PATH };\n';
  assert.deepEqual(lintTests(source, "passthrough.test.mjs"), []);
});

test("shell-side PATH= with $PATH re-inclusion stays green", () => {
  const source = [
    "const script = `#!/bin/sh",
    'export PATH="${SHIM_BIN}:$PATH"',
    "exec dsh \"$@\"",
    "`;",
    "",
  ].join("\n");
  assert.deepEqual(lintTests(source, "shell.test.mjs"), []);
});

test("shell-side absolute PATH without re-inclusion is rejected (the doppler lane dir class)", () => {
  // assembled like DEFECT_LINE: the flagged literal must not appear on a
  // PATH line in THIS file
  const badLine = [
    '  export PATH="',
    "/usr/local/bin",
    '"',
  ].join("");
  const source = ["const script = `#!/bin/sh", badLine, "exec doppler \"$@\"", "`;", ""].join("\n");
  const errors = lintTests(source, "shellbad.test.mjs");
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /'\/usr\/local\/bin'/);
});

test("comment lines are not flagged (explanations may cite the pattern)", () => {
  // `PATH` is spliced in at runtime: these source lines must stay clean
  // for the revert guard below while the fixture lines start with a
  // comment marker once joined.
  const comment = (lead, tail) => `${lead} PATH${tail}`;
  const source = [
    comment("//", ": /usr/bin:/bin would be a landmine here — see run 32933615526."),
    comment(" *", "=/usr/bin in a block comment is dead text too."),
    comment("#", "=/bin inside an embedded shell comment"),
    "",
  ].join("\n");
  assert.deepEqual(lintTests(source, "comments.test.mjs"), []);
});

// --- rule 2: the driver-spawn backoff seam (runs 34748403843 /
// 34788769043 / 34795917609 / 34803136058). The driver's name is
// assembled at runtime — a plainly-written fixture would make THIS file
// carry a real driver const and trip the very guard that must stay
// green (the revert-guard corpus scan scans this file too).

const DRIVER_NAME = ["run", "dsh", "agent.sh"].join("-");

const driverSpawnFixture = (envLines) =>
  [
    'import { test } from "node:test";',
    'import { spawnSync } from "node:child_process";',
    `const SCRIPT = path.join(ROOT, "scripts", "${DRIVER_NAME}");`,
    'test("a task", () => {',
    ...envLines,
    '  const proc = spawnSync("bash", [SCRIPT, "a task"], { encoding: "utf8", env, timeout: 60_000 });',
    "  assert.equal(proc.status, 0);",
    "});",
    "",
  ].join("\n");

test("an unpinned driver spawn is rejected: the retry backoff wedges the suite (run 34803136058)", () => {
  const source = driverSpawnFixture([
    "  const env = { ...process.env };",
  ]);
  const errors = lintTests(source, "wedge.test.mjs");
  assert.equal(errors.length, 1);
  assert.equal(errors[0].line, 6);
  assert.match(errors[0].message, /DSH_RETRY_BACKOFF_S/);
  assert.match(errors[0].message, /34803136058/);
});

test("a pinned driver spawn lints clean (the PR #88 seam, pinned everywhere)", () => {
  const source = driverSpawnFixture([
    '  const env = { ...process.env, DSH_RETRY_BACKOFF_S: "0" };',
  ]);
  assert.deepEqual(lintTests(source, "pinned.test.mjs"), []);
});

test("an inline env literal is inspected too: unpinned rejected, pinned clean", () => {
  const unpinned = [
    'import { test } from "node:test";',
    'import { spawnSync } from "node:child_process";',
    `const SCRIPT = path.join(ROOT, "scripts", "${DRIVER_NAME}");`,
    'test("a task", () => {',
    "  const proc = spawnSync(",
    "    \"bash\",",
    "    [SCRIPT, \"a task\"],",
    "    { encoding: \"utf8\", env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, timeout: 60_000 },",
    "  );",
    "});",
    "",
  ].join("\n");
  const errors = lintTests(unpinned, "inline.test.mjs");
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /DSH_RETRY_BACKOFF_S/);

  const pinned = unpinned.replace(
    "PATH: `${bin}:${process.env.PATH}` },",
    'PATH: `${bin}:${process.env.PATH}`, DSH_RETRY_BACKOFF_S: "0" },',
  );
  assert.deepEqual(lintTests(pinned, "inline-pinned.test.mjs"), []);
});

test("a commented-out pin is not a pin (dead text stays dead)", () => {
  const source = driverSpawnFixture([
    "  const env = {",
    "    ...process.env,",
    '    // DSH_RETRY_BACKOFF_S: "0",',
    "  };",
  ]);
  const errors = lintTests(source, "deadpin.test.mjs");
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /DSH_RETRY_BACKOFF_S/);
});

test("an unresolvable env identifier fails closed (flagged, not skipped)", () => {
  // The env object lives in another file (or is built dynamically): the
  // lint cannot see a pin, so it must FLAG the site rather than wave it
  // through — fail closed, like every scrubber here.
  const source = [
    'import { test } from "node:test";',
    'import { spawnSync } from "node:child_process";',
    `const SCRIPT = path.join(ROOT, "scripts", "${DRIVER_NAME}");`,
    'test("a task", () => {',
    "  const proc = spawnSync(\"bash\", [SCRIPT, \"a task\"], { encoding: \"utf8\", env: buildEnv(), timeout: 60_000 });",
    "  assert.equal(proc.status, 0);",
    "});",
    "",
  ].join("\n");
  const errors = lintTests(source, "unresolved.test.mjs");
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /cannot resolve in-file/);
  assert.match(errors[0].message, /DSH_RETRY_BACKOFF_S/);
});

test("shapes that cannot run the driver stay green (no false positives)", () => {
  const decl = `const SCRIPT = path.join(ROOT, "scripts", "${DRIVER_NAME}");`;
  // bash -n only parses; sed only reads; bash -c runs a string, not the
  // file; a plain task script is not the driver.
  const shapes = [
    'spawnSync("bash", ["-n", SCRIPT], { encoding: "utf8" });',
    'spawnSync("sed", ["-n", "/^f()/,/^}/p", SCRIPT], { encoding: "utf8" });',
    'spawnSync("bash", ["-c", `${SCRIPT} --help`], { env: { A: "1" } });',
    'spawnSync("node", [SCRIPT, "--check"], { env });',
  ];
  for (const line of shapes) {
    const source = [
      'import { test } from "node:test";',
      'import { spawnSync } from "node:child_process";',
      decl,
      'test("a task", () => {',
      `  ${line}`,
      "});",
      "",
    ].join("\n");
    assert.deepEqual(lintTests(source, `shape.test.mjs: ${line}`), []);
  }
});

test("a comment-only driver mention does not arm the rule", () => {
  const source = [
    'import { test } from "node:test";',
    'import { spawnSync } from "node:child_process";',
    `// const SCRIPT = path.join(ROOT, "scripts", "${DRIVER_NAME}");`,
    'test("a task", () => {',
    '  spawnSync("bash", [OTHER, "a task"], { env: { A: "1" } });',
    "});",
    "",
  ].join("\n");
  assert.deepEqual(lintTests(source, "commentonly.test.mjs"), []);
});

test("all shipped test files lint clean (revert guard)", () => {
  const files = readdirSync(TESTS_DIR).filter((f) => f.endsWith(".mjs"));
  assert.ok(files.length > 0, "corpus scan found no test files — wrong directory?");
  for (const f of files) {
    const errors = lintTests(readFileSync(path.join(TESTS_DIR, f), "utf8"), f);
    assert.deepEqual(errors, [], `${f} must lint clean`);
  }
});

test("CLI exits 1 on the broken fixture, 0 on the fixed one", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "tests-lint-cli-"));
  try {
    const broken = path.join(dir, "broken.test.mjs");
    const fixed = path.join(dir, "fixed.test.mjs");
    writeFileSync(broken, DEFECT_SOURCE);
    writeFileSync(fixed, 'const env = { PATH: `${dir}:${process.env.PATH}` };\n');
    const bad = runTool([broken]);
    assert.equal(bad.status, 1, `stderr: ${bad.stderr}`);
    assert.match(bad.stderr, /broken\.test\.mjs:4:/);
    const good = runTool([fixed]);
    assert.equal(good.status, 0, `stderr: ${good.stderr}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("unusable invocation is a loud usage error", () => {
  const r = runTool([]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /usage: tests-lint\.mjs/);
});
