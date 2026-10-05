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
//      EVERY plugin-declared spec for a name is kept: seed order (readdir)
//      must not decide which plugin's range reaches the registry (issue
//      #508 — first-writer-wins silently dropped the loser of the race, so
//      an unsatisfiable spec could vanish before npm ever saw it).
//   2. WALK peers to a fixpoint using REGISTRY metadata (`npm view`), not
//      the installed tree — no npm install happens during the walk, so no
//      round can rewrite the tree under the next round's feet. The union is
//      monotone (entries are only added) and the merge is deterministic
//      (plugin specs accumulate per name; walk-derived specs stay
//      subordinate and merge sorted), so re-derivation cannot flip-flop.
//   3. INSTALL the resolved union once (--no-save --no-package-lock keep
//      the checkout clean). npm's argv keeps only the LAST spec per name —
//      `npm i pkg@^4 pkg@^3` installs the last, it does NOT resolve a union
//      (receipt on npm 10.9.8, issue #508) — so a name two plugins seed is
//      resolved against the registry FIRST: pin a version satisfying every
//      declared range, or refuse loudly. A fast path skips npm entirely
//      when the tree already satisfies the closure — a seed-only reconcile
//      would prune the walked closure and force a pointless rebuild every
//      rerun.
//   4. VERIFY before the suite, fail loudly: every required package
//      present, every peer requirement of the installed @deepseek-ai/* /
//      @local/* family met, every @local link intact (npm prunes foreign
//      symlinks while reconciling — the links are part of the verified
//      tree, not a bolt-on re-linked after the fact).
//
// Hermetic on bare containers: the only inputs are the checkout and the
// registry. `--dry-run` pre-flights the walk + verify without npm.
// Internals are exported for the contract pins (tests/plugin-smoke-deps.test.mjs).

import fs, { realpathSync } from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const WALK_CAP = 50;

const die = (...m) => {
  console.error(...m);
  process.exit(1);
};

// A cwd with NO plugins/ directory reads as "no plugins" (issue #329):
// main()'s `die("no tested plugins found under plugins/")` then delivers
// its intended diagnostic for the missing case too, instead of the raw
// ENOENT traceback readdirSync throws first.
function pluginDirs(root) {
  const pluginsDir = path.join(root, "plugins");
  return fs.existsSync(pluginsDir) ? fs.readdirSync(pluginsDir) : [];
}

