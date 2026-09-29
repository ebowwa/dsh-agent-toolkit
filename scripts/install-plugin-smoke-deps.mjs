#!/usr/bin/env node
// Install the plugin smoke-test dependency closure, ONCE, with a hard
// convergence check. Replaces gates.yml's per-round npm loop (issue #161):
// npm reconciles node_modules to the spec list it is given per invocation,
// so feeding it the accumulated union round after round let each round
// prune what the previous round had just installed — the loop oscillated
// on bare checkouts and only looked green on warm cells.
//
// Approach:
//   1. SEED the name->spec union from the tested plugins' dependencies +
//      peerDependencies (declared in the checkout — stable by construction).
//   2. WALK peers to a fixpoint using REGISTRY metadata (`npm view`), not
//      the installed tree — no npm install happens during the walk, so no
//      round can rewrite the tree under the next round's feet. The union is
//      monotone (names are only added) and the merge is deterministic
//      (plugin-declared ranges win; walk-derived specs merge sorted), so
//      re-derivation cannot flip-flop.
//   3. INSTALL the resolved union once (--no-save --no-package-lock keep
//      the checkout clean). A fast path skips npm entirely when the tree
//      already satisfies the closure — a seed-only reconcile would prune
//      the walked closure and force a pointless rebuild every rerun.
//   4. VERIFY before the suite, fail loudly: every required package
//      present, every peer requirement of the installed @deepseek-ai/* /
//      @local/* family met, every @local link intact (npm prunes foreign
//      symlinks while reconciling — the links are part of the verified
//      tree, not a bolt-on re-linked after the fact).
//
// Hermetic on bare containers: the only inputs are the checkout and the
// registry. `--dry-run` pre-flights the walk + verify without npm.
// Internals are exported for the contract pins (tests/plugin-smoke-deps.test.mjs).

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const WALK_CAP = 50;

const die = (...m) => {
  console.error(...m);
  process.exit(1);
};

export function testedPlugins(root) {
  const out = [];
  for (const dir of fs.readdirSync(path.join(root, "plugins"))) {
    const pjPath = path.join(root, "plugins", dir, "package.json");
    if (!fs.existsSync(pjPath)) continue;
    if (!fs.existsSync(path.join(root, "plugins", dir, "test"))) continue;
    out.push({
      dir: `plugins/${dir}`,
      pkg: JSON.parse(fs.readFileSync(pjPath, "utf8")),
    });
  }
  return out;
}

// every @local/* plugin (not only tested ones) — cross-plugin imports
// (ui -> editor) may reach a plugin whose own test dir does not exist.
export function allPlugins(root) {
  const out = [];
  for (const dir of fs.readdirSync(path.join(root, "plugins"))) {
    const pjPath = path.join(root, "plugins", dir, "package.json");
    if (!fs.existsSync(pjPath)) continue;
    out.push({
      dir: `plugins/${dir}`,
      pkg: JSON.parse(fs.readFileSync(pjPath, "utf8")),
    });
  }
  return out;
}

// Deterministic merge: by name; a spec already present from a plugin
// declaration is authoritative (never overwritten); walk-derived specs
// merge in sorted order so iteration order cannot change the result.
export class Union {
  constructor() {
    this.map = new Map(); // name -> { spec, from }
  }
  add(name, spec, from) {
    const prev = this.map.get(name);
    if (!prev || (prev.from === "walk" && from === "plugin")) {
      this.map.set(name, { spec, from });
      return true;
    }
    return false;
  }
  get size() {
    return this.map.size;
  }
  specs() {
    return [...this.map.entries()]
      .map(([n, { spec }]) => `${n}@${spec}`)
      .sort();
  }
}

export function seed(plugins) {
  const union = new Union();
  for (const { pkg } of plugins) {
    for (const k of ["dependencies", "peerDependencies"])
      for (const [n, spec] of Object.entries(pkg[k] || {}))
        union.add(n, spec, "plugin");
  }
  return union;
}

export function registryPeers(name, spec) {
  let raw;
  try {
    raw = execFileSync(
      "npm",
      ["view", `${name}@${spec}`, "peerDependencies", "--json"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    );
  } catch {
    return {}; // unresolvable here; the verify phase names it loudly
  }
  raw = raw.trim();
  if (!raw || raw === "undefined" || raw === "{}") return {};
  // `npm view` on a range matching several versions returns an array of
  // per-version objects — take the newest (last).
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed.at(-1) ?? {}) : parsed;
  } catch {
    return {};
  }
}

// The @local/* plugins' peers are declared right in the checkout (their
// symlink is part of the tree) — no registry round-trip for them.
export function localPeers(plugins) {
  const peers = {};
  for (const { pkg } of plugins)
    if (pkg.name?.startsWith("@local/"))
      Object.assign(peers, pkg.peerDependencies || {});
  return peers;
}

