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
//      (plugin specs accumulate per name; walk-derived specs accumulate
//      under a walk-only name and merge sorted — issue #510: the walk
//      must not drop a second range's transitive peers), so re-derivation
//      cannot flip-flop.
//      2b. DEGRADE honestly, never lie (issue #653): a registry transport
//      failure during the walk is counted, not swallowed — a stall round
//      with failures re-queries once after a short backoff (a transient
//      blip self-heals), and a walk still degraded at its verdict round
//      is named on stderr. The install path refuses to claim "closure
//      satisfied" off a degraded walk; a warm install-once tree keeps
//      its exit 0, with the degraded verdict attached.
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
// plugin declaration is authoritative), while under a walk-ONLY name
// every DISTINCT walk spec accumulates (issue #510 — keeping only the
// first writer dropped the losing range's transitive peers from the
// closure); the entries per name are kept spec-sorted so arrival order
// decides nothing, and re-adding a union's own output cannot change it
// (the anti-oscillation invariant).
export class Union {
  constructor() {
    this.map = new Map(); // name -> [{ spec, from }]
  }
  add(name, spec, from) {
    const prev = this.map.get(name);
    if (from !== "plugin") {
      // a walk spec never displaces a plugin declaration (plugin ranges
      // are authoritative); under a walk-only name distinct specs
      // accumulate (issue #510), exact duplicates are no-ops
      if (!prev || !prev.length) {
        this.map.set(name, [{ spec, from }]);
        return true;
      }
      if (prev.some((e) => e.from === "plugin")) return false;
      if (prev.some((e) => e.spec === spec)) return false;
      this.map.set(
        name,
        [...prev, { spec, from }].sort((a, b) =>
          a.spec < b.spec ? -1 : a.spec > b.spec ? 1 : 0,
        ),
      );
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
      // stderr is captured: npm's own error code on it is the only
      // discriminator between a genuine registry no-match and a
      // transport failure (same seam #512 gave the version lists).
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
  } catch (e) {
    // A transport failure is no longer a silent {} (issue #653): it is
    // THROWN so the walk can see the round was starved — a swallowed
    // failure let a stall round whose failing calls held the
    // undiscovered peers read as convergence, and the install then
    // proceeded under-converged with verify none the wiser. The
    // warm-cell no-false-red property this swallow protected does not
    // die with it: it moves INTO the walk, which tolerates the failure
    // (counts it, re-queries the round once after a backoff, degrades
    // loudly) instead of dying. npm's own E404 stays a quiet {}: a
    // genuine registry no-match contributes no peers and needs no
    // attribution.
    const detail = classifyNpmViewFailure(e);
    if (detail)
      throw new NpmTransportError(
        `registry transport failure fetching peers of ${name}@${spec} — ` +
          `${detail} (issue #653)`,
      );
    return {}; // npm's own E404: genuinely no version under this spec
  }
  raw = raw.trim();
  if (!raw || raw === "undefined" || raw === "{}") return {};
  // `npm view` on a range matching several versions returns an array of
  // per-version objects — take the newest (last). A truncated or
  // garbled answer is TRANSPORT, not evidence of a peerless package
  // (issue #653, mirroring #512's version-list treatment).
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed.at(-1) ?? {}) : parsed;
  } catch (e) {
    throw new NpmTransportError(
      `registry returned an unparseable peer map for ${name}@${spec} — ` +
        `${e.message} (issue #653)`,
    );
  }
}

