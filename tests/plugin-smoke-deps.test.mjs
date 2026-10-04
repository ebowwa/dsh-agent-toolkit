// plugin-smoke-deps.test.mjs — contract pins for
// scripts/install-plugin-smoke-deps.mjs (issue #161: the plugin
// smoke-test dep install must converge — install-once + hard verify —
// not oscillate through a per-round npm reconcile loop).
//
// These tests fail without the fix: the union merge loses determinism,
// the walk no longer reaches a fixpoint through a peer cycle, the
// install-once fast path disappears, or non-convergence stops being
// loud — each pin goes red.
//
// The CLI legs pre-flight the checkout's convergence (#280): a fresh
// clone is not the converged tree CI gates on, so the green leg
// loud-skips there instead of carrying a guaranteed box-state red; the
// red-on-bare leg stays strict on every tree state.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, spawnSync } from "node:child_process";

import {
  Union,
  seed,
  walkToFixpoint,
  verify,
  linkLocals,
  testedPlugins,
} from "../scripts/install-plugin-smoke-deps.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// ---- fixtures ------------------------------------------------------------

const plugin = (name, deps = {}, peers = {}) => ({
  dir: "plugins/x",
  pkg: { name, dependencies: deps, peerDependencies: peers },
});

const TESTED = [
  plugin("@local/a", {}, { "@deepseek-ai/lib1": "^1.0.0" }),
  plugin("@local/b", { "@deepseek-ai/lib2": "^2.0.0" }),
];

test("seed comes from tested plugins only and is deterministic", () => {
  const one = seed(TESTED);
  const two = seed([...TESTED].reverse());
  assert.deepEqual(one.specs(), two.specs(), "order-independent");
  assert.deepEqual(
    one.specs(),
    ["@deepseek-ai/lib1@^1.0.0", "@deepseek-ai/lib2@^2.0.0"].sort(),
    "deps + peerDependencies of the tested plugins, nothing else",
  );
});

test("the union merge dedupes by name; plugin ranges are authoritative", () => {
  const u = new Union();
  assert.equal(u.add("p", "^1.0.0", "walk"), true);
  assert.equal(u.add("p", "^9.0.0", "walk"), false, "dedupe by name");
  assert.equal(u.size, 1);
  assert.equal(u.add("p", "^2.0.0", "plugin"), true, "plugin spec wins over walk");
  assert.deepEqual(u.specs(), ["p@^2.0.0"]);
  // idempotent + name-monotone: re-deriving a union from specs it produced
  // cannot change it (the anti-oscillation invariant)
  const again = new Union();
  for (const spec of u.specs()) again.add(...splitSpec(spec), "walk");
  assert.equal(again.size, u.size, "re-adding its own output is a no-op");
  assert.deepEqual(again.specs(), u.specs());
});

const splitSpec = (spec) => {
  const i = spec.lastIndexOf("@");
  return [spec.slice(0, i), spec.slice(i + 1)];
};

test("converge reaches the fixpoint THROUGH a peer cycle", () => {
  // registry graph with a cycle: lib1 -> lib2 -> lib3 -> lib1
  const graph = {
    "@deepseek-ai/lib1": { "@deepseek-ai/lib2": "^2.0.0" },
    "@deepseek-ai/lib2": { "@deepseek-ai/lib3": "^3.0.0" },
    "@deepseek-ai/lib3": { "@deepseek-ai/lib1": "^1.0.0" },
  };
  const union = seed(TESTED);
  const rounds = walkToFixpoint(union, TESTED, (n) => graph[n] ?? {});
  assert.ok(rounds > 0, "the walk actually iterated");
  assert.deepEqual(
    union.specs(),
    [
      "@deepseek-ai/lib1@^1.0.0",
      "@deepseek-ai/lib2@^2.0.0",
      "@deepseek-ai/lib3@^3.0.0",
    ],
    "fixpoint through the cycle, no names dropped",
  );
  // re-deriving from the converged union is a no-op (monotone fixpoint)
  const again = seed(TESTED);
  walkToFixpoint(again, TESTED, (n) => {
    for (const spec of union.specs()) if (spec.startsWith(n + "@")) return graph[n] ?? {};
    return graph[n] ?? {};
  });
  assert.deepEqual(again.specs(), union.specs(), "re-derivation is idempotent");
});

test("a growing (non-converging) walk is LOUD, not silent", () => {
  const union = seed(TESTED);
  assert.throws(
    () =>
      walkToFixpoint(union, TESTED, (n) => ({ [n + "-next"]: "^1.0.0" })),
    /did not converge/,
    "cap hit names the failure instead of returning a partial union",
  );
});