// Walk the peer closure to a fixpoint. The name union is monotone (names
// are only added, never removed) so re-derivation cannot flip-flop; the
// WALK_CAP only guards a genuinely unmaterializable graph and fails LOUDLY.
// `peersFn` is injectable for the contract pins (default: the registry).
export function walkToFixpoint(union, plugins, peersFn = registryPeers) {
  let rounds = 0;
  for (;;) {
    const before = union.size;
    const sources = [{ ...localPeers(plugins) }];
    for (const [name, { spec }] of [...union.map.entries()].sort())
      sources.push(peersFn(name, spec));
    for (const peers of sources)
      for (const [n, spec] of Object.entries(peers || {}))
        union.add(n, spec, "walk");
    // @local/* peers resolve via symlinks, never npm — keep them out of
    // the npm union, the walk already read them from the checkout.
    for (const n of [...union.map.keys()])
      if (n.startsWith("@local/")) union.map.delete(n);
    if (union.size === before) return rounds;
    if (++rounds > WALK_CAP)
      throw new Error(
        `peer-union walk did not converge after ${WALK_CAP} rounds; ` +
          `still growing (first few): ${union.specs().slice(0, 5).join(", ")}`,
      );
  }
}

export function linkLocals(root) {
  const nm = path.join(root, "node_modules");
  fs.mkdirSync(path.join(nm, "@local"), { recursive: true });
  for (const { dir, pkg } of allPlugins(root)) {
    if (!pkg.name?.startsWith("@local/")) continue;
    const target = path.join(nm, ...pkg.name.split("/"));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.rmSync(target, { force: true });
    fs.symlinkSync(path.join(root, dir), target, "dir");
  }
}

// The verified-tree contract: every required package present, every peer
// requirement of the installed @deepseek-ai/* / @local/* family met, and
// every @local link intact (npm prunes foreign symlinks while reconciling).
export function verify(root, plugins, union) {
  const nm = path.join(root, "node_modules");
  const problems = [];
  const present = (n) => fs.existsSync(path.join(nm, ...n.split("/")));
  for (const [n, { spec }] of [...union.map.entries()].sort())
    if (!present(n)) problems.push(`missing: ${n}@${spec}`);
  const familyPkgs = [];
  const dsai = path.join(nm, "@deepseek-ai");
  if (fs.existsSync(dsai))
    for (const d of fs.readdirSync(dsai))
      familyPkgs.push({
        name: `@deepseek-ai/${d}`,
        pkg: JSON.parse(
          fs.readFileSync(path.join(dsai, d, "package.json"), "utf8"),
        ),
      });
  for (const { pkg } of allPlugins(root))
    if (pkg.name?.startsWith("@local/")) familyPkgs.push({ name: pkg.name, pkg });
  for (const { name, pkg } of familyPkgs)
    for (const [n, spec] of Object.entries(pkg.peerDependencies || {}))
      if (!present(n)) problems.push(`unresolved peer: ${name} -> ${n}@${spec}`);
  for (const { dir, pkg } of allPlugins(root)) {
    if (!pkg.name?.startsWith("@local/")) continue;
    const target = path.join(nm, ...pkg.name.split("/"));
    let st = null;
    try {
      st = fs.lstatSync(target);
    } catch {
      /* absent — either missing: above or a pruned link */
    }
    if (!st || !st.isSymbolicLink())
      problems.push(
        `@local link pruned or absent: ${pkg.name} (expected -> ${dir})`,
      );
  }
  return problems;
}

export async function main(argv = process.argv.slice(2)) {
  const dryRun = argv.includes("--dry-run");
  const root = process.cwd();
  const plugins = testedPlugins(root);
  if (!plugins.length) die("no tested plugins found under plugins/");

  const union = seed(plugins);
  console.log(`seed (${union.size} specs): ${union.specs().join(" ")}`);
  const rounds = walkToFixpoint(union, plugins);
  console.log(
    rounds === 0
      ? `peer walk: seed already converged (${union.size} specs)`
      : `converged: ${union.size} specs in ${rounds} extra round(s)`,
  );

  const problems = verify(root, plugins, union);
  if (dryRun) {
    if (problems.length)
      die(`--dry-run: tree NOT satisfied:\n  ${problems.join("\n  ")}`);
    console.log(`--dry-run: verified — ${union.size} required packages present`);
    return;
  }

  if (problems.length === 0) {
    console.log(
      `already converged: ${union.size} specs present, peers satisfied, ` +
        `@local links intact — npm skipped (install-once)`,
    );
    return;
  }

  console.log(`install (${union.size} specs): ${union.specs().join(" ")}`);
  fs.mkdirSync(path.join(root, "node_modules"), { recursive: true });
  execFileSync(
    "npm",
    [
      "install",
      "--prefix",
      ".",
      "--legacy-peer-deps",
      "--no-save",
      "--no-package-lock",
      "--no-audit",
      "--no-fund",
      ...union.specs(),
    ],
    { stdio: "inherit" },
  );

  // npm's reconcile can prune the @local symlinks — re-link, then verify.
  linkLocals(root);
  const after = verify(root, plugins, union);
  if (after.length)
    die(
      `dependency closure did not converge after install ` +
        `(${union.size} specs):\n  ${after.join("\n  ")}`,
    );
  console.log(
    `verify: closure satisfied — ${union.size} required packages present, ` +
      `all peer requirements of the installed @deepseek-ai/* / @local/* ` +
      `family met, @local links intact`,
  );
}

const isMain =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) await main();