// npm's argv keeps only the LAST spec per name — `npm i pkg@^4 pkg@^3`
// installs the last argv spec, it does NOT resolve a union of ranges
// (receipt on npm 10.9.8, issue #508) — so a name carrying multiple
// specs (two plugins' seed, or walk-accumulated ranges — issue #510)
// must be resolved HERE, before the install: pin a registry version
// that satisfies EVERY declared range, or refuse loudly. Single-spec
// names pass through untouched — zero registry calls on a
// collision-free tree (the shape of today's checkout). `view` is
// injectable for the contract pins (tests/plugin-smoke-deps.test.mjs),
// same seam as the walk's peersFn.
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
          `unsatisfiable spec: ${name}@${spec} has no registry ` +
            `version (declared alongside ` +
            `${specs.filter((s) => s !== spec).map((s) => `${name}@${s}`).join(", ")}) ` +
            `— refusing the install (issues #508, #510)`,
        );
      common = common ? common.filter((v) => matching.includes(v)) : matching;
    }
    if (!common.length)
      throw new Error(
        `unsatisfiable spec union for ${name}: ` +
          `${specs.map((s) => `${name}@${s}`).join(" + ")} — no registry ` +
          `version satisfies every declared range; refusing the ` +
          `install (issues #508, #510)`,
      );
    // any common version is correct; the registry's own ascending
    // version order picks the newest of them
    let pin = common[common.length - 1];
    for (const v of view.allVersions(name)) if (common.includes(v)) pin = v;
    out.push(`${name}@${pin}`);
  }
  return out;
}

// A registry TRANSPORT failure — npm missing, offline or DNS-broken
// cell, registry 5xx, an unparseable answer. Typed and distinct from a
// genuine registry no-match so a gate red during a registry blip names
// the blip, not a phantom unsatisfiable range (issue #512; REVIEW.md
// Honesty: "Failures surface as typed errors with context; no swallowed
// exits").
export class NpmTransportError extends Error {
  constructor(message) {
    super(message);
    this.name = "NpmTransportError";
  }
}

// Split npm view's failure surface. Returns null when npm POSITIVELY
// identified a registry no-match (its E404 error code on stderr — the
// only failure that may honestly read as "the registry has no version
// under this spec"), or a transport-detail string for everything else:
// a spawn-level failure (no exit status — npm never ran, the ENOENT off
// a PATH-stripped or binary-less cell), and any non-E404 exit (offline,
// DNS, registry E5xx, auth). Unrecognized exits are fail-closed
// transport too: flattening them into [] made resolveUnionSpecs
// mis-diagnose the red as "unsatisfiable spec" (issue #512).
export function classifyNpmViewFailure(err) {
  if (typeof err?.status !== "number") {
    const why =
      typeof err?.code === "string"
        ? err.code
        : "no exit status — spawn or signal failure";
    return `npm did not run (${why})`;
  }
  const stderr = typeof err.stderr === "string" ? err.stderr : "";
  const code =
    stderr.match(/(?:^|\n)\s*npm (?:error|ERR!) code (\S+)/)?.[1] ?? null;
  if (code === "E404") return null;
  const tail = stderr
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(-5)
    .join(" | ");
  return (
    `npm view exited ${err.status}` +
    (code ? ` (${code})` : "") +
    (tail ? `: ${tail}` : "")
  );
}

