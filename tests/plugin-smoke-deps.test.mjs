// plugin-smoke-deps.test.mjs — contract pins for
// scripts/install-plugin-smoke-deps.mjs (issue #161: the plugin
// smoke-test dep install must converge — install-once + hard verify —
// not oscillate through a per-round npm reconcile loop).
//
// These tests fail without the fix: the union merge loses determinism,
// the walk no longer reaches a fixpoint through a peer cycle, the
// install-once fast path disappears, or non-convergence stops being
// loud — each pin goes red.

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

test("CLI --dry-run: green on the repo's converged tree, red on bare", () => {
  const script = path.join(ROOT, "scripts", "install-plugin-smoke-deps.mjs");
  const green = execFileSync("node", [script, "--dry-run"], {
    encoding: "utf8",
    cwd: ROOT,
  });
  assert.match(green, /--dry-run: verified/, "converged checkout pre-flights green");
  assert.match(green, /specs/, "the resolved union is printed");

  // bare fixture with an unmaterializable peer: red naming the gap,
  // without npm ever installing anything
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

test("a symlinked entry still runs main() — LOUD, never a silent 0 (#309, #311)", () => {
  // The #302 false-green class: pathToFileURL repairs argv[1]'s URL
  // encoding but not its symlinks, so through a symlinked entry the
  // isMain compare mismatched, main() silently never ran, and the
  // process exited 0 without seeding, walking, or verifying anything.
  // Empty plugins/ dir: main() dies LOUDLY ("no tested plugins") with
  // no npm and no network — the pre-fix guard instead exited 0 in
  // silence. (The dir must EXIST: an absent plugins/ crashes
  // testedPlugins with a raw ENOENT before the die line — see the
  // found: issue filed from this claim.)
  const script = path.join(ROOT, "scripts", "install-plugin-smoke-deps.mjs");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "psd-symlink-"));
  try {
    fs.mkdirSync(path.join(tmp, "plugins"));
    const link = path.join(tmp, "ipsd-link.mjs");
    fs.symlinkSync(script, link);
    const r = spawnSync(process.execPath, [link, "--dry-run"], {
      encoding: "utf8",
      cwd: tmp,
    });
    assert.notEqual(
      r.status,
      0,
      "main() must run through a symlinked entry — a silent exit 0 verified nothing",
    );
    assert.match(String(r.stderr), /no tested plugins found/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
