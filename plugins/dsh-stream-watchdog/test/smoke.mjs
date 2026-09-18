/**
 * Offline smoke test for @local/dsh-stream-watchdog — no dsh process touched.
 *
 *   node ~/.dsh/runtime/node_modules/@local/dsh-stream-watchdog/test/smoke.mjs
 *
 * (Run from the installed copy: lib/index.js imports @deepseek-ai/schemastery,
 * which resolves through the runtime tree's flat node_modules.)
 *
 * Covers: withIdleWatchdog pass-through (chunks, upstream finish chunks,
 * upstream throws), the two idle tiers — pre-first-token (firstTokenMs) and
 * mid-stream (idleMs) — each closing the underlying stream and yielding the
 * synthetic retryable TIMEOUT finish with the tier's message, per-chunk
 * timer reset, slow-but-legal first token passing, early consumer exit
 * closing the underlying stream, the apply() registration surface
 * (global+prepend listener, disabled kill switch, provider filter, aborted
 * pass-through, non-stream pass-through, logger side-channel), and the
 * lib/hot.js fresh-URL shim re-exporting the same API.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const pkgDir = dirname(dirname(fileURLToPath(import.meta.url)));
const nodeHalf = await import(join(pkgDir, "lib", "index.js"));
const hotHalf = await import(join(pkgDir, "lib", "hot.js"));

let pass = 0;
let fail = 0;
function check(label, ok, detail = "") {
	if (ok) {
		pass++;
		console.log(`  ok  ${label}`);
	} else {
		fail++;
		console.log(`FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
	}
}

const TICK = 5;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Manual-chunk stream: `send(chunk)`, `end()`, `fail(error)`; tracks closing. */
function manualStream() {
	const state = { closed: false, returnRequested: false, pending: [], done: false };
	let release;
	const gate = () => new Promise((r) => { release = r; });
	let waiter = gate();
	const gen = (async function* () {
		try {
			while (true) {
				await waiter;
				if (state.error !== undefined) throw state.error;
				const item = state.pending.shift();
				if (item !== undefined) { yield item.value; continue; }
				if (state.done) return;
				waiter = gate();
			}
		} finally {
			state.closed = true;
		}
	})();
	const it = gen[Symbol.asyncIterator]();
	return {
		get closed() { return state.closed; },
		get returnRequested() { return state.returnRequested; },
		send(chunk) { state.pending.push({ value: chunk }); release(); },
		end() { state.done = true; release(); },
		fail(error) { state.error = error; state.done = true; release(); },
		// the wrapper must REQUEST the close without awaiting it — a generator
		// suspended at a never-settling await completes return() only when that
		// await settles (the exact corpse this plugin exists to abandon)
		next: (v) => it.next(v),
		return: (v) => { state.returnRequested = true; return it.return(v); },
		[Symbol.asyncIterator]() { return this; }
	};
}

// ---------------------------------------------------------------------------
// 1. pass-through
// ---------------------------------------------------------------------------
console.log("withIdleWatchdog pass-through:");
{
	const inner = manualStream();
	const out = nodeHalf.withIdleWatchdog(inner, 1000, 1000);
	const it = out[Symbol.asyncIterator]();
	inner.send({ type: "text", text: "a" });
	inner.send({ type: "text", text: "b" });
	const a = await it.next();
	const b = await it.next();
	check("chunks arrive in order", a.value?.text === "a" && b.value?.text === "b", JSON.stringify([a.value, b.value]));
	inner.end();
	const fin = await it.next();
	check("upstream done ends the wrapper", fin.done === true && inner.closed, `done=${fin.done} closed=${inner.closed}`);
}
{
	const inner = manualStream();
	const finishChunk = { type: "finish", reason: { kind: "error", failure: { message: "upstream boom", code: "SERVER" } } };
	inner.send(finishChunk);
	inner.end();
	const chunks = [];
	for await (const c of nodeHalf.withIdleWatchdog(inner, 1000, 1000)) chunks.push(c);
	check("upstream error finish chunk passes through untouched",
		chunks.length === 1 && chunks[0] === finishChunk && chunks[0].reason.failure.code === "SERVER",
		JSON.stringify(chunks));
}
{
	const inner = manualStream();
	inner.fail(new Error("raw adapter throw"));
	let caught = null;
	try {
		for await (const c of nodeHalf.withIdleWatchdog(inner, 1000, 1000)) void c;
	} catch (e) { caught = e; }
	check("upstream thrown error propagates", caught?.message === "raw adapter throw", String(caught));
}

