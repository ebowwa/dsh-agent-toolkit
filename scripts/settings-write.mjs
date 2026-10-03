#!/usr/bin/env node
// settings-write.mjs — the agent template's settings write: PRESERVE by
// default, refuse a symlinked target loudly (FleetTower #642).
//
// THE DEFECT this replaces: run-dsh-agent.sh regenerated
// $DSH_HOME/settings.yaml on EVERY spawn by overwriting it with the
// stamped template (`node -e` regex stamp, then a `|| cp` fallback) —
// a full overwrite that followed symlinks. Any key the template does
// not manage (the user's nested provider routes, per-route credential
// pins) was dropped on every spawn, and through a symlinked settings
// path the overwrite landed in the USER's own file — the air16 clobber
// class (FleetTower #640: three stomps 2026-09-21/28/30).
//
// THE CONTRACT here:
//   1. the settings target must be a REAL FILE (lstat — the
//      lane-settings-guard rule; a symlink refuses the write LOUDLY,
//      exit 2, and nothing is touched);
//   2. first boot (file absent/blank) writes the stamped template
//      directly — nothing to preserve, no YAML runtime needed;
//   3. otherwise: read → normalize (the stamped template's own keys
//      win) → merge-preserve (every key the template does not set, at
//      any depth, rides through verbatim — preserveUnknownRoutes) →
//      atomic write (temp + rename, mode 0600);
//   4. no YAML runtime resolvable, or the existing file does not
//      parse → refuse (exit 3), file untouched. Never fall back to an
//      unmerged overwrite: silent-wrong is the defect this fixes.
//
// YAML resolution ladder (in order): Bun.YAML (bun runs), node:yaml
// (future builtin, probed at runtime), js-yaml resolved from the dsh
// install tree — the same parser @deepseek-ai/dsh uses to read the
// file back (dsh@0.1.0-rc.7 depends on js-yaml ^4.2.0). Probed roots:
// the repo's node_modules, the `dsh` on PATH (walked up to its package
// root), the node-executable's global module dir, and the driver's
// user-prefix fallback ($DSH_HOME/npm-global).
//
// Serialization note (honest limitation, same class as the tower lib):
// YAML comments do not survive a re-serialization. Values — including
// every preserved route and pin — do, and the write is byte-stable
// from the second spawn on. The old behavior lost the VALUES; this
// loses only comments.
//
// If/when upstream @deepseek-ai/dsh-settings ships a preserve-aware
// user-layer write, this helper and its two lib ports go and the
// upstream version is pinned instead (FleetTower #642 work order 3).
import { createRequire } from 'node:module';
import { lstatSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { checkLaneSettings } from './lane-settings-guard.mjs';
import { normalizeWritePreserving } from './settings-normalize.mjs';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));

/** The model-id charset the driver's own subagent stamp validates — the
 * stamped id lands INSIDE structured YAML, so metacharacters (newline,
 * `: `, ` #`, space) are an injection vector, not a cosmetic concern. */
export function assertSafeModelId(modelId) {
  const residue = String(modelId).replace(/[A-Za-z0-9._\-/]/g, '');
  if (residue !== '') {
    throw new Error(`settings-write: model id may contain only [A-Za-z0-9._-/] — the value is stamped into structured YAML (got '${modelId}')`);
  }
}

/**
 * The template stamp, byte-compatible with the old inline `node -e`:
 * the two-space-indented `model:` line under agent-default-model is
 * replaced wholesale. The function-form replacement keeps `$` in the
 * id literal (the string form would expand `$&`-class patterns).
 */
export function stampModel(templateText, modelId) {
  assertSafeModelId(modelId);
  return String(templateText).replace(/^  model: \S+$/m, () => `  model: ${modelId}`);
}

/** One YAML runtime candidate: name (for logs) + parse/stringify. */
function jsYamlAt(root) {
  try {
    const req = createRequire(join(root, 'noop.js'));
    const y = req('js-yaml');
    // canary: the rung must BOTH parse and serialize before it counts
    if (y.load('a: 1\n')?.a !== 1) return null;
    if (typeof y.dump !== 'function') return null;
    return {
      name: `js-yaml (${root})`,
      parse: (t) => y.load(t),
      stringify: (v) => y.dump(v, { lineWidth: -1 }),
    };
  } catch {
    return null;
  }
}

/** The `dsh` binaries on PATH, each walked up to its package root
 * (…/@deepseek-ai/dsh) — the install the template itself spawns, so
 * the parser is the version-aligned one. */
function dshPackageRootsFromPath() {
  const out = [];
  for (const dir of (process.env.PATH || '').split(':')) {
    if (!dir) continue;
    let real;
    try {
      real = realpathSync(join(dir, 'dsh'));
    } catch {
      continue;
    }
    let cur = dirname(real);
    for (let i = 0; i < 8; i++) {
      try {
        const pkg = JSON.parse(readFileSync(join(cur, 'package.json'), 'utf8'));
        if (pkg && pkg.name === '@deepseek-ai/dsh' && !out.includes(cur)) out.push(cur);
        break;
      } catch {
        const up = dirname(cur);
        if (up === cur) break;
        cur = up;
      }
    }
  }
  return out;
}