test("verify is fail-closed: missing package, unresolved peer, pruned link", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "psd-"));
  try {
    fs.mkdirSync(path.join(tmp, "plugins", "a", "test"), { recursive: true });
    fs.writeFileSync(
      path.join(tmp, "plugins", "a", "package.json"),
      JSON.stringify({
        name: "@local/a",
        peerDependencies: { "@deepseek-ai/lib1": "^1.0.0" },
      }),
    );
    const plugins = testedPlugins(tmp);
    const union = seed(plugins);
    // bare tree: every problem class is named
    const bare = verify(tmp, plugins, union);
    assert.ok(bare.some((p) => /missing: @deepseek-ai\/lib1/.test(p)), bare.join("; "));
    assert.ok(bare.some((p) => /unresolved peer/.test(p)), bare.join("; "));
    assert.ok(bare.some((p) => /@local link pruned or absent/.test(p)), bare.join("; "));

    // converged tree: satisfied — package present, peer met, link intact
    fs.mkdirSync(path.join(tmp, "node_modules", "@deepseek-ai", "lib1"), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(tmp, "node_modules", "@deepseek-ai", "lib1", "package.json"),
      JSON.stringify({ name: "@deepseek-ai/lib1", peerDependencies: {} }),
    );
    linkLocals(tmp);
    assert.deepEqual(verify(tmp, plugins, union), [], "converged tree verifies clean");

    // npm's reconcile pruned the @local symlink: loud again
    fs.rmSync(path.join(tmp, "node_modules", "@local"), {
      recursive: true,
      force: true,
    });
    assert.ok(
      verify(tmp, plugins, union).some((p) => /@local link pruned/.test(p)),
      "a pruned @local link fails the verify, not the smoke suite",
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ---- #280: convergence pre-flight -----------------------------------------
// The green half below asserts the CHECKOUT is converged — the state CI's
// gates job creates by running `node scripts/install-plugin-smoke-deps.mjs`
// before the suite (gates.yml). A fresh clone (bare `gh repo clone`, no
// installer run) is not that state and no PR can make it one: pre-flight
// the exact CLI once here and skip LOUD — naming the gaps — when it
// reports `tree NOT satisfied`, so the gate stays green-or-loud-skip on a
// bare clone instead of carrying a guaranteed red every agent burns a
// classification round on (#280). Fail-closed: any OTHER non-zero exit
// (a genuine script defect) does NOT skip — the leg runs and reds with
// the real stderr.
const DRY_RUN_PREFLIGHT = spawnSync(
  "node",
  [path.join(ROOT, "scripts", "install-plugin-smoke-deps.mjs"), "--dry-run"],
  { encoding: "utf8", cwd: ROOT },
);
const NOT_CONVERGED_GAPS = String(DRY_RUN_PREFLIGHT.stderr)
  .split("\n")
  .filter((l) => /^\s+(missing|unresolved peer|@local link)/.test(l));
const TREE_NOT_CONVERGED =
  DRY_RUN_PREFLIGHT.status !== 0 &&
  /tree NOT satisfied/.test(String(DRY_RUN_PREFLIGHT.stderr)) &&
  `repo tree not converged (${NOT_CONVERGED_GAPS.length} named gap(s), first: ${NOT_CONVERGED_GAPS[0]?.trim()}) — run scripts/install-plugin-smoke-deps.mjs to converge this checkout (#280)`;

test("CLI --dry-run: green on the repo's converged tree (skip when the checkout is not converged)", { skip: TREE_NOT_CONVERGED }, () => {
  assert.ok(
    DRY_RUN_PREFLIGHT.status === 0,
    `--dry-run pre-flight exited ${DRY_RUN_PREFLIGHT.status}: ${DRY_RUN_PREFLIGHT.stderr}`,
  );
  assert.match(DRY_RUN_PREFLIGHT.stdout, /--dry-run: verified/, "converged checkout pre-flights green");
  assert.match(DRY_RUN_PREFLIGHT.stdout, /specs/, "the resolved union is printed");
});

test("CLI --dry-run: red on bare — loud, naming the unmaterializable peer", () => {
  const script = path.join(ROOT, "scripts", "install-plugin-smoke-deps.mjs");
  // bare fixture with an unmaterializable peer: red naming the gap,
  // without npm ever installing anything. Strict on EVERY tree state —
  // the fixture is its own cwd, so #280's split keeps this half exercising
  // the red path even on a non-converged checkout.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "psd-cli-"));
  try {
    fs.mkdirSync(path.join(tmp, "plugins", "a", "test"), { recursive: true });
    fs.writeFileSync(
      path.join(tmp, "plugins", "a", "package.json"),
      JSON.stringify({
        name: "@local/a",
        peerDependencies: { "@deepseek-ai/definitely-not-a-real-pkg-xyz": "^1.0.0" },
      }),
    );
    let failed = false;
    try {
      execFileSync("node", [script, "--dry-run"], { cwd: tmp, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      failed = true;
      assert.match(String(e.stderr), /tree NOT satisfied/, "bare tree is LOUD red");
      assert.match(String(e.stderr), /@deepseek-ai\/definitely-not-a-real-pkg-xyz/, "the missing package is named");
    }
    assert.ok(failed, "--dry-run on a bare tree must exit non-zero");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