// ---------------------------------------------------------------------------
// 2. the idle stall — the reason this plugin exists
// ---------------------------------------------------------------------------
console.log("idle stall (mid-stream tier):");
{
	const inner = manualStream();
	const timeouts = [];
	const out = nodeHalf.withIdleWatchdog(inner, 10000, 2 * TICK, (budget, sawFirst) => timeouts.push({ budget, sawFirst }));
	inner.send({ type: "text", text: "only chunk" });
	const chunks = [];
	for await (const c of out) chunks.push(c);
	check("pre-stall chunk passes", chunks[0]?.text === "only chunk", JSON.stringify(chunks[0]));
	const finish = chunks[1];
	check("stall yields exactly one synthetic finish", chunks.length === 2 && finish?.type === "finish", JSON.stringify(chunks));
	check("finish reason is kind error", finish?.reason?.kind === "error", JSON.stringify(finish?.reason));
	check("failure code is retryable TIMEOUT", finish?.reason?.failure?.code === "TIMEOUT", JSON.stringify(finish?.reason?.failure));
	check("message names the idle budget", /no model output for \d+ms/.test(finish?.reason?.failure?.message ?? ""), finish?.reason?.failure?.message);
	check("underlying close was requested (not awaited)", inner.returnRequested, `returnRequested=${inner.returnRequested}`);
	check("onTimeout side-channel fired once, mid-stream tier", timeouts.length === 1 && timeouts[0].sawFirst === true && timeouts[0].budget === 2 * TICK, JSON.stringify(timeouts));
}
{
	// a drip slower than nothing but faster than the budget never trips it
	const inner = manualStream();
	const out = nodeHalf.withIdleWatchdog(inner, 10000, 6 * TICK);
	const it = out[Symbol.asyncIterator]();
	const seen = [];
	inner.send({ n: 1 }); seen.push((await it.next()).value.n);
	await sleep(2 * TICK); inner.send({ n: 2 }); seen.push((await it.next()).value.n);
	await sleep(2 * TICK); inner.send({ n: 3 }); seen.push((await it.next()).value.n);
	inner.end();
	const fin = await it.next();
	check("activity inside the budget resets the timer", seen.join() === "1,2,3" && fin.done === true, `seen=${seen} done=${fin.done}`);
}
{
	// consumer abandons mid-wait: the underlying stream must still get a
	// (requested) close, and the abandonment itself must not hang
	const inner = manualStream();
	const out = nodeHalf.withIdleWatchdog(inner, 10000);
	const it = out[Symbol.asyncIterator]();
	inner.send({ n: 1 });
	await it.next();
	const abandon = it.return?.();
	const raced = await Promise.race([abandon.then(() => "settled"), sleep(1000).then(() => "hung")]);
	check("early consumer exit does not hang cleanup", raced === "settled", raced);
	check("early consumer exit requests the underlying close", inner.returnRequested, `returnRequested=${inner.returnRequested}`);
}

// ---------------------------------------------------------------------------
// 2b. the first-token tier — dsh resends the whole chat history every step,
//     so long-prompt server-side prefill can legitimately outlast the
//     mid-stream budget; the first chunk must get its own (longer) window
// ---------------------------------------------------------------------------
console.log("first-token tier:");
{
	// no chunk ever: the FIRST-token budget is the one enforced, even though
	// the mid-stream budget is far longer — proves the tiers don't mix up
	const inner = manualStream();
	const timeouts = [];
	const t0 = Date.now();
	const out = nodeHalf.withIdleWatchdog(inner, 2 * TICK, 10000, (budget, sawFirst) => timeouts.push({ budget, sawFirst }));
	const chunks = [];
	for await (const c of out) chunks.push(c);
	const elapsed = Date.now() - t0;
	const finish = chunks[0];
	check("pre-first-token stall ends in TIMEOUT finish",
		chunks.length === 1 && finish?.reason?.failure?.code === "TIMEOUT", JSON.stringify(chunks));
	check("first-token message is distinct", /no first token within \d+ms/.test(finish?.reason?.failure?.message ?? ""), finish?.reason?.failure?.message);
	check("first-token budget enforced (not the mid-stream one)", elapsed < 5000 && timeouts[0]?.budget === 2 * TICK && timeouts[0]?.sawFirst === false,
		`elapsed=${elapsed}ms timeouts=${JSON.stringify(timeouts)}`);
	check("underlying close requested on first-token timeout", inner.returnRequested, `returnRequested=${inner.returnRequested}`);
}
{
	// a slow-but-legal first token inside the first-token budget passes, and
	// the mid-stream tier takes over only afterwards
	const inner = manualStream();
	const out = nodeHalf.withIdleWatchdog(inner, 10 * TICK, 2 * TICK);
	const it = out[Symbol.asyncIterator]();
	const slowFirst = (async () => { await sleep(4 * TICK); inner.send({ n: 1 }); })();
	{
		const first = await it.next();
		check("first token inside its budget passes", first.value?.n === 1, JSON.stringify(first.value));
	}
	inner.send({ n: 2 });
	const second = await it.next();
	check("mid-stream tier armed after the first token", second.value?.n === 2, JSON.stringify(second.value));
	inner.end();
	const fin = await it.next();
	check("stream ends normally after late first token", fin.done === true, `done=${fin.done}`);
	await slowFirst;
}
{
	// a first token OUTSIDE the first-token budget still fires the tier
	const inner = manualStream();
	const out = nodeHalf.withIdleWatchdog(inner, 2 * TICK, 10000);
	const chunks = [];
	const consume = (async () => { for await (const c of out) chunks.push(c); })();
	await sleep(6 * TICK);
	inner.send({ n: 1 }); // too late — budget already lapsed
	await consume;
	check("late first token is still killed by the first-token tier",
		chunks.length === 1 && chunks[0]?.reason?.failure?.message?.includes("no first token"), JSON.stringify(chunks));
}

