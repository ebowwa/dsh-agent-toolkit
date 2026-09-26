// plugin-smoke-deps.test.mjs — contract pins for the plugin smoke-test dep
// installer (scripts/install-plugin-smoke-deps.mjs, issue #161).
//
// Regression anchor: gates.yml's old inline install loop re-resolved npm
// against a per-round spec list. npm reconciles node_modules to the list it
// is given, so each round read a tree its own previous round had rewritten;
// on bare checkouts the loop oscillated (issue #161 receipt: a 10/12-spec
// cycle) and fell through the round cap WITHOUT failing — `node --test`
// red with ERR_MODULE_NOT_FOUND before any test substantively ran. It only
// looked green on the warm self-hosted cell. These tests fail if the
// oscillating loop comes back, the fixpoint merge loses determinism, or the
// tree verification (the loud convergence check) stops guarding the gate.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  pluginSpecs,
  localPluginNames,
  scanPeerNeeds,
  mergeSpecs,
  sameSpecSet,
  verifyTree,
  symlinkLocal,
  converge,
} from "../scripts/install-plugin-smoke-deps.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TOOL = path.join(ROOT, "scripts", "install-plugin-smoke-deps.mjs");
const GATES = readFileSync(path.join(ROOT, ".github", "workflows", "gates.yml"), "utf8");

// --- fixtures ---------------------------------------------------------------

