/**
 * Host half of queue priority: one authenticated HTTP route that reorders a
 * session's pending prompt queue (the FIFO "next-turn" inbox list the stock
 * Queue dock renders above the composer).
 *
 * The stock session/updateQueue RPC only accepts edit / remove / steer —
 * there is no move action. The durable inbox underneath it, however, exposes
 * full splice semantics (ReactLoopInbox.splice journals an agent/inbox/spliced
 * event per call), and the product's own queue-EDIT action is already a
 * remove+insert in one journal event. A reorder is therefore expressed the
 * same way: ONE adjacent swap per call —
 *
 *   POST /api/queue-priority   { sessionId, itemId, direction: "up"|"down" }
 *     -> { accepted: true, from, to }
 *
 * The swap splices positions (i, i±1) in a single agent/inbox/spliced event
 * (removedCount 2, both messages re-inserted swapped), so there is no
 * intermediate state in which a message is missing from the queue and the
 * durable log replays to the exact same order. The handler body is
 * synchronous, so it cannot interleave with a turn claiming head-of-queue on
 * the same event loop.
 *
 * Scope: next-turn only. next-step items (steering/context placement) await a
 * step boundary, not a turn, so their order is not user-meaningful. Errors:
 * 404 session/not-found (not attached), 404 session/queue-item-not-found
 * (already claimed/consumed), 400 queue/at-edge (nothing to swap with).
 *
 * The route rides the shared /api prefix, so the browser's gateway cookie
 * authenticates every call. Manual config normalization — no zod Config, no
 * schema-drift boot risk. Set config.disabled: true on the row to unhook.
 */
//#region lib/index.js

/** Cordis plugin name used by loader diagnostics. */
export const name = "queue-priority";
/** The connection service owns the route registry; the agents service resolves sessions. */
export const inject = ["connection", "agents"];

/** Stable browser path (kept across any future transport migration). */
export const MOVE_ROUTE = "/api/queue-priority";

/** One JSON Response helper. */
function json(value, status = 200) {
	return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json; charset=utf-8" } });
}

/**
 * Apply one adjacent swap to a next-turn list WITHOUT touching any state —
 * exported pure so the offline test can verify the splice math against the
 * same semantics the live route uses.
 *
 * @param nextTurn - current pending next-turn messages (read-only use).
 * @param itemId - identity of the message to move.
 * @param direction - "up" swaps with the previous message, "down" with the next.
 * @returns a descriptor the caller can splice with, or an error code.
 */
export function planMove(nextTurn, itemId, direction) {
	const from = nextTurn.findIndex((message) => message.id === itemId);
	if (from === -1) return { error: "session/queue-item-not-found" };
	const to = from + (direction === "up" ? -1 : 1);
	if (to < 0 || to >= nextTurn.length) return { error: "queue/at-edge" };
	const lo = Math.min(from, to);
	const hi = Math.max(from, to);
	return {
		from,
		to,
		// remove both neighbors, re-insert them swapped — one durable event
		splice: { start: lo, deleteCount: 2, inserted: [nextTurn[hi], nextTurn[lo]] }
	};
}

/**
 * Plugin apply: register the one route. No services beyond `connection` and
 * `agents`; nothing else is touched, so disposal is fiber-scoped and clean.
 */
export function apply(ctx, config = {}) {
	if (config.disabled === true) return;
	ctx.connection.fetch.register({
		path: MOVE_ROUTE,
		methods: ["POST"],
		requestBody: "buffered",
		fetch: async (request) => {
			try {
				let body;
				try {
					body = await request.json();
				} catch {
					return json({ error: 'body must be JSON: { "sessionId": string, "itemId": string, "direction": "up"|"down" }' }, 400);
				}
				const sessionId = typeof body?.sessionId === "string" && body.sessionId.length > 0 ? body.sessionId : null;
				const itemId = typeof body?.itemId === "string" && body.itemId.length > 0 ? body.itemId : null;
				const direction = body?.direction === "up" || body?.direction === "down" ? body.direction : null;
				if (sessionId === null || itemId === null || direction === null) {
					return json({ error: 'expected { "sessionId": string, "itemId": string, "direction": "up"|"down" }' }, 400);
				}
				const agent = ctx.agents.get(sessionId);
				if (agent === undefined) {
					return json({ error: `session "${sessionId}" not found (not attached)`, code: "session/not-found" }, 404);
				}
				const plan = planMove(agent.inbox.nextTurn, itemId, direction);
				if (plan.error === "session/queue-item-not-found") {
					return json({ error: "queued item is no longer pending", code: plan.error }, 404);
				}
				if (plan.error !== undefined) {
					return json({ error: `item is already at the ${direction === "up" ? "top" : "bottom"} of the queue`, code: plan.error }, 400);
				}
				agent.inbox.splice("next-turn", plan.splice.start, plan.splice.deleteCount, plan.splice.inserted);
				return json({ accepted: true, from: plan.from, to: plan.to });
			} catch (error) {
				return json({ error: `queue-priority route failed: ${String(error?.message ?? error).slice(0, 300)}` }, 500);
			}
		}
	});
}
