// plugin-smoke-skip-guard.test.mjs — pins the bare-gate loud-skip guard
// in the three plugin smoke suites (issue #358).
//
// Regression anchor: the smokes import their plugin's lib/index.js, which
// imports @deepseek-ai/* workspace deps a bare clone has not installed —
// the module LOAD threw ERR_MODULE_NOT_FOUND, so bare `node --test` (the
// CI-parity gate form) carried 3 guaranteed reds on every fresh clone
// that looked like PLUGIN breakage rather than box state (a
// misclassification magnet; the #280 family). These tests fail without
// the guard: delete any smoke's catch block and the behavioral leg goes
// red on a bare tree; silence its SKIP reason and the structural leg
// goes red everywhere.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const SMOKES = [
  "plugins/dsh-stream-watchdog/test/smoke.mjs",
  "plugins/dsh-system-prompt-editor/test/smoke.mjs",
  "plugins/dsh-system-prompt-ui/test/smoke.mjs",
];

for (const rel of SMOKES) {
  test(`${rel}: green or LOUD skip on any tree — never a MODULE_NOT_FOUND red (issue #358)`, () => {
    const res = spawnSync(process.execPath, [path.join(ROOT, rel)], { encoding: "utf8" });
    const output = `${res.stdout ?? ""}${res.stderr ?? ""}`;
    assert.equal(res.status, 0, `smoke must exit 0 — real run on a converged tree, loud skip on a bare one; got exit ${res.status}\n${output}`);
    assert.doesNotMatch(output, /ERR_MODULE_NOT_FOUND/, "a bare tree skips loud, it does not red with a module-load stack");
    if (/SKIP\t/.test(output)) {
      assert.match(output, /install-plugin-smoke-deps/, "a skip names its fix (the converging installer)");
    }
  });

  test(`${rel}: the guard is structural — catch the module-load failure, SKIP loud, exit 0`, () => {
    const src = readFileSync(path.join(ROOT, rel), "utf8");
    assert.match(src, /ERR_MODULE_NOT_FOUND/, "catches the module-load failure by code");
    assert.match(src, /SKIP\\t/, "prints the census-able SKIP\\t line");
    assert.match(src, /install-plugin-smoke-deps/, "the skip reason names the converging fix");
    assert.match(src, /process\.exit\(0\)/, "a skip stays green");
  });
}
