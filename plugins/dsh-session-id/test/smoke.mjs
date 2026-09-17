/**
 * Offline smoke test — no dsh process, no browser.
 *   node half: apply() against an empty mock ctx (the host side is a stub).
 *   client half: executes lib/client.js in a vm with a stub ModuleLoader,
 *   stub seeds (react/jsx/primitives), a stub navigator.clipboard, then
 *   drives apply() against a mock slots/locale ctx and renders the button
 *   as a plain function call with stub hooks.
 * Run: node test/smoke.mjs
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { apply as nodeApply, name as nodeName, inject as nodeInject } from "../lib/index.js";

const SESSION = "session-11111111-2222-3333-4444-555555555555";
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
await check("node half: stub exports and apply() no-ops on an empty ctx", () => {
	assert.equal(nodeName, "session-id-ui");
	// vm-free plain array from this realm
	assert.equal(nodeInject.length, 0);
	nodeApply({});
});

// --- client half -------------------------------------------------------------
let registration = null;
let clipboardText = null;
let clipboardBroken = false;
const sandbox = {
	window: { __ModuleLoader__: { load: (reg) => { registration = reg; } } },
	navigator: { clipboard: { writeText: async (text) => {
		if (clipboardBroken) throw new Error("denied");
		clipboardText = text;
	} } },
	setTimeout: () => 1,
	clearTimeout: () => {}
};
vm.createContext(sandbox);
new vm.Script(readFileSync(new URL("../lib/client.js", import.meta.url), "utf8"), { filename: "lib/client.js" }).runInContext(sandbox);

await check("client half: registers with the ModuleLoader under its id", () => {
	assert.ok(registration);
	assert.equal(registration.id, "@local/dsh-session-id");
	assert.equal(typeof registration.factory, "function");
});

const jsxStub = (type, props) => ({ type, props });
const seeds = {
	"react": {
		useState: (initial) => [initial, () => {}],
		useEffect: () => {},
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

await check("client half: registers dictionaries and the utilities slot entry", () => {
	assert.equal(localeDicts.length, 1);
	assert.equal(localeDicts[0][0], "session-id-ui");
	const { zh, en } = localeDicts[0][1];
	assert.equal(en["header.copy"], "Copy session id");
	assert.ok(en["header.tooltip"].includes("{id}"));
	assert.ok(zh["header.tooltip"].includes("{id}"));
	assert.equal(slotInjects.length, 1);
	assert.equal(slotInjects[0][0], "conversation.session.header.utilities");
	slotInjects[0][1](); // registerFn -> ctx.slots.register
	assert.equal(slotRegisters.length, 1);
	assert.equal(slotRegisters[0].options.id, "session-id-ui");
	assert.equal(typeof slotRegisters[0].component, "function");
});

const t = (key, params) => key + (params ? ` ${JSON.stringify(params)}` : "");
const component = slotRegisters[0].component;

await check("component: renders nothing without a session", () => {
	assert.equal(component({ t, sessionId: undefined }), null);
	assert.equal(component({ t, sessionId: null }), null);
});

await check("component: renders a button whose tooltip carries the full id", () => {
	const element = component({ t, sessionId: SESSION });
	assert.equal(element.type, "button");
	assert.equal(element.props.title.includes(SESSION), true);
	assert.equal(element.props["aria-label"], "header.copy");
	// the primitives seed stub resolves every icon to a factory returning its key
	assert.equal(element.props.children.type(), "IconCopyOutline16");
});

/** Flush pending copy-chain microtasks (onClick fires the async copy as void). */
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

await check("component: click copies the id through navigator.clipboard", async () => {
	const element = component({ t, sessionId: SESSION });
	await element.props.onClick();
	await settle();
	assert.equal(clipboardText, SESSION);
});

await check("component: falls back to the legacy copy path when the API throws", async () => {
	clipboardBroken = true;
	clipboardText = null;
	// minimal DOM for the fallback branch (textarea + body)
	let appended = null;
	sandbox.document = {
		querySelector: () => null,
		createElement: () => {
			const node = { style: {}, value: "", setAttribute: () => {}, select: () => {} };
			return node;
		},
		body: { appendChild: (n) => { appended = n; }, removeChild: () => {} },
		execCommand: (cmd) => {
			if (cmd === "copy" && appended !== null) clipboardText = appended.value;
			return true;
		}
	};
	const element = component({ t, sessionId: SESSION });
	await element.props.onClick();
	await settle();
	assert.equal(clipboardText, SESSION);
	delete sandbox.document;
	clipboardBroken = false;
});

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
