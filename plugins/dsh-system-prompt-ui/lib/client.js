window.__ModuleLoader__.load({
	id: "@local/dsh-system-prompt-ui",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let react_jsx_runtime = require("react/jsx-runtime");
		let _deepseek_ai_dsh_client_ui_primitives = require("@deepseek-ai/dsh-client-ui-primitives");
		//#region lib/client/Editor.module.css
		const css = ".spUi_moreButton{width:28px;height:28px;color:var(--dsw-alias-label-secondary);cursor:pointer;background:0 0;border:none;border-radius:28px;flex:none;justify-content:center;align-items:center;padding:6px;display:inline-flex}.spUi_moreButton svg{width:15px;height:15px}.spUi_moreButton:hover{background:var(--dsw-alias-interactive-bg-hover)}.spUi_tabs{display:flex;gap:4px;margin:2px 0 10px;flex-wrap:wrap}.spUi_tab{display:inline-flex;align-items:center;gap:6px;padding:4px 10px;border-radius:999px;border:1px solid var(--dsw-alias-border-l3);background:0 0;color:var(--dsw-alias-label-secondary);cursor:pointer;font-size:12px;line-height:18px}.spUi_tab:hover{background:var(--dsw-alias-interactive-bg-hover)}.spUi_tabActive{border-color:var(--dsw-alias-state-business-primary);color:var(--dsw-alias-label-primary)}.spUi_tabDisabled{opacity:.5;cursor:default}.spUi_tabDot{width:6px;height:6px;border-radius:6px;background:var(--dsw-alias-state-business-primary);flex:none}.spUi_textarea{width:100%;box-sizing:border-box;min-height:240px;max-height:56vh;resize:vertical;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;line-height:18px;padding:10px 12px;border:1px solid var(--dsw-alias-border-l3);border-radius:8px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary)}.spUi_textarea:focus{outline:none;border-color:var(--dsw-alias-state-business-primary)}.spUi_meta{margin-top:6px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);display:flex;justify-content:space-between;gap:16px;align-items:baseline}.spUi_metaPath{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;direction:rtl}.spUi_status{margin-top:8px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}.spUi_statusError{color:var(--dsw-alias-state-error-primary)}.spUi_footer{display:flex;gap:8px;justify-content:flex-end;align-items:center}";
		const tagId = "@local/dsh-system-prompt-ui/Editor.module.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "@local/dsh-system-prompt-ui";
			tag.dataset.pluginCss = tagId;
			tag.textContent = css;
			document.head.appendChild(tag);
		}
		var Editor_module_css_default = {
			"moreButton": "spUi_moreButton",
			"tabs": "spUi_tabs",
			"tab": "spUi_tab",
			"tabActive": "spUi_tabActive",
			"tabDisabled": "spUi_tabDisabled",
			"tabDot": "spUi_tabDot",
			"textarea": "spUi_textarea",
			"meta": "spUi_meta",
			"metaPath": "spUi_metaPath",
			"status": "spUi_status",
			"statusError": "spUi_statusError",
			"footer": "spUi_footer"
		};
		//#endregion
		//#region lib/client/locales.js
		/** Locale namespace owned by the system-prompt editor dialog. */
		const NS = "system-prompt-ui";
		/** Simplified-Chinese system-prompt editor strings. */
		const zh = {
			"header.edit": "编辑系统提示词",
			"dialog.title": "系统提示词 — 常驻指令",
			"dialog.hint": "最具体的一层生效:本对话 → 所在工作区 → 所有对话;自下一轮起生效。",
			"dialog.loading": "加载中…",
			"dialog.loadFailed": "无法读取系统提示词内容",
			"dialog.loadFailedPrefix": "读取失败",
			"dialog.empty": "(空 — 未设置,不进入提示词)",
			"dialog.save": "保存",
			"dialog.cancel": "取消",
			"dialog.close": "关闭",
			"dialog.saving": "保存中…",
			"dialog.saved": "已保存 — 自下一轮起生效。",
			"dialog.cleared": "已清除 — 回落到更宽的范围,自下一轮起生效。",
			"dialog.saveFailed": "保存失败",
			"chars": "{n} 个字符",
			"scope.chat": "本对话",
			"scope.workspace": "工作区 · {title}",
			"scope.workspaceNone": "工作区",
			"scope.global": "所有对话",
			"scope.unset": "(未设置 — 使用更宽的范围)",
			"scope.active": "当前生效:{scope}",
			"scope.noWorkspace": "本对话不属于任何工作区,没有工作区一层。",
			"action.clear": "清除覆盖"
		};
		/** English system-prompt editor strings. */
		const en = {
			"header.edit": "Edit system prompt",
			"dialog.title": "System prompt — standing instructions",
			"dialog.hint": "The most specific set block wins: this chat → its workspace → all chats. Applies from the next turn.",
			"dialog.loading": "Loading…",
			"dialog.loadFailed": "Could not load the system-prompt block",
			"dialog.loadFailedPrefix": "Load failed",
			"dialog.empty": "(empty — unset levels contribute nothing to the prompt)",
			"dialog.save": "Save",
			"dialog.cancel": "Cancel",
			"dialog.close": "Close",
			"dialog.saving": "Saving…",
			"dialog.saved": "Saved — applies from the next turn.",
			"dialog.cleared": "Cleared — falls back to the broader scope from the next turn.",
			"dialog.saveFailed": "Save failed",
			"chars": "{n} characters",
			"scope.chat": "This chat",
			"scope.workspace": "Workspace · {title}",
			"scope.workspaceNone": "Workspace",
			"scope.global": "All chats",
			"scope.unset": "(not set — falls back to the broader scope)",
			"scope.active": "Active: {scope}",
			"scope.noWorkspace": "This chat belongs to no workspace (Ungrouped) — the workspace level is unavailable.",
			"action.clear": "Clear override"
		};
		//#endregion
		//#region lib/client/Editor.js
		/** Stable browser path of the host route (same constant as the node half). */
		const BLOCK_ROUTE = "/api/system-prompt.block";
		/** Scope tab order shown in the dialog. */
		const TAB_ORDER = ["session", "workspace", "global"];

		function messageOf(error) {
			return error instanceof Error ? error.message : String(error);
		}

		/**
		* Editor dialog: scoped blocks (this chat / workspace / all chats) over
		* the host route. First non-empty level wins in the prompt; the dialog
		* shows each level's state, edits one at a time, and can clear a
		* session/workspace override (which falls back).
		* @param props - open/onClose state, the session id, and the locale seat.
		* @returns the modal element.
		*/
		function SystemPromptEditor({ open, onClose, t, sessionId }) {
			const [data, setData] = react.useState(null);
			const [selected, setSelected] = react.useState("global");
			const [texts, setTexts] = react.useState({ session: "", workspace: "", global: "" });
			const [phase, setPhase] = react.useState("idle");
			const [error, setError] = react.useState(null);
			const [errorOp, setErrorOp] = react.useState("load");
			const [clearedNote, setClearedNote] = react.useState(false);
			const initialized = react.useRef(false);
			const routeUrl = react.useCallback((suffix) => BLOCK_ROUTE + (sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : "") + suffix, [sessionId]);
			const applyData = react.useCallback((value) => {
				setData(value);
				setTexts({
					session: value.blocks.session.content,
					workspace: value.blocks.workspace.content,
					global: value.blocks.global.content
				});
				// first load lands on the effective scope; later loads keep the
				// tab unless it stopped existing (workspace disappeared)
				if (!initialized.current) {
					initialized.current = true;
					setSelected(value.effective);
				} else setSelected((current) => current === "workspace" && value.workspace === null ? value.effective : current);
			}, []);
			const load = react.useCallback(async () => {
				setPhase("loading");
				setError(null);
				setClearedNote(false);
				try {
					const response = await fetch(routeUrl(""), { method: "GET" });
					if (!response.ok) throw new Error(`HTTP ${response.status}`);
					applyData(await response.json());
					setPhase("ready");
				} catch (cause) {
					setErrorOp("load");
					setError(messageOf(cause));
					setPhase("error");
				}
			}, [routeUrl, applyData]);
			react.useEffect(() => {
				if (open) void load();
			}, [open, load]);
			const send = react.useCallback(async (scope, content) => {
				setPhase("saving");
				setError(null);
				setClearedNote(false);
				try {
					const response = await fetch(routeUrl(""), {
						method: "PUT",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({ sessionId, scope, content })
					});
					const value = await response.json().catch(() => ({}));
					if (!response.ok) throw new Error(value.error || `HTTP ${response.status}`);
					if (scope !== "global" && content.length === 0) setClearedNote(true);
					const refresh = await fetch(routeUrl(""), { method: "GET" });
					if (refresh.ok) applyData(await refresh.json());
					setPhase("saved");
				} catch (cause) {
					setErrorOp("save");
					setError(messageOf(cause));
					setPhase("error");
				}
			}, [routeUrl, sessionId, applyData]);
			const busy = phase === "loading" || phase === "saving";
			const saved = phase === "saved";
			const level = data === null ? null : data.blocks[selected];
			const labelOf = react.useCallback((scope) => scope === "session" ? t("scope.chat") : scope === "workspace" && data !== null && data.workspace !== null ? t("scope.workspace", { title: data.workspace.title }) : t("scope.global"), [t, data]);
			return (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Modal, {
				open,
				onClose: onClose,
				title: t("dialog.title"),
				closeLabel: saved ? t("dialog.close") : t("dialog.cancel"),
				children: (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
					(0, react_jsx_runtime.jsx)("div", {
						className: Editor_module_css_default.status,
						children: t("dialog.hint")
					}),
					data === null ? (0, react_jsx_runtime.jsx)("div", {
						className: Editor_module_css_default.status,
						children: busy ? t("dialog.loading") : phase === "error" ? t("dialog.loadFailed") : ""
					}) : (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
						(0, react_jsx_runtime.jsx)("div", {
							className: Editor_module_css_default.tabs,
							role: "tablist",
							children: TAB_ORDER.map((scope) => {
								const available = scope !== "session" || sessionId !== undefined && sessionId !== null;
								const workspaceAvailable = scope !== "workspace" || data.workspace !== null;
								const disabled = busy || !available || !workspaceAvailable;
								return (0, react_jsx_runtime.jsxs)("button", {
									type: "button",
									role: "tab",
									"aria-selected": selected === scope,
									disabled: disabled,
									title: scope === "workspace" && data.workspace === null ? t("scope.noWorkspace") : null,
									className: `${Editor_module_css_default.tab} ${selected === scope ? Editor_module_css_default.tabActive : ""} ${disabled ? Editor_module_css_default.tabDisabled : ""}`,
									onClick: () => {
										if (!disabled) setSelected(scope);
									},
									children: [
										scope === "session" ? t("scope.chat") : scope === "workspace" ? data.workspace !== null ? t("scope.workspace", { title: data.workspace.title }) : t("scope.workspaceNone") : t("scope.global"),
										data.blocks[scope].set ? (0, react_jsx_runtime.jsx)("span", { className: Editor_module_css_default.tabDot }) : null
									]
								}, scope);
							})
						}),
						data.workspace === null ? (0, react_jsx_runtime.jsx)("div", {
							className: Editor_module_css_default.status,
							children: t("scope.noWorkspace")
						}) : null,
						(0, react_jsx_runtime.jsx)("div", {
							className: Editor_module_css_default.status,
							children: t("scope.active", { scope: labelOf(data.effective) })
						})
					] }),
					phase !== "error" ? (0, react_jsx_runtime.jsx)("textarea", {
						className: Editor_module_css_default.textarea,
						value: level === null ? "" : texts[selected],
						onChange: (event) => {
							const value = event.target.value;
							setTexts((previous) => ({ ...previous, [selected]: value }));
							if (phase === "saved") setPhase("ready");
						},
						spellCheck: false,
						placeholder: busy ? t("dialog.loading") : t("dialog.empty"),
						disabled: busy
					}) : (0, react_jsx_runtime.jsx)("textarea", {
						className: Editor_module_css_default.textarea,
						value: texts[selected],
						readOnly: true,
						placeholder: t("dialog.loadFailed")
					}),
					(0, react_jsx_runtime.jsxs)("div", {
						className: Editor_module_css_default.meta,
						children: [
							(0, react_jsx_runtime.jsx)("span", {
								className: Editor_module_css_default.metaPath,
								children: level !== null && level.set && level.file !== null ? level.file : t("scope.unset")
							}),
							(0, react_jsx_runtime.jsx)("span", {
								children: t("chars", { n: String(texts[selected].length) })
							})
						]
					}),
					error !== null && (0, react_jsx_runtime.jsx)("div", {
						className: `${Editor_module_css_default.status} ${Editor_module_css_default.statusError}`,
						children: `${t(errorOp === "load" ? "dialog.loadFailedPrefix" : "dialog.saveFailed")}: ${error}`
					}),
					saved && clearedNote && (0, react_jsx_runtime.jsx)("div", {
						className: Editor_module_css_default.status,
						children: t("dialog.cleared")
					}),
					saved && !clearedNote && (0, react_jsx_runtime.jsx)("div", {
						className: Editor_module_css_default.status,
						children: t("dialog.saved")
					})
				] }),
				footer: (0, react_jsx_runtime.jsxs)("div", {
					className: Editor_module_css_default.footer,
					children: [
						level !== null && selected !== "global" && level.set ? (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
							onClick: () => {
								void send(selected, "");
							},
							disabled: busy,
							children: t("action.clear")
						}) : null,
						(0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
							onClick: onClose,
							children: saved ? t("dialog.close") : t("dialog.cancel")
						}),
						(0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
							variant: "primary",
							onClick: () => {
								void send(selected, texts[selected]);
							},
							disabled: busy || saved,
							children: saved ? clearedNote ? t("dialog.cleared") : t("dialog.saved") : phase === "saving" ? t("dialog.saving") : t("dialog.save")
						})
					]
				})
			});
		}
		//#endregion
		//#region lib/client/HeaderAction.js
		/**
		* Render the chat-header edit-prompt button and the editor dialog it
		* opens, registered into the conversation header utilities cluster.
		* @param props - Session runtime (sessionId) and the locale seat from the slot renderer.
		* @returns the persistent header action and its dialog.
		*/
		function SystemPromptHeaderAction(props) {
			const { t, sessionId } = props;
			const [editorOpen, setEditorOpen] = react.useState(false);
			return (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
				(0, react_jsx_runtime.jsx)("button", {
					type: "button",
					className: Editor_module_css_default.moreButton,
					"aria-label": t("header.edit"),
					title: t("header.edit"),
					onClick: () => {
						setEditorOpen(true);
					},
					children: (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconListPenOutline16, {})
				}),
				(0, react_jsx_runtime.jsx)(SystemPromptEditor, {
					open: editorOpen,
					onClose: () => {
						setEditorOpen(false);
					},
					t,
					sessionId
				})
			] });
		}
		//#endregion
		//#region lib/client/index.js
		/** Browser plugin owning the system-prompt editor header action. */
		const inject = ["slots", "locale"];
		/**
		* Register the locale dictionaries and mount the editor into the chat
		* header's utilities cluster (next to the ⋯ more-actions area).
		* @param ctx - browser context carrying the slots and locale services.
		*/
		function apply(ctx) {
			ctx.effect(() => ctx.locale.register(NS, {
				zh,
				en
			}), "system-prompt-ui: browser dictionaries");
			ctx.slots.inject("conversation.session.header.utilities", () => ctx.slots.register({
				name: "conversation.session.header.utilities",
				id: "system-prompt-ui",
				locale: NS,
				inject: () => ({})
			}, SystemPromptHeaderAction));
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
