#!/usr/bin/env node
// fleet-manifest-drift.mjs — the standing-manifest drift fence (#397).
//
// Why this exists (incident: issue #397, 2026-10-04): config/fleet-manifest.md
// self-describes as the standing fleet context injected into EVERY dispatched
// task, yet it rotted 8 days behind the tower registry — two air machines
// (three nodes) joined the pool and one of them (air16-native-open) minted
// ~110 of the day's claim rows, roughly half the dispatch load, while agents
// planned against a manifest that named none of them. "Owner-edit it when the
// pool changes" had no check backing it, so the copy rotted silently and
// ledger rows from registered nodes read as phantom.
//
// The fence: diff the manifest's Node-registry node ids against FleetTower's
// live fleet.manifest.json. A node added or removed in the tower registry
// without the manifest following fails HERE (red gate, node named) instead of
// mis-placing work downstream.
//
// Usage: node fleet-manifest-drift.mjs [--manifest PATH] [--registry PATH]
//   --manifest  the standing manifest to check (default: this repo's
//               config/fleet-manifest.md)
//   --registry  the tower registry JSON to diff against (default: fetched
//               from github via `gh api` — GH_TOKEN/GH_BIN respected)
//
// stdout: the verdict line (aligned: N nodes / drift detail).
// stderr: the loud-SKIP reason when the registry cannot be reached.
// exit:   0 aligned, or registry UNREACHABLE (loud skip — a credential-less
//           cell must never mint a false verdict in either direction);
//         1 DRIFT — the manifest and the tower registry disagree;
//         2 usage / unreadable manifest / unparseable registry.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_MANIFEST = path.join(SCRIPT_DIR, "..", "config", "fleet-manifest.md");
const REGISTRY_REPO = "ebowwa/FleetTower";
const REGISTRY_PATH = "fleet.manifest.json";

// --- pure halves (tested directly) -------------------------------------------

