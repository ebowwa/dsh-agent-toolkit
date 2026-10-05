// tests/smoke-deps-canary.test.mjs — pins the fresh-runner canary
// (issue #506): a pristine-tree install + smoke grade so registry/spec
// drift reds CI instead of hiding behind the self-hosted cell's
// converged node_modules.
//
// Regression anchor: the cell's gates pass "Install plugin smoke-test
// deps" green via the installer's install-once fast path (an
// already-converged tree skips npm entirely), so gates never exercised
// npm on that tree. dsh-reflex shipped a peer spec the registry cannot
// satisfy ('>=0.1.0' vs prereleases-only >=0.1.x) and it stayed green —
// the spec only materializes into the seed union when the plugin GAINS
// a test dir (testedPlugins() seeds tested plugins only), exactly what
// PR #505's new smoke did: every fresh clone ETARGETed while the cell
// stayed green. These tests fail without the canary: delete the
// workflow (or neuter its pristine mint / real-install leg) and the
// pins below go red naming the missing fence.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const canaryPath = path.join(
  ROOT,
  ".github",
  "workflows",
  "smoke-deps-canary.yml",
);
const canary = (() => {
  try {
    return readFileSync(canaryPath, "utf8");
  } catch {
    return "";
  }
})();

const stepBlock = (name) => {
  const start = canary.indexOf(`- name: ${name}`);
  assert.ok(start > 0, `smoke-deps-canary.yml carries the "${name}" step`);
  const next = canary.indexOf("- name:", start + 1);
  return canary.slice(start, next > 0 ? next : canary.length);
};

test("the canary exists", () => {
  assert.ok(
    canary.length > 0,
    ".github/workflows/smoke-deps-canary.yml must exist (issue #506: " +
      "registry/spec drift must red CI, not hide behind the cell's " +
      "converged node_modules)",
  );
});

test("the pristine mint archives tracked files only — a copied node_modules can never reintroduce the fast path", () => {
  const step = stepBlock("Mint the pristine tree");
  assert.match(
    step,
    /git archive HEAD \| tar -x -C/,
    "the pristine tree must be minted via git archive (tracked files " +
      "only) — copying the workspace checkout could carry its converged " +
      "node_modules, the exact masking this canary exists to defeat",
  );
  assert.match(
    step,
    /mktemp -d/,
    "per-run staging via mktemp (the tmp-hygiene convention) — a fixed " +
      "path collides across concurrent runs",
  );
  assert.match(
    step,
    /node_modules/,
    "the mint must fail loudly if a pristine tree ever carries " +
      "node_modules (the structural fence)",
  );
});

test("the install leg is the REAL installer on the pristine tree — the fast path must be unreachable", () => {
  const mint = stepBlock("Mint the pristine tree");
  const install = stepBlock(
    "Install the smoke-dep closure into it (the real npm leg)",
  );
  assert.match(
    install,
    /cd "\$PRISTINE"/,
    "the installer must run INSIDE the pristine tree, never on the " +
      "workspace checkout (whose node_modules would skip npm)",
  );
  assert.match(
    install,
    /node scripts\/install-plugin-smoke-deps\.mjs/,
    "the leg must call scripts/install-plugin-smoke-deps.mjs — the " +
      "exact installer gates runs (one closure derivation, one truth)",
  );
  assert.ok(
    !/--dry-run/.test(install),
    "no --dry-run: on a pristine tree a dry run is born-red by " +
      "construction (nothing is installed yet) and exercises NO npm leg " +
      "— the real install is the canary's signal",
  );
  // the workspace checkout itself is never the install target: exactly
  // one installer invocation in the whole workflow, inside $PRISTINE
  const invocations = canary.match(
    /node scripts\/install-plugin-smoke-deps\.mjs/g,
  );
  assert.ok(
    invocations?.length === 1,
    "exactly one installer invocation, on the pristine tree (an extra " +
      "one on the checkout would re-create the stale-tree fast path)",
  );
  assert.ok(
    canary.indexOf("PRISTINE=") < canary.indexOf(
      "node scripts/install-plugin-smoke-deps.mjs",
    ),
    "the pristine mint must precede the install leg (ordering is the " +
      "guarantee — install runs on: " +
      "an archive, not the checkout)",
  );
  assert.ok(
    !/^\s*cd .*GITHUB_WORKSPACE/m.test(canary),
    "the canary never installs on the workspace checkout",
  );
  assert.match(
    mint,
    /RUNNER_TEMP/,
    "staging rides the runner scratch dir with a TMPDIR fallback, not a " +
      "fixed host path",
  );
});

test("the smoke leg grades the fresh tree — the dep-sensitive suites run where the install just landed", () => {
  const smoke = stepBlock("Run the plugin smokes on the fresh tree");
  assert.match(
    smoke,
    /cd "\$PRISTINE"/,
    "the smokes must run inside the pristine tree (a fresh install is " +
      "only graded where it happened)",
  );
  assert.match(
    smoke,
    /node --test plugins\/\*\/test\/smoke\.mjs/,
    "the plugin smokes are the fresh-tree-sensitive set (the unit tests " +
      "read tracked files only — gates' unit leg already grades those " +
      "tree-independently)",
  );
});

test("the triggers carry both fences: pre-merge PR grading and the registry clock", () => {
  assert.match(
    canary,
    /pull_request:\n    paths:\n      - 'plugins\/\*\/package\.json'\n      - 'plugins\/\*\/test\/\*\*'\n      - 'scripts\/install-plugin-smoke-deps\.mjs'\n      - '\.github\/workflows\/smoke-deps-canary\.yml'/,
    "PRs touching a plugin spec, a plugin smoke (the #506 landing " +
      "shape — #505's new dsh-reflex smoke is what surfaced the bad " +
      "spec), the installer, or the canary itself must be graded fresh " +
      "BEFORE merge",
  );
  assert.match(
    canary,
    /schedule:\n    - cron: '[\d*]+ [\d*]+ [\d*]+ \* \*'/,
    "the daily clock catches REGISTRY-side drift (unpublishes, moved " +
      "dist-tags, new transitive peers) that no checkout edit could " +
      "trigger",
  );
  assert.match(
    canary,
    /workflow_dispatch:/,
    "dispatch re-runs the canary on demand (the tower fires it on PR " +
      "head branches, the gates pattern)",
  );
  assert.match(
    canary,
    /runs-on: \[self-hosted, dsh\]/,
    "the canary grades on the same cell class whose fast path it " +
      "defeats",
  );
  assert.match(
    canary,
    /timeout-minutes: \d+/,
    "a hung registry walk must time out loudly, not hold the cell",
  );
});
