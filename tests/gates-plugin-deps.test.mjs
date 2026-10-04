// gates-plugin-deps.test.mjs — pins the gates.yml "Install plugin
// smoke-test deps" step to the install-once installer with a hard
// convergence check (issue #161).
//
// Regression anchor: the pre-#161 step ran a per-round `npm install` of
// the accumulated union; npm reconciles node_modules to the per-invocation
// spec list, so each round pruned what the previous round had installed —
// the loop oscillated on bare checkouts (issue #161 receipt) and hit its
// round cap in a PRUNED state, flaky-red in the smokes. These tests fail
// without the fix: revert gates.yml to the per-round loop (or stop calling
// the installer) and this suite goes red.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const gates = readFileSync(
  path.join(ROOT, ".github", "workflows", "gates.yml"),
  "utf8",
);

const step = (() => {
  const start = gates.indexOf("Install plugin smoke-test deps");
  assert.ok(start > 0, "gates.yml carries the plugin smoke-test deps step");
  const next = gates.indexOf("- name:", start + 1);
  return gates.slice(start, next > 0 ? next : gates.length);
})();

test("the step delegates to the install-once installer", () => {
  assert.match(
    step,
    /run: node scripts\/install-plugin-smoke-deps\.mjs/,
    "the step must call scripts/install-plugin-smoke-deps.mjs",
  );
});

test("the per-round npm reconciliation loop must not come back", () => {
  assert.ok(
    !/while :;/.test(step),
    "no per-round shell loop — npm re-resolves node_modules to each " +
      "invocation's spec list, so per-round installs oscillate (issue #161)",
  );
  assert.ok(
    !/npm install/.test(step),
    "npm invocations live only in the installer, never in the step",
  );
});

test("the installer is the only place npm runs for the smoke deps", () => {
  const installer = readFileSync(
    path.join(ROOT, "scripts", "install-plugin-smoke-deps.mjs"),
    "utf8",
  );
  assert.match(installer, /"install"/, "installer runs npm install exactly once");
  assert.match(
    installer,
    /--no-save/,
    "--no-save keeps the checkout clean (scripts-only repo, no lockfile)",
  );
  assert.match(
    installer,
    /--no-package-lock/,
    "--no-package-lock keeps the checkout clean",
  );
  assert.match(
    installer,
    /dependency closure did not converge after install/,
    "post-install verification is fail-closed — non-convergence is LOUD",
  );
  assert.match(
    installer,
    /npm skipped \(install-once\)/,
    "an already-converged tree skips npm entirely (install-once fast path)",
  );
});

test("the documented local recipes name the plugin smoke suites (issue #301)", () => {
  // CLAUDE.md and README.md both teach a local glob-form run command. The
  // tests/ glob alone silently skips the five plugins/*/test/smoke.mjs
  // suites that CI's bare `node --test` discovery also runs: an agent who
  // edits a plugin smoke, verifies with the glob-only form, and pushes
  // sees green while the edited suite never ran (issue #301 receipt:
  // glob form 441 vs bare 446 on pristine main). Pin the invocation
  // itself — ONE `node --test` span carrying both globs in order — so the
  // pin tolerates prose reflow and code-fence vs inline-span differences
  // but fails the moment either doc drops the plugins glob again.
  const recipe = /node --test tests\/\*\.test\.mjs plugins\/\*\/test\/smoke\.mjs/;
  for (const name of ["CLAUDE.md", "README.md"]) {
    const doc = readFileSync(path.join(ROOT, name), "utf8");
    assert.match(
      doc,
      recipe,
      `${name}: the local test recipe must name plugins/*/test/smoke.mjs in the same node --test invocation — the tests/ glob alone silently skips the five plugin smoke suites CI also runs (issue #301)`,
    );
  }
});
