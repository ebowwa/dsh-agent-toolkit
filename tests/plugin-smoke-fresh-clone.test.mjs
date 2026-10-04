// plugin-smoke-fresh-clone.test.mjs — contract pins for issue #358: the
// plugin smoke suites whose lib half resolves workspace peer deps
// (@deepseek-ai/* packages, the @local/* links) must SKIP LOUD on a
// checkout that has not run scripts/install-plugin-smoke-deps.mjs,
// instead of reddening the default bare gate with ERR_MODULE_NOT_FOUND
// stack noise that looks like plugin breakage.
//
// Three pins, each hermetic against box state:
//   1. deps-absent copy -> exit 0 + a SKIP line naming the missing
//      package and the convergence fix (the skip REASON is asserted,
//      not just the exit code).
//   2. a missing RELATIVE module is a real defect, not box state: the
//      same guard must rethrow and the suite stays red (the
//      "Cannot find module <path>" signature never skips).
//   3. at the real location the suite is green on EITHER box state —
//      ALL PASS on a converged tree, SKIP on a bare one — so this pin
//      cannot flake between the author cell and CI (the tests-lint
//      lesson: no gate may depend on machine state).

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SUITES = [
	"dsh-stream-watchdog",
	"dsh-system-prompt-editor",
	"dsh-system-prompt-ui",
];

// Run one smoke file with node; never throws — returns {status, stdout, stderr}.
const run = (file, timeout = 120_000) => {
	const res = spawnSync(process.execPath, [file], { encoding: "utf8", timeout });
	return { status: res.status, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
};

// A plugin dir copied into mktemp has no node_modules above it: its
// workspace peer deps cannot resolve. (tmpdir on every lane lives
// outside the checkout — this is how the repo's own suites build
// hermetic fixtures.)
const bareCopy = (plugin) => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), `smoke-fresh-${plugin}-`));
	fs.cpSync(path.join(ROOT, "plugins", plugin), path.join(dir, plugin), { recursive: true });
	return path.join(dir, plugin, "test", "smoke.mjs");
};

for (const plugin of SUITES) {
	test(`#358: ${plugin} smoke skips LOUD on a deps-absent copy (bare-clone gate stays green)`, () => {
		const smoke = bareCopy(plugin);
		const { status, stdout } = run(smoke);
		assert.equal(status, 0, `expected exit 0 on a bare tree, got ${status}\nstdout:\n${stdout}`);
		const line = stdout.split("\n").find((l) => l.startsWith("SKIP "));
		assert.ok(line, `a SKIP line must lead the output, got:\n${stdout}`);
		assert.match(
			line,
			/workspace dep '(@deepseek-ai|@local)\/[^']+' not installed/,
			"the skip names the missing workspace package",
		);
		assert.match(line, /install-plugin-smoke-deps/, "the skip names the convergence fix");
	});
}

test("#358: a missing relative module is a defect, never a skip — the guard rethrows", () => {
	const smoke = bareCopy("dsh-system-prompt-editor");
	fs.rmSync(path.join(path.dirname(path.dirname(smoke)), "lib", "index.js"));
	const { status, stdout } = run(smoke);
	assert.notEqual(status, 0, "a broken lib import must stay red");
	assert.ok(!stdout.split("\n").some((l) => l.startsWith("SKIP ")), "no skip line for a real defect");
});

test("#358: at the real location every guarded suite is green on either box state", () => {
	for (const plugin of SUITES) {
		const { status, stdout } = run(path.join(ROOT, "plugins", plugin, "test", "smoke.mjs"));
		assert.equal(status, 0, `${plugin}: converged tree must ALL-PASS, bare tree must SKIP — got ${status}\nstdout:\n${stdout}`);
		const pass = stdout.includes("ALL PASS") || stdout.includes("pass, 0 fail");
		const skip = stdout.split("\n").some((l) => l.startsWith("SKIP "));
		assert.ok(pass || skip, `${plugin}: neither a full pass nor a loud skip — got:\n${stdout}`);
	}
});