const withFixture = (fn) => {
  const dir = mkdtempSync(path.join(tmpdir(), "plugin-smoke-deps-"));
  const plugins = path.join(dir, "plugins");
  const nm = path.join(dir, "node_modules");
  try {
    return fn({ dir, plugins, nm });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

/** plugins/<short>/ with a package.json (+ test/ when tested). */
const addPlugin = (plugins, short, name, { deps = {}, peers = {}, tested = false } = {}) => {
  const d = path.join(plugins, short);
  mkdirSync(d, { recursive: true });
  if (tested) mkdirSync(path.join(d, "test"), { recursive: true });
  writeFileSync(
    path.join(d, "package.json"),
    JSON.stringify({ name, version: "0.1.0", dependencies: deps, peerDependencies: peers })
  );
  return d;
};

/** Materialize an installed package stub (the fake registry's product). */
const installPkg = (nm, name, peers = {}) => {
  const d = path.join(nm, ...name.split("/"));
  mkdirSync(d, { recursive: true });
  writeFileSync(
    path.join(d, "package.json"),
    JSON.stringify({ name, version: "1.0.0", peerDependencies: peers })
  );
};

// --- the seed union: registry metadata, not tree state ----------------------

test("seed specs come from TESTED plugins' deps+peers (registry metadata, stable across rounds)", () => {
  withFixture(({ plugins }) => {
    addPlugin(plugins, "p-a", "@local/p-a", {
      tested: true,
      deps: { "@deepseek-ai/core": "^1.0.0" },
      peers: { "@deepseek-ai/util": "^1.0.0" },
    });
    // not tested -> its peers must NOT seed the install (the old step's filter)
    addPlugin(plugins, "p-b", "@local/p-b", { peers: { "never-installed": "^9.0.0" } });
    const specs = pluginSpecs(plugins);
    assert.deepEqual(specs.map((s) => `${s.name}@${s.spec}`), [
      "@deepseek-ai/core@^1.0.0",
      "@deepseek-ai/util@^1.0.0",
    ]);
    // determinism: the resolved list is a pure function of the plugins dir
    assert.deepEqual(pluginSpecs(plugins), specs, "re-deriving the seed must be stable");
  });
});

// --- the merge: deterministic, monotone, oscillation-proof ------------------

test("merge dedupes by name; plugin-declared ranges beat walk-derived ones (no range flip-flop)", () => {
  const seed = [{ name: "x", spec: "^1.0.0", requiredBy: "@local/p-a" }];
  const walkA = [{ name: "x", spec: ">=0.1.0", requiredBy: "@deepseek-ai/util" }];
  const walkB = [{ name: "x", spec: "^2.0.0", requiredBy: "@deepseek-ai/other" }];
  const m1 = mergeSpecs(seed, walkA);
  assert.equal(m1.length, 1);
  assert.equal(m1[0].spec, "^1.0.0", "the plugin seed is authoritative on collision");
  // deriving the walk from a tree the union produced must not flip the range
  const m2 = mergeSpecs(seed, walkA, walkB);
  assert.equal(m2[0].spec, "^1.0.0");
  assert.ok(sameSpecSet(m1, mergeSpecs(seed, walkB, walkA)), "walk order must not matter");
});

test("merge is idempotent and name-monotone (the union can only grow — the anti-oscillation invariant)", () => {
  const seed = [{ name: "a", spec: "^1.0.0", requiredBy: "p" }];
  const needs = [
    { name: "b", spec: "^1.0.0", requiredBy: "@deepseek-ai/a" },
    { name: "b", spec: "^1.0.0", requiredBy: "@deepseek-ai/c" },
  ];
  const u1 = mergeSpecs(seed, needs);
  assert.deepEqual(u1.map((s) => s.name).sort(), ["a", "b"]);
  assert.ok(sameSpecSet(u1, mergeSpecs(u1, needs)), "re-merging a satisfied walk is a no-op");
});

// --- the walk: missing peers of the installed family ------------------------

test("scan reports unmet peers of installed @deepseek-ai/* and @local/*, and only unmet ones", () => {
  withFixture(({ plugins, nm }) => {
    addPlugin(plugins, "p-a", "@local/p-a", { peers: { "@deepseek-ai/core": "^1.0.0" } });
    installPkg(nm, "@deepseek-ai/core", { "@deepseek-ai/util": "^1.0.0" }); // util missing
    installPkg(nm, "@deepseek-ai/ok"); // no peers
    mkdirSync(path.join(nm, "@local"), { recursive: true });
    symlinkLocal(plugins, nm); // p-a linked -> its peer core present -> not reported
    const needs = scanPeerNeeds(plugins, nm);
    assert.deepEqual(needs.map((s) => `${s.name}@${s.spec}`), ["@deepseek-ai/util@^1.0.0"]);
    assert.equal(needs[0].requiredBy, "@deepseek-ai/core");
  });
});

test("verifyTree fails on a missing union package, an unmet peer, or a pruned @local link", () => {
  withFixture(({ plugins, nm }) => {
    addPlugin(plugins, "p-a", "@local/p-a", { tested: true, peers: { "@deepseek-ai/core": "^1.0.0" } });
    const union = [
      { name: "@deepseek-ai/core", spec: "^1.0.0", requiredBy: "@local/p-a" },
      { name: "@deepseek-ai/util", spec: "^1.0.0", requiredBy: "@deepseek-ai/core" },
    ];
    // bare tree: everything missing, including the @local link
    const bare = verifyTree(plugins, nm, union);
    assert.deepEqual(
      bare.map((m) => m.name).sort(),
      ["@deepseek-ai/core", "@deepseek-ai/util", "@local/p-a"]
    );
    // half-installed (npm pruned the link back — the ui -> editor class)
    installPkg(nm, "@deepseek-ai/core", { "@deepseek-ai/util": "^1.0.0" });
    installPkg(nm, "@deepseek-ai/util");
    const partial = verifyTree(plugins, nm, union);
    assert.deepEqual(partial.map((m) => m.name), ["@local/p-a"]);
    symlinkLocal(plugins, nm);
    assert.deepEqual(verifyTree(plugins, nm, union), [], "a satisfied tree must verify clean");
  });
});

// --- convergence: the fixpoint + the loud failure ---------------------------

/** Fake npm: materializes the union from a name->peers registry table. */
const fakeRegistry = (nm, table) => (union) => {
  for (const s of union)
    if (table[s.name]) installPkg(nm, s.name, table[s.name]);
};

test("converge walks the transitive peer closure to a fixpoint — even through a peer cycle", () => {
  withFixture(({ plugins, nm }) => {
    addPlugin(plugins, "p-a", "@local/p-a", { tested: true, peers: { "@deepseek-ai/core": "^1.0.0" } });
    symlinkLocal(plugins, nm);
    const table = {
      "@deepseek-ai/core": { "@deepseek-ai/util": "^1.0.0" },
      "@deepseek-ai/util": {
        "@deepseek-ai/core": "^1.0.0", // cycle: the old loop's killer
        "left-pad-ish": "^2.0.0", // non-scoped peer (the node-addon-require-builtin class)
      },
      "left-pad-ish": {},
    };
    let installs = 0;
    const { union, rounds } = converge({
      pluginsDir: plugins,
      nodeModulesDir: nm,
      install: (u) => {
        installs++;
        return fakeRegistry(nm, table)(u);
      },
      log: () => {},
    });
    assert.deepEqual(
      union.map((s) => s.name).sort(),
      ["@deepseek-ai/core", "@deepseek-ai/util", "left-pad-ish"],
      "the full transitive closure, not a per-round guess"
    );
    assert.deepEqual(verifyTree(plugins, nm, union), [], "fixpoint tree verifies clean");
    // re-running on the converged tree is a no-op (the stability receipt):
    // the install-once fast path verifies the walked closure and skips npm
    // entirely — the seed-only reconcile would prune it and force a rebuild
    let refeeds = 0;
    const again = converge({
      pluginsDir: plugins,
      nodeModulesDir: nm,
      install: () => {
        refeeds++;
      },
      log: () => {},
    });
    assert.equal(again.rounds, 0, "second pass converges with zero extra rounds");
    assert.equal(refeeds, 0, "an already-converged tree must skip npm entirely");
    assert.deepEqual(verifyTree(plugins, nm, again.union), []);
    assert.ok(installs >= 2 && installs < 12, `bounded walks, not a churn loop (${installs})`);
  });
});

test("non-convergence is LOUD: an unmaterializable union fails before any test runs", () => {
  withFixture(({ plugins, nm }) => {
    addPlugin(plugins, "p-a", "@local/p-a", { tested: true, peers: { "@deepseek-ai/core": "^1.0.0" } });
    symlinkLocal(plugins, nm);
    assert.throws(
      () => converge({ pluginsDir: plugins, nodeModulesDir: nm, install: () => {}, log: () => {} }),
      (e) => /did not converge/.test(e.message) && /@deepseek-ai\/core/.test(e.message),
      "the gate must red with the missing names, never fall through silently"
    );
    // and a round cap is honored when the walk keeps growing
    let grow = 0;
    const churning = (union) => {
      for (const s of union) installPkg(nm, s.name, { [`ghost-${grow++}`]: "^1.0.0" });
    };
    assert.throws(
      () =>
        converge({
          pluginsDir: plugins,
          nodeModulesDir: nm,
          install: churning,
          maxRounds: 3,
          log: () => {},
        }),
      (e) => /within 3 rounds/.test(e.message)
    );
  });
});

// --- the CLI: dry-run pre-flight (no npm, no mutation) ----------------------

test("CLI --dry-run: red with the missing names on a bare checkout, green on a satisfied tree", () => {
  withFixture(({ dir, plugins, nm }) => {
    addPlugin(plugins, "p-a", "@local/p-a", { tested: true, peers: { "@deepseek-ai/core": "^1.0.0" } });
    const bare = spawnSync(process.execPath, [TOOL, "--root", dir, "--dry-run"], { encoding: "utf8" });
    assert.equal(bare.status, 1, "a bare checkout must report NOT converged");
    assert.match(bare.stderr, /@deepseek-ai\/core/);
    // satisfy the tree exactly as the installer would
    symlinkLocal(plugins, nm);
    installPkg(nm, "@deepseek-ai/core");
    const ok = spawnSync(process.execPath, [TOOL, "--root", dir, "--dry-run"], { encoding: "utf8" });
    assert.equal(ok.status, 0, JSON.stringify(ok.stderr));
    assert.match(ok.stdout, /converged/);
    assert.match(ok.stdout, /@deepseek-ai\/core\@\^1\.0\.0/, "the resolved union list is printed");
  });
});

// --- gates.yml revert guards -------------------------------------------------

test("gates.yml installs via the convergent script; the oscillating inline loop is gone", () => {
  assert.match(
    GATES,
    /node scripts\/install-plugin-smoke-deps\.mjs/,
    "the Install plugin smoke-test deps step must run the fixpoint installer"
  );
  assert.ok(
    !GATES.includes("for _ in 1 2 3 4 5"),
    "the cap-5 re-resolve loop must not come back (issue #161 oscillation)"
  );
  assert.ok(
    !GATES.includes("npm install"),
    "npm invocations live in the installer (one owner, one convergence check) — not inline in the workflow"
  );
  assert.match(GATES, /node --test/, "the gates still run the suite after the install step");
});

test("the whole @local plugin family is link-managed (cross-plugin imports survive npm reconcile)", () => {
  withFixture(({ plugins, nm }) => {
    addPlugin(plugins, "p-a", "@local/p-a", { tested: true });
    addPlugin(plugins, "p-b", "@local/p-b"); // untested but importable (the ui -> editor class)
    addPlugin(plugins, "p-c", "@vendor/p-c"); // not @local -> never linked
    symlinkLocal(plugins, nm);
    assert.ok(existsSync(path.join(nm, "@local", "p-a")));
    assert.ok(existsSync(path.join(nm, "@local", "p-b")), "untested @local plugins still link");
    assert.ok(!existsSync(path.join(nm, "@vendor")), "non-@local plugins are not linked");
    assert.equal(localPluginNames(plugins).length, 2);
    // relinking after a simulated npm prune is idempotent
    rmSync(path.join(nm, "@local", "p-a"), { force: true, recursive: true });
    symlinkLocal(plugins, nm);
    assert.ok(existsSync(path.join(nm, "@local", "p-a")));
  });
});
