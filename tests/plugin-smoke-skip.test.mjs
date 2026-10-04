// plugin-smoke-skip.test.mjs — contract pins for the plugin-smoke loud-skip
// guards (issue #358): a fresh `gh repo clone` + the bare gate form
// (`node --test`, which auto-discovers plugins/*/test/smoke.mjs) must be
// green-or-loud-skip on the plugin smoke legs — NEVER an ERR_MODULE_NOT_FOUND
// red. The smokes' lib entries import @deepseek-ai/* / @local/* workspace
// deps a bare clone has not installed; CI converges them first (gates.yml
// runs scripts/install-plugin-smoke-deps.mjs before `node --test`), a fresh
// checkout does not. Before the guards, three guaranteed reds shipped with
// every bare gate run and read as PLUGIN breakage (a MODULE_NOT_FOUND stack)
// rather than box state — a misclassification magnet, the #280 family.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

const SMOKES = [
	{ smoke: "plugins/dsh-stream-watchdog/test/smoke.mjs", libEntry: "plugins/dsh-stream-watchdog/lib/index.js" },
	{ smoke: "plugins/dsh-system-prompt-editor/test/smoke.mjs", libEntry: "plugins/dsh-system-prompt-editor/lib/index.js" },
	{ smoke: "plugins/dsh-system-prompt-ui/test/smoke.mjs", libEntry: "plugins/dsh-system-prompt-ui/lib/index.js" },
];

/**
 * Bare package specifiers statically reachable from a lib entry: follow
 * RELATIVE imports breadth-first within the plugin (the graph the smoke's
 * `await import("../lib/index.js")` really pulls through resolution);
 * node: builtins and non-bare specifiers are not resolution risks.
 */
function reachableBareSpecifiers(entryRel) {
	const bare = new Set();
	const seen = new Set();
	const queue = [join(ROOT, entryRel)];
	while (queue.length > 0) {
		const file = queue.shift();
		if (seen.has(file)) continue;
		seen.add(file);
		const src = readFileSync(file, "utf8");
		const specs = [
			...src.matchAll(/\bfrom\s*"([^"]+)"/g),
			...src.matchAll(/\bimport\s*\(\s*"([^"]+)"\s*\)/g),
		].map((m) => m[1]);
		for (const spec of specs) {
			if (spec.startsWith(".")) queue.push(resolve(dirname(file), spec));
			else if (!spec.startsWith("node:") && !spec.startsWith("/")) bare.add(spec);
		}
	}
	return bare;
}

for (const { smoke, libEntry } of SMOKES) {
	test(`${smoke}: green-or-loud-skip on ANY box state — no MODULE_NOT_FOUND red (#358)`, () => {
		// Behavioral, box-state-adaptive: on a bare clone the guard skips loud
		// (exit 0 + the SKIP banner naming the remedy); on a converged tree
		// (the CI cell) the smoke runs in full and passes. Either state, a
		// nonzero exit or an ERR_MODULE_NOT_FOUND in the output is a #358
		// regression — the acceptance is "no MODULE_NOT_FOUND reds remain in
		// the default gate path".
		const res = spawnSync(process.execPath, [join(ROOT, smoke)], {
			encoding: "utf8",
			cwd: ROOT,
		});
		const out = `${res.stdout ?? ""}\n${res.stderr ?? ""}`;
		assert.equal(res.status, 0, `smoke must exit 0 on any tree state; output:\n${out}`);
		assert.ok(!out.includes("ERR_MODULE_NOT_FOUND"), `the link-time red must not ship — output:\n${out}`);
		const skipped = /^SKIP: .*install-plugin-smoke-deps\.mjs/m.test(out);
		const ran = /\bALL PASS\b|\d+ pass, \d+ fail\b/.test(out);
		assert.ok(skipped || ran, `output must carry either the loud skip banner or a completed run — output:\n${out}`);
	});

	test(`${smoke}: the guard probes BEFORE the lib import — the red fires at link time (#358)`, () => {
		// Corpus: a STATIC `from "../lib/...` import is hoisted past any
		// guard (the original failure mode), so the lib import must be
		// dynamic and ordered after the probe.
		const src = readFileSync(join(ROOT, smoke), "utf8");
		assert.ok(!/from\s+"\.\.\/lib\//.test(src), "no static lib import may remain — it hoists past the guard");
		const probe = src.indexOf("missingSmokeDeps");
		const libImportMatch = src.match(/await\s+import\(\s*(?:"\.\.\/lib\/index\.js"|join\(pkgDir,\s*"lib",\s*"index\.js"\))\s*\)/);
		assert.ok(libImportMatch, "the lib entry is imported dynamically (the smoke runs its own import)");
		const libImport = libImportMatch.index;
		assert.ok(probe > 0 && libImport > probe, "the dep probe must precede the dynamic lib import");
		const banner = src.indexOf("SKIP:");
		assert.ok(banner > 0 && banner < libImport, "the skip banner must be part of the pre-import path");
		assert.ok(/install-plugin-smoke-deps\.mjs/.test(src), "the skip banner names the remedy command");
	});

	test(`${smoke}: SMOKE_DEPS covers every bare specifier the lib graph reaches (no drift)`, () => {
		// The guard's dep list must be a superset of what the lib entry
		// actually imports — a new workspace dep added to the lib without a
		// matching SMOKE_DEPS entry would re-arm the link-time red.
		const src = readFileSync(join(ROOT, smoke), "utf8");
		const listMatch = src.match(/const SMOKE_DEPS = \[([\s\S]*?)\];/);
		assert.ok(listMatch, "the smoke declares its SMOKE_DEPS list");
		const listed = new Set([...listMatch[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]));
		const reachable = reachableBareSpecifiers(libEntry);
		for (const spec of reachable) {
			assert.ok(listed.has(spec), `SMOKE_DEPS must list ${spec} — the lib graph imports it`);
		}
	});
}
