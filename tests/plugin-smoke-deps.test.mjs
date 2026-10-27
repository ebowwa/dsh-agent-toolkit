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
import { execFileSync, spawnSync } from "node:child_process";

import {
  Union,
  seed,
  walkToFixpoint,
  registryPeers,
  resolveUnionSpecs,
  localPeers,
  verify,
  linkLocals,
  closureSeamsAbsent,
  testedPlugins,
  allPlugins,
  NpmTransportError,
  classifyNpmViewFailure,
  withTransientRetry,
  classifyInstallFailure,
  npmFailureCode,
  TRANSIENT_NPM_CODES,
  RETRY_BACKOFF_MS,
} from "../scripts/install-plugin-smoke-deps.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// ── crash-proof scratch ──────────────────────────────────────────────
// Every fixture dir this file mints goes through `mint()`, which registers
// it for a sweep that cannot be skipped. That matters twice here: most of
// the `psd-*` dirs are PATH fixtures whose `finally` only RESTORES
// `process.env.PATH` (the dir itself was never removed on any run at
// all), and a suite killed by SIGTERM/SIGINT runs no finally even where
// one exists. `process.on('exit')` also fires for `process.exit()`, so
// every exit shape reaches the same idempotent sweep — under node. Under
// `bun test` NO process exit hook fires at end of run (measured: a
// process.on("exit") sweeper stranded its own probe dir), so the runner
// arm below — `afterAll`, which bun runs after the file's tests even when
// they fail — is the arm that actually sweeps a bun-driven run.
const scratch = [];
const mint = (prefix) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  scratch.push(d);
  return d;
};
const sweepScratch = () => {
  for (const d of scratch.splice(0)) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* already gone */ }
  }
};
process.on("exit", sweepScratch);
for (const [signal, code] of [["SIGTERM", 143], ["SIGINT", 130], ["SIGHUP", 129]]) {
  process.on(signal, () => { sweepScratch(); process.exit(code); });

/**
 * Reap THIS FILE's stale siblings before the first mint (the residue half of
 * the #2698 invariant). A SIGKILL runs no code at all — bounded-gate's
 * watchdog SIGKILLs a wedged suite, so no in-process teardown can ever run
 * for that kill — and the next run reclaims what a killed one left. The
 * rails are the fleet sweepers': exact name prefixes, an age budget far past
 * the slowest suite, real directories only, and an unreadable root removes
 * nothing (the mint must never die because its housekeeping did).
 */
const STALE_MS = 60 * 60 * 1000;
const reapStaleScratch = (prefixes) => {
  let names;
  try { names = fs.readdirSync(os.tmpdir()); } catch { return; }
  const now = Date.now();
  for (const name of names) {
    if (!prefixes.some((p) => name.startsWith(p))) continue;
    try {
      const p = path.join(os.tmpdir(), name);
      if (!fs.statSync(p).isDirectory()) continue; // a file/symlink named like scratch is never a candidate
      if (now - fs.statSync(p).mtimeMs < STALE_MS) continue;
      fs.rmSync(p, { recursive: true, force: true });
    } catch { continue; } // raced vanish or unreadable — leave it
  }
};
reapStaleScratch(["psd-"]);
}
// bun arm: registered through a guarded dynamic import — a static
// `from "bun:test"` would fail module resolution under the gate's
// `node --test` run, where this file must still load. Under node the
// process.on("exit") arm above is the live sweeper; only bun needs this.
if (process.versions.bun) {
  const { afterAll } = await import("bun:test");
  afterAll(sweepScratch);
}

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

test("the union merge keeps every distinct spec per walk-only name; plugin ranges are authoritative", () => {
  const u = new Union();
  assert.equal(u.add("p", "^1.0.0", "walk"), true);
  assert.equal(
    u.add("p", "^9.0.0", "walk"),
    true,
    "a distinct walk range ACCUMULATES (issue #510) — the dropped range's transitive peers must reach the closure",
  );
  assert.equal(u.add("p", "^9.0.0", "walk"), false, "an exact duplicate is still a no-op");
  assert.equal(u.size, 2);
  assert.equal(u.add("p", "^2.0.0", "plugin"), true, "plugin spec wins over walk");
  assert.deepEqual(u.specs(), ["p@^2.0.0"], "the plugin declaration replaces the walk-accumulated name");
  // idempotent + name-monotone: re-deriving a union from specs it produced
  // cannot change it (the anti-oscillation invariant)
  const again = new Union();
  for (const spec of u.specs()) again.add(...splitSpec(spec), "walk");
  assert.equal(again.size, u.size, "re-adding its own output is a no-op");
  assert.deepEqual(again.specs(), u.specs());
});

// ---- issue #508: the seed must not be first-writer-wins per name --------

test("every plugin spec for a name survives the seed — readdir order decides nothing (issue #508)", () => {
  const first = plugin("@local/a", {}, { "@deepseek-ai/lib1": "^1.0.0" });
  const second = plugin("@local/b", {}, { "@deepseek-ai/lib1": ">=9.0.0" });
  const one = seed([first, second]);
  const two = seed([second, first]);
  assert.deepEqual(one.specs(), two.specs(), "seed order cannot change the union");
  assert.deepEqual(
    one.specs(),
    ["@deepseek-ai/lib1@>=9.0.0", "@deepseek-ai/lib1@^1.0.0"].sort(),
    "BOTH plugin specs are registered — the loser of the readdir race reaches npm",
  );
  assert.deepEqual(seed([first, second]).specs(), one.specs(), "re-seeding is a no-op");
});

test("the #508 receipt shape: an unsatisfiable spec seeded after a satisfiable one stays in the union", () => {
  // dsh-system-prompt-editor (sorts first) seeds dsh-tools@^0.1.0-rc.7;
  // a plugin sorted after seeding an unsatisfiable dsh-tools spec used to
  // have that spec silently dropped — the installer went green on a
  // broken closure and the #507 canary's red coverage was race-dependent
  const editor = plugin(
    "@local/editor",
    {},
    { "@deepseek-ai/dsh-tools": "^0.1.0-rc.7" },
  );
  const negprobe = plugin(
    "@local/negprobe",
    {},
    { "@deepseek-ai/dsh-tools": ">=0.1.0" },
  );
  const union = seed([editor, negprobe]);
  assert.ok(
    union.specs().includes("@deepseek-ai/dsh-tools@>=0.1.0"),
    `the unsatisfiable spec must reach the install surface: ${union.specs().join(" ")}`,
  );
});

