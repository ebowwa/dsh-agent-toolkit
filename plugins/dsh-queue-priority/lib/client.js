window.__ModuleLoader__.load({
	id: "@local/dsh-queue-priority",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let react_jsx_runtime = require("react/jsx-runtime");
		let _deepseek_ai_dsh_client_ui_primitives = require("@deepseek-ai/dsh-client-ui-primitives");
		//#region lib/client/QueuePriorityPanel.module.css
		const css = ".qp_dock{box-sizing:border-box;width:calc(100% - var(--dsh-composer-side-clearance) - var(--dsh-composer-side-clearance) - var(--dsh-composer-dock-inset) - var(--dsh-composer-dock-inset));max-width:calc(var(--dsh-composer-card-max-width) - var(--dsh-composer-dock-inset) - var(--dsh-composer-dock-inset));margin:0 auto;padding:0 var(--dsh-composer-dock-inset);flex:none}.qp_panel{background:var(--dsw-specific-tip);border-radius:8px;border:.5px solid var(--dsw-alias-border-l1);width:100%;padding:2px 0;overflow:hidden}.qp_header{box-sizing:border-box;width:100%;min-height:28px;color:var(--dsw-alias-label-tertiary);align-items:center;gap:8px;padding:2px 12px 0;display:flex}.qp_title{min-width:0;font-family:Inter, var(--dsw-font-family);font-size:11px;font-weight:500;line-height:18px;letter-spacing:.2px;text-transform:uppercase;flex:auto}.qp_list{max-height:180px;margin:0;padding:0 0 2px;list-style:none;overflow-y:auto}.qp_row{box-sizing:border-box;border-radius:8px;align-items:center;gap:8px;width:100%;min-height:32px;padding:2px 5px 2px 12px;display:flex}.qp_row+.qp_row{box-shadow:inset 0 1px 0 var(--dsw-alias-border-l1)}.qp_pos{color:var(--dsw-alias-label-tertiary);font:var(--dsw-font-xs-13);font-variant-numeric:tabular-nums;flex:none;min-width:16px;text-align:right}.qp_preview{min-width:0;color:var(--dsw-alias-label-primary-dimmed);font:var(--dsw-font-xs-13);font-family:Inter, var(--dsw-font-family);flex:auto;text-overflow:ellipsis;white-space:nowrap;word-break:break-word;overflow:hidden}.qp_editor{min-width:0;flex:auto;font:var(--dsw-font-xs-13);font-family:Inter, var(--dsw-font-family);color:var(--dsw-alias-label-primary);background:0 0;border:1px solid var(--dsw-alias-border-l1);border-radius:6px;padding:3px 8px;outline:none}.qp_editor:focus{border-color:var(--dsw-alias-label-tertiary)}.qp_actions{flex:none;align-items:center;gap:4px;display:flex}.qp_action{corner-shape:round;width:24px;height:24px;color:var(--dsw-alias-label-tertiary);cursor:pointer;background:0 0;border:none;border-radius:999px;flex:none;place-items:center;padding:0;display:grid}.qp_action svg{width:13px;height:13px}.qp_action:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}.qp_action:focus-visible{outline:2px solid var(--dsw-alias-label-tertiary);outline-offset:-2px}.qp_action:disabled{cursor:default;opacity:.4}.qp_note{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:18px;padding:0 12px 2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}";
		const tagId = "@local/dsh-queue-priority/QueuePriorityPanel.module.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "@local/dsh-queue-priority";
			tag.dataset.pluginCss = tagId;
			tag.textContent = css;
			document.head.appendChild(tag);
		}
		var QueuePriorityPanel_module_css_default = {
			"dock": "qp_dock",
			"panel": "qp_panel",
			"header": "qp_header",
			"title": "qp_title",
			"list": "qp_list",
			"row": "qp_row",
			"pos": "qp_pos",
			"preview": "qp_preview",
			"editor": "qp_editor",
			"actions": "qp_actions",
			"action": "qp_action",
			"note": "qp_note"
		};
		//#endregion
		//#region lib/client/locales.js
		/** Locale namespace owned by the queue-priority panel. */
		const NS = "queue-priority";
		/** Simplified-Chinese queue-priority strings. */
		const zh = {
			"panel.title": "队列顺序(先运行最上面)",
			"panel.note": "队列已更新",
			"row.up": "提前(与上一条交换)",
			"row.down": "延后(与下一条交换)",
			"row.edit": "编辑提示词",
			"row.edit.unsupported": "仅可编辑纯文本提示词",
			"row.save": "保存修改",
			"row.cancel": "放弃修改",
			"row.remove": "从队列删除",
			"row.steer": "立即发送(插入当前运行回合)",
			"row.steer.unavailable": "没有正在运行的回合可插入",
			"row.fork": "复制此提示词(在下方插入副本)",
			"row.failed": "操作失败:{reason}"
		};
		/** English queue-priority strings. */
		const en = {
			"panel.title": "Queue order (top runs first)",
			"panel.note": "queue updated",
			"row.up": "Move earlier (swap with previous)",
			"row.down": "Move later (swap with next)",
			"row.edit": "Edit prompt",
			"row.edit.unsupported": "Only plain-text prompts can be edited",
			"row.save": "Save edit",
			"row.cancel": "Discard edit",
			"row.remove": "Delete from queue",
			"row.steer": "Send now (steer the running turn)",
			"row.steer.unavailable": "No running turn to steer",
			"row.fork": "Duplicate this prompt (inserts a copy below)",
			"row.failed": "action failed: {reason}"
		};
		//#endregion
		//#region lib/client/QueuePriorityPanel.js
		/** How long a transient failure note stays visible. */
		const NOTE_MS = 2600;

		/**
		 * Best-effort one-line text for a queue row across the shapes the store
		 * has used (row.text / row.preview, or content blocks on either
		 * row.message.content or row.content).
		 */
		function textOfRow(row) {
			if (typeof row.text === "string" && row.text.length > 0) return row.text;
			const content = Array.isArray(row.message?.content) ? row.message.content : Array.isArray(row.content) ? row.content : [];
			const text = content.filter((block) => block?.type === "text").map((block) => block.text ?? "").join(" ").replace(/\s+/g, " ").trim();
			if (text.length > 0) return text;
			return typeof row.preview === "string" ? row.preview : "";
		}

		/**
		 * Whether a queue row is pure text — the same contract the stock dock
		 * applies to its edit button (rows.text non-null). Rows carrying image /
		 * file attachments cannot be edited to plain text without silently
		 * dropping the attachments, so their pencil stays disabled.
		 */
		function isTextOnlyRow(row) {
			const content = Array.isArray(row.message?.content) ? row.message.content : Array.isArray(row.content) ? row.content : null;
			if (content === null || content.length === 0) return false;
			return content.every((block) => block?.type === "text" && typeof block.text === "string");
		}

		/**
		 * Queue panel: a second dock entry under the stock Queue dock listing
		 * every pending prompt in run order with the full action set the stock
		 * collapsed dock hides: bump up / down (reorder), edit (inline), delete,
		 * steer (send into the running turn), and fork (duplicate in place).
		 * Every action POSTs the cookie-authenticated host route, which mirrors
		 * the stock session/updateQueue semantics against the durable inbox;
		 * the store then re-renders from the pushed projections.
		 *
		 * Renders nothing when the queue is not mutable (same gate as the stock
		 * dock); unlike the stock dock it also stays up for a single item, where
		 * edit / delete / steer / fork still apply.
		 * @param props - framework-supplied useSession/t plus the sessionId
		 * captured by the entry's inject callback.
		 * @returns the panel, or null when there is nothing to act on.
		 */
		function QueuePriorityPanel(props) {
			const useSession = props.useSession;
			const t = props.t;
			const sessionId = props.sessionId;
			const timer = react.useRef(null);
			react.useEffect(() => () => {
				if (timer.current !== null) clearTimeout(timer.current);
			}, []);
			const inbox = useSession((s) => s.queue);
			const queue = react.useMemo(() => (Array.isArray(inbox) ? inbox.filter((row) => row?.placement === "queued") : []), [inbox]);
			const queueMutable = useSession((s) => s.subagent === null || (s.subagent?.address?.mode === "continuable"));
			const running = useSession((s) => s.running);
			const [busy, setBusy] = react.useState(null);
			const [note, setNote] = react.useState(null);
			const [editing, setEditing] = react.useState(null);
			// an edit targeting a row the store already dropped (claimed by the
			// turn loop) closes itself instead of saving into a dead item
			react.useEffect(() => {
				if (editing !== null && !queue.some((row) => row.id === editing.id)) setEditing(null);
			}, [queue, editing]);
			if (typeof sessionId !== "string" || sessionId.length === 0) return null;
			if (queue.length < 1 || !queueMutable) return null;
			/** One host call; resolves true when the route accepted it. */
			const act = async (itemId, action, extra) => {
				setBusy(itemId + ":" + action);
				try {
					const response = await fetch("/api/queue-priority", {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({ sessionId, itemId, action, ...extra })
					});
					const value = await response.json().catch(() => ({}));
					if (!response.ok) throw new Error(value.error || `HTTP ${response.status}`);
					setNote(t("panel.note"));
					return true;
				} catch (cause) {
					setNote(t("row.failed", { reason: String(cause?.message ?? cause).slice(0, 140) }));
					return false;
				} finally {
					setBusy((current) => current === itemId + ":" + action ? null : current);
					if (timer.current !== null) clearTimeout(timer.current);
					timer.current = setTimeout(() => {
						setNote(null);
						timer.current = null;
					}, NOTE_MS);
				}
			};
			const saveEdit = async () => {
				if (editing === null || editing.text.trim() === "") return;
				if (await act(editing.id, "edit", { text: editing.text })) setEditing(null);
			};
			const actionButton = (row, label, title, disabled, onClick, Icon) => (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Tooltip, {
				label: label,
				side: "bottom",
				delayMs: 500,
				children: (0, react_jsx_runtime.jsx)("button", {
					type: "button",
					className: QueuePriorityPanel_module_css_default.action,
					"aria-label": label,
					title: title,
					disabled: disabled,
					onClick: onClick,
					children: (0, react_jsx_runtime.jsx)(Icon, {})
				})
			}, label);
			return (0, react_jsx_runtime.jsxs)("div", {
				className: QueuePriorityPanel_module_css_default.dock,
				"data-queue-priority": "",
				children: [(0, react_jsx_runtime.jsx)("div", {
					className: QueuePriorityPanel_module_css_default.panel,
					children: [(0, react_jsx_runtime.jsxs)("div", {
						className: QueuePriorityPanel_module_css_default.header,
						children: [(0, react_jsx_runtime.jsx)("span", {
							className: QueuePriorityPanel_module_css_default.title,
							children: t("panel.title")
						}), note !== null && (0, react_jsx_runtime.jsx)("span", {
							className: QueuePriorityPanel_module_css_default.note,
							children: note
						})]
					}), (0, react_jsx_runtime.jsx)("ul", {
						className: QueuePriorityPanel_module_css_default.list,
						children: queue.map((row, index) => (0, react_jsx_runtime.jsxs)("li", {
							className: QueuePriorityPanel_module_css_default.row,
							children: [(0, react_jsx_runtime.jsx)("span", {
								className: QueuePriorityPanel_module_css_default.pos,
								"aria-hidden": true,
								children: index + 1
							}), editing?.id === row.id ? (0, react_jsx_runtime.jsx)("input", {
								autoFocus: true,
								className: QueuePriorityPanel_module_css_default.editor,
								"aria-label": t("row.edit"),
								value: editing.text,
								onChange: (event) => {
									setEditing({ id: row.id, text: event.currentTarget.value });
								},
								onKeyDown: (event) => {
									if (event.key === "Escape") {
										setEditing(null);
										return;
									}
									if (event.key === "Enter" && !event.nativeEvent.isComposing) {
										event.preventDefault();
										void saveEdit();
									}
								}
							}) : (0, react_jsx_runtime.jsx)("span", {
								className: QueuePriorityPanel_module_css_default.preview,
								children: (0, _deepseek_ai_dsh_client_ui_primitives.projectUserText)(textOfRow(row), [])
							}), (0, react_jsx_runtime.jsxs)("div", {
								className: QueuePriorityPanel_module_css_default.actions,
								children: [editing?.id === row.id ? [
									actionButton(row, t("row.save"), void 0, busy !== null || editing.text.trim() === "", () => {
										void saveEdit();
									}, _deepseek_ai_dsh_client_ui_primitives.IconCheckOutline16),
									actionButton(row, t("row.cancel"), void 0, busy !== null, () => {
										setEditing(null);
									}, _deepseek_ai_dsh_client_ui_primitives.IconCloseOutline16)
								] : [
									actionButton(row, t("row.up"), void 0, busy !== null || index === 0, () => {
										void act(row.id, "up");
									}, _deepseek_ai_dsh_client_ui_primitives.IconChevronUpOutline14),
									actionButton(row, t("row.down"), void 0, busy !== null || index === queue.length - 1, () => {
										void act(row.id, "down");
									}, _deepseek_ai_dsh_client_ui_primitives.IconChevronDownOutline14),
									actionButton(row, t("row.edit"), isTextOnlyRow(row) ? void 0 : t("row.edit.unsupported"), busy !== null || !isTextOnlyRow(row), () => {
										setEditing({ id: row.id, text: textOfRow(row) });
									}, _deepseek_ai_dsh_client_ui_primitives.IconEditOutline16),
									actionButton(row, t("row.remove"), void 0, busy !== null, () => {
										void act(row.id, "remove");
									}, _deepseek_ai_dsh_client_ui_primitives.IconTrashOutline16),
									actionButton(row, t("row.steer"), running ? void 0 : t("row.steer.unavailable"), busy !== null || !running, () => {
										void act(row.id, "steer");
									}, _deepseek_ai_dsh_client_ui_primitives.IconSendOutline14),
									actionButton(row, t("row.fork"), void 0, busy !== null, () => {
										void act(row.id, "fork");
									}, _deepseek_ai_dsh_client_ui_primitives.IconCopyOutline16)
								]]
							})]
						}, row.id))
					})]
				})]
			});
		}
		//#endregion
		//#region lib/client/index.js
		/** Browser plugin owning the queue reorder dock panel. */
		const inject = ["slots", "locale"];
		/**
		 * Register the locale dictionaries and mount the queue panel as a
		 * second conversation.input.dock entry (below the stock Queue dock,
		 * order 21). The entry's inject callback captures the sessionId so the
		 * component can address the host route; useSession and t arrive from
		 * the session-scoped slot renderer, exactly as for the stock dock.
		 * @param ctx - browser context carrying the slots and locale services.
		 */
		function apply(ctx) {
			ctx.effect(() => ctx.locale.register(NS, {
				zh,
				en
			}), "queue-priority: browser dictionaries");
			ctx.slots.inject("conversation.input.dock", () => ctx.slots.register({
				name: "conversation.input.dock",
				id: "queue-priority",
				order: 21,
				locale: NS,
				inject: (sessionId) => ({ sessionId })
			}, QueuePriorityPanel));
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
