// tests/plugin-smoke-fresh-clone.test.mjs — pins issue #358: every plugin
// smoke whose lib reaches deps a fresh clone lacks must carry the
// fresh-clone loud-skip guard. Those deps come from
// scripts/install-plugin-smoke-deps.mjs (CI gates run it before the suite);
// a bare `gh repo clone` does not have them, so an unguarded smoke dies
// ERR_MODULE_NOT_FOUND under the CI-parity form (`node --test`) — a
// guaranteed box-state red that misreads as plugin breakage and burns a
// classification round on every fresh-clone agent (the #358 receipt: 3
// MODULE_NOT_FOUND reds on pristine main, identical with and without an
// unrelated PR's diff).
//
// The guard contract pinned here (see any guarded plugins/*/test/smoke.mjs):
//   1. probe the lib load BEFORE test registration, catching only
//      ERR_MODULE_NOT_FOUND (any other load error rethrows — fail-closed),
//   2. skip as a counted node:test { skip } whose reason names the first
//      missing package and the installer command,
//   3. the suite body runs only inside the registered test.
//
// These tests fail without the fix: revert any guarded smoke to a bare
// static import of ../lib (or delete its guard) and the pins below go red
// naming the file.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLUGINS = path.join(ROOT, "plugins");

// A smoke needs the guard when its plugin declares dependencies /
// peerDependencies, OR when any lib source imports @deepseek-ai/* or
// @local/* (cross-plugin workspace links the installer materializes —
// dsh-system-prompt-ui declares none yet its lib imports the editor).
function libReachesExternalDeps(pluginDir) {
  const lib = path.join(PLUGINS, pluginDir, "lib");
  if (!fs.existsSync(lib)) return false;
  const walk = (dir) =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((ent) => {
      const p = path.join(dir, ent.name);
      return ent.isDirectory() ? walk(p) : /\.(mjs|js)$/.test(ent.name) ? [p] : [];
    });
  return walk(lib).some((p) =>
    /from\s+["']@(deepseek-ai|local)\//.test(fs.readFileSync(p, "utf8")),
  );
}

const smokes = fs
  .readdirSync(PLUGINS)
  .flatMap((dir) => {
    const smoke = path.join(PLUGINS, dir, "test", "smoke.mjs");
    if (!fs.existsSync(smoke)) return [];
    const pkg = JSON.parse(
      fs.readFileSync(path.join(PLUGINS, dir, "package.json"), "utf8"),
    );
    const declared =
      Object.keys(pkg.dependencies ?? {}).length +
      Object.keys(pkg.peerDependencies ?? {}).length;
    return [
      {
        dir,
        src: fs.readFileSync(smoke, "utf8"),
        needsGuard: declared > 0 || libReachesExternalDeps(dir),
      },
    ];
  });

test("the #358 classifier: the four dep-reaching smokes are guard-required, the dep-free two are not", () => {
  const byDir = Object.fromEntries(smokes.map((s) => [s.dir, s.needsGuard]));
  assert.deepEqual(
    { ...byDir },
    {
      "dsh-queue-priority": false,
      "dsh-reflex": true,
      "dsh-session-id": false,
      "dsh-stream-watchdog": true,
      "dsh-system-prompt-editor": true,
      "dsh-system-prompt-ui": true,
    },
    "classifier drift — a plugin changed its dep surface; update this pin " +
      "deliberately (a new true must carry the guard in its smoke)",
  );
});

test("every guard-required smoke carries the loud-skip guard: ERR_MODULE_NOT_FOUND probe, counted skip, installer pointer", () => {
  const violators = smokes
    .filter((s) => s.needsGuard)
    .filter(
      (s) =>
        !/ERR_MODULE_NOT_FOUND/.test(s.src) ||
        !/\{\s*skip:\s*GUARD\.skip\s*\}/.test(s.src) ||
        !/install-plugin-smoke-deps/.test(s.src),
    )
    .map((s) => s.dir);
  assert.deepEqual(
    violators,
    [],
    "smokes missing the #358 fresh-clone loud-skip guard (probe + counted " +
      "skip + installer pointer): " +
      violators.join(", "),
  );
});

test("the guard is fail-closed: a non-module load error must rethrow, not skip", () => {
  const violators = smokes
    .filter((s) => s.needsGuard)
    .filter((s) => !/throw error;/.test(s.src))
    .map((s) => s.dir);
  assert.deepEqual(
    violators,
    [],
    "every guarded smoke must rethrow load errors other than " +
      "ERR_MODULE_NOT_FOUND (a skip must never swallow a real defect): " +
      violators.join(", "),
  );
});