test("union merge: plugin specs accumulate per name; walk stays subordinate (issue #508)", () => {
  const u = new Union();
  assert.equal(u.add("p", "^1.0.0", "plugin"), true);
  assert.equal(
    u.add("p", "^2.0.0", "plugin"),
    true,
    "a second plugin's spec for the same name is KEPT, not dropped",
  );
  assert.equal(u.add("p", "^2.0.0", "plugin"), false, "an exact duplicate is a no-op");
  assert.equal(
    u.add("p", "^9.0.0", "walk"),
    false,
    "a walk spec cannot add itself under a plugin-declared name",
  );
  assert.deepEqual(u.specs(), ["p@^1.0.0", "p@^2.0.0"].sort());
  const w = new Union();
  assert.equal(w.add("q", "^1.0.0", "walk"), true);
  assert.equal(
    w.add("q", "^9.0.0", "walk"),
    true,
    "walk-vs-walk ACCUMULATES distinct ranges (issue #510 — first-writer-wins dropped the loser's transitive peers)",
  );
  assert.equal(
    w.add("q", "^9.0.0", "walk"),
    false,
    "an exact duplicate stays a no-op (the walk iterates sorted, so re-derivation is deterministic)",
  );
  assert.equal(w.add("q", "^2.0.0", "plugin"), true, "plugin still wins over walk");
  assert.deepEqual(w.specs(), ["q@^2.0.0"], "the plugin spec replaces the walk entries");
});

test("resolveUnionSpecs pins a version satisfying EVERY plugin range (issue #508)", () => {
  const u = new Union();
  u.add("pkg", "^1.0.0", "plugin");
  u.add("pkg", ">=1.2.0 <2.0.0", "plugin");
  u.add("solo", "^3.0.0", "plugin");
  const registry = {
    "pkg@^1.0.0": ["1.0.0", "1.2.0", "1.5.0"],
    "pkg@>=1.2.0 <2.0.0": ["1.2.0", "1.5.0"],
  };
  const calls = [];
  const install = resolveUnionSpecs(u, {
    specVersions: (n, s) => (calls.push(`${n}@${s}`), registry[`${n}@${s}`] ?? []),
    allVersions: () => ["1.0.0", "1.2.0", "1.5.0"],
  });
  assert.deepEqual(
    install,
    ["pkg@1.5.0", "solo@^3.0.0"],
    "multi-spec names resolve to ONE pinned spec both ranges accept; single-spec names pass through untouched",
  );
  assert.deepEqual(calls, ["pkg@^1.0.0", "pkg@>=1.2.0 <2.0.0"], "single-spec names cost zero registry calls");
});

test("resolveUnionSpecs refuses LOUDLY: empty intersection and per-spec no-match (issue #508)", () => {
  const disjoint = new Union();
  disjoint.add("pkg", "^1.0.0", "plugin");
  disjoint.add("pkg", "^2.0.0", "plugin");
  assert.throws(
    () =>
      resolveUnionSpecs(disjoint, {
        specVersions: (n, s) => (s === "^1.0.0" ? ["1.0.0", "1.9.0"] : ["2.0.0"]),
        allVersions: () => ["1.0.0", "1.9.0", "2.0.0"],
      }),
    /unsatisfiable spec union for pkg.*pkg@\^1\.0\.0 \+ pkg@\^2\.0\.0/s,
    "no common version — the refusal names the name and BOTH specs",
  );
  const none = new Union();
  none.add("pkg", ">=9.0.0", "plugin");
  none.add("pkg", "^1.0.0", "plugin");
  assert.throws(
    () =>
      resolveUnionSpecs(none, {
        specVersions: (n, s) => (s === ">=9.0.0" ? [] : ["1.0.0"]),
        allVersions: () => ["1.0.0"],
      }),
    /unsatisfiable spec: pkg@>=9\.0\.0 has no registry version/,
    "a spec the registry cannot satisfy at all refuses before npm ever runs",
  );
});

test("verify names the WHOLE union of a multi-spec name, not the race winner (issue #508)", () => {
  const first = plugin("@local/a", {}, { "@deepseek-ai/lib1": "^1.0.0" });
  const second = plugin("@local/b", {}, { "@deepseek-ai/lib1": ">=9.0.0" });
  const plugins = [first, second];
  const union = seed(plugins);
  const problems = verify("/nonexistent-root-508", plugins, union);
  const missing = problems.find((p) => p.startsWith("missing: @deepseek-ai/lib1@"));
  assert.ok(missing, `the missing line exists: ${problems.join("; ")}`);
  assert.match(missing, /\^1\.0\.0/, "the first plugin's range is named");
  assert.match(missing, />=9\.0\.0/, "the second plugin's range is named too");
});

// ---- issue #510: localPeers is not last-writer-wins; walk specs accumulate

test("localPeers keeps EVERY @local plugin's spec per name — plugin order decides nothing (issue #510)", () => {
  const a = plugin("@local/a", {}, { "@deepseek-ai/lib1": "^1.0.0" });
  const b = plugin("@local/b", {}, {
    "@deepseek-ai/lib1": "^2.0.0",
    "@deepseek-ai/lib2": "^2.0.0",
  });
  const c = plugin("@local/c", {}, { "@deepseek-ai/lib1": "^1.0.0" }); // exact dup spec
  const one = localPeers([a, b, c]);
  const two = localPeers([c, b, a]);
  assert.deepEqual(one, two, "plugin order (the readdir race) cannot change the collected peers");
  assert.deepEqual(
    one["@deepseek-ai/lib1"],
    ["^1.0.0", "^1.0.0", "^2.0.0"],
    "BOTH distinct ranges survive — Object.assign's last-writer-wins is gone (issue #510); exact dups dedupe later in Union.add",
  );
  assert.deepEqual(one["@deepseek-ai/lib2"], ["^2.0.0"], "disjoint peer names still collect");
  assert.deepEqual(localPeers([plugin("@local/d")]), {}, "a plugin with no peers contributes nothing");
  assert.deepEqual(localPeers([plugin("@deepseek-ai/not-local", {}, { x: "^1" })]), {}, "non-@local plugins are ignored");
});

