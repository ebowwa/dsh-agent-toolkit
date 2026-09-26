#!/usr/bin/env node
// install-plugin-smoke-deps.mjs — CONVERGENT installer for the plugin smoke
// tests' @deepseek-ai/* / @local/* dependency closure (gates.yml step
// "Install plugin smoke-test deps", issue #161).
//
// WHY THIS EXISTS — the old inline loop could not converge. npm reconciles
// node_modules to the spec list it is given each invocation, so a
// re-resolve loop that reads the peer graph from the tree its own previous
// round just rewrote oscillates on a bare checkout: each round's list
// changes what the previous round installed, the cap-5 loop falls through
// WITHOUT failing, and `node --test` reds with ERR_MODULE_NOT_FOUND before
// any test substantively ran (issue #161 receipt: 10/12-spec cycle). It
// only looked green on the warm self-hosted cell, where the profile tree
// happened to satisfy the walk — environment-dependent, not converged.
//
// HOW THIS CONVERGES — deterministic fixpoint, one source of truth:
//   1. Seed the union from the TESTED plugins' dependencies+peerDependencies
//      (read from plugins/*/package.json — registry metadata, not tree state).
//   2. Walk the peer graph from metadata: peers of every installed
//      @deepseek-ai/* package and of every @local/* plugin. The walk's name
//      union is MONOTONE (names are never removed) and the merge is
//      deterministic (plugin-declared ranges win collisions; among
//      walk-derived ones, the sorted-last range wins), so re-deriving the
//      union cannot flip-flop: iterate install -> re-walk until the union
//      stops growing (a fixpoint exists because each round's union is a
//      pure function of the union that produced the tree it read).
//   3. VERIFY the tree, hard-fail the gate before `node --test` runs:
//      every required name present in node_modules and every
//      peerDependency of the installed @deepseek-ai/* / @local/* family
//      satisfied. Non-convergence is now a LOUD red with the missing
//      names, never a silent fall-through.
//   4. Re-link node_modules/@local/* after every npm pass (npm may prune
//      foreign symlinks while reconciling) — same as the profile's flat
//      tree does in production.
//
// HERMETIC on bare containers: the only inputs are the checkout (plugins/)
// and the registry; no stale node_modules, profile tree, or lockfile is
// consulted (npm runs --no-save --no-package-lock, checkout stays clean).
// Range COMPATIBILITY is npm's job (one version per name; --legacy-peer-deps
// defers conflict errors) — the verification here is presence of every
// required package, which is the failure mode the smokes actually hit
// (ERR_MODULE_NOT_FOUND).

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const NPM_FLAGS = [
  "--legacy-peer-deps",
  "--no-save",
  "--no-package-lock",
  "--no-audit",
  "--no-fund",
];

/** Read plugins/<dir>/package.json, or null. */
export function readPluginPackage(pluginsDir, dir) {
  const pj = path.join(pluginsDir, dir, "package.json");
  if (!fs.existsSync(pj)) return null;
  try {
    return JSON.parse(fs.readFileSync(pj, "utf8"));
  } catch {
    return null;
  }
}

/** Does this plugin dir carry tests (the smoke suites the gate runs)? */
export function isTestedPlugin(pluginsDir, dir) {
  return (
    fs.existsSync(path.join(pluginsDir, dir, "test")) &&
    readPluginPackage(pluginsDir, dir) !== null
  );
}

/**
 * Seed specs: dependencies+peerDependencies of the TESTED plugins, as
 * {name, spec}. Registry metadata — stable across rounds by construction.
 */
export function pluginSpecs(pluginsDir) {
  const out = [];
  for (const dir of fs.readdirSync(pluginsDir)) {
    if (!isTestedPlugin(pluginsDir, dir)) continue;
    const p = readPluginPackage(pluginsDir, dir);
    for (const k of ["dependencies", "peerDependencies"])
      for (const [name, spec] of Object.entries(p[k] || {}))
        out.push({ name, spec: String(spec), requiredBy: p.name || dir });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name) || a.spec.localeCompare(b.spec));
}

