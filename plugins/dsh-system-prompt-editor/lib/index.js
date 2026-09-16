/**
 * File-backed live system-prompt block + read/write agent tools, SCOPED:
 * a per-chat override file and a per-workspace override file over the global
 * block. First non-empty wins — an absent/empty file at any level simply
 * falls through to the next, so the feature is inert until someone writes.
 *
 *   session   ~/.dsh/system-prompts/<sessionId>.md          (this chat)
 *   workspace ~/.dsh/system-prompts/workspace-<id>.md       (this workspace)
 *   global    ~/.dsh/system-prompt.md                       (every chat)
 *
 *   1. A prompt section "deployment:user-prompt" (order 9000 — after all
 *      TOOL_* guidance, before the persona suffix) whose `text` is a FUNCTION.
 *      The agent loop calls systemPrompt.assemble() on every preStep with the
 *      assembling agent in the context, so the effective file is re-resolved
 *      and re-read for every LLM call; a write lands on the next turn of every
 *      RUNNING session, not just new ones.
 *   2. `interpolate: false` — block text stays literal. A stray `{{anything}}`
 *      must never trip the strict variable validator.
 *   3. Empty text is dropped by renderPrompt, so an unset chain contributes
 *      exactly nothing — zero prompt pollution.
 *
 * Workspace resolution: the live workspace registry's sessionIds membership
 * (canonical-cwd filtered), falling back to realpath(session cwd) ===
 * workspace.path. Sessions in no workspace (Ungrouped) skip the workspace
 * level. Subagent children resolve by their own header cwd.
 *
 * Tools (host-plane, visible to every session):
 *   - read_system_prompt: the EFFECTIVE block (and which scope/file it came
 *     from, plus per-level set/chars); with full=true the COMPLETE rendered
 *     prompt as the next request would carry it.
 *   - write_system_prompt: replace/append a block at a chosen scope (default
 *     global — the shared harness-wide block); empty content at session or
 *     workspace scope REMOVES the override (falls back). Atomic tmp+rename,
 *     one-deep .bak at every level.
 *
 * Config (row-level, all optional): { disabled, file, dir, maxChars,
 * maxFullChars, maxWriteChars }. Manual normalization — no exported zod
 * Config, so no schema-drift boot risk.
 */
//#region lib/index.js
import { readFileSync, writeFileSync, renameSync, mkdirSync, copyFileSync, unlinkSync, realpathSync } from "node:fs";
import { dirname, resolve, join } from "node:path";
import { homedir } from "node:os";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { assembleContextFor } from "@deepseek-ai/dsh-agent";
import { renderPrompt } from "@deepseek-ai/dsh-system-prompt";

/** Cordis plugin name used by loader diagnostics. */
export const name = "system-prompt-editor";
/** The seams this plugin rides: tools, the prompt assembler, workspace lookups. */
export const inject = ["tools", "systemPrompt", "workspaceRegistry"];

/** Section name in the assembled prompt (shadows nothing; unique). */
export const USER_PROMPT_SECTION = "deployment:user-prompt";
/** After TOOL_* guidance (≤ 2800), before DEPLOYMENT_PERSONA_SUFFIX (10200). */
export const USER_PROMPT_ORDER = 9000;
/** Resolution order of the override chain (first non-empty wins). */
export const SCOPES = ["session", "workspace", "global"];

function capInt(value, min, max, fallback) {
	return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max ? Math.floor(value) : fallback;
}

/** Expand a leading ~ (alone or ~/…) and make absolute against cwd. */
export function expandPath(value) {
	const raw = String(value);
	if (raw === "~") return homedir();
	if (raw.startsWith("~/")) return resolve(homedir(), raw.slice(2));
	return resolve(raw);
}

/** Normalize untrusted row config into the shapes this plugin reads. */
export function normalizeConfig(config = {}) {
	return {
		disabled: config.disabled === true,
		file: typeof config.file === "string" && config.file.length > 0 ? expandPath(config.file) : resolve(homedir(), ".dsh", "system-prompt.md"),
		// directory holding the per-session / per-workspace override files
		dir: typeof config.dir === "string" && config.dir.length > 0 ? expandPath(config.dir) : resolve(homedir(), ".dsh", "system-prompts"),
		// block size cap for what enters the PROMPT (tokens cost money every turn)
		maxChars: capInt(config.maxChars, 200, 131072, 16384),
		// render cap for what a read_system_prompt(full=true) may return
		maxFullChars: capInt(config.maxFullChars, 2000, 1000000, 100000),
		// write cap — refuse absurd replacements rather than silently truncate
		maxWriteChars: capInt(config.maxWriteChars, 200, 131072, 65536)
	};
}

