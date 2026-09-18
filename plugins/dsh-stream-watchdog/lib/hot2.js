/* hot2.js — FULL COPY of lib/index.js at a fresh URL. Do NOT re-export ./index.js:
   the running process caches module URLs, so hot.js (and anything it
   re-exports) returns the stale cached module forever. A new full-copy
   file is the only way to hot-swap code into the live loader.
   Deploy: point the cordis.patch.yml row here (two-write flip:
   disabled=true, then name=hot2.js + disabled=false). hot.js stays as the
   original mount; hot3.js is the next swap. */
import z from "@deepseek-ai/schemastery";

/**
 * Stream watchdog for stalled model streams (persistent web install).
 *
 * The failure it fixes: a provider SSE stream that opens and then goes
 * silent — HTTP 200 + headers, zero chunks afterwards. The whole LLM stack
 * is idle-timeout-free by design, so such a stream hangs the step forever:
 * the chat looks randomly stopped mid-turn. Pressing Stop journals
 * `aborted/user`; not pressing Stop hangs the session indefinitely (a real
 * FleetTower case sat frozen for 12h). The openai SDK's own `timeout` only
 * bounds time-to-headers (openai-node v6 clears the timer when `fetch`
 * resolves), pi-ai forwards a timeout only when the profile sets one, and
 * the retry policy fires only on a THROWN failure — a silent stream never
 * throws, so nothing recovers it.
 *
 * This plugin wraps the outermost `llm/stream` waterfall and races each
 * `next()` against an idle timer, with two budgets: `firstTokenTimeoutMs`
 * until the first chunk (dsh resends the whole chat history every step, so
 * a long prompt's server-side prefill can legitimately take minutes before
 * token one — a 60s budget here kills healthy streams and feeds a retry
 * storm, which is exactly what the first 60s flat build produced), then
 * `idleTimeoutMs` for each later gap. When a budget lapses, it closes the
 * underlying stream and yields the stream protocol's error finish chunk
 * carrying the retryable `TIMEOUT` code — byte-for-byte the shape
 * `adapterStream` itself produces for a failed adapter call. The agent
 * loop's existing machinery then does the rest:
 * `assistant/attempt` settles, the `agent/request-error` waterfall fires,
 * dsh-llm-retry sees `TIMEOUT` in `retryableCodes` and re-issues the step
 * (up to the provider's max retries with backoff). A stalled stream turns
 * from an eternal silent hang into one automatic retry round; only after
 * the retries exhaust does the turn end with a visible error.
 *
 * Guarding is per provider route (default `["zai"]` — where the stalls
 * were observed) and pass-through otherwise. The listener is registered
 * `global` + `prepend`, so it wraps the FINAL stream: every chunk any
 * inner middleware produces resets the timer, and prepared one-shot calls
 * (`llm.prepareCall().stream`) are covered the same as plain `llm.stream`.
 *
 * Mount: `cordis.patch.yml` insert row pointing at `lib/hot.js` (the
 * fresh-URL shim — future code changes swap to a new URL without editing
 * the row twice). Kill switch: `config.disabled: true`.
 */
//#region lib/hot2.js (full copy — fresh URL = fresh module)
/** Cordis plugin name used by loader diagnostics. */
export const name = "stream-watchdog";
/** No host services are needed. */
export const inject = [];

/** Runtime schema for the watchdog policy. */
export const Config = z.object({
	/** Budget until the FIRST chunk: covers full-history prefill time-to-first-token. */
	firstTokenTimeoutMs: z.number().max(900000).default(300000),
	/** Budget between later chunks: a silent gap mid-stream is a dead stream. */
	idleTimeoutMs: z.number().max(600000).default(120000),
	/** Provider routes to guard; the entry "*" guards every provider. */
	providers: z.array(z.string()).default(["zai"]),
	/** Kill switch: mount the row but pass every stream through untouched. */
	disabled: z.boolean().default(false)
});