// The versions the registry offers under name@spec — [] reads as "none",
// and resolveUnionSpecs turns that into the loud refusal. [] now means
// npm SAID so (its E404): every transport failure throws
// NpmTransportError instead, so a registry blip cannot masquerade as an
// unsatisfiable spec (issue #512).
function npmViewVersions(name, spec) {
  let raw;
  try {
    raw = execFileSync(
      "npm",
      ["view", `${name}@${spec}`, "version", "--json"],
      // stderr is CAPTURED, not discarded: the npm error code it carries
      // is the only discriminator between a genuine no-match and a
      // transport failure (issue #512).
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
  } catch (e) {
    const detail = classifyNpmViewFailure(e);
    if (detail)
      throw new NpmTransportError(
        `registry transport failure resolving ${name}@${spec} — ` +
          `${detail} (issue #512)`,
      );
    return []; // npm's own E404: genuinely no version under this spec
  }
  raw = raw.trim();
  if (!raw) return []; // npm exited 0 and named no versions
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    // a truncated or garbled answer is not evidence of an empty registry
    throw new NpmTransportError(
      `registry returned an unparseable version list for ${name}@${spec}` +
        ` — ${e.message} (issue #512)`,
    );
  }
  return Array.isArray(parsed) ? parsed : [parsed];
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
// symlink is part of the tree) — no registry round-trip for them. EVERY
// @local plugin's spec per name is collected (issue #510: Object.assign
// was last-writer-wins across @local plugins, so the range that lost the
// readdir race — and its whole transitive peer set — never reached the
// walk); the value shape is name -> specs[], spec-sorted so plugin order
// decides nothing.
export function localPeers(plugins) {
  const peers = {};
  for (const { pkg } of plugins)
    if (pkg.name?.startsWith("@local/"))
      for (const [n, spec] of Object.entries(pkg.peerDependencies || {}))
        peers[n] = [...(peers[n] ?? []), spec];
  for (const specs of Object.values(peers)) specs.sort();
  return peers;
}

// Peer sources arrive in two shapes: localPeers() collects EVERY spec
// per name (name -> specs[]), while the registry's peersFn answers
// name -> spec — normalize both to [name, spec] pairs for the walk.
function peerEntries(peers) {
  return Object.entries(peers || {}).flatMap(([n, v]) =>
    (Array.isArray(v) ? v : [v]).map((spec) => [n, spec]),
  );
}

// Bounded sync backoff before a degraded stall's one re-query (issue
// #653). Atomics.wait is the honest sync sleep on the main thread; the
// contract pins inject their own no-op `sleep` instead of waiting.
export const DEGRADED_BACKOFF_MS = 2000;
function sleepMs(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    // a platform without SharedArrayBuffer/Atomics.wait skips the wait —
    // the re-query itself, not the sleep, is the substance
  }
}