/** Read the block; any read failure means "no block" (absent == empty == inert). */
export function readBlock(file) {
	try {
		return readFileSync(file, "utf8");
	} catch {
		return "";
	}
}

/** Atomic replace: same-dir tmp + rename, one-deep .bak, parent dirs created. */
export function writeBlock(file, content) {
	mkdirSync(dirname(file), { recursive: true });
	const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
	writeFileSync(tmp, content, "utf8");
	try {
		copyFileSync(file, `${file}.bak`);
	} catch {
		/* no previous block to back up */
	}
	renameSync(tmp, file);
}

/** Remove an override, keeping a one-deep .bak; absent file is a no-op. */
export function clearBlock(file) {
	try {
		copyFileSync(file, `${file}.bak`);
	} catch {
		/* nothing set */
	}
	try {
		unlinkSync(file);
	} catch {
		/* already absent */
	}
}

/** Filesystem-safe, collision-free spelling of an id inside the dir. */
function safeName(id) {
	return String(id).replace(/[^A-Za-z0-9_.-]/g, "_");
}

/**
 * The file layout of the override chain for one normalized config.
 * @param resolved - normalizeConfig() output.
 * @returns globalFile/dir plus the per-scope file speller.
 */
export function resolveLayout(resolved) {
	return {
		globalFile: resolved.file,
		dir: resolved.dir,
		sessionFile: (sessionId) => join(resolved.dir, `${safeName(sessionId)}.md`),
		workspaceFile: (workspaceId) => join(resolved.dir, `workspace-${safeName(workspaceId)}.md`)
	};
}

/**
 * Resolve the workspace of a session, synchronously. Membership first (the
 * registry's live canonical-cwd-filtered index), then realpath(cwd) path
 * match. Any failure (no registry, missing dir, …) means "no workspace".
 * @param registry - the workspaceRegistry service (or a mock with list()).
 * @param sessionId - the session to look up, when known.
 * @param cwd - the session's header cwd, when known (fallback key).
 * @returns {id,title,path} or null.
 */
export function workspaceFor(registry, sessionId, cwd) {
	if (registry === null || registry === undefined) return null;
	try {
		const list = registry.list();
		if (typeof sessionId === "string" && sessionId.length > 0) {
			const hit = list.find((ws) => Array.isArray(ws.sessionIds) && ws.sessionIds.includes(sessionId));
			if (hit !== undefined) return { id: hit.id, title: hit.title, path: hit.path };
		}
		if (typeof cwd === "string" && cwd.length > 0) {
			let canonical;
			try {
				canonical = realpathSync(cwd);
			} catch {
				return null;
			}
			const hit = list.find((ws) => ws.path === canonical);
			if (hit !== undefined) return { id: hit.id, title: hit.title, path: hit.path };
		}
	} catch {
		/* registry unavailable — workspace level is simply not resolvable */
	}
	return null;
}

/**
 * Resolve the effective block and every level's state for one session.
 * @param layout - resolveLayout() output.
 * @param deps - { sessionId?, cwd?, registry? } — all optional; without a
 *   sessionId only the global level exists, without a registry the workspace
 *   level is skipped.
 * @returns { effective: {scope,file,content,chars,set}, blocks: {session,
 *   workspace, global}, workspace: {id,title,path}|null, sessionId: string|null }.
 */
export function readScoped(layout, deps = {}) {
	const sessionId = typeof deps.sessionId === "string" && deps.sessionId.length > 0 ? deps.sessionId : null;
	const workspace = workspaceFor(deps.registry, sessionId ?? undefined, deps.cwd);
	const levels = [
		{ scope: "session", file: sessionId !== null ? layout.sessionFile(sessionId) : null },
		{ scope: "workspace", file: workspace !== null ? layout.workspaceFile(workspace.id) : null },
		{ scope: "global", file: layout.globalFile }
	].map((level) => {
		if (level.file === null) return { scope: level.scope, file: null, content: "", chars: 0, set: false };
		const raw = readBlock(level.file);
		return { scope: level.scope, file: level.file, content: raw, chars: raw.length, set: raw.length > 0 };
	});
	const blocks = Object.fromEntries(levels.map((level) => [level.scope, level]));
	const effective = levels.find((level) => level.set) ?? blocks.global;
	return { effective, blocks, workspace, sessionId };
}

