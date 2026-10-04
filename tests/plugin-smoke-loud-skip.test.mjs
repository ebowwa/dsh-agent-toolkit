// plugin-smoke-loud-skip.test.mjs — contract pins for the fresh-clone
// loud-skip gate in the plugin smoke suites (issue #358).
//
// Regression anchor: bare `node --test` on a fresh clone carried THREE
// ERR_MODULE_NOT_FOUND reds — dsh-stream-watchdog, dsh-system-prompt-editor,
// dsh-system-prompt-ui — because the smokes import plugin sources that
// import workspace deps a bare clone has not installed. CI stayed green
// (gates.yml converges the tree via install-plugin-smoke-deps.mjs before
// `node --test`), so the red only fired in the local parity form, where it
// looked like PLUGIN breakage and burned classification rounds (the #280
// box-state family).
//
// The contract: on a tree WITHOUT the converged node_modules, each gated
// smoke LOUD-SKIPS — exit 0, the skip reason naming the missing specs and
// the recovery command — and never touches its lib at import time. On a
// converged tree the suites run in full (pinned by CI's own bare
// `node --test` after the install step, which fails if a suite skips its
// substance away). The absent-deps world is constructed hermetically: a
// plugin-dir copy in a mkdtemp tree has no node_modules above it.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// The three suites the #358 receipts name, each with a spec that is
// guaranteed-missing on a bare clone (probed first by the gate itself).
const GATED_SUITES = [
	{ dir: "plugins/dsh-stream-watchdog", missing: "@deepseek-ai/schemastery" },
	{ dir: "plugins/dsh-system-prompt-editor", missing: "@deepseek-ai/dsh-tools" },
	{ dir: "plugins/dsh-system-prompt-ui", missing: "@local/dsh-system-prompt-editor" },
];

// Copy lib/, test/ and package.json of one plugin into a bare mkdtemp tree
// (no node_modules anywhere above it — os.tmpdir is outside the checkout).
function barePluginCopy(dir) {
	const tree = mkdtempSync(path.join(tmpdir(), "loud-skip-"));
	const suiteSrc = path.join(ROOT, dir);
	cpSync(suiteSrc, path.join(tree, "plugin"), {
		recursive: true,
		filter: (s) => {
			const rel = path.relative(suiteSrc, s);
			const top = rel.split(path.sep)[0];
			return (
				rel === "" || rel === "package.json" || top === "lib" || top === "test"
			);
		},
	});
	return tree;
}

test("fresh-clone world: each gated smoke LOUD-SKIPS (exit 0, reason carries the missing spec + the recovery command)", () => {
	for (const { dir, missing } of GATED_SUITES) {
		const tree = barePluginCopy(dir);
		try {
			const res = spawnSync(
				process.execPath,
				[path.join(tree, "plugin", "test", "smoke.mjs")],
				{ cwd: tree, encoding: "utf8" },
			);
			const out = `${res.stdout}\n${res.stderr}`;
			assert.equal(res.status, 0, `${dir}: expected green exit on the bare tree, got ${res.status}\n${out}`);
			assert.match(out, /skip/i, `${dir}: the skip must be VISIBLE in the output`);
			assert.match(
				out,
				/install-plugin-smoke-deps\.mjs/,
				`${dir}: the skip reason must carry the recovery command`,
			);
			assert.match(
				out,
				new RegExp(missing.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
				`${dir}: the skip reason must name the missing spec (${missing})`,
			);
			assert.doesNotMatch(
				out,
				/ERR_MODULE_NOT_FOUND/,
				`${dir}: the bare tree must never see the import-time crash`,
			);
		} finally {
			rmSync(tree, { recursive: true, force: true });
		}
	}
});

test("source pin: the gate cannot silently regress — guarded dynamic lib imports, probe, reason", () => {
	for (const { dir } of GATED_SUITES) {
		const src = readFileSync(path.join(ROOT, dir, "test", "smoke.mjs"), "utf8");
		assert.match(src, /#358/, `${dir}: the gate cites its issue`);
		assert.match(src, /import\.meta\.resolve/, `${dir}: deps are probed, not imported`);
		assert.match(
			src,
			/install-plugin-smoke-deps\.mjs/,
			`${dir}: the skip reason carries the recovery command`,
		);
		// a revert to the STATIC lib import re-arms the fresh-clone
		// ERR_MODULE_NOT_FOUND — the dynamic import is load-bearing
		assert.doesNotMatch(
			src,
			/^import\s[^\n]*from\s+"\.\.\/lib\/index\.js"/m,
			`${dir}: lib/index.js must be imported behind the gate, never statically`,
		);
	}
});