// Walk the peer closure to a fixpoint. The name union is monotone (names
// are only added, never removed) so re-derivation cannot flip-flop; the
// WALK_CAP only guards a genuinely unmaterializable graph and fails LOUDLY.
// `peersFn` is injectable for the contract pins (default: the registry).
//
// A degraded round is NOT convergence (issue #653): registryPeers throws
// NpmTransportError when npm could not speak, and a stall round whose
// failing calls held the undiscovered peers must not read as "no peers
// exist" — that starved stall is what let a blip install an
// under-converged closure that verify then passed quietly. So the walk
// counts transport failures per round and:
//   * on a stall round WITH failures, re-queries the SAME union once
//     after a short backoff — a transient blip self-heals (restoring the
//     run-once contract), and a growing round re-arms the budget so each
//     stall gets exactly one retry and the walk stays bounded;
//   * when that retry also stalls with failures, fires
//     `onDegraded({ stage: "verdict", failures, detail })` and returns —
//     the caller owns the attribution (the install path refuses to claim
//     "closure satisfied" off a degraded walk; a warm install-once tree
//     keeps exit 0 with the warning);
//   * a verdict round with ZERO failures is real convergence — a blip
//     inside an earlier growing round self-healed, because every round
//     re-queries every entry.
// `opts.onDegraded` / `opts.sleep` are injectable for the pins.
export function walkToFixpoint(
  union,
  plugins,
  peersFn = registryPeers,
  opts = {},
) {
  const onDegraded = opts.onDegraded ?? (() => {});
  const sleep = opts.sleep ?? sleepMs;
  let rounds = 0;
  let stallRetried = false; // one bounded re-query per stall (issue #653)
  for (;;) {
    const before = union.size;
    let failures = 0;
    const failDetail = [];
    const sources = [localPeers(plugins)];
    for (const [name, entries] of [...union.map.entries()].sort())
      for (const { spec } of entries) {
        try {
          sources.push(peersFn(name, spec));
        } catch (e) {
          if (!(e instanceof NpmTransportError)) throw e;
          failures++;
          failDetail.push(`${name}@${spec}: ${e.message}`);
          sources.push({}); // the entry contributes nothing THIS round
        }
      }
    for (const peers of sources)
      for (const [n, spec] of peerEntries(peers)) union.add(n, spec, "walk");
    // @local/* peers resolve via symlinks, never npm — keep them out of
    // the npm union, the walk already read them from the checkout.
    for (const n of [...union.map.keys()])
      if (n.startsWith("@local/")) union.map.delete(n);
    if (union.size === before) {
      if (failures > 0 && !stallRetried) {
        // A starved stall is not a fixpoint (issue #653): the failing
        // calls may hold exactly the peers the successful ones never
        // surfaced. One bounded re-query after a short backoff.
        stallRetried = true;
        onDegraded({
          stage: "stall-retry",
          failures,
          detail: failDetail.join("; "),
        });
        sleep(DEGRADED_BACKOFF_MS);
        continue;
      }
      if (failures > 0)
        onDegraded({
          stage: "verdict",
          failures,
          detail: failDetail.join("; "),
        });
      return rounds;
    }
    stallRetried = false; // growth re-arms the retry budget (per stall)
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
  // The walk's degraded verdicts are attributed HERE (issue #653): every
  // event is a loud stderr warning, and a walk that ENDED degraded is
  // remembered so no success line below can claim more than the walk
  // actually saw.
  let walkDegraded = null;
  const rounds = walkToFixpoint(union, plugins, registryPeers, {
    onDegraded: ({ stage, failures, detail }) => {
      console.error(
        `WARNING (issue #653): peer walk ${stage === "verdict" ? "ENDED" : "stalled"} ` +
          `degraded — ${failures} registry transport failure(s): ${detail}`,
      );
      if (stage === "verdict") walkDegraded = { failures, detail };
    },
  });
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
    if (walkDegraded)
      console.error(
        degradedNote(walkDegraded) +
          ` --dry-run pre-flights what was walked, nothing more`,
      );
    return;
  }

  if (problems.length === 0) {
    console.log(
      `already converged: ${union.size} specs present, peers satisfied, ` +
        `@local links intact — npm skipped (install-once)`,
    );
    if (walkDegraded)
      // A warm cell keeps its exit 0 during a registry blip — the
      // #642-protected install-once property — but the verdict is
      // honest: the tree satisfies what was WALKED, and what the walk
      // never saw is named.
      console.error(degradedNote(walkDegraded));
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
  if (walkDegraded)
    // The ticket's exact false-green (issue #653): an install that ran
    // against an under-converged union and — the blip having ended —
    // satisfied its own smaller union, then read "closure satisfied"
    // with every walked peer missing. npm will not re-add them
    // (--legacy-peer-deps), so the claim is a lie the plugin smokes pay
    // for one ERR_MODULE_NOT_FOUND later. Refuse typed instead: the red
    // names the transport and the remedy, an operator never bisects
    // trust against it, and a rerun on a stable registry converges for
    // real.
    die(
      `peer walk ended DEGRADED — refusing to claim "closure satisfied" ` +
        `off an under-converged union (${degradedNote(walkDegraded).trim()})`,
    );
  console.log(
    `verify: closure satisfied — ${union.size} required packages present, ` +
      `all peer requirements of the installed @deepseek-ai/* / @local/* ` +
      `family met, @local links intact`,
  );
}

// The one-line attribution riding every degraded success claim (issue
// #653). Names the transport failures and the remedy; `detail` already
// carries npm's own error codes (ECONNREFUSED, E5xx, …).
function degradedNote({ failures, detail }) {
  return (
    `\nWARNING (issue #653): this verdict is backed by a DEGRADED walk ` +
    `(${failures} registry transport failure(s) persisted through the ` +
    `backoff retry: ${detail}) — peers the walk never saw are unknown; ` +
    `a downstream module-not-found red likely names the transport, not ` +
    `the plugins. Rerun once the registry is reachable.\n`
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