/** Node ids from the manifest's `## Node registry` table (first column). */
export function parseManifestNodes(md) {
  const heading = /^##\s+Node registry\s*$/m.exec(md);
  if (!heading) return null; // structural: no table to fence
  const rest = md.slice(heading.index + heading[0].length);
  const nextHeading = rest.search(/^##\s+/m);
  const section = nextHeading === -1 ? rest : rest.slice(0, nextHeading);
  const ids = [];
  for (const line of section.split("\n")) {
    const m = /^\|\s*`?([A-Za-z0-9][A-Za-z0-9._-]*)`?\s*\|/.exec(line);
    if (!m) continue;
    if (m[1] === "Nodes") continue; // header row
    ids.push(m[1]);
  }
  return ids.length ? ids : null;
}

/** Flat node list from a tower registry object: {id, machine, os, lane, note}. */
export function registryNodes(registry) {
  const out = [];
  for (const [machine, spec] of Object.entries(registry?.machines ?? {})) {
    for (const node of spec?.nodes ?? []) {
      if (!node?.id) continue;
      out.push({
        id: node.id,
        machine,
        os: spec?.os ?? "unknown",
        lane: node?.lane ?? "unknown",
        note: node?.registryNote ?? "",
      });
    }
  }
  return out;
}

/** Both-direction diff: what the manifest is missing, and what it names that
 *  the registry no longer carries. Empty arrays == aligned. */
export function drift(manifestIds, regNodes) {
  const regIds = new Set(regNodes.map(n => n.id));
  const have = new Set(manifestIds);
  return {
    missing: regNodes.filter(n => !have.has(n.id)),
    stale: manifestIds.filter(id => !regIds.has(id)),
  };
}

// --- IO halves ---------------------------------------------------------------

function fetchRegistry() {
  const gh = process.env.GH_BIN || "gh";
  const res = spawnSync(gh, [
    "api", `repos/${REGISTRY_REPO}/contents/${REGISTRY_PATH}`,
    "--jq", ".content",
  ], { encoding: "utf8", timeout: 15_000 });
  if (res.error || res.status !== 0 || !res.stdout) {
    const why = res.error?.code === "ENOENT"
      ? `no gh binary (${gh})`
      : (res.stderr || res.error?.message || `gh exit ${res.status}`).split("\n")[0];
    return { ok: false, why };
  }
  try {
    return { ok: true, registry: JSON.parse(Buffer.from(res.stdout.trim(), "base64").toString("utf8")) };
  } catch (e) {
    return { ok: false, why: `registry JSON unparseable: ${e.message}` };
  }
}

// --- CLI ---------------------------------------------------------------------

export function main(argv) {
  let manifestPath = DEFAULT_MANIFEST;
  let registryPath = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--manifest" && argv[i + 1]) manifestPath = argv[++i];
    else if (argv[i] === "--registry" && argv[i + 1]) registryPath = argv[++i];
    else {
      console.error(`fleet-manifest-drift: unknown argument: ${argv[i]}`);
      console.error("usage: node fleet-manifest-drift.mjs [--manifest PATH] [--registry PATH]");
      return 2;
    }
  }

  if (!existsSync(manifestPath)) {
    console.error(`fleet-manifest-drift: manifest not found: ${manifestPath}`);
    return 2;
  }
  const manifestIds = parseManifestNodes(readFileSync(manifestPath, "utf8"));
  if (!manifestIds) {
    console.error(`fleet-manifest-drift: no '## Node registry' table with rows in ${manifestPath}`);
    return 2;
  }

  let reg;
  if (registryPath) {
    if (!existsSync(registryPath)) {
      console.error(`fleet-manifest-drift: registry file not found: ${registryPath}`);
      return 2;
    }
    try {
      reg = { ok: true, registry: JSON.parse(readFileSync(registryPath, "utf8")) };
    } catch (e) {
      console.error(`fleet-manifest-drift: registry JSON unparseable (${registryPath}): ${e.message}`);
      return 2;
    }
  } else {
    reg = fetchRegistry();
  }
  if (!reg.ok) {
    // Loud skip, exit 0: a cell without a cross-repo credential must not mint
    // a false aligned NOR a false drift — the skip line rides the gate log.
    console.error(`SKIP fleet-manifest-drift: tower registry unreachable — ${reg.why}`);
    console.error("  (the fence needs gh + GH_TOKEN with read on " + REGISTRY_REPO + "; a skipped fence is visible, never silent)");
    return 0;
  }

  const regNodes = registryNodes(reg.registry);
  if (!regNodes.length) {
    console.error("fleet-manifest-drift: registry carries zero nodes — refusing to bless an empty diff");
    return 2;
  }
  const { missing, stale } = drift(manifestIds, regNodes);
  if (!missing.length && !stale.length) {
    console.log(`fleet-manifest-drift: aligned — ${manifestIds.length} manifest nodes match ${REGISTRY_REPO}@${REGISTRY_PATH} (${regNodes.length} registry nodes)`);
    return 0;
  }
  console.error(`fleet-manifest-drift: DRIFT — ${manifestPath} vs ${REGISTRY_REPO}@${REGISTRY_PATH}`);
  for (const n of missing) {
    console.error(`  registry node MISSING from manifest: ${n.id} (machine ${n.machine}, ${n.os}, lane ${n.lane})${n.note ? ` — ${n.note}` : ""}`);
  }
  for (const id of stale) {
    console.error(`  manifest row STALE — registry no longer carries: ${id}`);
  }
  console.error("  fix: owner-edit config/fleet-manifest.md (node table + Last aligned date) to follow the tower registry");
  return 1;
}

// Symlink-safe self-invocation guard (the #302 class): import.meta.url
// resolves to the module's realpath; realpathSync resolves the INVOKED path
// the same way, so a symlinked argv no longer silently skips main().
const invokedAsEntry = (() => {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();

if (invokedAsEntry) {
  process.exit(main(process.argv.slice(2)));
}
