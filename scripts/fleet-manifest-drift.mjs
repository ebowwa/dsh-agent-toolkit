#!/usr/bin/env node
// fleet-manifest-drift.mjs — standing-registry drift fence (issue #397).
//
// Why this exists: config/fleet-manifest.md self-describes as the standing
// fleet context injected into every dispatched agent's task prompt, but
// nothing backed its "owner-edit it when the pool changes" instruction —
// the copy rotted silently for 8 days while the live tower registry
// (FleetTower fleet.manifest.json) gained both air machines. Receipt
// (2026-10-04, issue #397): air16-native-open alone minted 110 of the
// day's claim rows while every agent's injected registry pretended it did
// not exist, and agents misread its ledger rows as phantom-node output.
//
// What it does: parses the node table out of the manifest markdown,
// collects node ids across machines from the tower registry JSON, and
// diffs the two id sets. Drift fails LOUD — a stale table mis-places work.
//
// Usage: node scripts/fleet-manifest-drift.mjs [--manifest <path>] [--registry <path|->]
//   --manifest  the standing registry markdown
//               (default: this repo's config/fleet-manifest.md)
//   --registry  the tower registry JSON — a file path, or `-` for stdin.
//               Default: gh api repos/$DSH_TOWER_REPO/contents/fleet.manifest.json
//               (the same registry the manifest's own header cites).
//
// exit: 0  aligned — table and registry carry the same node id set
//       1  DRIFT — the sets disagree; re-sync the table, bump its
//          "Last aligned" date, and cite this run in the PR
//       2  fail-closed — unreadable input, unparseable JSON/table, or bad
//          usage. Never a silent green: an unreadable registry is a red,
//          not a pass.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_MANIFEST = path.join(SCRIPT_DIR, "..", "config", "fleet-manifest.md");
const REGISTRY_REPO = process.env.DSH_TOWER_REPO || "ebowwa/FleetTower";
const REGISTRY_FILE = "fleet.manifest.json";

// --- pure core (exported for tests) -----------------------------------------

