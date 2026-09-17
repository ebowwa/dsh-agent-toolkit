/**
 * Host half of queue priority: one authenticated HTTP route managing a
 * session's pending prompt queue (the FIFO "next-turn" inbox list the stock
 * Queue dock renders above the composer).
 *
 *   POST /api/queue-priority
 *     { sessionId, itemId, direction: "up"|"down" }   -> reorder (legacy alias)
 *     { sessionId, itemId, action: "up"|"down" }      -> reorder swap
 *     { sessionId, itemId, action: "remove" }         -> delete the queued item
 *     { sessionId, itemId, action: "edit", text }     -> replace its text content
 *     { sessionId, itemId, action: "steer" }          -> send it into the running turn now
 *     { sessionId, itemId, action: "fork" }           -> duplicate it directly below itself
 *       -> { accepted: true, ... }
 *
 * remove / edit / steer mirror the stock session/updateQueue handler where
 * they overlap: edit is a whole-content replace validated to text-only
 * blocks with non-whitespace text (the stock QUEUE_EDIT_NON_TEXT /
 * gateway/bad-request pair); steer is remove + agent.steer(message) and is
 * refused with session/steer-unavailable unless agent.status === "running";
 * remove is inbox.remove. Move and fork are the extras the stock RPC lacks:
 * move is ONE adjacent swap spliced in a single agent/inbox/spliced journal
 * event (no intermediate state in which a message is missing from the queue,
 * and the durable log replays to the exact same order); fork is a
 * structuredClone of the queued message with a fresh randomUUID id, spliced
 * directly below the original — also one durable event, replay-exact.
 *
 * Two deliberate differences from the stock handler, both forced by the
 * plugin context: no fileUploads.retirePrompt on remove (this context
 * carries no fileUploads service; the orphaned upload record is harmless),
 * and no next-step fallback for locating the item (the panel only lists
 * queued items; next-step placement awaits a step boundary, so its order is
 * not user-meaningful).
 *
 * Errors: 404 session/not-found (not attached), 404
 * session/queue-item-not-found (already claimed/consumed), 400 queue/at-edge
 * (nothing to swap with), 400 queue/edit-invalid (missing/blank edit text),
 * 409 session/steer-unavailable (no running turn to steer into).
 *
 * The route rides the shared /api prefix, so the browser's gateway cookie
 * authenticates every call. Manual config normalization — no zod Config, no
 * schema-drift boot risk. Set config.disabled: true on the row to unhook.
 */
import { randomUUID } from "node:crypto";
//#region lib/index.js

/** Cordis plugin name used by loader diagnostics. */
export const name = "queue-priority";
/** The connection service owns the route registry; the agents service resolves sessions. */
export const inject = ["connection", "agents"];

/** Stable browser path (kept across any future transport migration). */
export const MOVE_ROUTE = "/api/queue-priority";

/** Action kinds the route accepts (direction up/down is folded into this union). */
const ACTIONS = new Set(["up", "down", "remove", "edit", "steer", "fork"]);

/** One JSON Response helper. */
function json(value, status = 200) {
	return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json; charset=utf-8" } });
}

/** Detach and deep-freeze a copied message — same shape the stock edit path publishes. */
function deepFreeze(value) {
	if (value !== null && typeof value === "object") {
		for (const key of Object.keys(value)) deepFreeze(value[key]);
		Object.freeze(value);
	}
	return value;
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
 * Build the edited replacement for one queued message — a frozen copy with
 * its content replaced by the given plain text. Exported pure for the test;
 * the caller has already validated that the text has non-whitespace content
 * (same contract as the stock edit action).
 * @param message - the queued message to replace.
 * @param text - the new prompt text.
 * @returns the frozen replacement message.
 */
export function planEdit(message, text) {
	return deepFreeze(Object.assign(structuredClone(message), {
		content: [{ type: "text", text }]
	}));
}

/**
 * Build the fork of one queued message — an independent frozen copy with a
 * fresh identity, identical content and source otherwise. Exported pure for
 * the test.
 * @param message - the queued message to duplicate.
 * @returns {object} the frozen fork, ready to splice below the original.
 */
export function planFork(message) {
	return deepFreeze(Object.assign(structuredClone(message), { id: randomUUID() }));
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
					return json({ error: 'body must be JSON: { "sessionId", "itemId", "action" | "direction", "text"? }' }, 400);
				}
				const sessionId = typeof body?.sessionId === "string" && body.sessionId.length > 0 ? body.sessionId : null;
				const itemId = typeof body?.itemId === "string" && body.itemId.length > 0 ? body.itemId : null;
				// `direction` stays accepted as the move alias (v1 callers).
				const kind = ACTIONS.has(body?.action) ? body.action
					: body?.direction === "up" || body?.direction === "down" ? body.direction : null;
				if (sessionId === null || itemId === null || kind === null) {
					return json({ error: 'expected { "sessionId": string, "itemId": string, "action": "up"|"down"|"remove"|"edit"|"steer"|"fork", "text"? }' }, 400);
				}
				if (kind === "edit" && (typeof body.text !== "string" || body.text.trim() === "")) {
					return json({ error: "queue edit content must include non-whitespace text", code: "queue/edit-invalid" }, 400);
				}
				const agent = ctx.agents.get(sessionId);
				if (agent === undefined) {
					return json({ error: `session "${sessionId}" not found (not attached)`, code: "session/not-found" }, 404);
				}
				const index = agent.inbox.nextTurn.findIndex((message) => message.id === itemId);
				if (index === -1) {
					return json({ error: "queued item is no longer pending", code: "session/queue-item-not-found" }, 404);
				}
				if (kind === "up" || kind === "down") {
					const plan = planMove(agent.inbox.nextTurn, itemId, kind);
					if (plan.error === "session/queue-item-not-found") {
						return json({ error: "queued item is no longer pending", code: plan.error }, 404);
					}
					if (plan.error !== undefined) {
						return json({ error: `item is already at the ${kind === "up" ? "top" : "bottom"} of the queue`, code: plan.error }, 400);
					}
					agent.inbox.splice("next-turn", plan.splice.start, plan.splice.deleteCount, plan.splice.inserted);
					return json({ accepted: true, from: plan.from, to: plan.to });
				}
				if (kind === "remove") {
					agent.inbox.remove(itemId);
					return json({ accepted: true, removed: index });
				}
				if (kind === "edit") {
					agent.inbox.replace(itemId, planEdit(agent.inbox.nextTurn[index], body.text));
					return json({ accepted: true });
				}
				if (kind === "steer") {
					if (agent.status !== "running") {
						return json({ error: "current turn no longer accepts steering", code: "session/steer-unavailable" }, 409);
					}
					const message = agent.inbox.nextTurn[index];
					agent.inbox.remove(itemId);
					agent.steer(message);
					return json({ accepted: true, steered: true });
				}
				// fork: duplicate the message directly below the original — one
				// durable splice, replay-exact; the copy is immediately editable
				// and reorderable like any other queued row.
				const forked = planFork(agent.inbox.nextTurn[index]);
				agent.inbox.splice("next-turn", index + 1, 0, [forked]);
				return json({ accepted: true, forkedId: forked.id, at: index + 1 });
			} catch (error) {
				return json({ error: `queue-priority route failed: ${String(error?.message ?? error).slice(0, 300)}` }, 500);
			}
		}
	});
}
//#endregion
