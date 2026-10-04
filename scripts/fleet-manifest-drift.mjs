#!/usr/bin/env node
// fleet-manifest-drift.mjs — the standing registry's drift fence (issue #397).
//
// `config/fleet-manifest.md` self-describes as the authoritative standing
// fleet context injected into every dispatched agent's task prompt, but
// nothing backed that claim: the copy rotted for 8 days while the live
// tower registry (FleetTower `fleet.manifest.json`) added three nodes on
// two machines — one of them (air16-native-open) carrying ~110 of the
// day's claim rows while absent from the file every agent planned
// against. The manifest's own instruction, "owner-edit it when the pool
// changes", had no drift check behind it.
//
// This script diffs the manifest's node registry table against the live
// tower registry and FAILS LOUD on drift:
//   - a tower node missing from the manifest table (the stale-copy rot)
//   - a manifest row the tower no longer lists (a retired/phantom node)
//   - an OS-class mismatch on a shared node (placement-law hazard)
// Lane prose and notes are NOT compared — the tower stores ordinal lane
// ids, the manifest renders served-lane semantics; only the load-bearing
// alignment (which nodes exist, on what OS class) is fenced.
//
// Tower read: FleetTower is PRIVATE, so the fetch goes through `gh api`
// (GH_BIN overridable, GH_TOKEN honored by gh itself). Unreachable is a
// CLASSIFIED red, never a silent green — a check that cannot see the
// registry has verified nothing.
//
// CI home: .github/workflows/fleet-manifest-drift.yml (pull_request on
// the fence's own paths + a daily schedule, because the drift that
// matters is tower-side: the toolkit repo does not change when the pool
// does). Pinned by tests/fleet-manifest-drift.test.mjs.

import { readFileSync } from "node:fs";
import { realpathSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const MANIFEST_PATH = path.join(SCRIPT_DIR, "..", "config", "fleet-manifest.md");
const TOWER_REPO = process.env.DSH_TOWER_REPO || "ebowwa/FleetTower";

/** Parse the manifest's node registry table into id -> {os, lanes, notes}.
 * Rows look like `| mini-L1 | macOS | mac (native toolchain) | ... |`;
 * the header row and the |---| separator are skipped. Any other table
 * that ever appears in the file must not start with a node-shaped cell —
 * the registry table is the only 4-column table the file carries. */
export function parseRegistryTable(md) {
  const nodes = new Map();
  for (const line of md.split("\n")) {
    const m = /^\|([^|]+)\|([^|]+)\|([^|]+)\|([^|]*)\|\s*$/.exec(line);
    if (!m) continue;
    const id = m[1].trim();
    if (id === "Nodes" || /^-{3,}$/.test(id)) continue; // header + separator
    nodes.set(id, { os: m[2].trim(), lanes: m[3].trim(), notes: m[4].trim() });
  }
  return nodes;
}

/** Flatten the tower registry's machines[].nodes[] into id -> {os, lane, note, machine}. */
export function towerNodesFromJson(registry) {
  const nodes = new Map();
  for (const [machine, def] of Object.entries(registry.machines ?? {})) {
    for (const node of def.nodes ?? []) {
      if (!node.id) continue;
      nodes.set(node.id, {
        os: normalizeOs(def.os),
        lane: node.lane ?? "",
        note: node.registryNote ?? "",
        machine,
      });
    }
  }
  return nodes;
}

const OS_CANON = { macos: "macOS", linux: "Linux", windows: "Windows" };
function normalizeOs(raw) {
  const key = String(raw ?? "").toLowerCase();
  return OS_CANON[key] ?? String(raw ?? "").trim();
}

/** Diff the two registries into a list of drift findings (empty = aligned). */
export function diffRegistries(manifestNodes, towerNodes) {
  const findings = [];
  for (const [id, tower] of towerNodes) {
    const row = manifestNodes.get(id);
    if (!row) {
      findings.push(
        `missing-from-manifest: ${id} (tower: ${tower.os}, lane ${tower.lane}, machine ${tower.machine}` +
          `${tower.note ? ` — ${tower.note}` : ""}) — add the row, the registry carried it`
      );
      continue;
    }
    if (normalizeOs(row.os) !== normalizeOs(tower.os)) {
      findings.push(
        `os-mismatch: ${id} (manifest says ${row.os}, tower says ${tower.os}) — placement-law hazard, fix the OS cell`
      );
    }
  }
  for (const id of manifestNodes.keys()) {
    if (!towerNodes.has(id)) {
      findings.push(
        `absent-from-tower: ${id} (manifest row carries a node the registry no longer lists) — retire the row`
      );
    }
  }
  return findings;
}

/** Fetch + decode the tower registry through gh (the repo is private).
 * Throws a classified Error on any failure — never returns a guess. */
export function fetchTowerRegistry({ ghBin = process.env.GH_BIN || "gh" } = {}) {
  const proc = spawnSync(
    ghBin,
    ["api", `repos/${TOWER_REPO}/contents/fleet.manifest.json`, "--jq", ".content"],
    { encoding: "utf8" }
  );
  if (proc.error) {
    throw new Error(`gh unavailable (${proc.error.message}) — the check cannot see the registry`);
  }
  if (proc.status !== 0) {
    const tail = String(proc.stderr ?? "").trim().split("\n").slice(-3).join(" | ");
    throw new Error(`gh api exited ${proc.status}${tail ? `: ${tail}` : ""} — the check cannot see the registry`);
  }
  const b64 = String(proc.stdout ?? "").replace(/\s+/g, "");
  let registry;
  try {
    registry = JSON.parse(Buffer.from(b64, "base64").toString("utf8"));
  } catch (err) {
    throw new Error(`tower registry is not valid JSON after decode (${err.message})`);
  }
  if (!registry || typeof registry !== "object" || !registry.machines) {
    throw new Error("tower registry decode carried no machines map — refusing to diff against a guess");
  }
  return registry;
}

export function main() {
  const manifest = readFileSync(MANIFEST_PATH, "utf8");
  const manifestNodes = parseRegistryTable(manifest);
  if (manifestNodes.size === 0) {
    console.error("fleet-manifest-drift: manifest table parse found ZERO nodes — parser or file is broken");
    process.exit(1);
  }
  let towerNodes;
  try {
    towerNodes = towerNodesFromJson(fetchTowerRegistry());
  } catch (err) {
    console.error(`fleet-manifest-drift: UNAVAILABLE — ${err.message}`);
    process.exit(1);
  }
  const findings = diffRegistries(manifestNodes, towerNodes);
  if (findings.length > 0) {
    console.error(`fleet-manifest-drift: DRIFT — ${findings.length} finding(s) between config/fleet-manifest.md and ${TOWER_REPO} fleet.manifest.json:`);
    for (const f of findings) console.error(`  - ${f}`);
    console.error("The manifest is the standing context every dispatched agent plans against — realign it (owner edit) and bump Last aligned.");
    process.exit(1);
  }
  console.log(
    `fleet-manifest-drift: aligned — ${manifestNodes.size} nodes, manifest table ↔ ${TOWER_REPO} fleet.manifest.json`
  );
}

// Symlink-safe CLI guard (the #302/#324 class lives in the naive
// import.meta.url ↔ argv[1] comparison): realpath BOTH sides so a
// symlinked argv[1] still runs main, and a bare import (tests) does not.
const isMain = (() => {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  try {
    return realpathSync(argv1) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();
if (isMain) main();
