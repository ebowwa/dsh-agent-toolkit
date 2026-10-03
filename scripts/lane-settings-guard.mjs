// lane-settings-guard.mjs — the settings.yaml symlink tripwire.
//
// Verbatim port of FleetTower #641's scripts/lib/lane-settings-guard.mjs
// (issue #640 work order 1) into the agent template: every
// run-dsh-agent.sh spawn writes $DSH_HOME/settings.yaml, so the SAME
// lstat rule the tower's enroll/deploy paths enforce has to hold here —
// a write through a symlink is the air16 clobber class.
//
// THE CLASS: air16's lane home (~/.dsh-open/settings.yaml) sat as a
// SYMLINK into the user's ~/.dsh/settings.yaml since Aug 31. Every
// agent spawn runs settings read → normalize → atomic-write THROUGH the
// link, so every persisted DSH_MODEL override normalize-wrote the
// USER's provider file — three clobbers (2026-09-21/28/30, backups
// settings.yaml.clobbered-fleet-template-20260921, .fleet-clobber-
// 20260928.bak, .fleet-clobber-20260930.bak) before the mechanism was
// named. The mini lanes were never symlinks; the interim fix (09-30
// 00:31Z) replaced the link with a real lane-owned file.
//
// THE CONTRACT: the template's settings write path asserts that the
// settings target is a REAL FILE. A symlink fails LOUDLY — this module
// never silently skips, and never follows the link (stat would happily
// report the target's regular-file-ness; only lstat sees the link
// itself). A MISSING settings.yaml is fine (nothing to clobber — first
// boot). A directory/device/anything-else is also a fail.
//
// Everything here is pure fs-introspection: no writes, no unlinking.
// The guard REFUSES and says why; replacing the symlink with a real
// lane-owned file stays a human/operator action by design (auto-
// "fixing" would itself be a clobber of whatever the link targeted).
import { lstatSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/** The settings file every lane home carries. */
export const LANE_SETTINGS_BASENAME = 'settings.yaml';

/** The lane home a node loop resolves settings through. */
export function laneSettingsPath(laneHome) {
  return join(String(laneHome), LANE_SETTINGS_BASENAME);
}

/**
 * Inspect one lane settings path WITHOUT following symlinks.
 * Returns { ok: true, path, kind } when the path is a real file (or
 * absent — nothing to clobber), and { ok: false, path, kind, reason }
 * for a symlink or any other non-regular-file shape. Never throws for
 * the shapes it inspects; a genuinely unreadable filesystem state
 * surfaces as ok:false with reason 'stat-failed'.
 */
export function checkLaneSettings(settingsPath) {
  const path = String(settingsPath);
  let st;
  try {
    st = lstatSync(path);
  } catch (err) {
    if (err && err.code === 'ENOENT') return { ok: true, path, kind: 'absent' };
    return { ok: false, path, kind: 'stat-failed', reason: `lstat failed: ${String(err.code ?? err)}` };
  }
  if (st.isSymbolicLink()) {
    return {
      ok: false,
      path,
      kind: 'symlink',
      reason: 'SYMLINK — every lane normalize-write would stomp the link target (the 2026-09-21/28/30 settings.yaml clobber class); replace with a real lane-owned file',
    };
  }
  if (!st.isFile()) {
    return { ok: false, path, kind: 'not-a-file', reason: `not a regular file (mode ${st.mode.toString(8)})` };
  }
  return { ok: true, path, kind: 'real-file' };
}

/**
 * The assert form write paths call: throws a loud Error on any
 * non-real-file shape, returns the ok result otherwise. The error
 * message carries the path and the clobber-class context — the "fail
 * loudly" of the work order.
 */
export function assertLaneSettingsRealFile(settingsPath) {
  const res = checkLaneSettings(settingsPath);
  if (!res.ok) {
    throw new Error(`lane-settings-guard: ${res.path} ${res.reason}`);
  }
  return res;
}

/**
 * Every lane home worth guarding on this box: the node's own resolved
 * lane home (DSH_HOME when set, ~/.dsh when not) plus every sibling
 * ~/.dsh-* lane home. Sorted for deterministic logs. Never follows
 * symlinks — a symlinked lane HOME is exactly the finding, so the dir
 * scan lists entries by name (readdirSync, no realpath) and the per-
 * path check above does the lstat.
 */
export function laneHomesUnder(homeDir, primaryLaneHome) {
  const homes = new Set();
  if (primaryLaneHome) homes.add(String(primaryLaneHome));
  let entries = [];
  try {
    entries = readdirSync(String(homeDir));
  } catch {
    entries = [];
  }
  for (const name of entries) {
    if (/^\.dsh-/.test(name)) homes.add(join(String(homeDir), name));
  }
  return [...homes].sort();
}

/**
 * Check every lane home under `homeDir` (+ the primary). Returns one
 * { path, ok, kind, reason? } row per lane settings file. Never throws
 * — callers log the !ok rows loudly and refuse the paths that depend
 * on them.
 */
export function scanLaneSettings(homeDir, primaryLaneHome) {
  return laneHomesUnder(homeDir, primaryLaneHome).map((h) => {
    const res = checkLaneSettings(laneSettingsPath(h));
    return { laneHome: h, path: res.path, ok: res.ok, kind: res.kind, ...(res.reason ? { reason: res.reason } : {}) };
  });
}