export function testedPlugins(root) {
  const out = [];
  for (const dir of pluginDirs(root)) {
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
  for (const dir of pluginDirs(root)) {
    const pjPath = path.join(root, "plugins", dir, "package.json");
    if (!fs.existsSync(pjPath)) continue;
    out.push({
      dir: `plugins/${dir}`,
      pkg: JSON.parse(fs.readFileSync(pjPath, "utf8")),
    });
  }
  return out;
}

// Deterministic merge: EVERY plugin-declared spec for a name is kept —
// seed order (readdir) must not decide which plugin's range reaches the
// registry (issue #508: first-writer-wins let the loser of that race
// vanish silently, so an unsatisfiable spec never reached npm and the
// canary's red coverage was race-dependent). walk-derived specs stay
// subordinate: a name any plugin declares keeps only plugin ranges (the
// plugin declaration is authoritative), a name no plugin declares keeps
// the FIRST walk spec (the walk's sorted iteration makes that
// deterministic), and re-adding a union's own output cannot change it
// (the anti-oscillation invariant).
export class Union {
  constructor() {
    this.map = new Map(); // name -> [{ spec, from }]
  }
  add(name, spec, from) {
    const prev = this.map.get(name);
    if (from !== "plugin") {
      // a walk spec never displaces anything: plugin ranges are
      // authoritative, and walk-vs-walk keeps the first writer
      if (prev && prev.length) return false;
      this.map.set(name, [{ spec, from }]);
      return true;
    }
    if (!prev || !prev.some((e) => e.from === "plugin")) {
      // first plugin declaration for the name replaces any walk entry
      this.map.set(name, [{ spec, from }]);
      return true;
    }
    if (prev.some((e) => e.from === "plugin" && e.spec === spec))
      return false; // exact duplicate — already registered
    this.map.set(name, [...prev, { spec, from }]);
    return true;
  }
  get size() {
    let n = 0;
    for (const entries of this.map.values()) n += entries.length;
    return n;
  }
  specs() {
    const out = [];
    for (const [n, entries] of this.map)
      for (const { spec } of entries) out.push(`${n}@${spec}`);
    return out.sort();
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

// npm's argv keeps only the LAST spec per name — `npm i pkg@^4 pkg@^3`
// installs the last argv spec, it does NOT resolve a union of ranges
// (receipt on npm 10.9.8, issue #508) — so a name two plugins seed must
// be resolved HERE, before the install: pin a registry version that
// satisfies EVERY declared range, or refuse loudly. Single-spec names
// pass through untouched — zero registry calls on a collision-free tree
// (the shape of today's checkout). `view` is injectable for the
// contract pins (tests/plugin-smoke-deps.test.mjs), same seam as the
// walk's peersFn.
export function resolveUnionSpecs(
  union,
  view = { specVersions: npmViewVersions, allVersions: npmViewAllVersions },
) {
  const out = [];
  for (const [name, entries] of [...union.map.entries()].sort()) {
    const specs = entries.map((e) => e.spec);
    if (specs.length === 1) {
      out.push(`${name}@${specs[0]}`);
      continue;
    }
    let common = null;
    for (const spec of specs) {
      const matching = view.specVersions(name, spec);
      if (!matching.length)
        throw new Error(
          `unsatisfiable plugin spec: ${name}@${spec} has no registry ` +
            `version (seeded alongside ` +
            `${specs.filter((s) => s !== spec).map((s) => `${name}@${s}`).join(", ")}) ` +
            `— refusing the install (issue #508)`,
        );
      common = common ? common.filter((v) => matching.includes(v)) : matching;
    }
    if (!common.length)
      throw new Error(
        `unsatisfiable plugin spec union for ${name}: ` +
          `${specs.map((s) => `${name}@${s}`).join(" + ")} — no registry ` +
          `version satisfies every plugin declaration; refusing the ` +
          `install (issue #508)`,
      );
    // any common version is correct; the registry's own ascending
    // version order picks the newest of them
    let pin = common[common.length - 1];
    for (const v of view.allVersions(name)) if (common.includes(v)) pin = v;
    out.push(`${name}@${pin}`);
  }
  return out;
}

// The versions the registry offers under name@spec — [] reads as "none",
// and resolveUnionSpecs turns that into the loud refusal.
function npmViewVersions(name, spec) {
  let raw;
  try {
    raw = execFileSync(
      "npm",
      ["view", `${name}@${spec}`, "version", "--json"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    );
  } catch {
    return []; // the registry cannot satisfy this spec — resolved loudly above
  }
  raw = raw.trim();
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return [];
  }
}

// The registry's full version list for name, in registry (ascending)
// order — the tie-break that picks WHICH common version gets pinned.
function npmViewAllVersions(name) {
  try {
    const parsed = JSON.parse(
      execFileSync("npm", ["view", name, "versions", "--json"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }),
    );
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return []; // degenerate: fall back to the per-spec order's last match
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
    for (const [name, entries] of [...union.map.entries()].sort())
      for (const { spec } of entries) sources.push(peersFn(name, spec));
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

// "Never installed" = the closure is absent from BOTH seams the installer
// manages: the @deepseek-ai/* packages npm extracts, and the @local/* links
// linkLocals() makes (issue #432). An EMPTY @deepseek-ai scope dir alone is
// NOT a never-installed witness — npm creates the scope dir before
// extraction, so a crashed mid-install leaves exactly that shape, while
// linkLocals() from a prior run leaves the @local links behind: that tree
// fails the verify (a genuinely broken install) and must stay red, not
// skip. Only a tree with no witness on either seam is the pristine-clone
// state a "was never installed" skip may claim.
export function closureSeamsAbsent(root) {
  const nm = path.join(root, "node_modules");
  // Seam 1: the @deepseek-ai/* extraction target. The scope dir's EXISTENCE
  // proves nothing (npm pre-creates it); only content does.
  const dsai = path.join(nm, "@deepseek-ai");
  if (fs.existsSync(dsai) && fs.readdirSync(dsai).length > 0) return false;
  // Seam 2: the @local/* links. npm never creates these — a symlink here
  // is proof the closure step ran on this tree.
  const local = path.join(nm, "@local");
  if (!fs.existsSync(local)) return true;
  for (const d of fs.readdirSync(local)) {
    try {
      if (fs.lstatSync(path.join(local, d)).isSymbolicLink()) return false;
    } catch {
      // raced away mid-readdir — not a seam witness
    }
  }
  return true;
}

// The verified-tree contract: every required package present, every peer
// requirement of the installed @deepseek-ai/* / @local/* family met, and
// every @local link intact (npm prunes foreign symlinks while reconciling).
export function verify(root, plugins, union) {
  const nm = path.join(root, "node_modules");
  const problems = [];
  const present = (n) => fs.existsSync(path.join(nm, ...n.split("/")));
  for (const [n, entries] of [...union.map.entries()].sort())
    if (!present(n))
      problems.push(
        `missing: ${n}@${entries.map((e) => e.spec).join(" || ")}`,
      );
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

  // npm's argv dedupes specs per name (last one wins), so multi-spec
  // names are resolved to a single pinned spec first — a name no
  // registry version can satisfy for every plugin declaration dies HERE,
  // loudly, before npm runs (issue #508: the red no longer depends on
  // which plugin won the readdir race).
  let installSpecs;
  try {
    installSpecs = resolveUnionSpecs(union);
  } catch (e) {
    die(e.message);
  }
  console.log(
    `install (${installSpecs.length} specs): ${installSpecs.join(" ")}`,
  );
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
      ...installSpecs,
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

/** CLI guard — compare REALPATHS, not raw URLs (issue #324, the #302
 * class). pathToFileURL normalizes URL encoding but resolves NO
 * symlinks: import.meta.url is the entry's realpath while argv[1] stays
 * as invoked, so through a symlink (or a /tmp → /private/tmp alias) the
 * old comparison never matched, main() silently never ran, and the
 * script exited 0 without installing or verifying anything — gates' dep
 * step green with no deps. An unresolvable argv[1] (module imported
 * under test) means "not the CLI" and is caught, not crashed. */
const invokedAsMain = (() => {
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
  } catch {
    return false;
  }
})();

if (invokedAsMain) await main();