test("the #510 receipt shape: two WALKED ranges of one name both reach the closure (issue #510)", () => {
  // two seeded packages' registry metadata carry DIFFERENT ranges of the
  // same walk-only name p — pre-#510 Union.add's walk-vs-walk rule kept
  // only the first writer, so p@^2.0.0's whole transitive set (r@^2)
  // silently vanished from the closure
  const plugins = [
    plugin("@local/a", { m: "^1.0.0" }), // m@^1.0.0 seeded
    plugin("@local/b", { n: "^1.0.0" }), // n@^1.0.0 seeded
  ];
  const graph = {
    "m@^1.0.0": { p: "^1.0.0" },
    "n@^1.0.0": { p: "^2.0.0" }, // the second range of walk-only p
    "p@^1.0.0": { r: "^1.0.0" },
    "p@^2.0.0": { r: "^2.0.0" },
  };
  const peersFn = (n, spec) => graph[`${n}@${spec}`] ?? {};
  const union = seed(plugins);
  walkToFixpoint(union, plugins, peersFn);
  for (const want of [
    "m@^1.0.0",
    "n@^1.0.0",
    "p@^1.0.0",
    "p@^2.0.0",
    "r@^1.0.0",
    "r@^2.0.0",
  ])
    assert.ok(
      union.specs().includes(want),
      `the closure must keep BOTH walked ranges' transitive peers: want ${want} in [${union.specs().join(" ")}]`,
    );
});

test("the localPeers merge point: BOTH @local ranges reach the walk closure — neither merge point alone suffices (issue #510)", () => {
  // sources[0] of the walk is localPeers' merged object — pre-#510
  // Object.assign kept only the LAST @local plugin's range, and even
  // with both collected the walk-vs-walk rule dropped the second, so
  // this pin goes red unless BOTH merge points move together
  const seeded = [plugin("@local/a", { m: "^1.0.0" })]; // seed: m only
  const walked = [
    plugin("@local/a", {}, { p: "^1.0.0" }), // localPeers must carry BOTH p ranges
    plugin("@local/b", {}, { p: "^2.0.0" }), // (the readdir-later one used to win outright)
  ];
  const graph = {
    "m@^1.0.0": {},
    "p@^1.0.0": { r: "^1.0.0" },
    "p@^2.0.0": { r: "^2.0.0" },
  };
  const peersFn = (n, spec) => graph[`${n}@${spec}`] ?? {};
  const union = seed(seeded);
  walkToFixpoint(union, walked, peersFn);
  for (const want of ["p@^1.0.0", "p@^2.0.0", "r@^1.0.0", "r@^2.0.0"])
    assert.ok(
      union.specs().includes(want),
      `both @local ranges and their transitives must land: want ${want} in [${union.specs().join(" ")}]`,
    );
  // the reverse plugin order converges to the SAME union
  const flipped = seed(seeded);
  walkToFixpoint(flipped, [...walked].reverse(), peersFn);
  assert.deepEqual(flipped.specs(), union.specs(), "readdir order decides nothing end-to-end");
});

test("union merge: distinct walk specs accumulate under a walk-only name, spec-sorted (issue #510)", () => {
  const u = new Union();
  assert.equal(u.add("p", "^2.0.0", "walk"), true);
  assert.equal(u.add("p", "^1.0.0", "walk"), true, "a second distinct walk range is KEPT");
  assert.equal(u.add("p", "^1.0.0", "walk"), false, "an exact duplicate is a no-op");
  assert.deepEqual(
    u.map.get("p").map((e) => e.spec),
    ["^1.0.0", "^2.0.0"],
    "per-name entries are spec-sorted, not arrival-ordered",
  );
  const v = new Union();
  v.add("p", "^1.0.0", "walk");
  v.add("p", "^2.0.0", "walk");
  assert.equal(v.add("p", "^9.0.0", "plugin"), true, "a plugin declaration still absorbs the walk-accumulated name");
  assert.deepEqual(v.specs(), ["p@^9.0.0"], "plugin ranges are authoritative over accumulated walk specs");
  const w = new Union();
  w.add("q", "^1.0.0", "plugin");
  assert.equal(w.add("q", "^2.0.0", "walk"), false, "a walk spec never adds under a plugin-declared name");
});

test("resolveUnionSpecs resolves walk-accumulated names: pin the common version (issue #510)", () => {
  const u = new Union();
  u.add("pkg", "^1.0.0", "walk");
  u.add("pkg", ">=1.2.0 <2.0.0", "walk");
  const registry = {
    "pkg@^1.0.0": ["1.0.0", "1.2.0", "1.5.0"],
    "pkg@>=1.2.0 <2.0.0": ["1.2.0", "1.5.0"],
  };
  const install = resolveUnionSpecs(u, {
    specVersions: (n, s) => registry[`${n}@${s}`] ?? [],
    allVersions: () => ["1.0.0", "1.2.0", "1.5.0"],
  });
  assert.deepEqual(
    install,
    ["pkg@1.5.0"],
    "a walk-accumulated multi-spec name installs ONE pinned version both ranges accept",
  );
});

test("resolveUnionSpecs refuses a walk-accumulated name with no common version, loudly (issue #510)", () => {
  const u = new Union();
  u.add("pkg", "^1.0.0", "walk");
  u.add("pkg", "^2.0.0", "walk");
  assert.throws(
    () =>
      resolveUnionSpecs(u, {
        specVersions: (n, s) => (s === "^1.0.0" ? ["1.0.0", "1.9.0"] : ["2.0.0"]),
        allVersions: () => ["1.0.0", "1.9.0", "2.0.0"],
      }),
    /unsatisfiable spec union for pkg.*pkg@\^1\.0\.0 \+ pkg@\^2\.0\.0/s,
    "an unmaterializable walk-accumulated union refuses loudly — silently dropping a range was the #510 bug",
  );
});

test("re-walking a converged walk-accumulated union adds nothing (anti-oscillation, issue #510)", () => {
  const plugins = [
    plugin("@local/a", { m: "^1.0.0" }),
    plugin("@local/b", { n: "^1.0.0" }),
  ];
  const graph = {
    "m@^1.0.0": { p: "^1.0.0" },
    "n@^1.0.0": { p: "^2.0.0" },
    "p@^1.0.0": { r: "^1.0.0" },
    "p@^2.0.0": { r: "^1.0.0" },
  };
  const peersFn = (n, spec) => graph[`${n}@${spec}`] ?? {};
  const union = seed(plugins);
  walkToFixpoint(union, plugins, peersFn);
  const once = union.specs();
  assert.ok(once.includes("p@^1.0.0") && once.includes("p@^2.0.0"), once.join(" "));
  const rounds = walkToFixpoint(union, plugins, peersFn);
  assert.equal(rounds, 0, "already converged — zero further rounds");
  assert.deepEqual(union.specs(), once, "re-walking changes nothing");
});

