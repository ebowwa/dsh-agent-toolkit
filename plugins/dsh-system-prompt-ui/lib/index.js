/**
 * Host half of the system-prompt UI: one authenticated HTTP route that the
 * browser editor dialog reads and writes through, with scope.
 *
 * The block chain itself (deployment:user-prompt prompt section, the agent
 * tools, and the resolution rule "this chat → workspace → global, first
 * non-empty wins") is owned by @local/dsh-system-prompt-editor — this plugin
 * imports its pure helpers so both halves can never disagree on semantics,
 * while keeping its own row/config so either plugin can be disabled without
 * touching the other:
 *
 *   GET  /api/system-prompt.block?sessionId=<id>
 *        -> { sessionId, workspace, effective, blocks: { session, workspace, global } }
 *   PUT  /api/system-prompt.block  (body { sessionId?, scope?, content })
 *        -> scope "session"|"workspace"|"global" (default "global"); empty
 *           content at session/workspace scope REMOVES the override.
 *
 * The route rides the shared /api prefix, so the browser's gateway cookie
 * authenticates every call. Writes are atomic (same-dir tmp + rename) and
 * keep a one-deep .bak — the same write path as the write_system_prompt tool.
 *
 * Manual config normalization via the editor's normalizeConfig — no zod
 * Config, so no schema-drift boot risk.
 */
//#region lib/index.js
import { normalizeConfig, readBlock, writeBlock, clearBlock, resolveLayout, readScoped, SCOPES } from "@local/dsh-system-prompt-editor";

/** Cordis plugin name used by loader diagnostics. */
export const name = "system-prompt-ui";
/** The connection service owns the route registry; the registry resolves workspaces. */
export const inject = ["connection", "workspaceRegistry"];

/** Stable browser path (kept across any future transport migration). */
export const BLOCK_ROUTE = "/api/system-prompt.block";

/** Hard sanity cap on what one GET will return per level to the editor dialog. */
export const MAX_READ_CHARS = 131072;

/** One JSON Response helper. */
function json(value, status = 200) {
	return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json; charset=utf-8" } });
}

/** Trim one level's state to what the dialog needs (content capped). */
function levelView(level) {
	if (level === undefined || level.file === null) return { file: null, set: false, chars: 0, content: "" };
	return {
		file: level.file,
		set: level.set,
		chars: level.chars,
		content: level.content.slice(0, MAX_READ_CHARS)
	};
}

/**
 * Plugin apply: register the one route. No services beyond `connection`.
 */
export function apply(ctx, config) {
	const resolved = normalizeConfig(config);
	if (resolved.disabled) return;
	const layout = resolveLayout(resolved);

	ctx.connection.fetch.register({
		path: BLOCK_ROUTE,
		methods: ["GET", "PUT"],
		requestBody: "buffered",
		fetch: async (request) => {
			try {
				const url = new URL(request.url);
				const sessionIdParam = url.searchParams.get("sessionId");
				const sessionId = sessionIdParam !== null && sessionIdParam.length > 0 ? sessionIdParam : null;
				if (request.method === "GET") {
					const { effective, blocks, workspace } = readScoped(layout, { sessionId: sessionId ?? undefined, registry: ctx.workspaceRegistry });
					return json({
						sessionId,
						workspace: workspace === null ? null : { id: workspace.id, title: workspace.title, path: workspace.path },
						effective: effective.scope,
						blocks: {
							session: levelView(blocks.session),
							workspace: levelView(blocks.workspace),
							global: levelView(blocks.global)
						}
					});
				}
				// PUT
				let body;
				try {
					body = await request.json();
				} catch {
					return json({ error: 'body must be JSON: { "sessionId"?: string, "scope"?: "session"|"workspace"|"global", "content": string }' }, 400);
				}
				const content = body?.content;
				if (typeof content !== "string") return json({ error: "content must be a string" }, 400);
				const scope = body?.scope === undefined || body?.scope === null ? "global" : String(body.scope);
				if (!SCOPES.includes(scope)) return json({ error: `scope must be one of ${SCOPES.map((s) => `"${s}"`).join(", ")}` }, 400);
				const putSessionId = typeof body?.sessionId === "string" && body.sessionId.length > 0 ? body.sessionId : sessionId;
				let file;
				if (scope === "session") {
					if (putSessionId === null || putSessionId === undefined) return json({ error: 'scope "session" needs a sessionId (query param or body)' }, 400);
					file = layout.sessionFile(putSessionId);
				} else if (scope === "workspace") {
					const { workspace } = readScoped(layout, { sessionId: putSessionId ?? undefined, registry: ctx.workspaceRegistry });
					if (workspace === null) return json({ error: "this chat belongs to no workspace (Ungrouped) — use the chat or global scope" }, 400);
					file = layout.workspaceFile(workspace.id);
				} else {
					file = layout.globalFile;
				}
				if (content.length === 0) {
					if (scope === "global") return json({ error: "the global block must not be empty (to disable it, remove the file or set the plugin row's config.disabled)" }, 400);
					clearBlock(file);
					return json({ scope, file, cleared: true, chars: 0 });
				}
				if (content.length > resolved.maxWriteChars) return json({ error: `content is ${content.length} chars, over the ${resolved.maxWriteChars}-char cap — nothing was written` }, 400);
				writeBlock(file, content);
				return json({ scope, file, cleared: false, chars: content.length });
			} catch (error) {
				return json({ error: `system-prompt route failed: ${String(error?.message ?? error).slice(0, 300)}` }, 500);
			}
		}
	});
}
//#endregion