// ---------------------------------------------------------------------------
// 3. apply() registration surface
// ---------------------------------------------------------------------------
console.log("apply():");
function mockCtx() {
	const listeners = [];
	const warns = [];
	return {
		listeners,
		warns,
		logger: { warn: (m) => warns.push(m) },
		on(event, handler, opts) { listeners.push({ event, handler, opts }); return () => {}; }
	};
}
const STREAM_EVENT = "llm/stream";
{
	const ctx = mockCtx();
	nodeHalf.apply(ctx, { firstTokenTimeoutMs: 1000, idleTimeoutMs: 1000, providers: ["zai"], disabled: false });
	check("registers exactly one listener", ctx.listeners.length === 1, JSON.stringify(ctx.listeners.map(l => l.event)));
	check("listener is on llm/stream", ctx.listeners[0]?.event === STREAM_EVENT);
	check("listener is global+prepend", ctx.listeners[0]?.opts?.global === true && ctx.listeners[0]?.opts?.prepend === true,
		JSON.stringify(ctx.listeners[0]?.opts));
}
{
	const ctx = mockCtx();
	nodeHalf.apply(ctx, { firstTokenTimeoutMs: 1000, idleTimeoutMs: 1000, providers: ["zai"], disabled: true });
	check("config.disabled registers nothing", ctx.listeners.length === 0, String(ctx.listeners.length));
}
{
	const ctx = mockCtx();
	nodeHalf.apply(ctx, { firstTokenTimeoutMs: 1000, idleTimeoutMs: 1000, providers: ["zai"], disabled: false });
	const { handler } = ctx.listeners[0];
	const inner = manualStream();
	const passthrough = await handler({ provider: "deepseek" }, () => inner);
	check("non-listed provider passes through unwrapped", passthrough === inner);
	const guarded = await handler({ provider: "zai" }, () => manualStream());
	check("listed provider gets a wrapper stream", guarded !== undefined && guarded[Symbol.asyncIterator] !== undefined && guarded !== inner);
	const aborted = await handler({ provider: "zai", signal: AbortSignal.abort("x") }, () => inner);
	check("already-aborted signal passes through unwrapped", aborted === inner);
	const notAStream = await handler({ provider: "zai" }, () => undefined);
	check("non-stream next() result passes through", notAStream === undefined);
}
{
	// end-to-end through the apply() handler: pre-first-token stall → TIMEOUT
	// finish + logger warn naming the tier
	const ctx = mockCtx();
	nodeHalf.apply(ctx, { firstTokenTimeoutMs: 2 * TICK, idleTimeoutMs: 10000, providers: ["*"], disabled: false });
	const { handler } = ctx.listeners[0];
	const inner = manualStream();
	const guarded = await handler({ provider: "zai" }, () => inner);
	const chunks = [];
	for await (const c of guarded) chunks.push(c);
	check("handler-guarded stall ends in TIMEOUT finish",
		chunks.length === 1 && chunks[0]?.reason?.failure?.code === "TIMEOUT", JSON.stringify(chunks));
	check("logger recorded the watchdog firing with the tier",
		ctx.warns.length === 1 && /stream-watchdog:/.test(ctx.warns[0]) && /time-to-first-token/.test(ctx.warns[0]), JSON.stringify(ctx.warns));
}
{
	// Config defaults: the two budgets and their ceilings
	const cfg = nodeHalf.Config({});
	check("Config defaults: firstTokenTimeoutMs 300000", cfg?.firstTokenTimeoutMs === 300000, JSON.stringify(cfg));
	check("Config defaults: idleTimeoutMs 120000", cfg?.idleTimeoutMs === 120000, JSON.stringify(cfg));
	check("Config defaults: providers [zai]", JSON.stringify(cfg?.providers) === '["zai"]', JSON.stringify(cfg?.providers));
	check("Config defaults: disabled false", cfg?.disabled === false, String(cfg?.disabled));
}

// ---------------------------------------------------------------------------
// 4. lib/hot.js shim re-exports the API
// ---------------------------------------------------------------------------
console.log("hot.js shim:");
check("shim exports name", hotHalf.name === "stream-watchdog", String(hotHalf.name));
check("shim exports inject array", Array.isArray(hotHalf.inject));
check("shim exports Config", hotHalf.Config !== undefined);
check("shim exports apply function", typeof hotHalf.apply === "function");
check("shim exports withIdleWatchdog", typeof hotHalf.withIdleWatchdog === "function");

// ---------------------------------------------------------------------------
console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
