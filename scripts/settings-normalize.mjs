// settings-normalize.mjs — the normalize-write that PRESERVES unknown
// and nested provider routes.
//
// Verbatim port of FleetTower #641's scripts/lib/settings-normalize.mjs
// (issue #640 work order 2) into the agent template — the WRITE that
// actually stomped the user's provider file lives HERE: every
// run-dsh-agent.sh spawn resolves settings via DSH_HOME, and the rc.7
// runtime normalizer (@deepseek-ai/dsh-settings) is a flat catalog
// writer that DROPS unknown/nested provider routes. FleetTower #642
// wires this port into the template's write path; when upstream
// @deepseek-ai/dsh-settings ships a preserve-aware user-layer write,
// the lane patch goes and the upstream version is pinned instead.
//
// THE CLASS: the rc.7 normalizer (@deepseek-ai/dsh-settings user-layer
// write) is a FLAT catalog writer — a normalize-write DROPS the user's
// nested provider routes (opencode-go / opencode-go-2 / per-route
// credential pins) and glues its zai/glm catalog in, so a lane agent's
// persisted DSH_MODEL override stomped the user's multi-provider file
// (three clobbers, issue #640 body). Same parser class as FT#542
// (rc.7 flat-only credentials).
//
// THE CONTRACT: a normalize-write here is
//   original → normalize (the writer's OWN keys win) → MERGE-PRESERVE
//   (every original key the normalizer did not set, at ANY depth, is
//   carried through untouched) → atomic write.
// The normalizer keeps the keys it manages (its catalog, the resolved
// model); the USER's unknown/nested routes survive every write. A
// symlink at the settings path fails the write LOUDLY (the lane-
// settings-guard rule — never write through the link).
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { checkLaneSettings } from './lane-settings-guard.mjs';

/** Plain object (not array, not null) — the recursion predicate. */
export function isPlainObject(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Route-entry identity inside an array: id, name, or route — else null. */
function routeId(entry) {
  if (!isPlainObject(entry)) return null;
  for (const k of ['id', 'name', 'route']) {
    if (typeof entry[k] === 'string' && entry[k] !== '') return `${k}:${entry[k]}`;
  }
  return null;
}

/** Index an array's entries by their route id (first wins). */
function byRouteId(arr) {
  const m = new Map();
  for (const e of arr) {
    const id = routeId(e);
    if (id !== null && !m.has(id)) m.set(id, e);
  }
  return m;
}

/**
 * Deep merge-preserve: for every key of `original` that `normalized`
 * does not carry, the original value is cloned through verbatim; where
 * both sides are objects the merge recurses; where both sides are
 * ROUTE ARRAYS (entries with an id/name/route), original-only routes
 * are appended and shared routes merge-preserve per-entry. The
 * normalizer's own values win for keys it sets — the user's unknown
 * keys and nested pins never lose.
 */
export function preserveUnknownRoutes(normalized, original) {
  if (!isPlainObject(original)) return normalized;
  const out = isPlainObject(normalized) ? { ...normalized } : normalized;
  for (const [key, origVal] of Object.entries(original)) {
    // OWN-key test only (issue #330, the FleetTower #791 class): `key in
    // out` consults the prototype chain, so a user key named like an
    // Object.prototype member (constructor / toString / hasOwnProperty /
    // ...) read as "the normalizer set it", was never copied, and
    // silently dropped from the written file — Object.entries/stringify
    // below only ever see OWN keys.
    if (!Object.hasOwn(out, key)) {
      out[key] = clone(origVal);
      continue;
    }
    const normVal = out[key];
    if (isPlainObject(origVal) && isPlainObject(normVal)) {
      out[key] = preserveUnknownRoutes(normVal, origVal);
      continue;
    }
    if (Array.isArray(origVal) && Array.isArray(normVal)) {
      out[key] = preserveRouteArray(normVal, origVal);
    }
    // scalars: the normalizer's value stands (it owns the keys it set)
  }
  return out;
}

function preserveRouteArray(normalizedArr, originalArr) {
  const origById = byRouteId(originalArr);
  const keptIds = new Set();
  const out = normalizedArr.map((entry) => {
    const id = routeId(entry);
    if (id === null || !origById.has(id)) return entry;
    keptIds.add(id);
    const origEntry = origById.get(id);
    if (isPlainObject(entry) && isPlainObject(origEntry)) return preserveUnknownRoutes(entry, origEntry);
    return entry;
  });
  // original-only routes ride at the END, verbatim, order preserved
  for (const [id, entry] of origById) {
    if (!keptIds.has(id)) out.push(clone(entry));
  }
  return out;
}

function clone(v) {
  if (Array.isArray(v)) return v.map(clone);
  if (isPlainObject(v)) {
    const o = {};
    for (const [k, val] of Object.entries(v)) o[k] = clone(val);
    return o;
  }
  return v;
}

/**
 * The guarded normalize-write: refuse a symlinked settings path LOUDLY
 * (throw — the lane-settings-guard rule), then apply `normalize` to the
 * parsed current settings, merge-preserve the original, and write
 * ATOMICALLY (temp file + rename in the same dir — the write the
 * clobber class rode was atomic but link-following; this one never
 * even opens the path for writing when it is a link).
 *
 * `parse`/`stringify` default to Bun.YAML when present (settings.yaml
 * is YAML), falling back to JSON. The template's settings-write.mjs
 * passes an explicit YAML pair (Bun.YAML → node:yaml → js-yaml from
 * the dsh install tree). Returns the text written.
 */
export function normalizeWritePreserving(settingsPath, normalize, { parse, stringify } = {}) {
  const res = checkLaneSettings(settingsPath);
  if (!res.ok) {
    throw new Error(`lane-settings-guard: refusing normalize-write — ${res.path} ${res.reason}`);
  }
  const path = String(settingsPath);
  const p = parse ?? defaultParse();
  const s = stringify ?? defaultStringify();
  let original = {};
  let have = '';
  try {
    have = readText(path);
    if (have.trim() !== '') original = p(have);
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      original = {};
    } else {
      throw err;
    }
  }
  const normalized = normalize(isPlainObject(original) ? clone(original) : {});
  const merged = preserveUnknownRoutes(normalized, isPlainObject(original) ? original : {});
  const text = s(merged);
  const tmp = join(dirname(path), `.${path.split('/').pop()}.normalize-${process.pid}.tmp`);
  writeFileSync(tmp, text, { mode: 0o600 });
  renameSync(tmp, path);
  return text;
}

function readText(path) {
  return readFileSync(path, 'utf-8');
}

function defaultParse() {
  if (typeof Bun !== 'undefined' && Bun.YAML) return (t) => Bun.YAML.parse(t);
  return (t) => JSON.parse(t);
}
function defaultStringify() {
  if (typeof Bun !== 'undefined' && Bun.YAML && Bun.YAML.stringify) return (v) => Bun.YAML.stringify(v);
  return (v) => JSON.stringify(v, null, 2) + '\n';
}
