/**
 * Offline smoke test for @local/dsh-queue-priority — no dsh process touched.
 *
 *   node ~/.dsh/runtime/node_modules/@local/dsh-queue-priority/test/smoke.mjs
 *
 * Covers: the pure swap planner (math + edge errors), the edit / fork message
 * builders, the route's request validation and error mapping against a mock
 * agents registry + recording inbox — including the stock-mirroring remove /
 * edit / steer semantics and fork's clone-below — and the browser factory via
 * a vm harness with stub module seeds (registration only — the panel's React
 * rendering is exercised by loading the page, not here).
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

const pkgDir = dirname(dirname(fileURLToPath(import.meta.url)));
const nodeHalf = await import(join(pkgDir, "lib", "index.js"));

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

// ---------------------------------------------------------------------------
// 1. planMove — pure swap math
// ---------------------------------------------------------------------------
console.log("planMove:");
// rows carry the message shape the real inbox holds (id + content + source)
const list = (n) => Array.from({ length: n }, (_, i) => ({
	id: `m${i}`,
	role: "user",
	content: [{ type: "text", text: `m${i}` }],
	source: { kind: "user", rpcId: `r${i}` }
}));

{
	const l = list(3);
	const p = nodeHalf.planMove(l, "m2", "up");
	check("up from tail swaps 2 and 3", p.splice.start === 1 && p.splice.deleteCount === 2
		&& p.splice.inserted[0]?.id === "m2" && p.splice.inserted[1]?.id === "m1", JSON.stringify(p));
}
{
	const l = list(3);
	const p = nodeHalf.planMove(l, "m0", "down");
	check("down from head swaps 1 and 2", p.splice.start === 0 && p.splice.deleteCount === 2
		&& p.splice.inserted[0]?.id === "m1" && p.splice.inserted[1]?.id === "m0", JSON.stringify(p));
}
{
	// apply the planned splice to a copy and confirm the resulting order
	const l = list(4);
	const p = nodeHalf.planMove(l, "m3", "up");
	const next = l.toSpliced(p.splice.start, p.splice.deleteCount, ...p.splice.inserted);
	check("applied swap moves m3 before m2", next.map((m) => m.id).join(",") === "m0,m1,m3,m2", next.map((m) => m.id).join(","));
}
check("up at head is at-edge", nodeHalf.planMove(list(3), "m0", "up")?.error === "queue/at-edge");
check("down at tail is at-edge", nodeHalf.planMove(list(3), "m2", "down")?.error === "queue/at-edge");
check("unknown id is item-not-found", nodeHalf.planMove(list(3), "zzz", "up")?.error === "session/queue-item-not-found");

// ---------------------------------------------------------------------------
// 1b. planEdit / planFork — pure message builders
// ---------------------------------------------------------------------------
console.log("planEdit / planFork:");
{
	const source = Object.freeze({ id: "m1", role: "user", content: [{ type: "text", text: "old" }], source: { kind: "user", rpcId: "r1" } });
	const edited = nodeHalf.planEdit(source, "new text");
	check("edit replaces content with the text block", edited.content.length === 1 && edited.content[0].type === "text" && edited.content[0].text === "new text", JSON.stringify(edited.content));
	check("edit keeps identity and source", edited.id === "m1" && edited.source.rpcId === "r1");
	check("edited message is frozen and detached", Object.isFrozen(edited) && source.content[0].text === "old");
}
{
	const source = Object.freeze({ id: "m1", role: "user", content: [{ type: "text", text: "hello" }], source: { kind: "user", rpcId: "r1" } });
	const fork = nodeHalf.planFork(source);
	check("fork has a fresh uuid-shaped id", typeof fork.id === "string" && fork.id !== "m1" && /^[0-9a-f-]{36}$/.test(fork.id), fork.id);
	check("fork carries identical content and source", JSON.stringify(fork.content) === JSON.stringify(source.content) && fork.source.rpcId === "r1");
	check("fork is frozen and the original is untouched", Object.isFrozen(fork) && fork !== source && source.id === "m1");
}

// ---------------------------------------------------------------------------
// 2. apply() — route registration, validation, and the swap against a mock inbox
// ---------------------------------------------------------------------------
console.log("apply (mock ctx):");

function makeCtx(status = "idle") {
	const inboxCalls = [];
	const steered = [];
	const inbox = {
		nextTurn: list(3),
		splice(target, start, deleteCount, inserted) {
			inboxCalls.push({ target, start, deleteCount, inserted });
			const removed = this.nextTurn.slice(start, start + deleteCount);
			this.nextTurn = this.nextTurn.toSpliced(start, deleteCount, ...inserted);
			return removed;
		},
		remove(id) {
			const index = this.nextTurn.findIndex((message) => message.id === id);
			if (index === -1) return;
			inboxCalls.push({ target: "next-turn", start: index, deleteCount: 1, inserted: [] });
			this.nextTurn = this.nextTurn.toSpliced(index, 1);
		},
		replace(id, next) {
			const index = this.nextTurn.findIndex((message) => message.id === id);
			if (index === -1) return;
			inboxCalls.push({ target: "next-turn", start: index, deleteCount: 1, inserted: [next] });
			this.nextTurn = this.nextTurn.toSpliced(index, 1, next);
		}
	};
	const registered = [];
	const ctx = {
		agents: {
			get(id) {
				return id === "session-live" ? {
					inbox,
					status,
					steer(message) { steered.push(message); }
				} : undefined;
			}
		},
		connection: {
			fetch: {
				register(entry) { registered.push(entry); }
			}
		}
	};
	return { ctx, inbox, inboxCalls, steered, registered };
}

const jsonBody = (value) => ({ json: async () => value, url: "http://x/api/queue-priority" });

{
	const mock = makeCtx();
	nodeHalf.apply(mock.ctx);
	check("registers exactly one route", mock.registered.length === 1 && mock.registered[0].path === "/api/queue-priority" && mock.registered[0].methods.join(",") === "POST");
	const route = mock.registered[0];
	const res = await route.fetch(jsonBody({ sessionId: "session-live", itemId: "m2", direction: "up" }));
	const body = await res.json();
	check("live move accepted", res.status === 200 && body.accepted === true && body.from === 2 && body.to === 1, JSON.stringify(body));
	check("one durable splice journaled", mock.inboxCalls.length === 1 && mock.inboxCalls[0].target === "next-turn"
		&& mock.inboxCalls[0].start === 1 && mock.inboxCalls[0].deleteCount === 2, JSON.stringify(mock.inboxCalls));
	check("inbox order after move", mock.inbox.nextTurn.map((m) => m.id).join(",") === "m0,m2,m1", mock.inbox.nextTurn.map((m) => m.id).join(","));
}
{
	const mock = makeCtx();
	nodeHalf.apply(mock.ctx);
	const route = mock.registered[0];
	const bad = await route.fetch(jsonBody({ sessionId: "session-live", itemId: "m0", direction: "sideways" }));
	check("invalid direction -> 400, no splice", bad.status === 400 && mock.inboxCalls.length === 0, String(bad.status));
	const edge = await route.fetch(jsonBody({ sessionId: "session-live", itemId: "m0", direction: "up" }));
	check("at-edge -> 400 with code", edge.status === 400 && (await edge.json()).code === "queue/at-edge");
	const gone = await route.fetch(jsonBody({ sessionId: "session-gone", itemId: "m0", direction: "up" }));
	check("unattached session -> 404", gone.status === 404 && (await gone.json()).code === "session/not-found");
	const consumed = await route.fetch(jsonBody({ sessionId: "session-live", itemId: "zzz", direction: "down" }));
	check("consumed item -> 404", consumed.status === 404 && (await consumed.json()).code === "session/queue-item-not-found");
	check("error paths spliced nothing", mock.inboxCalls.length === 0, JSON.stringify(mock.inboxCalls));
}
{
	const mock = makeCtx();
	nodeHalf.apply(mock.ctx, { disabled: true });
	check("config.disabled registers nothing", mock.registered.length === 0);
}

// ---------------------------------------------------------------------------
// 2b. apply() — the stock-mirroring actions: remove / edit / steer / fork
// ---------------------------------------------------------------------------
console.log("apply (remove / edit / steer / fork):");
{
	const mock = makeCtx();
	nodeHalf.apply(mock.ctx);
	const route = mock.registered[0];
	const res = await route.fetch(jsonBody({ sessionId: "session-live", itemId: "m1", action: "remove" }));
	const body = await res.json();
	check("remove accepted", res.status === 200 && body.accepted === true, JSON.stringify(body));
	check("remove spliced exactly one row out", mock.inbox.nextTurn.map((m) => m.id).join(",") === "m0,m2"
		&& mock.inboxCalls.length === 1 && mock.inboxCalls[0].deleteCount === 1, JSON.stringify(mock.inbox.nextTurn));
	const again = await route.fetch(jsonBody({ sessionId: "session-live", itemId: "m1", action: "remove" }));
	check("double remove -> 404 item-not-found", again.status === 404 && (await again.json()).code === "session/queue-item-not-found");
}
{
	const mock = makeCtx();
	nodeHalf.apply(mock.ctx);
	const route = mock.registered[0];
	const bad = await route.fetch(jsonBody({ sessionId: "session-live", itemId: "m1", action: "edit", text: "   " }));
	check("blank edit -> 400 edit-invalid, nothing mutated", bad.status === 400 && (await bad.json()).code === "queue/edit-invalid"
		&& mock.inbox.nextTurn[1].content[0].text === "m1", String(bad.status));
	const noText = await route.fetch(jsonBody({ sessionId: "session-live", itemId: "m1", action: "edit" }));
	check("edit without text -> 400", noText.status === 400);
	const res = await route.fetch(jsonBody({ sessionId: "session-live", itemId: "m1", action: "edit", text: "rewritten prompt" }));
	const body = await res.json();
	check("edit accepted", res.status === 200 && body.accepted === true, JSON.stringify(body));
	check("edit rewrote content in place", mock.inbox.nextTurn.length === 3 && mock.inbox.nextTurn[1].id === "m1"
		&& mock.inbox.nextTurn[1].content[0].text === "rewritten prompt", JSON.stringify(mock.inbox.nextTurn[1]));
	check("edited replacement is frozen", Object.isFrozen(mock.inbox.nextTurn[1]));
}
{
	const mock = makeCtx();
	nodeHalf.apply(mock.ctx);
	const route = mock.registered[0];
	const res = await route.fetch(jsonBody({ sessionId: "session-live", itemId: "m1", action: "steer" }));
	check("steer while idle -> 409 steer-unavailable, queue untouched", res.status === 409
		&& (await res.json()).code === "session/steer-unavailable"
		&& mock.inbox.nextTurn.map((m) => m.id).join(",") === "m0,m1,m2" && mock.steered.length === 0, String(res.status));
}
{
	const mock = makeCtx("running");
	nodeHalf.apply(mock.ctx);
	const route = mock.registered[0];
	const target = mock.inbox.nextTurn[1];
	const res = await route.fetch(jsonBody({ sessionId: "session-live", itemId: "m1", action: "steer" }));
	const body = await res.json();
	check("steer while running accepted", res.status === 200 && body.accepted === true && body.steered === true, JSON.stringify(body));
	check("steer removed the row and handed the original to agent.steer", mock.inbox.nextTurn.map((m) => m.id).join(",") === "m0,m2"
		&& mock.steered.length === 1 && mock.steered[0] === target, JSON.stringify(mock.steered.map((m) => m.id)));
}
{
	const mock = makeCtx();
	nodeHalf.apply(mock.ctx);
	const route = mock.registered[0];
	const original = mock.inbox.nextTurn[1];
	const res = await route.fetch(jsonBody({ sessionId: "session-live", itemId: "m1", action: "fork" }));
	const body = await res.json();
	check("fork accepted with fresh id below the original", res.status === 200 && body.accepted === true
		&& body.at === 2 && typeof body.forkedId === "string" && body.forkedId !== "m1", JSON.stringify(body));
	check("fork inserted a clone directly below", mock.inbox.nextTurn.map((m) => m.id).join(",") === "m0,m1,clone,m2".replace("clone", body.forkedId)
		&& mock.inboxCalls.length === 1 && mock.inboxCalls[0].start === 2 && mock.inboxCalls[0].deleteCount === 0, JSON.stringify(mock.inbox.nextTurn.map((m) => m.id)));
	check("clone is frozen, content-identical, and the original object is untouched", Object.isFrozen(mock.inbox.nextTurn[2])
		&& JSON.stringify(mock.inbox.nextTurn[2].content) === JSON.stringify(original.content)
		&& mock.inbox.nextTurn[1] === original);
	const bogus = await route.fetch(jsonBody({ sessionId: "session-live", itemId: "m1", action: "explode" }));
	check("unknown action -> 400", bogus.status === 400);
}
{
	const mock = makeCtx();
	nodeHalf.apply(mock.ctx);
	const route = mock.registered[0];
	const broken = await route.fetch({ url: "http://x/api/queue-priority", json: async () => { throw new Error("not json"); } });
	check("unparseable body -> 400", broken.status === 400);
	const threw = await route.fetch(jsonBody({ sessionId: "session-live", itemId: "m0", direction: "down" }));
	// sanity: a well-formed call succeeds, proving the 400 above was the body, not the shape
	check("well-formed call still fine", threw.status === 200);
}

// ---------------------------------------------------------------------------
// 3. browser half — vm harness, registration only
// ---------------------------------------------------------------------------
console.log("browser half (vm):");
{
	const source = readFileSync(join(pkgDir, "lib", "client.js"), "utf8");
	const loads = [];
	const seeds = {
		react: { useRef: () => ({}), useEffect: () => {}, useMemo: (_f, deps) => _f(deps), useState: (v) => [v, () => {}] },
		"react/jsx-runtime": { jsx: () => null, jsxs: () => null, Fragment: "F" },
		"@deepseek-ai/dsh-client-ui-primitives": {
			projectUserText: (text) => text,
			Tooltip: ({ children }) => children,
			IconChevronUpOutline14: () => null,
			IconChevronDownOutline14: () => null,
			IconEditOutline16: () => null,
			IconTrashOutline16: () => null,
			IconCheckOutline16: () => null,
			IconCloseOutline16: () => null,
			IconSendOutline14: () => null,
			IconCopyOutline16: () => null
		}
	};
	const context = {
		window: {
			__ModuleLoader__: {
				load: (entry) => loads.push(entry)
			}
		},
		document: {
			querySelector: () => null,
			createElement: () => ({ style: {}, dataset: {} }),
			head: { appendChild: () => {} }
		}
	};
	context.globalThis = context;
	vm.createContext(context);
	vm.runInContext(source, context, { filename: "client.js" });
	check("loader received one module entry", loads.length === 1 && loads[0].id === "@local/dsh-queue-priority");

	const modules = { ...seeds };
	const require_ = (id) => {
		if (!(id in modules)) throw new Error(`seed missing: ${id}`);
		return modules[id];
	};
	const ns = loads[0].factory(require_);
	check("factory exports apply+inject", typeof ns.apply === "function" && Array.isArray(ns.inject) && ns.inject.includes("slots") && ns.inject.includes("locale"));

	const effects = [];
	const slotEntries = [];
	const fakeCtx = {
		effect: (dispose, label) => { effects.push(label ?? String(dispose)); return dispose; },
		locale: { register: (n, dicts) => { effects.push(`locale:${n}`); check("locale dictionaries en+zh registered", Boolean(dicts.en && dicts.zh) && n === "queue-priority"); } },
		slots: {
			inject: (slotName, register) => slotEntries.push({ slotName, entry: register() }),
			register: (meta, Component) => ({ ...meta, component: Component })
		}
	};
	ns.apply(fakeCtx);
	check("registers one conversation.input.dock entry", slotEntries.length === 1 && slotEntries[0].slotName === "conversation.input.dock");
	const entry = slotEntries[0].entry;
	check("entry is queue-priority @ order 21", entry.id === "queue-priority" && entry.order === 21 && entry.locale === "queue-priority" && typeof entry.inject === "function");
	check("entry component defined", typeof entry.component === "function" || typeof entry[1] === "function");
	const injected = entry.inject("session-abcd");
	check("inject captures the sessionId", injected.sessionId === "session-abcd");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
