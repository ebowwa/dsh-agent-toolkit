// plugin-smoke-loudskip.test.mjs — contract pins for the plugin smoke
// suites' environmental fence (issue #358): on a bare clone (no
// scripts/install-plugin-smoke-deps.mjs run yet) the three workspace-dep
// smokes died with a raw ERR_MODULE_NOT_FOUND — a box-state red that
// reads as plugin breakage and burns classification rounds on every
// fresh-clone bare `node --test` gate.
//
// The fence (plugins/<p>/test/deps-fence.mjs, guardedImport) turns the
// missing-PACKAGE class into a LOUD skip — `SKIP\t<plugin>\t<reason>` +
// exit 0 — while anything substantive (missing relative module, real lib
// error) still rethrows and stays red.
//
// These tests fail without the fix: a bare tree reds the invariant leg,
// and a fence that swallowed substantive breakage reds the discriminator.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const FENCED_PLUGINS = [
	"dsh-stream-watchdog",
	"dsh-system-prompt-editor",
	"dsh-system-prompt-ui",
];

const runNode = (args, opts = {}) =>
	execFileSync(process.execPath, args, {
		encoding: "utf8",
		timeout: 60_000,
		maxBuffer: 16 * 1024 * 1024,
		...opts,
	});

// ---- the acceptance invariant, on the real tree ----------------------------
//
// Whatever state this checkout is in — bare (deps absent) or converged
// (installer ran) — each fenced smoke must exit 0 and SAY which of the
// two it is: a SKIP line carrying its reason, or the suite's own pass
// markers. A red here is the #358 class by definition.

test("fenced smokes: green-or-loud-skip on any tree state (bare OR converged)", () => {
	for (const plugin of FENCED_PLUGINS) {
		const smoke = path.join(ROOT, "plugins", plugin, "test", "smoke.mjs");
		let out;
		try {
			out = runNode([smoke]);
		} catch (error) {
			assert.fail(
				`plugins/${plugin}/test/smoke.mjs exited ${error.status} on this tree — ` +
				`the #358 class (environmental red, not a finding). Output:\n${error.stdout ?? ""}${error.stderr ?? ""}`,
			);
		}
		const skipped = /^SKIP\t/m.test(out);
		const ran = /\bpass\b|ALL PASS/i.test(out);
		assert.ok(skipped !== ran, `exactly one of skip-or-ran, got:\n${out}`);
		if (skipped) {
			assert.match(out, /^SKIP\t@local\/[\w-]+ smoke\t/m, "skip line carries the plugin name");
			assert.match(out, /install-plugin-smoke-deps\.mjs/, "skip reason names the installer");
			assert.match(out, /#358/, "skip reason names the issue");
		}
	}
});

// ---- hermetic fence unit: the missing-PACKAGE class skips loud --------------
//
// Builds, in a temp dir outside the repo (no node_modules inheritance),
// the minimal shape the fence guards: a plugin with package.json, a lib
// whose import closure misses a workspace package, and a smoke importing
// the lib through guardedImport — using the REAL fence file verbatim.

function hermeticCase(t, fencePlugin, libSource) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "t358-fence-"));
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	const pluginDir = path.join(dir, "plugin");
	fs.mkdirSync(path.join(pluginDir, "lib"), { recursive: true });
	fs.mkdirSync(path.join(pluginDir, "test"), { recursive: true });
	fs.writeFileSync(path.join(pluginDir, "package.json"), `${JSON.stringify({ name: "@local/t358-stub" }, null, "\t")}\n`);
	// the REAL shipped fence for that plugin, not a paraphrase
	fs.copyFileSync(
		path.join(ROOT, "plugins", fencePlugin, "test", "deps-fence.mjs"),
		path.join(pluginDir, "test", "deps-fence.mjs"),
	);
	fs.writeFileSync(path.join(pluginDir, "lib", "index.js"), libSource);
	fs.writeFileSync(
		path.join(pluginDir, "test", "smoke.mjs"),
		[
			'import { guardedImport } from "./deps-fence.mjs";',
			'const lib = await guardedImport("../lib/index.js", import.meta.url);',
			'console.log("SUITE-RAN", Object.keys(lib).length);',
			"",
		].join("\n"),
	);
	return path.join(pluginDir, "test", "smoke.mjs");
}

test("fence: a missing workspace PACKAGE skips loud with its reason (never a raw MODULE_NOT_FOUND red)", (t) => {
	for (const fencePlugin of FENCED_PLUGINS) {
		const smoke = hermeticCase(t, fencePlugin, 'import "@deepseek-ai/t358-missing-probe";\nexport default 1;\n');
		const out = runNode([smoke]);
		assert.match(out, /^SKIP\t@local\/t358-stub smoke\t/m, `${fencePlugin}: SKIP line names the plugin`);
		assert.match(out, /@deepseek-ai\/t358-missing-probe/, `${fencePlugin}: reason names the missing package`);
		assert.match(out, /install-plugin-smoke-deps\.mjs/, `${fencePlugin}: reason names the installer`);
		assert.ok(!out.includes("SUITE-RAN"), `${fencePlugin}: the suite body did not run behind the skip`);
	}
});

test("fence: a missing RELATIVE module is substantive — rethrown, no skip (the fence never swallows real breakage)", (t) => {
	for (const fencePlugin of FENCED_PLUGINS) {
		const smoke = hermeticCase(t, fencePlugin, 'import "./definitely-absent-relative.js";\nexport default 1;\n');
		let threw = null;
		try {
			runNode([smoke]);
		} catch (error) {
			threw = error;
		}
		assert.ok(threw, `${fencePlugin}: the stub smoke must exit nonzero on a missing relative module`);
		const out = `${threw.stdout ?? ""}${threw.stderr ?? ""}`;
		assert.ok(!/^SKIP\t/m.test(out), `${fencePlugin}: no SKIP line for a substantive failure`);
		assert.match(out, /ERR_MODULE_NOT_FOUND/, `${fencePlugin}: the real error class surfaces`);
	}
});
