// gitignore-clean.test.mjs — pin that the installer-path artifacts stay out
// of git (issue #170).
//
// install-plugin-smoke-deps.mjs (PR #165, the documented local path for the
// plugin smokes) installs the @deepseek-ai/* closure into node_modules/ AT
// THE REPO ROOT (--no-save --no-package-lock, untracked by design). With no
// .gitignore that tree sat one `git add -A` away from a committed vendored
// dependency closure. PR #171 added the root .gitignore; this file pins it
// so the ignore cannot silently regress.
//
// Environment contract (PR #174 review, blocking finding 1): the gates run
// this suite AFTER "Install plugin smoke-test deps", so node_modules/ is
// EXPECTED to exist and carry the real @deepseek-ai/* closure. These tests
// therefore never precondition on its absence, and cleanup removes ONLY the
// fixture they laid — never the shared tree the installer produced (a test
// that deletes the CI-installed deps breaks every suite that runs after it).
//
// All git usage is read-only plumbing (no add/commit/reset).

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const GITIGNORE = path.join(ROOT, ".gitignore");
const NODE_MODULES = path.join(ROOT, "node_modules");
// A package name the real closure will never contain, so the fixture can be
// removed in isolation.
const FIXTURE_PKG = "@deepseek-ai/dsh-gitignore-probe-fixture";

const git = (...args) =>
  spawnSync("git", ["-C", ROOT, ...args], { encoding: "utf8" });

test("a root .gitignore exists and ignores node_modules/", () => {
  assert.ok(existsSync(GITIGNORE), ".gitignore must exist at the repo root");
  const rules = readFileSync(GITIGNORE, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
  assert.ok(
    rules.some((rule) => rule === "node_modules/" || rule === "node_modules" || rule === "/node_modules/"),
    ".gitignore must carry a node_modules/ rule; got: " + JSON.stringify(rules),
  );
});

test("git check-ignore matches via the ROOT .gitignore", () => {
  const probe = git("check-ignore", "-v", `node_modules/${FIXTURE_PKG}/package.json`);
  assert.equal(probe.status, 0, "check-ignore must match (exit 0): " + probe.stderr);
  // A global/core.excludesFile rule would satisfy the exit code alone; pin
  // that the match comes from the repo's own root file.
  assert.match(
    probe.stdout,
    /\.gitignore:\d+:node_modules/,
    "match must come from the root .gitignore; got: " + JSON.stringify(probe.stdout),
  );
});

test("git status stays clean under the installer's node_modules/", () => {
  // The real checkout may already hold the full installer closure (gates
  // install it one step before the suite). Lay only a probe fixture and
  // assert the whole node_modules/ path stays invisible.
  const fixture = path.join(NODE_MODULES, FIXTURE_PKG);
  mkdirSync(fixture, { recursive: true });
  try {
    // The installer's artifact shape: vendored package dirs plus the
    // @local plugin links it relinks after every npm pass.
    writeFileSync(path.join(fixture, "package.json"), `{"name":"${FIXTURE_PKG}"}\n`);
    mkdirSync(path.join(NODE_MODULES, "@local"), { recursive: true });

    const status = git("status", "--porcelain", "--untracked-files=all", "--", "node_modules");
    assert.equal(status.status, 0, status.stderr);
    assert.equal(
      status.stdout,
      "",
      "node_modules/ must be invisible to git status; saw:\n" + status.stdout,
    );
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
  assert.ok(!existsSync(fixture), "cleanup must remove the fixture");
  // The shared tree the installer produced must survive the test.
  assert.ok(existsSync(NODE_MODULES), "shared node_modules/ must not be deleted by the test");
});