/** Pull {sessionId, cwd} off a tool-exec / assembly-context agent, defensively. */
export function agentLocator(agent) {
	const session = agent?.session;
	return {
		sessionId: typeof session?.id === "string" ? session.id : undefined,
		cwd: typeof session?.header?.cwd === "string" ? session.header.cwd : undefined
	};
}

/**
 * Plugin apply: one dynamic prompt section, two agent tools.
 * Same plain-object shape (name/inject/apply) as the other @local plugins.
 */
export function apply(ctx, config) {
	const resolved = normalizeConfig(config);
	if (resolved.disabled) return;
	const layout = resolveLayout(resolved);

	const resolveForAgent = (agent) => readScoped(layout, { ...agentLocator(agent), registry: ctx.workspaceRegistry });

	ctx.systemPrompt.section({
		name: USER_PROMPT_SECTION,
		order: USER_PROMPT_ORDER,
		interpolate: false,
		text: (context) => resolveForAgent(context?.agent).effective.content.slice(0, resolved.maxChars)
	});

	ctx.tools.register(
		defineTool({
			name: "read_system_prompt",
			description:
				"Read the standing system-prompt block this chat runs under, and which scope it came from. Resolution: this-chat override → workspace override → the global block (first non-empty wins; unset levels are skipped). With full: true, instead return the COMPLETE system prompt exactly as the next LLM request would carry it. Use this to see the standing instructions you are running under before editing them.",
			parameters: {
				full: { type: "boolean", description: "true: return the complete rendered system prompt (capped), not just the effective block. Default false." }
			},
			output: {
				schema: {
					type: "object",
					additionalProperties: false,
					properties: {
						scope: { type: "string", required: true, description: "Which level the effective block came from: \"session\", \"workspace\", or \"global\"." },
						file: { type: "string", required: true, description: "Path of the effective block file (the global file when nothing is set)." },
						block: { type: "string", required: true, description: "Effective block text (\"\" when unset at every level — the section then contributes nothing)." },
						blockTruncated: { type: "boolean", required: true, description: "Whether the block was cut by the size cap." },
						workspace: { type: "string", description: "The resolved workspace (\"title (id)\"), or \"none\" when this chat belongs to no workspace." },
						sessionSet: { type: "boolean", description: "Whether a this-chat override file exists and is non-empty." },
						sessionFile: { type: "string", description: "Path of the this-chat override file." },
						workspaceSet: { type: "boolean", description: "Whether a workspace override exists and is non-empty." },
						workspaceFile: { type: "string", description: "Path of the workspace override file." },
						globalSet: { type: "boolean", description: "Whether the global block is set." },
						globalFile: { type: "string", description: "Path of the global block file." },
						full: { type: "string", description: "The complete rendered system prompt (only present when full was requested)." },
						fullTruncated: { type: "boolean", description: "Whether the full prompt was cut by the render cap." }
					}
				},
				render: (_args, value) => {
					const lines = [`# effective block — scope: ${value.scope} (${value.file})`];
					lines.push(value.block.length > 0 ? value.block : "(empty — no level is set; the section contributes nothing to the prompt)");
					if (value.blockTruncated) lines.push("(…block truncated by the size cap…)");
					const levels = [
						["this chat", value.sessionSet, value.sessionFile],
						["workspace", value.workspaceSet, value.workspaceFile],
						["global", value.globalSet, value.globalFile]
					].filter(([, , path]) => path !== undefined);
					if (levels.length > 0) {
						lines.push("", "# levels");
						for (const [label, set, path] of levels) lines.push(`- ${label}: ${set ? "set" : "unset"} — ${path}`);
					}
					if (value.full !== undefined) {
						lines.push("", "# complete system prompt (as the next request carries it)");
						lines.push(value.full);
						if (value.fullTruncated) lines.push("(…full prompt truncated by the render cap…)");
					}
					return [{ type: "text", text: lines.join("\n") }];
				}
			},
			isConcurrencySafe: () => true,
			async execute(args, exec) {
				const agent = exec?.agent;
				const { effective, blocks, workspace } = resolveForAgent(agent);
				const block = effective.content.slice(0, resolved.maxChars);
				const result = {
					scope: effective.scope,
					file: effective.file,
					block,
					blockTruncated: effective.content.length > block.length
				};
				if (blocks.session.file !== null) {
					result.sessionSet = blocks.session.set;
					result.sessionFile = blocks.session.file;
				}
				if (blocks.workspace.file !== null) {
					result.workspaceSet = blocks.workspace.set;
					result.workspaceFile = blocks.workspace.file;
				}
				result.globalSet = blocks.global.set;
				result.globalFile = blocks.global.file;
				result.workspace = workspace === null ? "none" : `${workspace.title} (${workspace.id})`;
				if (args.full === true) {
					let full;
					try {
						full = agent === undefined ? "(full assembly unavailable in this context: no agent on the tool exec)" : renderPrompt(await ctx.systemPrompt.assemble(assembleContextFor(agent, exec?.signal)));
					} catch (error) {
						full = `(full assembly unavailable in this context: ${String(error?.message ?? error).slice(0, 200)})`;
					}
					const cut = full.slice(0, resolved.maxFullChars);
					result.full = cut;
					result.fullTruncated = full.length > cut.length;
				}
				return result;
			}
		})
	);

	ctx.tools.register(
		defineTool({
			name: "write_system_prompt",
			description:
				"Write a standing system-prompt block at a chosen scope (default global). Scope \"session\" = a private override for THIS chat only; \"workspace\" = every chat in this workspace; \"global\" = every chat of this harness (the default). Resolution is this chat → workspace → global; the first non-empty wins, so a narrower override shadows broader ones. Applies from the NEXT turn of every affected running session (no restart). The previous content of whatever file is written is kept at <file>.bak. Empty content at session or workspace scope REMOVES that override (falls back); the global block must be non-empty (to disable it, remove the file or use config.disabled). Plain text/markdown; no template syntax ({{...}} is literal). Replace by default; append: true adds to the end of the same scope's block.",
			parameters: {
				content: { type: "string", required: true, description: "The new block text (or the text to append when append: true; empty string = remove the override for session/workspace scopes)." },
				scope: { type: "string", description: "Where the block applies: \"session\" (this chat), \"workspace\" (this workspace), or \"global\" (all chats). Default \"global\"." },
				append: { type: "boolean", description: "true: append to the current block of that scope (separated by a blank line) instead of replacing it. Default false." }
			},
			output: {
				schema: {
					type: "object",
					additionalProperties: false,
					properties: {
						scope: { type: "string", required: true, description: "The scope written (or cleared)." },
						file: { type: "string", required: true, description: "Path of the block file written or removed." },
						chars: { type: "integer", required: true, description: "Characters now in that scope's block (0 when cleared or already unset)." },
						cleared: { type: "boolean", required: true, description: "Whether this call REMOVED the override (empty content at session/workspace scope)." },
						appended: { type: "boolean", required: true, description: "Whether the write appended instead of replacing." }
					}
				},
				render: (_args, value) => [
					{
						type: "text",
						text: value.cleared
							? `system-prompt override cleared at scope ${value.scope} (${value.file}; falls back to the broader scope; previous version at ${value.file}.bak)`
							: `system-prompt block ${value.appended ? "appended" : "written"} at scope ${value.scope}: ${value.chars} chars in ${value.file} (applies to affected sessions from their next turn; previous version at ${value.file}.bak)`
					}
				]
			},
			isConcurrencySafe: () => true,
			async execute(args, exec) {
				const content = String(args.content ?? "");
				const scope = args.scope === undefined ? "global" : String(args.scope);
				if (!SCOPES.includes(scope)) throw new Error(`write_system_prompt: scope must be one of ${SCOPES.map((s) => `"${s}"`).join(", ")} — got "${scope}"`);
				const agent = exec?.agent;
				const { sessionId } = agentLocator(agent);
				const workspace = workspaceFor(ctx.workspaceRegistry, sessionId, agentLocator(agent).cwd);
				let file;
				if (scope === "session") {
					if (sessionId === undefined) throw new Error('write_system_prompt: scope "session" needs this chat\'s identity, which is unavailable in this execution context');
					file = layout.sessionFile(sessionId);
				} else if (scope === "workspace") {
					if (workspace === null) throw new Error('write_system_prompt: scope "workspace" requires this chat to belong to a workspace (Ungrouped chats have none)');
					file = layout.workspaceFile(workspace.id);
				} else {
					file = layout.globalFile;
				}
				if (content.length === 0) {
					if (scope === "global") throw new Error("write_system_prompt: the global block must not be empty (to disable it, remove the file or set the plugin row's config.disabled)");
					clearBlock(file);
					return { scope, file, chars: 0, cleared: true, appended: false };
				}
				if (content.length > resolved.maxWriteChars) throw new Error(`write_system_prompt: content is ${content.length} chars, over the ${resolved.maxWriteChars}-char cap — nothing was written`);
				const append = args.append === true;
				const current = readBlock(file);
				const next = append && current.length > 0 ? `${current}\n\n${content}` : content;
				writeBlock(file, next);
				return { scope, file, chars: next.length, cleared: false, appended: append };
			}
		})
	);
}
//#endregion