// ---- issue #512: a transport failure is NOT an unsatisfiable spec -------
//
// `npm view` exits non-zero for a GENUINE no-match (E404) and for every
// TRANSPORT failure (npm missing, offline/DNS-broken cell, registry 5xx)
// alike; flattening both into [] made resolveUnionSpecs refuse a
// transport red as "unsatisfiable spec" — a phantom root cause an
// operator bisects trust against (REVIEW.md Honesty: failures surface
// as typed errors with context; no swallowed exits).

// A fake npm on PATH drives the REAL default seam (npmViewVersions)
// hermetically: stdout+exit scripts for the registry's answer shapes.
const fakeNpmOnPath = (script) => {
  const bin = mint("psd-512-npm-");
  fs.writeFileSync(path.join(bin, "npm"), `#!/bin/sh\n${script}\n`, {
    mode: 0o755,
  });
  return bin;
};
const withPath = (bin, fn) => {
  const keep = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${keep}`;
  try {
    fn();
  } finally {
    process.env.PATH = keep;
  }
};

test("classifyNpmViewFailure: only a positively-identified E404 reads as a genuine no-match (issue #512)", () => {
  assert.equal(
    classifyNpmViewFailure({
      status: 1,
      stderr: "npm error code E404\nnpm error 404 No match found for version ^9.0.0\n",
    }),
    null,
    "npm's own E404 is the registry speaking: no version under this spec",
  );
  for (const [label, err] of [
    [
      "spawn failure (npm missing, the #512 repro)",
      Object.assign(new Error("spawn npm ENOENT"), { code: "ENOENT", status: null }),
    ],
    [
      "network failure",
      {
        status: 1,
        stderr: "npm error code ECONNREFUSED\nnpm error network request to https://registry.npmjs.org/pkg failed\n",
      },
    ],
    ["registry 5xx", { status: 1, stderr: "npm error code E500\nnpm error 500 Internal Server Error - GET\n" }],
    ["unrecognized non-zero exit — fail-closed", { status: 1, stderr: "" }],
    [
      "killed by signal — no exit status",
      { status: null, signal: "SIGTERM", stderr: "" },
    ],
  ]) {
    const detail = classifyNpmViewFailure(err);
    assert.equal(typeof detail, "string", `${label} must classify as transport, not no-match`);
    assert.doesNotMatch(
      detail ?? "",
      /unsatisfiable/,
      `the transport detail never borrows the unsatisfiable-spec voice (${label})`,
    );
  }
  assert.match(
    classifyNpmViewFailure({
      status: 1,
      stderr: "npm error code ECONNREFUSED\nnpm error network request failed\n",
    }),
    /ECONNREFUSED/,
    "the transport detail names npm's own error code",
  );
});

test("the #512 repro: an unspawnable npm reds as NpmTransportError — never 'unsatisfiable spec'", () => {
  const u = new Union();
  u.add("pkg", "^1.0.0", "walk");
  u.add("pkg", "^2.0.0", "walk");
  const keep = process.env.PATH;
  // npm cannot spawn — transport failure, not an empty match. The PATH
  // is a prepared EMPTY dir: no npm on it anywhere, hermetically, on
  // every box (a literal `/nonexistent` is tests-lint-banned and
  // lane-fragile — ambient re-inclusion would keep npm spawnable).
  process.env.PATH = mint("psd-512-no-npm-");
  try {
    assert.throws(
      () => resolveUnionSpecs(u),
      (e) =>
        e instanceof NpmTransportError &&
        /npm did not run/.test(e.message) &&
        !/unsatisfiable spec/.test(e.message),
      "the gate red names the transport (npm never ran), not a phantom unsatisfiable range",
    );
  } finally {
    process.env.PATH = keep;
  }
});

test("the real default seam: registry answers classify through fake npm on PATH (issue #512)", () => {
  const multi = new Union();
  multi.add("pkg", "^1.0.0", "plugin");
  multi.add("pkg", ">=9.0.0", "plugin");

  // npm's E404 no-match → the UNSATISFIABLE refusal, now trustworthy
  // evidence (the registry itself said there is no version)
  withPath(
    fakeNpmOnPath('echo "npm error code E404" >&2\necho "npm error 404 No match found" >&2\nexit 1'),
    () =>
      assert.throws(
        () => resolveUnionSpecs(multi),
        (e) => !(e instanceof NpmTransportError) && /unsatisfiable spec: pkg@\^1\.0\.0 has no registry version/.test(e.message),
        "a genuine E404 still refuses as unsatisfiable — the refusal keeps its shape",
      ),
  );

  // network failure → NpmTransportError naming npm's code
  withPath(
    fakeNpmOnPath('echo "npm error code ECONNREFUSED" >&2\nexit 1'),
    () =>
      assert.throws(
        () => resolveUnionSpecs(multi),
        (e) =>
          e instanceof NpmTransportError &&
          /ECONNREFUSED/.test(e.message) &&
          !/unsatisfiable spec/.test(e.message),
        "a dead registry reds as transport with the right root cause",
      ),
  );

  // a truncated/garbled success is NOT evidence of an empty registry
  withPath(
    fakeNpmOnPath('echo "registry-garbage-not-json"\nexit 0'),
    () =>
      assert.throws(
        () => resolveUnionSpecs(multi),
        (e) =>
          e instanceof NpmTransportError &&
          /unparseable/.test(e.message) &&
          !/unsatisfiable spec/.test(e.message),
        "a garbled registry answer must not collapse into []",
      ),
  );
});

// ---- issue #653: a degraded walk is NOT convergence ----------------------
//
// registryPeers' old swallow fed the walk {} for every transport
// failure, and walkToFixpoint stopped at the first stall — so a round
// whose failing calls held the undiscovered peers read as "no peers
// exist", the install proceeded under-converged, and verify passed the
// degraded union quietly (exit 0, "closure satisfied", walked peers
// missing). The walk now counts transport failures, gives a starved
// stall ONE backoff re-query, and a degraded verdict is attributed —
// the install path refuses to claim closure off it, the warm
// install-once path keeps exit 0 with the warning.

test("the walk default seam: registryPeers throws transport on ECONNREFUSED, stays quiet on E404 (issue #653)", () => {
  withPath(
    fakeNpmOnPath(
      'echo "npm error code ECONNREFUSED" >&2\n' +
        'echo "npm error network request failed" >&2\nexit 1',
    ),
    () =>
      assert.throws(
        () => registryPeers("@deepseek-ai/lib653", "^1.0.0"),
        (e) =>
          e instanceof NpmTransportError &&
          /ECONNREFUSED/.test(e.message) &&
          /peers of @deepseek-ai\/lib653/.test(e.message),
        "a registry blip is a typed transport failure, never a silent {}",
      ),
  );
  withPath(
    fakeNpmOnPath(
      'echo "npm error code E404" >&2\n' +
        'echo "npm error 404 No match found for version ^9.0.0" >&2\nexit 1',
    ),
    () =>
      assert.deepEqual(
        registryPeers("@deepseek-ai/lib653", "^9.0.0"),
        {},
        "npm's own E404 stays a quiet no-peer answer — a genuine no-match needs no attribution",
      ),
  );
  withPath(
    fakeNpmOnPath('echo "registry-garbage-not-json"\nexit 0'),
    () =>
      assert.throws(
        () => registryPeers("@deepseek-ai/lib653", "^1.0.0"),
        (e) =>
          e instanceof NpmTransportError && /unparseable/.test(e.message),
        "a garbled peer map is transport, not evidence of a peerless package",
      ),
  );
  // Same hermetic-absence shape as the #512 repro above: a prepared
  // EMPTY dir as the whole PATH — no npm spawnable on any box, no
  // literal banned path, no ambient re-inclusion to keep npm alive.
  const keep = process.env.PATH;
  process.env.PATH = mint("psd-653-no-npm-");
  try {
    assert.throws(
      () => registryPeers("@deepseek-ai/lib653", "^1.0.0"),
      (e) =>
        e instanceof NpmTransportError && /npm did not run/.test(e.message),
      "an unspawnable npm is transport (the #512 repro, now on the walk seam too)",
    );
  } finally {
    process.env.PATH = keep;
  }
});

test("a starved stall re-queries once after a backoff and recovers the hidden peers (issue #653)", () => {
  // Round 1's only registry call hits the blip; the re-query succeeds —
  // the transient-blip shape the #654 receipts watched turn into
  // convergence-in-4-reruns. The walk self-heals instead of stopping.
  const events = [];
  const sleeps = [];
  let calls = 0;
  const peersFn = () => {
    if (++calls === 1)
      throw new NpmTransportError(
        "registry transport failure fetching peers of m@^1.0.0 (issue #653)",
      );
    return { p: "^1.0.0" };
  };
  const plugins = [plugin("@local/a", { m: "^1.0.0" })];
  const union = seed(plugins);
  const rounds = walkToFixpoint(union, plugins, peersFn, {
    onDegraded: (info) => events.push(info),
    sleep: (ms) => sleeps.push(ms),
  });
  assert.ok(
    union.specs().includes("p@^1.0.0"),
    `the peers the blipped round held are discovered: ${union.specs().join(" ")}`,
  );
  assert.deepEqual(
    events.map((e) => e.stage),
    ["stall-retry"],
    "exactly one stall-retry event — the healed verdict fires none",
  );
  assert.deepEqual(sleeps, [2000], "one bounded backoff before the re-query");
  assert.ok(rounds >= 1, "the walk kept growing past the healed stall");
});

test("a walk that stays degraded through the re-query fires the verdict — and stops (bounded, issue #653)", () => {
  const events = [];
  const sleeps = [];
  const plugins = [plugin("@local/a", { m: "^1.0.0" })];
  const union = seed(plugins);
  const rounds = walkToFixpoint(union, plugins, () => {
    throw new NpmTransportError(
      "registry transport failure fetching peers of m@^1.0.0 (issue #653)",
    );
  }, {
    onDegraded: (info) => events.push(info),
    sleep: (ms) => sleeps.push(ms),
  });
  assert.equal(rounds, 0, "a fully-starved walk returns the seed-only union");
  assert.deepEqual(union.specs(), ["m@^1.0.0"], "the seed union is unchanged");
  assert.deepEqual(
    events.map((e) => e.stage),
    ["stall-retry", "verdict"],
    "the starved stall retried once, then the DEGRADED verdict fired",
  );
  assert.equal(events[1].failures, 1, "the verdict names the failure count");
  assert.match(events[1].detail, /ECONNREFUSED|transport/, "…and the detail");
  assert.deepEqual(
    sleeps,
    [2000],
    "BOUNDED: exactly one backoff — a hard-down registry cannot loop the walk",
  );
});

test("the partial-walk stop: failing calls holding the undiscovered peers no longer end the walk (issue #653)", () => {
  // The ticket's easier hole: round 1's successful call adds nothing
  // while the FAILING call held the only undiscovered peer — pre-fix
  // that stall was final and p never reached the closure.
  const events = [];
  const sleeps = [];
  const seen = new Set();
  const peersFn = (n, spec) => {
    const key = `${n}@${spec}`;
    if (n === "m") return {}; // succeeds, contributes nothing
    if (!seen.has(key)) {
      seen.add(key);
      throw new NpmTransportError(`blip on ${key}`);
    }
    return { p: "^1.0.0" }; // the peers the failed call held
  };
  const plugins = [
    plugin("@local/a", { m: "^1.0.0" }),
    plugin("@local/b", { q: "^1.0.0" }),
  ];
  const union = seed(plugins);
  walkToFixpoint(union, plugins, peersFn, {
    onDegraded: (info) => events.push(info),
    sleep: (ms) => sleeps.push(ms),
  });
  assert.ok(
    union.specs().includes("p@^1.0.0"),
    `the starved entry's peers reached the closure on the re-query: ${union.specs().join(" ")}`,
  );
  assert.ok(
    events.some((e) => e.stage === "stall-retry"),
    "the starved stall was counted and retried",
  );
});