/** Every plugin published as @local/* (symlinked into node_modules/@local). */
export function localPluginNames(pluginsDir) {
  const out = [];
  for (const dir of fs.readdirSync(pluginsDir)) {
    const p = readPluginPackage(pluginsDir, dir);
    if (p && typeof p.name === "string" && p.name.startsWith("@local/"))
      out.push({ name: p.name, dir });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Peer requirements currently UNMET by the tree: peers of every installed
 * node_modules/@deepseek-ai/* package and of every @local/* plugin.
 * Returns [{name, spec, requiredBy}] sorted — deterministic input for merge.
 */
export function scanPeerNeeds(pluginsDir, nodeModulesDir) {
  const need = [];
  const requirePeers = (pkgDir, requiredBy) => {
    const pjPath = path.join(pkgDir, "package.json");
    if (!fs.existsSync(pjPath)) return;
    let pj;
    try {
      pj = JSON.parse(fs.readFileSync(pjPath, "utf8"));
    } catch {
      return;
    }
    for (const [name, spec] of Object.entries(pj.peerDependencies || {}))
      if (!fs.existsSync(path.join(nodeModulesDir, ...name.split("/"))))
        need.push({ name, spec: String(spec), requiredBy });
  };
  const dsRoot = path.join(nodeModulesDir, "@deepseek-ai");
  if (fs.existsSync(dsRoot))
    for (const pkg of fs.readdirSync(dsRoot))
      requirePeers(path.join(dsRoot, pkg), `@deepseek-ai/${pkg}`);
  for (const { name, dir } of localPluginNames(pluginsDir))
    requirePeers(path.join(pluginsDir, dir), name);
  return need.sort(
    (a, b) =>
      a.name.localeCompare(b.name) ||
      a.spec.localeCompare(b.spec) ||
      a.requiredBy.localeCompare(b.requiredBy)
  );
}

/**
 * Merge spec lists into the resolved union: name-deduped, deterministic
 * keep-last precedence — earlier lists (the plugin seeds) LOSE to later
 * ones EXCEPT that seeds always win over walk-derived specs for the same
 * name (plugins declare the ranges the tests were written against).
 * Among same-precedence collisions the sorted-last range wins, so the
 * merge is a pure function of its inputs — re-deriving it from a tree it
 * produced cannot oscillate. Returns sorted [{name, spec, requiredBy}].
 */
export function mergeSpecs(seed, ...walkedLists) {
  const seeds = new Map(seed.map((s) => [s.name, s]));
  const walked = new Map();
  for (const list of walkedLists) {
    for (const s of [...list].sort((a, b) => a.name.localeCompare(b.name) || a.spec.localeCompare(b.spec)))
      walked.set(s.name, s); // sorted-last wins per name
  }
  const merged = new Map([...walked]);
  for (const [name, s] of seeds) merged.set(name, s); // plugin ranges authoritative
  return [...merged.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export const specKey = (s) => `${s.name}@${s.spec}`;

/** Same union? (name+range pairs, order-independent) */
export function sameSpecSet(a, b) {
  const ka = [...a.map(specKey)].sort();
  const kb = [...b.map(specKey)].sort();
  return ka.length === kb.length && ka.every((k, i) => k === kb[i]);
}

/**
 * Tree verification — the convergence check. Every union name must exist
 * in node_modules, and every peerDependency of the installed
 * @deepseek-ai/* / @local/* family must be present. Returns
 * [{name, why}] (empty = converged).
 */
export function verifyTree(pluginsDir, nodeModulesDir, union) {
  const missing = [];
  const absent = (name) => !fs.existsSync(path.join(nodeModulesDir, ...name.split("/")));
  for (const s of union)
    if (absent(s.name)) missing.push({ name: s.name, why: `required as ${specKey(s)} (from ${s.requiredBy})` });
  for (const need of scanPeerNeeds(pluginsDir, nodeModulesDir))
    missing.push({ name: need.name, why: `peer ${specKey(need)} required by ${need.requiredBy}` });
  // npm may prune foreign symlinks while reconciling — a missing @local
  // link is exactly the ui -> editor ERR_MODULE_NOT_FOUND class, so the
  // links are part of the verified tree, not a bolt-on after the fact.
  for (const { name } of localPluginNames(pluginsDir))
    if (absent(name)) missing.push({ name, why: "@local plugin not linked into node_modules/@local" });
  // dedupe by name, keep first reason
  const seen = new Map();
  for (const m of missing) if (!seen.has(m.name)) seen.set(m.name, m);
  return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** (Re-)link every @local/* plugin into node_modules/@local (idempotent). */
export function symlinkLocal(pluginsDir, nodeModulesDir) {
  const scope = path.join(nodeModulesDir, "@local");
  fs.mkdirSync(scope, { recursive: true });
  for (const { name, dir } of localPluginNames(pluginsDir)) {
    const short = name.slice("@local/".length);
    const link = path.join(scope, short);
    const target = path.relative(scope, path.join(pluginsDir, dir));
    fs.rmSync(link, { force: true, recursive: true });
    fs.symlinkSync(target, link, "dir");
  }
}

/**
 * Converge: seed install -> walk -> merge -> install ... until the union
 * stops growing, then verify the tree. `install(union)` is injectable for
 * tests; default shells out to npm with the hermetic flag set. Throws with
 * the missing names when the fixpoint is unreachable or the final tree is
 * unverified — the gate reds BEFORE `node --test`, never silently.
 */
export function converge({
  pluginsDir,
  nodeModulesDir,
  install,
  maxRounds = 12,
  log = (m) => console.log(m),
}) {
  const npmInstall = (union) => {
    const r = spawnSync("npm", ["install", ...NPM_FLAGS, ...union.map(specKey)], {
      stdio: "inherit",
    });
    if (r.status !== 0)
      throw new Error(
        `npm install failed (exit ${r.status}) for union:\n  ${union.map(specKey).join(" ")}`
      );
  };
  const doInstall = install || npmInstall;
  const relink = () => symlinkLocal(pluginsDir, nodeModulesDir);

  let union = mergeSpecs(pluginSpecs(pluginsDir));
  relink();
  if (fs.existsSync(nodeModulesDir)) {
    // install-once fast path: a tree that already verifies against the
    // FULL walked closure is left untouched — npm is never invoked with
    // the seed-only list, whose reconcile would prune the closure and
    // force a pointless rebuild every rerun (idempotency).
    const grown = mergeSpecs(union, scanPeerNeeds(pluginsDir, nodeModulesDir));
    if (sameSpecSet(grown, union) && verifyTree(pluginsDir, nodeModulesDir, union).length === 0) {
      log(
        `already converged: every required package present and every peer ` +
          `requirement met — npm skipped (install-once)`
      );
      return { union, rounds: 0 };
    }
  }
  if (union.length) {
    log(`install (seed, ${union.length} specs): ${union.map(specKey).join(" ")}`);
    doInstall(union);
    relink();
  }

  for (let round = 1; round <= maxRounds; round++) {
    const needs = scanPeerNeeds(pluginsDir, nodeModulesDir);
    const grown = mergeSpecs(union, needs);
    if (sameSpecSet(grown, union)) {
      const unmet = verifyTree(pluginsDir, nodeModulesDir, union);
      if (unmet.length === 0) {
        log(
          `converged: ${union.length} specs in ${round - 1} extra round(s); ` +
            `union: ${union.map(specKey).join(" ")}`
        );
        return { union, rounds: round - 1 };
      }
      throw new Error(
        `install did not converge: npm failed to materialize the union.\n` +
          unmet.map((m) => `  missing ${m.name}: ${m.why}`).join("\n")
      );
    }
    const added = grown.filter((s) => !union.some((u) => u.name === s.name));
    log(
      `round ${round}: union ${union.length} -> ${grown.length} specs ` +
        `(+${added.map((s) => s.name).join(", ") || "range updates"})`
    );
    union = grown;
    doInstall(union);
    relink();
  }
  const unmet = verifyTree(pluginsDir, nodeModulesDir, union);
  throw new Error(
    `install did not converge within ${maxRounds} rounds — the peer walk ` +
      `kept growing the union (issue #161 oscillation class).\n` +
      (unmet.length
        ? unmet.map((m) => `  missing ${m.name}: ${m.why}`).join("\n")
        : `  union: ${union.map(specKey).join(" ")}`)
  );
}

function main(argv) {
  const args = argv.slice(2);
  const opt = (flag) => {
    const i = args.indexOf(flag);
    return i === -1 ? null : args[i + 1];
  };
  const root = opt("--root") || process.cwd();
  const dryRun = args.includes("--dry-run");
  const maxRounds = Number(opt("--max-rounds") || 12);
  const pluginsDir = path.join(root, "plugins");
  const nodeModulesDir = path.join(root, "node_modules");

  if (dryRun) {
    // No npm, no mutation: derive the union from the plugins dir + whatever
    // tree exists, verify it, report. Exit 1 = not converged (pre-flight).
    const union = mergeSpecs(pluginSpecs(pluginsDir));
    const unmet = fs.existsSync(nodeModulesDir)
      ? verifyTree(pluginsDir, nodeModulesDir, union)
      : union.map((s) => ({ name: s.name, why: "no node_modules — nothing installed yet" }));
    console.log(`dry-run union (${union.length} specs): ${union.map(specKey).join(" ")}`);
    if (unmet.length) {
      console.error(`NOT converged (${unmet.length} unmet):`);
      for (const m of unmet) console.error(`  missing ${m.name}: ${m.why}`);
      process.exitCode = 1;
    } else {
      console.log("converged: every required package present, every peer requirement met");
    }
    return;
  }

  const { union } = converge({ pluginsDir, nodeModulesDir, maxRounds, log: (m) => console.log(m) });
  const unmet = verifyTree(pluginsDir, nodeModulesDir, union);
  if (unmet.length) {
    console.error(`verification FAILED after convergence (${unmet.length} unmet):`);
    for (const m of unmet) console.error(`  missing ${m.name}: ${m.why}`);
    process.exitCode = 1;
    return;
  }
  console.log(
    `verify: union satisfied — ${union.length} required packages present, ` +
      `all peer requirements of the installed @deepseek-ai/* / @local/* family met`
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url)))
  main(process.argv);
