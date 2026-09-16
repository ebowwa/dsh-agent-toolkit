/**
 * Offline smoke test — no dsh process, no browser.
 *   node half: apply() against a mock connection ctx with a mock workspace
 *   registry, exercising the scoped route with real Request/Response objects.
 *   client half: executes lib/client.js in a vm with a stub ModuleLoader and
 *   stub seeds, then drives apply() against a mock slots/locale ctx.
 * Run: node test/smoke.mjs
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import vm from "node:vm";
import { apply as nodeApply, BLOCK_ROUTE } from "../lib/index.js";

const dir = mkdtempSync(join(tmpdir(), "sp-ui-"));
const file = join(dir, "system-prompt.md");
const scopeDir = join(dir, "system-prompts");
mkdirSync(scopeDir);
const SESSION = "session-11111111-2222-3333-4444-555555555555";
const WS_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const registry = () => ({
	list: () => [{ id: WS_ID, title: "Profiles WS", path: "/nowhere", sessionIds: [SESSION] }]
});
let failures = 0;
const check = async (label, fn) => {
	try {
		await fn();
		console.log(`ok   ${label}`);
	} catch (error) {
		failures += 1;
		console.log(`FAIL ${label}: ${error?.message ?? error}`);
	}
};

// --- node half ---------------------------------------------------------------
const routes = [];
const ctxNode = { workspaceRegistry: registry(), connection: { fetch: { register: (route) => routes.push(route) } } };
await check("node half: exports and one route registered", () => {
	nodeApply(ctxNode, { file, dir: scopeDir });
	assert.equal(routes.length, 1);
	assert.equal(routes[0].path, BLOCK_ROUTE);
	assert.deepEqual([...routes[0].methods], ["GET", "PUT"]);
	assert.equal(routes[0].requestBody, "buffered");
	assert.equal(typeof routes[0].fetch, "function");
});

const route = routes[0];
const get = (query) => route.fetch(new Request(`http://x${BLOCK_ROUTE}${query}`, { method: "GET" }));
const put = (body, query = "") => route.fetch(new Request(`http://x${BLOCK_ROUTE}${query}`, {
	method: "PUT",
	headers: { "content-type": "application/json" },
	body: typeof body === "string" ? body : JSON.stringify(body)
}));

await check("GET (no session) returns the global-only view", async () => {
	const value = await (await get("")).json();
	assert.equal(value.sessionId, null);
	assert.equal(value.workspace, null);
	assert.equal(value.effective, "global");
	assert.equal(value.blocks.session.file, null);
	assert.equal(value.blocks.workspace.file, null);
	assert.equal(value.blocks.global.set, false);
	assert.equal(value.blocks.global.content, "");
});

await check("PUT global writes; scoped levels stay unset", async () => {
	const value = await (await put({ content: "Global standing rule." })).json();
	assert.deepEqual(value, { scope: "global", file, cleared: false, chars: "Global standing rule.".length });
	const view = await (await get("")).json();
	assert.equal(view.blocks.global.set, true);
	assert.equal(view.blocks.global.content, "Global standing rule.");
});

await check("GET with sessionId resolves the workspace and the chain", async () => {
	const view = await (await get(`?sessionId=${SESSION}`)).json();
	assert.equal(view.sessionId, SESSION);
	assert.equal(view.workspace.id, WS_ID);
	assert.equal(view.workspace.title, "Profiles WS");
	assert.equal(view.effective, "global"); // session+workspace unset → falls through
	assert.equal(view.blocks.session.file, join(scopeDir, `${SESSION}.md`));
	assert.equal(view.blocks.workspace.file, join(scopeDir, `workspace-${WS_ID}.md`));
	assert.equal(view.blocks.session.set, false);
});

await check("PUT session scope writes a private override; GET reflects the new effective", async () => {
	const value = await (await put({ sessionId: SESSION, scope: "session", content: "Chat rule." }, `?sessionId=${SESSION}`)).json();
	assert.equal(value.scope, "session");
	assert.equal(value.file, join(scopeDir, `${SESSION}.md`));
	const view = await (await get(`?sessionId=${SESSION}`)).json();
	assert.equal(view.effective, "session");
	assert.equal(view.blocks.session.content, "Chat rule.");
	assert.equal(view.blocks.global.content, "Global standing rule."); // untouched
});

await check("PUT workspace scope writes the workspace override (body sessionId only)", async () => {
	const value = await (await put({ sessionId: SESSION, scope: "workspace", content: "WS rule." })).json();
	assert.equal(value.file, join(scopeDir, `workspace-${WS_ID}.md`));
	const view = await (await get(`?sessionId=${SESSION}`)).json();
	assert.equal(view.effective, "session"); // session still shadows workspace
});

await check("empty PUT at session scope removes the override (falls to workspace)", async () => {
	const value = await (await put({ sessionId: SESSION, scope: "session", content: "" })).json();
	assert.equal(value.cleared, true);
	assert.equal(existsSync(join(scopeDir, `${SESSION}.md`)), false);
	assert.equal(readFileSync(join(scopeDir, `${SESSION}.md.bak`), "utf8"), "Chat rule.");
	const view = await (await get(`?sessionId=${SESSION}`)).json();
	assert.equal(view.effective, "workspace");
	assert.equal(view.blocks.session.set, false);
});

await check("PUT refuses empty global, bad scope, non-string content, session scope without id, workspace without membership", async () => {
	const sessionFile = join(scopeDir, `workspace-${WS_ID}.md`);
	const before = readFileSync(sessionFile, "utf8");
	const cases = [
		["empty global", { content: "" }],
		["bad scope", { content: "x", scope: "planet" }],
		["non-string", { content: 42 }],
		["missing", {}],
		["not-json", "this is not json"],
		["session no id", { scope: "session", content: "x" }],
		["workspace no membership", { scope: "workspace", content: "x" }]
	];
	for (const [label, body] of cases) {
		const response = await put(body);
		assert.equal(response.status, 400, label);
		assert.ok((await response.json()).error.length > 0, label);
	}
	assert.equal(readFileSync(sessionFile, "utf8"), before);
});

await check("PUT refuses oversized content at every scope", async () => {
	for (const scope of ["global", "session", "workspace"]) {
		const response = await put({ sessionId: SESSION, scope, content: "x".repeat(65537) });
		assert.equal(response.status, 400, scope);
	}
});

await check("disabled row registers no route", () => {
	const routes2 = [];
	nodeApply({ connection: { fetch: { register: (r) => routes2.push(r) } } }, { file, dir: scopeDir, disabled: true });
	assert.equal(routes2.length, 0);
});

// --- client half -------------------------------------------------------------
let registration = null;
const sandbox = {
	window: { __ModuleLoader__: { load: (reg) => { registration = reg; } } }
};
vm.createContext(sandbox);
new vm.Script(readFileSync(new URL("../lib/client.js", import.meta.url), "utf8"), { filename: "lib/client.js" }).runInContext(sandbox);

await check("client half: registers with the ModuleLoader under its id", () => {
	assert.ok(registration);
	assert.equal(registration.id, "@local/dsh-system-prompt-ui");
	assert.equal(typeof registration.factory, "function");
});

const jsxStub = (type, props) => ({ type, props });
const seeds = {
	"react": {
		useState: (initial) => [initial, () => {}],
		useEffect: () => {},
		useCallback: (fn) => fn,
		useRef: (initial) => ({ current: initial }),
		Fragment: Symbol.for("react.fragment")
	},
	"react/jsx-runtime": { jsx: jsxStub, jsxs: jsxStub, Fragment: Symbol.for("react.fragment") },
	"@deepseek-ai/dsh-client-ui-primitives": new Proxy({}, { get: (_t, key) => (key === "__esModule" ? true : () => key) })
};
const clientExports = registration.factory((spec) => {
	assert.ok(spec in seeds, `unexpected require: ${spec}`);
	return seeds[spec];
});

await check("client half: exports apply/inject for the browser runtime", () => {
	assert.equal(typeof clientExports.apply, "function");
	// vm-realm arrays fail host deepEqual — compare element-wise
	assert.equal(clientExports.inject.length, 2);
	assert.equal(clientExports.inject[0], "slots");
	assert.equal(clientExports.inject[1], "locale");
});

let slotInjects = [];
let slotRegisters = [];
let localeDicts = [];
const ctxClient = {
	effect: (fn) => { fn(); return () => {}; },
	locale: { register: (ns, dicts) => { localeDicts.push([ns, dicts]); return () => {}; } },
	slots: {
		inject: (slotName, registerFn) => { slotInjects.push([slotName, registerFn]); return () => {}; },
		register: (options, component) => { slotRegisters.push({ options, component }); return () => {}; }
	}
};
clientExports.apply(ctxClient);

await check("client half: registers dictionaries (incl. scope keys) and the utilities slot entry", () => {
	assert.equal(localeDicts.length, 1);
	assert.equal(localeDicts[0][0], "system-prompt-ui");
	const { zh, en } = localeDicts[0][1];
	assert.equal(en["scope.chat"], "This chat");
	assert.equal(zh["scope.chat"], "本对话");
	assert.equal(en["action.clear"], "Clear override");
	assert.ok(en["scope.active"].includes("{scope}"));
	assert.equal(en["header.edit"], "Edit system prompt");
	assert.equal(slotInjects.length, 1);
	assert.equal(slotInjects[0][0], "conversation.session.header.utilities");
	slotInjects[0][1](); // registerFn -> ctx.slots.register
	assert.equal(slotRegisters.length, 1);
	assert.equal(slotRegisters[0].options.id, "system-prompt-ui");
	assert.equal(typeof slotRegisters[0].component, "function");
});

rmSync(dir, { recursive: true, force: true });
console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
