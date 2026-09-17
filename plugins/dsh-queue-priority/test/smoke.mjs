/**
 * Offline smoke test for @local/dsh-queue-priority — no dsh process touched.
 *
 *   node ~/.dsh/runtime/node_modules/@local/dsh-queue-priority/test/smoke.mjs
 *
 * Covers: the pure swap planner (math + edge errors), the route's request
 * validation and error mapping against a mock agents registry + recording
 * inbox, and the browser factory via a vm harness with stub module seeds
 * (registration only — the panel's React rendering is exercised by loading
 * the page, not here).
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
const list = (n) => Array.from({ length: n }, (_, i) => ({ id: `m${i}` }));

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
// 2. apply() — route registration, validation, and the swap against a mock inbox
// ---------------------------------------------------------------------------
console.log("apply (mock ctx):");

function makeCtx() {
	const inboxCalls = [];
	const inbox = {
		nextTurn: list(3),
		splice(target, start, deleteCount, inserted) {
			inboxCalls.push({ target, start, deleteCount, inserted });
			const removed = this.nextTurn.slice(start, start + deleteCount);
			this.nextTurn = this.nextTurn.toSpliced(start, deleteCount, ...inserted);
			return removed;
		}
	};
	const registered = [];
	const ctx = {
		agents: {
			get(id) { return id === "session-live" ? { inbox } : undefined; }
		},
		connection: {
			fetch: {
				register(entry) { registered.push(entry); }
			}
		}
	};
	return { ctx, inbox, inboxCalls, registered };
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
			IconChevronDownOutline14: () => null
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
