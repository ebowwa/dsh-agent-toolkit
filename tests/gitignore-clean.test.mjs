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
// The check runs against the real repo index (read-only git plumbing: no
// add/commit/reset), constructs the artifact shape the installer produces,
// and asserts git reports nothing under it. Cleanup is in a finally block —
// a failing assertion must not leave a node_modules/ behind in the
// checkout.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const GITIGNORE = path.join(ROOT, ".gitignore");
const NODE_MODULES = path.join(ROOT, "node_modules");

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

test("git check-ignore matches a root-level node_modules path", () => {
  const probe = git("check-ignore", "-v", "node_modules/@deepseek-ai/fake/package.json");
  assert.equal(probe.status, 0, "check-ignore must match (exit 0): " + probe.stderr);
});

test("git status stays clean after the installer-path artifacts appear", () => {
  assert.ok(!existsSync(NODE_MODULES), "precondition: no node_modules/ in the checkout");
  const pkg = path.join(NODE_MODULES, "@deepseek-ai", "fake");
  mkdirSync(pkg, { recursive: true });
  try {
    // The installer's artifact shape: vendored package dirs plus the
    // @local plugin symlinks it relinks after every npm pass.
    writeFileSync(path.join(pkg, "package.json"), '{"name":"@deepseek-ai/fake"}\n');
    mkdirSync(path.join(NODE_MODULES, "@local"), { recursive: true });

    const status = git("status", "--porcelain", "--untracked-files=all", "--", "node_modules");
    assert.equal(
      status.stdout,
      "",
      "node_modules/ must be invisible to git status; saw:\n" + status.stdout,
    );
    assert.equal(status.status, 0, status.stderr);
  } finally {
    rmSync(NODE_MODULES, { recursive: true, force: true });
  }
  assert.ok(!existsSync(NODE_MODULES), "cleanup must remove the fixture");
});
