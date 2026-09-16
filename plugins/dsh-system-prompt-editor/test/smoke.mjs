/**
 * Offline smoke test — runs apply() against a mock ctx and exercises both
 * tools plus the dynamic section, with the scoped override chain. No dsh
 * process involved.
 * Run: node test/smoke.mjs
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { apply, normalizeConfig, readBlock, resolveLayout, readScoped, workspaceFor, USER_PROMPT_SECTION } from "../lib/index.js";

const dir = mkdtempSync(join(tmpdir(), "sp-editor-"));
const file = join(dir, "system-prompt.md");
const scopeDir = join(dir, "system-prompts");
mkdirSync(scopeDir);
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

const SESSION = "session-11111111-2222-3333-4444-555555555555";
const OTHER = "session-99999999-8888-7777-6666-555555555555";
const WS_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
mkdirSync(join(dir, "ws-home"));
// registry paths are realpath-canonicalized (as the real service does) — on macOS
// tmpdir lives under /private/var, so canonicalize the fixture the same way
const WS_PATH = realpathSync(join(dir, "ws-home"));
const registry = () => ({
	list: () => [
		{ id: WS_ID, title: "Test WS", path: WS_PATH, sessionIds: [SESSION] }
	]
});

// --- mock ctx capturing the section + tools -------------------------------
const sections = [];
const tools = new Map();
const ctx = {
	workspaceRegistry: registry(),
	systemPrompt: {
		section: (s) => {
			sections.push(s);
			return () => {};
		},
		// mock assemble: a minimal real-shaped assembly. The user-prompt section
		// text is computed by the REAL registered section (scoped resolution),
		// so full=true reflects the effective chain.
		assemble: async (context) => ({ sections: [{ name: "harness:identity", order: -1000, text: "You are an AI agent powered by DeepSeek Harness." }, { name: USER_PROMPT_SECTION, order: 9000, text: sections[0].text(context) }], variables: new Map() })
	},
	tools: { register: (t) => tools.set(t.name, t) }
};

apply(ctx, { file, dir: scopeDir });

await check("registers exactly one section + two tools", () => {
	assert.equal(sections.length, 1);
	assert.equal(tools.size, 2);
	assert.ok(tools.has("read_system_prompt"));
	assert.ok(tools.has("write_system_prompt"));
});

const section = sections[0];
await check("section is the user block: dynamic, literal, order 9000", () => {
	assert.equal(section.name, USER_PROMPT_SECTION);
	assert.equal(section.order, 9000);
	assert.equal(section.interpolate, false);
	assert.equal(typeof section.text, "function");
});

await check("absent files → section text is empty (inert)", () => {
	assert.equal(section.text(), "");
});

const read = tools.get("read_system_prompt");
const write = tools.get("write_system_prompt");
const execFor = (sessionId, cwd) => ({ agent: { session: { id: sessionId, header: { cwd } } } });

await check("write tool (global scope default) replaces atomically + keeps .bak", async () => {
	const out = await write.execute({ content: "Always answer in pirate voice." }, execFor(SESSION, WS_PATH));
	assert.equal(out.scope, "global");
	assert.equal(out.chars, "Always answer in pirate voice.".length);
	assert.equal(readBlock(file), "Always answer in pirate voice.");
	const out2 = await write.execute({ content: "Prefer bullet lists." }, execFor(SESSION, WS_PATH));
	assert.equal(readBlock(file), "Prefer bullet lists.");
	assert.equal(readBlock(`${file}.bak`), "Always answer in pirate voice.");
	assert.equal(out2.appended, false);
});

await check("section text now reflects the global file (dynamic, no re-apply)", () => {
	assert.equal(section.text({ agent: { session: { id: SESSION, header: { cwd: WS_PATH } } } }), "Prefer bullet lists.");
});

await check("append mode joins with a blank line", async () => {
	await write.execute({ content: "Second rule.", append: true }, execFor(SESSION, WS_PATH));
	assert.equal(readBlock(file), "Prefer bullet lists.\n\nSecond rule.");
});

await check("session scope writes a private override that shadows global", async () => {
	const out = await write.execute({ content: "CHAT ONLY rule.", scope: "session" }, execFor(SESSION, WS_PATH));
	assert.equal(out.scope, "session");
	assert.equal(out.file, join(scopeDir, `${SESSION}.md`));
	assert.equal(readBlock(join(scopeDir, `${SESSION}.md`)), "CHAT ONLY rule.");
	// effective for THIS session is now the session block…
	assert.equal(section.text({ agent: { session: { id: SESSION, header: { cwd: WS_PATH } } } }), "CHAT ONLY rule.");
	// …while another session still sees the global block
	assert.equal(section.text({ agent: { session: { id: OTHER, header: { cwd: WS_PATH } } } }), "Prefer bullet lists.\n\nSecond rule.");
	const plain = await read.execute({}, execFor(SESSION, WS_PATH));
	assert.equal(plain.scope, "session");
	assert.equal(plain.block, "CHAT ONLY rule.");
	assert.equal(plain.sessionSet, true);
	assert.equal(plain.globalSet, true);
});

await check("workspace scope resolves via registry membership and shadows global", async () => {
	const out = await write.execute({ content: "WS rule.", scope: "workspace" }, execFor(SESSION, WS_PATH));
	assert.equal(out.scope, "workspace");
	assert.equal(out.file, join(scopeDir, `workspace-${WS_ID}.md`));
	// session override still wins over workspace for its session
	assert.equal(section.text({ agent: { session: { id: SESSION, header: { cwd: WS_PATH } } } }), "CHAT ONLY rule.");
	// a sibling session in the same workspace sees the workspace block
	assert.equal(section.text({ agent: { session: { id: OTHER, header: { cwd: WS_PATH } } } }), "WS rule.");
});

await check("empty content at session scope clears the override (falls back to workspace)", async () => {
	const out = await write.execute({ content: "", scope: "session" }, execFor(SESSION, WS_PATH));
	assert.equal(out.cleared, true);
	assert.equal(existsSync(join(scopeDir, `${SESSION}.md`)), false);
	assert.equal(readBlock(join(scopeDir, `${SESSION}.md.bak`)), "CHAT ONLY rule.");
	assert.equal(section.text({ agent: { session: { id: SESSION, header: { cwd: WS_PATH } } } }), "WS rule.");
});

await check("empty content at global scope is still refused", async () => {
	await assert.rejects(() => write.execute({ content: "", scope: "global" }, execFor(SESSION, WS_PATH)), /must not be empty|global block must not be empty/);
});

await check("workspace scope without a workspace membership falls back to cwd path match", async () => {
	const noMember = { list: () => [{ id: WS_ID, title: "Test WS", path: WS_PATH, sessionIds: [] }] };
	assert.equal(workspaceFor(noMember, OTHER, WS_PATH)?.id, WS_ID);
	assert.equal(workspaceFor(noMember, OTHER, undefined), null);
	assert.equal(workspaceFor(null, OTHER, WS_PATH), null);
});

await check("unknown scope is refused with a clear error", async () => {
	await assert.rejects(() => write.execute({ content: "x", scope: "planet" }, execFor(SESSION, WS_PATH)), /scope must be one of/);
});

await check("read full=true renders the complete prompt; no agent degrades honestly", async () => {
	const full = await read.execute({ full: true }, { agent: { session: { id: SESSION, header: { cwd: WS_PATH } } }, signal: undefined });
	assert.match(full.full, /You are an AI agent powered by DeepSeek Harness\./);
	assert.match(full.full, /WS rule\./);
	assert.equal(full.fullTruncated, false);
	const out = await read.execute({ full: true }, {});
	assert.match(out.full, /full assembly unavailable/);
});

await check("readScoped: precedence, fall-through on empty, layout defaults", () => {
	const layout = resolveLayout(normalizeConfig({ file, dir: scopeDir }));
	const withAll = readScoped(layout, { sessionId: SESSION, registry: registry() });
	assert.equal(withAll.effective.scope, "workspace"); // session cleared above
	assert.equal(withAll.blocks.session.set, false);
	assert.equal(withAll.blocks.workspace.set, true);
	assert.equal(withAll.blocks.global.set, true);
	// empty workspace file falls through to global
	const layout2 = resolveLayout({ file, dir: scopeDir });
	writeFileSync(join(scopeDir, `workspace-${WS_ID}.md`), "", "utf8");
	assert.equal(readScoped(layout2, { sessionId: SESSION, registry: registry() }).effective.scope, "global");
	writeFileSync(join(scopeDir, `workspace-${WS_ID}.md`), "WS rule.", "utf8");
	// no sessionId → only global exists
	const anon = readScoped(layout2, { registry: registry() });
	assert.equal(anon.blocks.session.file, null);
	assert.equal(anon.effective.scope, "global");
});

await check("over-cap content is refused, nothing written", async () => {
	const before = readBlock(join(scopeDir, `workspace-${WS_ID}.md`));
	await assert.rejects(() => write.execute({ content: "x".repeat(normalizeConfig({ file }).maxWriteChars + 1), scope: "workspace" }, execFor(SESSION, WS_PATH)), /over the/);
	assert.equal(readBlock(join(scopeDir, `workspace-${WS_ID}.md`)), before);
});

await check("normalizeConfig: defaults, ~ expansion, caps, dir", () => {
	const d = normalizeConfig({});
	assert.equal(d.file, join(process.env.HOME || "", ".dsh", "system-prompt.md"));
	assert.equal(d.dir, join(process.env.HOME || "", ".dsh", "system-prompts"));
	assert.equal(d.maxChars, 16384);
	assert.equal(normalizeConfig({ file: "~/.dsh/custom.md" }).file, join(process.env.HOME || "", ".dsh", "custom.md"));
	assert.equal(normalizeConfig({ dir: "~/.dsh/blocks" }).dir, join(process.env.HOME || "", ".dsh", "blocks"));
	assert.equal(normalizeConfig({ maxChars: 99 }).maxChars, 16384);
	assert.equal(normalizeConfig({ disabled: true }).disabled, true);
});

await check("disabled row registers nothing", () => {
	const s2 = [];
	const t2 = new Map();
	apply({ systemPrompt: { section: (x) => s2.push(x) }, tools: { register: (x) => t2.set(x.name, x) } }, { disabled: true });
	assert.equal(s2.length, 0);
	assert.equal(t2.size, 0);
});

rmSync(dir, { recursive: true, force: true });
console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