// Parse the node table under "## Node registry" into {id, os, lanes, note}
// rows. Throws on a missing section, a duplicate node id, or a table with
// no rows — a malformed standing registry is a defect, not a skip.
export function parseNodeTable(md) {
  const lines = md.split(/\r?\n/);
  const at = lines.findIndex(l => /^##\s+Node registry\s*$/.test(l));
  if (at === -1) throw new Error("no '## Node registry' section in the manifest");
  const rows = [];
  const seen = new Set();
  let started = false;
  for (const line of lines.slice(at + 1)) {
    if (!line.startsWith("|")) {
      if (started) break; // the table ended; stop at the prose that follows
      continue; // prose between the heading and the table
    }
    started = true;
    const cells = line.split("|").map(c => c.trim());
    cells.shift();
    cells.pop(); // drop the empties the edge pipes produce
    if (cells.length < 4) continue; // not a full row (a stray one-cell line)
    if (cells.every(c => /^:?-{2,}:?$/.test(c))) continue; // separator row
    if (cells[0] === "Nodes") continue; // the header row
    const [id, os, lanes, ...note] = cells;
    if (!id) continue;
    if (seen.has(id)) throw new Error(`duplicate node id in the table: ${id}`);
    seen.add(id);
    rows.push({ id, os, lanes, note: note.join("|") });
  }
  if (!rows.length) throw new Error("the node table has no rows");
  return rows;
}

// Collect node ids across every machine in a parsed tower registry.
// Throws on a shape that cannot answer the question (no machines object,
// a machine without a nodes array, a node without an id) — fail-closed.
export function registryNodeIds(registry) {
  const machines = registry?.machines;
  if (!machines || typeof machines !== "object" || Array.isArray(machines)) {
    throw new Error("registry JSON has no machines object");
  }
  const ids = [];
  for (const [machine, def] of Object.entries(machines)) {
    if (!Array.isArray(def?.nodes)) {
      throw new Error(`machine ${machine} has no nodes array`);
    }
    for (const node of def.nodes) {
      if (!node?.id) throw new Error(`machine ${machine} carries a node without an id`);
      ids.push(node.id);
    }
  }
  if (!ids.length) throw new Error("the registry carries no nodes");
  return ids;
}

// Diff the two id sets. Empty on both sides = aligned.
export function diffIds(manifestIds, registryIds) {
  const m = new Set(manifestIds);
  const r = new Set(registryIds);
  return {
    missingFromManifest: registryIds.filter(id => !m.has(id)),
    notInRegistry: manifestIds.filter(id => !r.has(id)),
  };
}

// --- IO + CLI ---------------------------------------------------------------

function readRegistryText(registryArg) {
  if (registryArg === "-") return readFileSync(0, "utf8");
  if (registryArg !== undefined) {
    if (!existsSync(registryArg)) {
      throw new Error(`registry file not found: ${registryArg}`);
    }
    return readFileSync(registryArg, "utf8");
  }
  // default: the tower registry over the gh API (the shared account's
  // universal tool; works for private checkouts where raw fetch cannot)
  const res = spawnSync("gh", [
    "api", `repos/${REGISTRY_REPO}/contents/${REGISTRY_FILE}`, "--jq", ".content",
  ], { encoding: "utf8" });
  if (res.error) {
    throw new Error(`cannot spawn gh (${res.error.message}) — pass --registry <path> to check offline`);
  }
  if (res.status !== 0) {
    throw new Error(
      `gh api repos/${REGISTRY_REPO}/contents/${REGISTRY_FILE} exited ${res.status}: ${(res.stderr || "").trim()}`,
    );
  }
  return Buffer.from(res.stdout, "base64").toString("utf8");
}

function usage(msg) {
  if (msg) console.error(`fleet-manifest-drift: ${msg}`);
  console.error("usage: node scripts/fleet-manifest-drift.mjs [--manifest <path>] [--registry <path|->]");
  return 2;
}

export function main(argv) {
  let manifestPath = DEFAULT_MANIFEST;
  let registryArg;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--manifest" && argv[i + 1] !== undefined) manifestPath = argv[++i];
    else if (argv[i] === "--registry" && argv[i + 1] !== undefined) registryArg = argv[++i];
    else return usage(`unknown or incomplete argument: ${argv[i]}`);
  }
  let manifestText;
  try {
    manifestText = readFileSync(manifestPath, "utf8");
  } catch (err) {
    console.error(`fleet-manifest-drift: cannot read manifest ${manifestPath}: ${err.message}`);
    return 2;
  }
  let registry;
  try {
    registry = JSON.parse(readRegistryText(registryArg));
  } catch (err) {
    console.error(`fleet-manifest-drift: registry unreadable or unparseable: ${err.message}`);
    return 2;
  }
  let rows;
  let regIds;
  try {
    rows = parseNodeTable(manifestText);
    regIds = registryNodeIds(registry);
  } catch (err) {
    console.error(`fleet-manifest-drift: ${err.message}`);
    return 2;
  }
  const manifestIds = rows.map(r => r.id);
  const source = registryArg === "-"
    ? "stdin"
    : registryArg ?? `gh api repos/${REGISTRY_REPO}/contents/${REGISTRY_FILE}`;
  const { missingFromManifest, notInRegistry } = diffIds(manifestIds, regIds);
  if (!missingFromManifest.length && !notInRegistry.length) {
    console.log(
      `fleet-manifest-drift: aligned — ${manifestIds.length} nodes in both ${manifestPath} and ${source}`,
    );
    return 0;
  }
  console.error("fleet-manifest-drift: DRIFT — the standing manifest and the tower registry disagree");
  for (const id of missingFromManifest) {
    console.error(`  registry node MISSING from the manifest table: ${id}`);
  }
  for (const id of notInRegistry) {
    console.error(`  manifest node NOT in the tower registry: ${id}`);
  }
  console.error(`  re-sync: edit ${manifestPath}, bump "Last aligned", cite this run (issue #397)`);
  return 1;
}

// Hardened self-invocation guard (the #302/#324 class): compare the URL,
// then fall back to realpath on both sides — through a symlinked wrapper
// (wrapper dirs, /tmp → /private/tmp) the naive import.meta.url compare
// false-skips and the CLI exits 0 having done nothing.
const THIS_FILE = fileURLToPath(import.meta.url);
function isMain() {
  if (!process.argv[1]) return false;
  if (import.meta.url === pathToFileURL(process.argv[1]).href) return true;
  try {
    return realpathSync(process.argv[1]) === realpathSync(THIS_FILE);
  } catch {
    return false;
  }
}

if (isMain()) {
  process.exit(main(process.argv.slice(2)));
}
