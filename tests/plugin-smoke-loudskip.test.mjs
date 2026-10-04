// plugin-smoke-loudskip.test.mjs — pins the #358 loud-skip contract on the
// three plugin smokes that import @deepseek-ai/* / @local/* runtime deps.
//
// Regression anchor (issue #358): a bare `node --test` on a fresh clone —
// the CI-parity local gate form — ran the smokes WITHOUT the
// install-plugin-smoke-deps convergence step CI performs, so each smoke
// died at import time with ERR_MODULE_NOT_FOUND: three guaranteed reds on
// every fresh checkout that masquerade as plugin breakage (a
// misclassification magnet during gating rounds). The fix class: each
// smoke classifies bare-package absence as environmental — SKIP loud,
// exit 0 — while a broken relative import or a real code defect still
// rethrows red. These pins fail without the fix: revert any smoke to a
// static lib import (the guard cannot catch a static import, so the skip
// arm goes dead) and the source pins here go red; delete the classifier
// and run on a dep-less checkout and the spawn pin goes red with the
// MODULE_NOT_FOUND traceback it refuses.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const SMOKES = [
	"dsh-stream-watchdog",
	"dsh-system-prompt-editor",
	"dsh-system-prompt-ui",
].map((plugin) => ({
	plugin,
	file: path.join(ROOT, "plugins", plugin, "test", "smoke.mjs"),
}));

for (const { plugin, file } of SMOKES) {
	test(`${plugin}: the smoke carries the environmental loud-skip guard`, () => {
		const src = readFileSync(file, "utf8");
		// classify ONLY bare-package absence — the environmental arm
		assert.match(src, /ERR_MODULE_NOT_FOUND/, "guard inspects the ERR_MODULE_NOT_FOUND code");
		assert.match(src, /Cannot find package '/, "skip arm fires on BARE package absence only");
		assert.match(src, /process\.exit\(0\)/, "environmental absence exits 0 (green-or-loud-skip)");
		// the skip is LOUD: names the remedy, not just the symptom
		assert.match(src, /install-plugin-smoke-deps\.mjs/, "skip message names the installer command");
		assert.match(src, /SKIP /, "skip line is a marked SKIP, not silence");
	});

	test(`${plugin}: no static import of the plugin lib — a static import bypasses the guard (the #358 class)`, () => {
		const src = readFileSync(file, "utf8").split("\n");
		const staticLibImports = src
			.filter((line) => /^\s*import\b/.test(line) && /from\s+"(\.\.?\/lib\/|.*lib\/index\.js")/.test(line))
			.filter((line) => !/node:/.test(line));
		assert.deepEqual(
			staticLibImports,
			[],
			"the plugin lib must load through the guarded dynamic import — a static lib import dies ERR_MODULE_NOT_FOUND before any guard can classify it",
		);
	});
}

test("every guarded smoke: green-or-loud-skip under a direct run, never a MODULE_NOT_FOUND traceback", () => {
	// State-tolerant behavioral pin: on a dep-less checkout (fresh clone,
	// installer not yet run) each smoke must SKIP loud and exit 0; on a
	// converged tree (installer ran — the CI state) it runs for real and
	// exits 0. Either way an uncaught ERR_MODULE_NOT_FOUND trace is the
	// one outcome this contract forbids — exactly the #358 observable.
	for (const { plugin, file } of SMOKES) {
		const run = spawnSync(process.execPath, [file], { encoding: "utf8", timeout: 120_000 });
		assert.equal(run.status, 0, `${plugin} smoke exits 0 (deps absent → loud skip; present → full run)\nstdout:${run.stdout}\nstderr:${run.stderr}`);
		const out = `${run.stdout}\n${run.stderr}`;
		assert.doesNotMatch(
			out,
			/ERR_MODULE_NOT_FOUND/,
			`${plugin} smoke must never surface an uncaught module-not-found trace — the guard classifies bare-package absence as a loud environmental skip`,
		);
		const skipped = /SKIP /.test(run.stdout);
		if (skipped) {
			assert.match(run.stdout, /install-plugin-smoke-deps\.mjs/, "a skip must carry its remedy: the installer command");
		}
	}
});
