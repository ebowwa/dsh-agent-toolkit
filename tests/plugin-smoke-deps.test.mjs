// plugin-smoke-deps.test.mjs — contract pins for
// scripts/install-plugin-smoke-deps.mjs (issue #161: the plugin
// smoke-test dep install must converge — install-once + hard verify —
// not oscillate through a per-round npm reconcile loop).
//
// These tests fail without the fix: the union merge loses determinism,
// the walk no longer reaches a fixpoint through a peer cycle, the
// install-once fast path disappears, or non-convergence stops being
// loud — each pin goes red. The CLI legs are hermetic on any box
// (issue #280): green through a fixture-built converged tree, red on a
// bare one, and the repo's own checkout pinned only where the closure
// was actually installed.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

import {
  Union,
  seed,
  walkToFixpoint,
  verify,
  linkLocals,
  closureSeamsAbsent,
  testedPlugins,
  allPlugins,
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

test("a root with NO plugins/ dir reads as no plugins — not a raw ENOENT (issue #329)", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "psd-missing-"));
  try {
    // the unit seam: both readers return [] instead of throwing
    assert.deepEqual(
      testedPlugins(tmp),
      [],
      "testedPlugins on a missing plugins/ dir is [], never a throw",
    );
    assert.deepEqual(
      allPlugins(tmp),
      [],
      "allPlugins on a missing plugins/ dir is [], never a throw",
    );

    // the CLI seam: the die line delivers its intended diagnostic for the
    // MISSING case (same as the empty case), not a readdir traceback
    const script = path.join(ROOT, "scripts", "install-plugin-smoke-deps.mjs");
    let failed = false;
    try {
      execFileSync("node", [script, "--dry-run"], {
        cwd: tmp,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (e) {
      failed = true;
      assert.match(String(e.stderr), /no tested plugins found under plugins\//, "the script's own diagnostic fires");
      assert.doesNotMatch(String(e.stderr), /ENOENT/, "no raw readdir traceback");
    }
    assert.ok(failed, "a cwd without plugins/ must still exit non-zero (fail-closed)");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// CLI end-to-end through the real argv surface (--dry-run), hermetic on
// ANY box (issue #280): the green leg materializes its own converged
// tree in a temp dir — the repo checkout's node_modules is INSTALLED
// state (gates.yml installs the closure before the suite on the CI
// cell), not content a fresh clone carries, so pinning it
// unconditionally made every pristine-clone gate run exactly 1 red that
// no PR could fix (441/442 on a clean tree — the #273 box-state class).
test("CLI --dry-run: green on a converged tree, red on bare", (t) => {
  const script = path.join(ROOT, "scripts", "install-plugin-smoke-deps.mjs");

  // GREEN, hermetic: a converged tree this fixture builds itself — the
  // plugin's one peer is materialized by hand (package present,
  // peer-free), the @local link made the way the installer makes it.
  const green = fs.mkdtempSync(path.join(os.tmpdir(), "psd-cli-green-"));
  try {
    fs.mkdirSync(path.join(green, "plugins", "a", "test"), { recursive: true });
    fs.writeFileSync(
      path.join(green, "plugins", "a", "package.json"),
      JSON.stringify({
        name: "@local/a",
        peerDependencies: { "@deepseek-ai/psd-green-fixture-lib": "^1.0.0" },
      }),
    );
    fs.mkdirSync(
      path.join(green, "node_modules", "@deepseek-ai", "psd-green-fixture-lib"),
      { recursive: true },
    );
    fs.writeFileSync(
      path.join(
        green,
        "node_modules",
        "@deepseek-ai",
        "psd-green-fixture-lib",
        "package.json",
      ),
      JSON.stringify({
        name: "@deepseek-ai/psd-green-fixture-lib",
        peerDependencies: {},
      }),
    );
    linkLocals(green);
    const out = execFileSync("node", [script, "--dry-run"], {
      cwd: green,
      encoding: "utf8",
    });
    assert.match(out, /--dry-run: verified/, "converged tree pre-flights green");
    assert.match(out, /specs/, "the resolved union is printed");
  } finally {
    fs.rmSync(green, { recursive: true, force: true });
  }

  // RED, hermetic: bare fixture with an unmaterializable peer — red
  // naming the gap, without npm ever installing anything
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

  // The repo's own checkout: still pinned where the converged tree
  // exists (the CI cell, any box that ran the installer) — and SKIPPED,
  // not failed, where the closure was never installed (issue #280: a
  // fresh clone reds here through no fault of the diff). The skip is
  // narrow by construction (issue #432): "never installed" means the
  // closure is absent from BOTH seams the installer manages — no
  // @deepseek-ai/* packages under node_modules AND no @local/* links.
  // An empty @deepseek-ai scope dir alone proves nothing (npm creates
  // the scope dir before extraction); a tree carrying either seam and
  // still failing is a genuinely broken install and must stay red.
  let repo;
  try {
    repo = execFileSync("node", [script, "--dry-run"], {
      encoding: "utf8",
      cwd: ROOT,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (e) {
    if (!closureSeamsAbsent(ROOT)) throw e;
    t.skip(
      `repo tree bare (no @deepseek-ai/* packages AND no @local/* links ` +
        `under node_modules — the closure was never installed here; ` +
        `gates.yml installs it on the CI cell): ` +
        `hermetic legs above carry the CLI contract (issue #280)`,
    );
    return;
  }
  assert.match(repo, /--dry-run: verified/, "converged checkout pre-flights green");
  assert.match(repo, /specs/, "the resolved union is printed");
});

test("the repo-leg skip key stays narrow on BOTH seams (issue #432)", () => {
  const script = path.join(ROOT, "scripts", "install-plugin-smoke-deps.mjs");

  // The crashed-mid-install shape (issue #432's masking window): npm
  // created the @deepseek-ai scope dir before extraction and died;
  // linkLocals() from a prior run left the @local link behind.
  const stale = fs.mkdtempSync(path.join(os.tmpdir(), "psd-432-stale-"));
  try {
    fs.mkdirSync(path.join(stale, "plugins", "a", "test"), { recursive: true });
    fs.writeFileSync(
      path.join(stale, "plugins", "a", "package.json"),
      JSON.stringify({
        name: "@local/a",
        peerDependencies: { "@deepseek-ai/lib1": "^1.0.0" },
      }),
    );
    fs.mkdirSync(path.join(stale, "node_modules", "@deepseek-ai"), {
      recursive: true,
    });
    linkLocals(stale);
    const dsai = path.join(stale, "node_modules", "@deepseek-ai");
    assert.equal(fs.readdirSync(dsai).length, 0, "fixture: scope dir exists EMPTY");
    assert.ok(
      fs.lstatSync(path.join(stale, "node_modules", "@local", "a")).isSymbolicLink(),
      "fixture: a stale @local link survives",
    );

    // The tree IS a genuinely broken install — the dry-run is loud red
    // naming both gaps.
    let failed = false;
    try {
      execFileSync("node", [script, "--dry-run"], {
        cwd: stale,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (e) {
      failed = true;
      assert.match(String(e.stderr), /tree NOT satisfied/);
      assert.match(String(e.stderr), /missing: @deepseek-ai\/lib1/);
      assert.match(String(e.stderr), /unresolved peer: @local\/a/);
    }
    assert.ok(failed, "the stale-link tree is a broken install: dry-run exits non-zero");

    // …and the skip key must NOT classify it as never-installed: the
    // repo-leg takes the throw branch and stays red. Keying the skip on
    // the scope dir alone (the pre-#432 guard) flips this leg to skip.
    assert.equal(
      closureSeamsAbsent(stale),
      false,
      "a tree carrying the @local-link seam is NOT never-installed — it stays red",
    );
  } finally {
    fs.rmSync(stale, { recursive: true, force: true });
  }

  // The pristine clone stays skip-eligible: absent from BOTH seams.
  const pristine = fs.mkdtempSync(path.join(os.tmpdir(), "psd-432-pristine-"));
  try {
    fs.mkdirSync(path.join(pristine, "plugins", "a", "test"), { recursive: true });
    fs.writeFileSync(
      path.join(pristine, "plugins", "a", "package.json"),
      JSON.stringify({
        name: "@local/a",
        peerDependencies: { "@deepseek-ai/lib1": "^1.0.0" },
      }),
    );
    assert.equal(
      closureSeamsAbsent(pristine),
      true,
      "no node_modules at all → never-installed (skip stays)",
    );
    // An empty scope dir with no links left the tree with no seam
    // witness — indistinguishable from pristine to the verifier, still
    // skip-eligible.
    fs.mkdirSync(path.join(pristine, "node_modules", "@deepseek-ai"), {
      recursive: true,
    });
    assert.equal(
      closureSeamsAbsent(pristine),
      true,
      "empty scope dir, no @local links → never-installed (skip stays)",
    );
    // Any populated @deepseek-ai/* package is a seam witness → red.
    fs.mkdirSync(path.join(pristine, "node_modules", "@deepseek-ai", "lib1"), {
      recursive: true,
    });
    assert.equal(
      closureSeamsAbsent(pristine),
      false,
      "populated @deepseek-ai scope → NOT never-installed (broken install stays red)",
    );
  } finally {
    fs.rmSync(pristine, { recursive: true, force: true });
  }
});

test("CLI runs through a symlinked argv (issue #324, the #302 class)", () => {
  // pathToFileURL normalizes URL encoding but resolves NO symlinks:
  // import.meta.url is the entry's realpath, argv[1] stays as invoked,
  // so the pre-#324 guard (`import.meta.url ===
  // pathToFileURL(process.argv[1]).href`) never matched through a
  // symlink — main() silently never ran and the script exited 0 without
  // seeding, verifying, or installing anything. A wrapper reaching the
  // gates dep step through a symlinked path green-skips the whole
  // dependency closure. Revert the realpath guard and this leg goes red
  // (observed on pristine main @ 3da299e: symlinked --dry-run exit 0,
  // zero output; direct run loud red).
  const script = path.join(ROOT, "scripts", "install-plugin-smoke-deps.mjs");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "psd-symlink-"));
  try {
    // no deps/peers: 0 seed specs, zero registry walks — the @local-link
    // verify leg alone supplies a state-independent loud observable
    fs.mkdirSync(path.join(tmp, "plugins", "a", "test"), { recursive: true });
    fs.writeFileSync(
      path.join(tmp, "plugins", "a", "package.json"),
      JSON.stringify({ name: "@local/a" }),
    );
    const link = path.join(tmp, "ipsd-link.mjs");
    fs.symlinkSync(script, link);
    let failed = false;
    try {
      execFileSync("node", [link, "--dry-run"], {
        cwd: tmp,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (e) {
      failed = true;
      assert.match(String(e.stdout), /seed \(0 specs\)/, "main() RAN through the symlink");
      assert.match(String(e.stderr), /tree NOT satisfied/, "the dry-run verify is loud");
      assert.match(String(e.stderr), /@local link pruned or absent/, "the gap is named");
    }
    assert.ok(failed, "--dry-run through the symlink must not exit 0");

    // direct invocation is unchanged
    let directFailed = false;
    try {
      execFileSync("node", [script, "--dry-run"], {
        cwd: tmp,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch {
      directFailed = true;
    }
    assert.ok(directFailed, "direct --dry-run on the bare fixture stays red");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