/**
 * Best-effort, non-blocking close of the underlying iterator. Never awaited:
 * an async generator suspended at a never-settling await (the stalled read
 * this plugin exists to break) queues its return request until that await
 * settles, so awaiting `return()` would hang the watchdog on the very corpse
 * it is closing — and a hanging `finally` would hang the consumer's for-await
 * cleanup on abort. The queued close drains when the corpse dies on its own;
 * rejections are suppressed because nobody is left watching the promise.
 * @param it - the underlying iterator to close.
 */
function closeInner(it) {
	try {
		const closing = it.return?.();
		closing?.catch?.(() => {});
	} catch { /* best-effort */ }
}

/**
 * Wrap one chunk stream with the idle watchdog. Exported pure for the smoke
 * test: an async iterable in, an async iterable out. Chunks pass through in
 * order. Two budgets: `firstTokenMs` bounds the silence before the FIRST
 * chunk (dsh resends the whole chat history every step, so a long prompt's
 * server-side prefill can legitimately take minutes before token one);
 * `idleMs` bounds each later gap, where silence is far more likely a dead
 * stream. On a budget win the underlying stream is closed and the wrapper
 * yields the protocol's error finish chunk with the retryable `TIMEOUT`
 * code, then ends. Early consumer exit and watchdog termination both
 * request a close of the underlying iterator, mirroring `adapterStream`'s
 * own `finally` (non-blocking; see {@link closeInner}).
 * @param inner - the downstream chunk stream (async iterable of chunks).
 * @param firstTokenMs - budget until the first chunk, in milliseconds.
 * @param idleMs - budget between later chunks, in milliseconds.
 * @param onTimeout - optional side-channel (logging), fired once per timeout.
 * @returns the guarded stream.
 */
export function withIdleWatchdog(inner, firstTokenMs, idleMs, onTimeout) {
	async function* guarded() {
		const it = inner[Symbol.asyncIterator]();
		let closed = false;
		let sawFirst = false;
		let timer;
		try {
			while (true) {
				const next = it.next();
				// A late rejection after an idle win (the abort path also rejects
				// the pending next()) must never surface as an unhandled rejection.
				next.catch(() => {});
				const budget = sawFirst ? idleMs : firstTokenMs;
				const idle = new Promise((resolve) => { timer = setTimeout(resolve, budget); });
				let idleWon;
				try {
					idleWon = await Promise.race([next.then(() => false, () => false), idle.then(() => true)]);
				} finally {
					clearTimeout(timer);
					timer = undefined;
				}
				if (idleWon) {
					closed = true;
					closeInner(it);
					onTimeout?.(budget, sawFirst);
					yield {
						type: "finish",
						reason: {
							kind: "error",
							failure: {
								message: sawFirst
									? `stream idle: no model output for ${budget}ms`
									: `stream idle: no first token within ${budget}ms`,
								code: "TIMEOUT"
							}
						}
					};
					return;
				}
				const result = await next;
				if (result.done) { closed = true; return; }
				sawFirst = true;
				yield result.value;
			}
		} finally {
			clearTimeout(timer);
			if (!closed) closeInner(it);
		}
	}
	return guarded();
}

/** Plugin apply: register the global, outermost `llm/stream` interceptor. */
export function apply(ctx, config) {
	if (config.disabled) return;
	const providers = new Set(config.providers);
	const guardAll = providers.has("*");
	ctx.on("llm/stream", (options, next) => {
		if (!guardAll && !providers.has(options?.provider)) return next();
		if (options?.signal?.aborted) return next();
		const stream = next();
		if (stream === void 0 || stream?.[Symbol.asyncIterator] === undefined) return stream;
		return withIdleWatchdog(stream, config.firstTokenTimeoutMs, config.idleTimeoutMs, (budget, sawFirst) => {
			try {
				const what = sawFirst ? "mid-stream idle" : "time-to-first-token";
				ctx.logger?.warn(`stream-watchdog: provider "${String(options?.provider)}" ${what} ${budget}ms — closed a stalled stream as retryable TIMEOUT`);
			} catch { /* logging must never break the stream */ }
		});
	}, { global: true, prepend: true });
}
//#endregion