test("a non-transport error from peersFn still propagates — the walk never swallows it (issue #653)", () => {
  const plugins = [plugin("@local/a", { m: "^1.0.0" })];
  assert.throws(
    () =>
      walkToFixpoint(seed(plugins), plugins, () => {
        throw new RangeError("a genuine bug, not a registry blip");
      }),
    RangeError,
    "only NpmTransportError is tolerated-as-degraded; everything else is loud",
  );
});

// The ticket's exact 4-step false green, end-to-end through the real CLI
// and a fake npm on PATH: view=ECONNREFUSED (the walk ends degraded on
// the seed-only union), install=succeeds (the blip is over) and
// materializes the one required package, so verify passes the
// under-converged union — pre-fix that read "closure satisfied" exit 0
// with every walked peer missing (npm will not re-add them under
// --legacy-peer-deps). Post-fix the install path refuses typed, naming
// the transport and the remedy. Sabotage probe: delete the
// `if (walkDegraded) die(...)` arm in main() and this leg exits 0 —
// the false green this pin exists to kill.
test("CLI: a cold install off a degraded walk refuses 'closure satisfied' — the #653 false green is dead", () => {
  const script = path.join(ROOT, "scripts", "install-plugin-smoke-deps.mjs");
  const tmp = mint("psd-653-cold-");
  try {
    fs.mkdirSync(path.join(tmp, "plugins", "a", "test"), { recursive: true });
    fs.writeFileSync(
      path.join(tmp, "plugins", "a", "package.json"),
      JSON.stringify({
        name: "@local/a",
        peerDependencies: { "@deepseek-ai/lib653": "^1.0.0" },
      }),
    );
    const bin = fakeNpmOnPath(
      [
        'case "$1" in',
        "  view)",
        '    echo "npm error code ECONNREFUSED" >&2',
        '    echo "npm error network request to registry failed" >&2',
        "    exit 1;;",
        "  install)",
        '    mkdir -p node_modules/@deepseek-ai/lib653',
        '    printf \'{"name":"@deepseek-ai/lib653","peerDependencies":{}}\' > node_modules/@deepseek-ai/lib653/package.json',
        '    echo "added 1 package in 0s"',
        "    exit 0;;",
        "  *)",
        "    exit 0;;",
        "esac",
      ].join("\n"),
    );
    const keep = process.env.PATH;
    process.env.PATH = `${bin}${path.delimiter}${keep}`;
    let failed = false;
    try {
      execFileSync("node", [script], {
        cwd: tmp,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (e) {
      failed = true;
      const out = String(e.stdout);
      const err = String(e.stderr);
      assert.match(err, /ENDED degraded/, "the walk's degraded verdict is loud");
      assert.match(err, /ECONNREFUSED/, "the transport is named, not hidden");
      assert.match(
        err,
        /refusing to claim "closure satisfied"/,
        "the install path refuses the under-converged closure",
      );
      assert.match(err, /Rerun once the registry is reachable/, "…with the remedy");
      assert.doesNotMatch(
        out,
        /closure satisfied/,
        "the false green is gone from stdout too",
      );
    } finally {
      process.env.PATH = keep;
    }
    assert.ok(failed, "a cold install off a degraded walk must exit non-zero");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// The #642-protected property, pinned on BOTH sides of the fix: a warm
// cell whose tree already satisfies the walked closure keeps exit 0
// during a registry blip (no false red, npm still skipped) — and the
// verdict now carries the degraded-walk warning instead of passing
// quietly.
test("CLI: a warm install-once tree stays exit 0 on a degraded walk — with the warning attached (issue #653)", () => {
  const script = path.join(ROOT, "scripts", "install-plugin-smoke-deps.mjs");
  const tmp = mint("psd-653-warm-");
  try {
    fs.mkdirSync(path.join(tmp, "plugins", "a", "test"), { recursive: true });
    fs.writeFileSync(
      path.join(tmp, "plugins", "a", "package.json"),
      JSON.stringify({
        name: "@local/a",
        peerDependencies: { "@deepseek-ai/lib653": "^1.0.0" },
      }),
    );
    fs.mkdirSync(path.join(tmp, "node_modules", "@deepseek-ai", "lib653"), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(tmp, "node_modules", "@deepseek-ai", "lib653", "package.json"),
      JSON.stringify({ name: "@deepseek-ai/lib653", peerDependencies: {} }),
    );
    linkLocals(tmp);
    const bin = fakeNpmOnPath(
      'echo "npm error code ECONNREFUSED" >&2\nexit 1',
    );
    const keep = process.env.PATH;
    process.env.PATH = `${bin}${path.delimiter}${keep}`;
    let out = "";
    let err = "";
    let status = null;
    try {
      // spawnSync, not execFileSync: the SUCCESS path must have its
      // stderr AND its real exit code pinned too — a zero exit that
      // discards the warning channel is exactly the quiet pass #653
      // closed.
      const r = spawnSync("node", [script], { cwd: tmp, encoding: "utf8" });
      out = String(r.stdout);
      err = String(r.stderr);
      status = r.status;
    } finally {
      process.env.PATH = keep;
    }
    assert.equal(status, 0, "the warm cell keeps exit 0 during the blip");
    assert.match(
      out,
      /npm skipped \(install-once\)/,
      "the warm cell keeps its install-once fast path — no false red",
    );
    assert.match(
      err,
      /ENDED degraded/,
      "the degraded walk is named on stderr, not passed quietly",
    );
    assert.match(err, /ECONNREFUSED/, "the transport is attributed");
    assert.doesNotMatch(
      out,
      /closure satisfied/,
      "no full-satisfaction claim rides a degraded walk",
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("structural: the degraded-walk arms stay owned — classifier inside registryPeers, bounded retry, typed refusal (issue #653)", () => {
  const src = fs.readFileSync(
    path.join(ROOT, "scripts", "install-plugin-smoke-deps.mjs"),
    "utf8",
  );
  const peersBody = src.slice(
    src.indexOf("export function registryPeers"),
    src.indexOf("export function resolveUnionSpecs"),
  );
  assert.match(
    peersBody,
    /classifyNpmViewFailure/,
    "registryPeers classifies its failures — the swallow cannot silently return",
  );
  assert.match(
    peersBody,
    /NpmTransportError/,
    "transport failures throw the typed error the walk counts",
  );
  assert.doesNotMatch(
    peersBody,
    /Deliberate swallow/,
    "the #642 swallow justification is superseded — degraded is no longer silent",
  );
  const walkBody = src.slice(
    src.indexOf("export function walkToFixpoint"),
    src.indexOf("export function linkLocals"),
  );
  assert.match(walkBody, /stage: "stall-retry"/, "the bounded re-query arm");
  assert.match(walkBody, /stage: "verdict"/, "the degraded-verdict arm");
  assert.match(
    walkBody,
    /if\s*\(failures > 0 && !stallRetried\)/,
    "the re-query is budgeted — a hard-down registry cannot loop the walk",
  );
  assert.match(
    src,
    /refusing to claim "closure satisfied"/,
    "the install path's typed refusal exists",
  );
  assert.match(
    src,
    /npm skipped \(install-once\)/,
    "the warm install-once fast path is untouched (the #642 property)",
  );
  assert.match(
    src,
    /dependency closure did not converge after install/,
    "the post-install non-convergence refusal is untouched",
  );
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
  const tmp = mint("psd-");
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
  const tmp = mint("psd-missing-");
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
  const green = mint("psd-cli-green-");
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
  const tmp = mint("psd-cli-");
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
  const stale = mint("psd-432-stale-");
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
  const pristine = mint("psd-432-pristine-");
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
  const tmp = mint("psd-symlink-");
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

// End-to-end through the real CLI (issue #508): two TESTED plugins seeding
// the same package name, the satisfiable seeder sorting FIRST — pre-fix
// first-writer-wins dropped the second plugin's spec entirely, so both the
// seed line and the verify line carried only the race winner's range and
// an unsatisfiable closure could pre-flight GREEN. The union now carries
// every plugin spec, in both printed lines, regardless of readdir order.
test("CLI: a spec that loses the readdir race still reaches the seed + verify lines (issue #508)", () => {
  const script = path.join(ROOT, "scripts", "install-plugin-smoke-deps.mjs");
  const tmp = mint("psd-508-");
  try {
    fs.mkdirSync(path.join(tmp, "plugins", "a", "test"), { recursive: true });
    fs.writeFileSync(
      path.join(tmp, "plugins", "a", "package.json"),
      JSON.stringify({
        name: "@local/a",
        peerDependencies: { "@deepseek-ai/lib508": "^1.0.0" },
      }),
    );
    fs.mkdirSync(path.join(tmp, "plugins", "b", "test"), { recursive: true });
    fs.writeFileSync(
      path.join(tmp, "plugins", "b", "package.json"),
      JSON.stringify({
        name: "@local/b",
        peerDependencies: { "@deepseek-ai/lib508": ">=9.0.0" },
      }),
    );
    let failed = false;
    try {
      execFileSync("node", [script, "--dry-run"], {
        cwd: tmp,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (e) {
      failed = true;
      const out = String(e.stdout);
      const err = String(e.stderr);
      assert.match(
        out,
        /seed \(2 specs\)/,
        "BOTH specs seeded — the race winner no longer replaces the loser",
      );
      assert.match(out, /@deepseek-ai\/lib508@\^1\.0\.0/);
      assert.match(
        out,
        /@deepseek-ai\/lib508@>=9\.0\.0/,
        "the readdir LOSER is in the printed union",
      );
      const missing = err
        .split("\n")
        .find((l) => l.includes("missing: @deepseek-ai/lib508@"));
      assert.ok(missing, `the verify names the gap: ${err}`);
      assert.match(missing, /\^1\.0\.0/, "the winner's range is named");
      assert.match(
        missing,
        />=9\.0\.0/,
        "the loser's range is named too — the verify reports the whole union",
      );
    }
    assert.ok(failed, "the bare fixture stays loud red");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// --- issue #660: ONE bounded transient retry -------------------------------
// gates.yml runs the installer as a single `run:` with no shell retry (the
// per-round shell loop is forbidden by tests/gates-plugin-deps.test.mjs), so
// a registry blip that killed spec resolution or the materialization killed
// the gate. The retry lives in the installer, is bounded to two attempts
// total, and re-runs ONLY the allow-listed transport/availability classes —
// a resolution VERDICT (ETARGET / ERESOLVE / E404) is never retried.

const npmError = (code, message = "boom") => {
  const e = new Error(`npm install failed${code ? ` (${code})` : ""}: ${message}`);
  e.status = 1;
  e.stderr = code ? `npm error code ${code}\nnpm error ${message}\n` : `npm error ${message}\n`;
  return e;
};

test("issue #660: a transient npm code retries EXACTLY once, then succeeds", () => {
  const calls = [];
  const retries = [];
  const sleeps = [];
  const out = withTransientRetry(
    (attempt) => {
      calls.push(attempt);
      if (attempt === 1) throw npmError("EAI_AGAIN", "network request to registry failed");
      return "installed";
    },
    { sleep: (ms) => sleeps.push(ms), onRetry: (i) => retries.push(i), what: "npm install" },
  );
  assert.equal(out, "installed");
  assert.equal(calls.length, 2, "two attempts total — ONE retry, never a loop");
  assert.equal(retries.length, 1, "the retry fired exactly once");
  assert.equal(retries[0].code, "EAI_AGAIN", "the retried class is named");
  assert.equal(retries[0].backoffMs, RETRY_BACKOFF_MS, "the backoff is the bounded default");
  assert.deepEqual(sleeps, [RETRY_BACKOFF_MS], "exactly one bounded backoff");
});

test("issue #660: a hard resolution failure is never retried (zero retries, zero waits)", () => {
  for (const code of ["ETARGET", "ERESOLVE", "E404", "EINTEGRITY", "ENOENT"]) {
    const calls = [];
    const sleeps = [];
    assert.throws(
      () =>
        withTransientRetry(
          (attempt) => {
            calls.push(attempt);
            throw npmError(code, `hard failure ${code}`);
          },
          { sleep: (ms) => sleeps.push(ms), onRetry: () => assert.fail(`retried ${code}`) },
        ),
      (e) => npmFailureCode(e) === code,
      `${code} must surface on the FIRST attempt`,
    );
    assert.equal(calls.length, 1, `${code}: a resolution verdict is authoritative — no second look`);
    assert.deepEqual(sleeps, [], `${code}: no backoff is spent on a verdict`);
  }
});

test("issue #660: a persistent transient failure stays bounded at two attempts (no third)", () => {
  const calls = [];
  assert.throws(
    () =>
      withTransientRetry(
        (attempt) => {
          calls.push(attempt);
          throw npmError("ECONNRESET");
        },
        { sleep: () => {} },
      ),
    /ECONNRESET|npm install failed/,
  );
  assert.equal(calls.length, 2, "a hard-down registry reds after the bounded retry — it never loops");
});

test("issue #660: the retried classes are the transport/availability allow-list, never a verdict", () => {
  // named in the source comment above withTransientRetry — the classes a
  // second attempt can honestly clear
  for (const code of ["ENOTFOUND", "EAI_AGAIN", "ECONNRESET", "ECONNREFUSED",
    "ETIMEDOUT", "EPIPE", "E503", "E502", "E504", "E429", "ELOCKED", "EBUSY"]) {
    assert.equal(
      classifyInstallFailure(npmError(code)).transient,
      true,
      `${code} is a transient class and must be retried`,
    );
    assert.ok(TRANSIENT_NPM_CODES.has(code), `${code} is declared in TRANSIENT_NPM_CODES`);
  }
  // …and the verdicts stay verdicts, even though they are npm codes too
  for (const code of ["ETARGET", "ERESOLVE", "E404", "EINTEGRITY", "EJSONPARSE", "EACCES"]) {
    assert.equal(
      classifyInstallFailure(npmError(code)).transient,
      false,
      `${code} is a real resolution/dependency error — retrying it would only bury it`,
    );
  }
  // an UNRECOGNIZED code is fail-closed (not retried), matching the #512
  // classifier's stance — an unknown class must not be assumed transient
  assert.equal(classifyInstallFailure(npmError("EWEIRD")).transient, false);
  // npm never ran (spawn/signal failure) — retrying a missing binary is pointless
  const spawnFail = Object.assign(new Error("spawn npm ENOENT"), { code: "ENOENT" });
  assert.equal(classifyInstallFailure(spawnFail).transient, false);
  assert.match(classifyInstallFailure(spawnFail).detail, /npm did not run/);
});

test("issue #660 structural: main() carries the retry at both transient boundaries", () => {
  const src = fs.readFileSync(
    path.join(ROOT, "scripts", "install-plugin-smoke-deps.mjs"),
    "utf8",
  );
  const mainBody = src.slice(src.indexOf("export async function main"));
  assert.match(
    mainBody,
    /withTransientRetry\(\(\) => resolveUnionSpecs\(union\)/,
    "spec resolution is retried once on NpmTransportError only",
  );
  assert.match(
    mainBody,
    /isTransient: \(e\) => e instanceof NpmTransportError/,
    "…classified by the typed transport error, never by a bare throw",
  );
  assert.match(
    mainBody,
    /stdio: \["ignore", "inherit", "pipe"\]/,
    "the install keeps stdout streaming and captures stderr for classification",
  );
  assert.match(mainBody, /what: "npm install"/, "the materialization boundary is retried");
  assert.match(
    src,
    /TRANSIENT_NPM_CODES/,
    "the allow-list is a named constant, not an inline condition",
  );
  assert.doesNotMatch(
    src,
    /while\s*\(\s*true\s*\).*npm install/s,
    "no unbounded npm loop",
  );
});

test("issue #660 CLI: an install that fails EAI_AGAIN once is retried and the gate goes GREEN", () => {
  const script = path.join(ROOT, "scripts", "install-plugin-smoke-deps.mjs");
  const tmp = mint("psd-660-retry-");
  try {
    fs.mkdirSync(path.join(tmp, "plugins", "a", "test"), { recursive: true });
    fs.writeFileSync(
      path.join(tmp, "plugins", "a", "package.json"),
      JSON.stringify({
        name: "@local/a",
        peerDependencies: { "@deepseek-ai/lib660": "^1.0.0" },
      }),
    );
    // stateful fake npm: the FIRST install attempt fails with a transient
    // transport code, the second materializes the package.
    const bin = mint("psd-660-npm-");
    fs.writeFileSync(
      path.join(bin, "npm"),
      [
        "#!/bin/sh",
        'case "$1" in',
        "  view) echo '{}'; exit 0;;",
        "  install)",
        '    n="$(cat .npm-install-attempts 2>/dev/null || echo 0)"',
        '    n=$((n + 1)); echo "$n" > .npm-install-attempts',
        '    if [ "$n" -eq 1 ]; then',
        '      echo "npm error code EAI_AGAIN" >&2',
        '      echo "npm error network request to registry failed" >&2',
        "      exit 1",
        "    fi",
        "    mkdir -p node_modules/@deepseek-ai/lib660",
        `    printf '%s' '{"name":"@deepseek-ai/lib660","peerDependencies":{}}' > node_modules/@deepseek-ai/lib660/package.json`,
        '    echo "added 1 package in 0s"',
        "    exit 0;;",
        "  *) exit 0;;",
        "esac",
      ].join("\n") + "\n",
      { mode: 0o755 },
    );
    const keep = process.env.PATH;
    process.env.PATH = `${bin}${path.delimiter}${keep}`;
    let r;
    try {
      r = spawnSync("node", [script], { cwd: tmp, encoding: "utf8" });
    } finally {
      process.env.PATH = keep;
    }
    const out = String(r.stdout);
    const err = String(r.stderr);
    assert.equal(r.status, 0, `the retried run must converge green:\n${out}\n${err}`);
    assert.equal(
      fs.readFileSync(path.join(tmp, ".npm-install-attempts"), "utf8").trim(),
      "2",
      "exactly two install attempts: the failure, then the ONE retry",
    );
    assert.match(err, /issue #660/, "the retry is a recorded, loud event");
    assert.match(err, /EAI_AGAIN/, "the retried transient class is named on stderr");
    assert.match(out, /closure satisfied/, "the gate's verdict is a real one — the install completed");
    assert.doesNotMatch(out, /closure satisfied.*DEGRADED/s, "no degraded claim rides this verdict");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("issue #660 CLI: a hard resolution failure makes exactly ONE install attempt (no retry)", () => {
  const script = path.join(ROOT, "scripts", "install-plugin-smoke-deps.mjs");
  const tmp = mint("psd-660-hard-");
  try {
    fs.mkdirSync(path.join(tmp, "plugins", "a", "test"), { recursive: true });
    fs.writeFileSync(
      path.join(tmp, "plugins", "a", "package.json"),
      JSON.stringify({
        name: "@local/a",
        peerDependencies: { "@deepseek-ai/lib660h": "^1.0.0" },
      }),
    );
    const bin = mint("psd-660h-npm-");
    fs.writeFileSync(
      path.join(bin, "npm"),
      [
        "#!/bin/sh",
        'case "$1" in',
        "  view) echo '{}'; exit 0;;",
        "  install)",
        '    n="$(cat .npm-install-attempts 2>/dev/null || echo 0)"',
        '    n=$((n + 1)); echo "$n" > .npm-install-attempts',
        '    echo "npm error code ETARGET" >&2',
        '    echo "npm error notarget No matching version found for @deepseek-ai/lib660h@^1.0.0" >&2',
        "    exit 1;;",
        "  *) exit 0;;",
        "esac",
      ].join("\n") + "\n",
      { mode: 0o755 },
    );
    const keep = process.env.PATH;
    process.env.PATH = `${bin}${path.delimiter}${keep}`;
    let r;
    try {
      r = spawnSync("node", [script], { cwd: tmp, encoding: "utf8" });
    } finally {
      process.env.PATH = keep;
    }
    assert.notEqual(r.status, 0, "a real resolution error is a red gate");
    assert.equal(
      fs.readFileSync(path.join(tmp, ".npm-install-attempts"), "utf8").trim(),
      "1",
      "ETARGET is a verdict — the install ran exactly once, never retried",
    );
    assert.match(String(r.stderr), /FAILED \(ETARGET\)/, "the red names npm's own code");
    assert.match(String(r.stderr), /not retried|not a transient class/, "…and says why it was not retried");
    assert.doesNotMatch(String(r.stderr), /one bounded retry/, "no retry was spent on a verdict");
    assert.doesNotMatch(String(r.stdout), /closure satisfied/, "no false green on a hard failure");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