/**
 * Resolve a YAML runtime for the settings write. Returns
 * { name, parse, stringify } or null (caller refuses, loudly). Bun
 * first, then a future node builtin, then js-yaml from the dsh tree.
 */
export function resolveYaml() {
  if (typeof Bun !== 'undefined' && Bun.YAML) {
    return { name: 'Bun.YAML', parse: (t) => Bun.YAML.parse(t), stringify: (v) => Bun.YAML.stringify(v) };
  }
  try {
    // a future Node builtin — probed at runtime, costs nothing today
    const y = createRequire(import.meta.url)('node:yaml');
    if (y && typeof y.parse === 'function' && typeof y.stringify === 'function') {
      return { name: 'node:yaml', parse: (t) => y.parse(t), stringify: (v) => y.stringify(v) };
    }
  } catch {
    // not this Node — fall through to the dsh tree
  }
  const roots = [];
  const push = (r) => {
    if (r && !roots.includes(r)) roots.push(r);
  };
  push(join(SCRIPT_DIR, '..', 'node_modules'));
  for (const r of dshPackageRootsFromPath()) push(r);
  push(join(dirname(process.execPath), '..', 'lib', 'node_modules', '@deepseek-ai', 'dsh'));
  if (process.env.DSH_HOME) {
    push(join(process.env.DSH_HOME, 'npm-global', 'lib', 'node_modules', '@deepseek-ai', 'dsh'));
  }
  for (const root of roots) {
    const candidate = jsYamlAt(root);
    if (candidate) return candidate;
  }
  return null;
}

/** Atomic write: temp file in the target dir + rename, mode 0600. */
function writeAtomic(path, text) {
  const tmp = join(dirname(path), `.${path.split('/').pop()}.settings-write-${process.pid}.tmp`);
  writeFileSync(tmp, text, { mode: 0o600 });
  renameSync(tmp, path);
}

/**
 * The guarded write the driver invokes. Returns
 *   { ok: true, mode: 'first-boot' | 'merge-preserve', yaml?, bytes }
 * or { ok: false, code: 2 | 3, reason } — 2 = guard refusal (misconfigured
 * lane: symlink / not a file), 3 = environment or parse refusal. Either
 * way the caller must treat the spawn as failed: there is NO fallback
 * overwrite — silence is the clobber class.
 */
export function runWrite({ settingsPath, templatePath, modelId }) {
  // 1. the lstat refusal, BEFORE anything is read or written
  const guard = checkLaneSettings(settingsPath);
  if (!guard.ok) {
    return { ok: false, code: 2, reason: `refusing settings write — ${guard.path} ${guard.reason}` };
  }
  let stamped;
  try {
    stamped = stampModel(readFileSync(templatePath, 'utf8'), modelId);
  } catch (err) {
    return { ok: false, code: 3, reason: `template unreadable or model id unsafe: ${(err && err.message) || err}` };
  }
  // 2. first boot: nothing to preserve — write the stamped template
  //    directly; no YAML runtime is needed when there is nothing to
  //    merge (fresh lanes and job-scoped homes boot on any box)
  let existing = null;
  try {
    existing = readFileSync(settingsPath, 'utf8');
  } catch (err) {
    if (!err || err.code !== 'ENOENT') {
      return { ok: false, code: 3, reason: `existing settings unreadable: ${(err && err.message) || err}` };
    }
  }
  if (existing === null || existing.trim() === '') {
    writeAtomic(settingsPath, stamped);
    return { ok: true, mode: 'first-boot', bytes: stamped.length };
  }
  // 3. merge-preserve path — needs a real YAML runtime
  const yaml = resolveYaml();
  if (!yaml) {
    return {
      ok: false,
      code: 3,
      reason: 'no YAML runtime available (probed Bun.YAML, node:yaml, js-yaml from the repo node_modules, the dsh install tree, and $DSH_HOME/npm-global) — refusing to overwrite an EXISTING settings file; install @deepseek-ai/dsh or remove the stale file',
    };
  }
  try {
    const text = normalizeWritePreserving(settingsPath, () => yaml.parse(stamped), {
      parse: yaml.parse,
      stringify: yaml.stringify,
    });
    return { ok: true, mode: 'merge-preserve', yaml: yaml.name, bytes: text.length };
  } catch (err) {
    return {
      ok: false,
      code: 3,
      reason: `normalize-write refused — existing settings left untouched: ${(err && err.message) || err}`,
    };
  }
}

// --- CLI: node settings-write.mjs <settingsPath> <templatePath> <modelId> --
function main(argv) {
  const [settingsPath, templatePath, modelId] = argv;
  if (!settingsPath || !templatePath || !modelId) {
    console.error('usage: node settings-write.mjs <settingsPath> <templatePath> <modelId>');
    return 2;
  }
  const res = runWrite({ settingsPath, templatePath, modelId });
  if (!res.ok) {
    console.error(`settings-write: ${res.reason}`);
    return res.code;
  }
  console.error(
    `settings-write: ${res.mode} write ok (${res.bytes} bytes)${res.yaml ? ` via ${res.yaml}` : ' — no YAML runtime needed (nothing to preserve)'}`,
  );
  return 0;
}

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
