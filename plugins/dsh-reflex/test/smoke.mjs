/**
 * Offline smoke test for @local/dsh-reflex — no dsh process, no engine.
 *   wiring: apply() against a mock ctx (tools registry + systemPrompt fake),
 *   including a host WITHOUT a systemPrompt service (the best-effort branch).
 *   transport: a real closed port (ECONNREFUSED) and a real one-line JSON
 *   TCP server stand in for the engine, so the last-error surface is
 *   exercised end to end at the socket boundary (issue #502).
 * Run: node test/smoke.mjs
 * Fresh-clone gate (#358): absent deps skip loud (counted node:test skip) — GUARD below.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";

// #358 fresh-clone loud-skip guard: this suite's lib imports deps that only
// an installed/converged tree carries (@deepseek-ai/dsh-tools). CI gates
// install them first (scripts/install-plugin-smoke-deps.mjs); a bare
// `gh repo clone` does not, so a missing dep SKIPS LOUD — counted, with the
// reason — instead of dying ERR_MODULE_NOT_FOUND and misreading as plugin
// breakage. Any other load error still reds (fail-closed).
const GUARD = await (async () => {
	try {
		const lib = await import("../lib/index.js");
		return { lib };
	} catch (error) {
		if (error?.code === "ERR_MODULE_NOT_FOUND") {
			const missing = /Cannot find package '([^']+)'/.exec(String(error?.message))?.[1] ?? "a plugin dep";
			return { skip: `plugin smoke deps absent on this tree (first missing: '${missing}') — fresh-clone state, not plugin breakage; run node scripts/install-plugin-smoke-deps.mjs to run this suite (issue #358)` };
		}
		throw error;
	}
})();

const { name, inject, normalizeConfig, apply } = GUARD.lib;

/** Mock session ctx: records registered tools and systemPrompt sections. */
function mockCtx() {
	const ctx = {
		tools: { registered: [], register: (...tools) => ctx.tools.registered.push(...tools) },
		systemPrompt: { sections: [], section: (s) => ctx.systemPrompt.sections.push(s) }
	};
	return ctx;
}

/** One free TCP port, returned CLOSED — connect() to it refuses instantly. */
async function closedPort() {
	const server = createServer();
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	const port = server.address().port;
	server.close();
	return port;
}

/** One engine stand-in: answers every connect with one JSON line. */
async function jsonEngine(line) {
	const sockets = new Set();
	const server = createServer((socket) => {
		sockets.add(socket);
		socket.end(line + "\n");
		socket.on("close", () => sockets.delete(socket));
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	return {
		port: server.address().port,
		// destroy the half-open server side first: after socket.end() the
		// connection can linger and server.close()'s callback never fires
		close: () => new Promise((resolve) => {
			for (const s of sockets) s.destroy();
			server.close(() => resolve());
		})
	};
}

test("@local/dsh-reflex smoke (offline)", { skip: GUARD.skip }, async () => {
	assert.equal(name, "reflex-tools");
	assert.deepEqual(inject, ["tools", "systemPrompt"]);
	// normalizeConfig keeps its untrusted-config contract (no service key of
	// its own; out-of-range values fall back to defaults, valid ones pass)
	const resolved = normalizeConfig({ port: 99999, timeoutMs: 1 });
	assert.equal(resolved.port, 49173);
	assert.equal(resolved.timeoutMs, 90000);
	assert.equal(normalizeConfig({ timeoutMs: 5000 }).timeoutMs, 5000);
	assert.equal(resolved.systemPrompt, undefined);

	// one closed port drives every failure-path call (refused instantly)
	const dead = await closedPort();

	// wiring: apply() registers all nine tools and captures the service
	const ctx = mockCtx();
	apply(ctx, { port: dead, timeoutMs: 3000 });
	assert.equal(ctx.tools.registered.length, 9, "all nine reflex_* tools register");
	const status = ctx.tools.registered.find((t) => t.name === "reflex_status");
	assert.ok(status, "reflex_status is among the registered tools");
	assert.equal(ctx.systemPrompt.sections.length, 0, "apply() itself writes no section");

	// best-effort: a host WITHOUT a systemPrompt service still gets the tools
	const bare = { tools: { registered: [], register: (...t) => bare.tools.registered.push(...t) } };
	apply(bare, { port: dead, timeoutMs: 3000 });
	assert.equal(bare.tools.registered.length, 9, "tool registration survives an absent systemPrompt service");
	const bareStatus = bare.tools.registered.find((t) => t.name === "reflex_status");

	// failure surfaces: a refused engine call returns {ok:false} AND appends
	// the persistent tool:reflex_last_error section
	const failed = await status.execute({});
	assert.equal(failed.ok, false, "a dead engine answers ok:false");
	assert.equal(ctx.systemPrompt.sections.length, 1, "the failure appends exactly one section");
	const section = ctx.systemPrompt.sections[0];
	assert.equal(section.name, "tool:reflex_last_error");
	assert.equal(section.order, 113);
	assert.match(section.text, /^reflex: last status attempt failed — /, "the section names the failed command");
	assert.ok(section.text.length <= 300 + "reflex: last status attempt failed — ".length, "the error payload is sliced to 300 chars");

	// the best-effort host surfaces nothing (no service to call)
	const bareFailed = await bareStatus.execute({});
	assert.equal(bareFailed.ok, false);
	assert.equal(bare.tools.registered.length, 9, "no throw despite the absent service");

	// success stays silent: an engine that answers {ok:true} appends nothing
	const engine = await jsonEngine(JSON.stringify({ ok: true, command: "status" }));
	try {
		const ctx3 = mockCtx();
		apply(ctx3, { port: engine.port, timeoutMs: 3000 });
		const ok = await ctx3.tools.registered.find((t) => t.name === "reflex_status").execute({});
		assert.equal(ok.ok, true, "the one-line engine answer parses as ok:true");
		assert.equal(ctx3.systemPrompt.sections.length, 0, "a successful call appends NO section");
	} finally {
		await engine.close();
	}
});
