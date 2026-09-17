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
		const css = ".qp_dock{box-sizing:border-box;width:calc(100% - var(--dsh-composer-side-clearance) - var(--dsh-composer-side-clearance) - var(--dsh-composer-dock-inset) - var(--dsh-composer-dock-inset));max-width:calc(var(--dsh-composer-card-max-width) - var(--dsh-composer-dock-inset) - var(--dsh-composer-dock-inset));margin:0 auto;padding:0 var(--dsh-composer-dock-inset);flex:none}.qp_panel{background:var(--dsw-specific-tip);border-radius:8px;border:.5px solid var(--dsw-alias-border-l1);width:100%;padding:2px 0;overflow:hidden}.qp_header{box-sizing:border-box;width:100%;min-height:28px;color:var(--dsw-alias-label-tertiary);align-items:center;gap:8px;padding:2px 12px 0;display:flex}.qp_title{min-width:0;font-family:Inter, var(--dsw-font-family);font-size:11px;font-weight:500;line-height:18px;letter-spacing:.2px;text-transform:uppercase;flex:auto}.qp_list{margin:0;padding:0 0 2px;list-style:none}.qp_row{box-sizing:border-box;border-radius:8px;align-items:center;gap:8px;width:100%;min-height:32px;padding:2px 5px 2px 12px;display:flex}.qp_row+.qp_row{box-shadow:inset 0 1px 0 var(--dsw-alias-border-l1)}.qp_pos{color:var(--dsw-alias-label-tertiary);font:var(--dsw-font-xs-13);font-variant-numeric:tabular-nums;flex:none;min-width:16px;text-align:right}.qp_preview{min-width:0;color:var(--dsw-alias-label-primary-dimmed);font:var(--dsw-font-xs-13);font-family:Inter, var(--dsw-font-family);flex:auto;text-overflow:ellipsis;white-space:nowrap;word-break:break-word;overflow:hidden}.qp_actions{flex:none;align-items:center;gap:4px;display:flex}.qp_action{corner-shape:round;width:24px;height:24px;color:var(--dsw-alias-label-tertiary);cursor:pointer;background:0 0;border:none;border-radius:999px;flex:none;place-items:center;padding:0;display:grid}.qp_action svg{width:13px;height:13px}.qp_action:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}.qp_action:focus-visible{outline:2px solid var(--dsw-alias-label-tertiary);outline-offset:-2px}.qp_action:disabled{cursor:default;opacity:.4}.qp_note{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:18px;padding:0 12px 2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}";
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
			"panel.note": "排队顺序已调整",
			"row.up": "提前(与上一条交换)",
			"row.down": "延后(与下一条交换)",
			"row.failed": "调整失败:{reason}"
		};
		/** English queue-priority strings. */
		const en = {
			"panel.title": "Queue order (top runs first)",
			"panel.note": "queue order changed",
			"row.up": "Move earlier (swap with previous)",
			"row.down": "Move later (swap with next)",
			"row.failed": "move failed: {reason}"
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
		 * Queue reorder panel: a second dock entry under the stock Queue dock
		 * listing every pending prompt in run order with bump-up / bump-down
		 * buttons. Each move POSTs the cookie-authenticated host route, which
		 * performs one durable adjacent swap on the session's next-turn inbox;
		 * the store then re-renders from the pushed projections.
		 *
		 * Renders nothing unless at least two prompts are pending (nothing to
		 * reorder) and the queue is mutable (same gate as the stock dock).
		 * @param props - framework-supplied useSession/t plus the sessionId
		 * captured by the entry's inject callback.
		 * @returns the panel, or null when there is nothing to reorder.
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
			const [busy, setBusy] = react.useState(null);
			const [note, setNote] = react.useState(null);
			if (typeof sessionId !== "string" || sessionId.length === 0) return null;
			if (queue.length < 2 || !queueMutable) return null;
			const move = async (itemId, direction) => {
				setBusy(itemId + ":" + direction);
				try {
					const response = await fetch("/api/queue-priority", {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({ sessionId, itemId, direction })
					});
					const value = await response.json().catch(() => ({}));
					if (!response.ok) throw new Error(value.error || `HTTP ${response.status}`);
					setNote(t("panel.note"));
				} catch (cause) {
					setNote(t("row.failed", { reason: String(cause?.message ?? cause).slice(0, 140) }));
				} finally {
					setBusy((current) => current === itemId + ":" + direction ? null : current);
					if (timer.current !== null) clearTimeout(timer.current);
					timer.current = setTimeout(() => {
						setNote(null);
						timer.current = null;
					}, NOTE_MS);
				}
			};
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
							}), (0, react_jsx_runtime.jsx)("span", {
								className: QueuePriorityPanel_module_css_default.preview,
								children: (0, _deepseek_ai_dsh_client_ui_primitives.projectUserText)(textOfRow(row), [])
							}), (0, react_jsx_runtime.jsxs)("div", {
								className: QueuePriorityPanel_module_css_default.actions,
								children: [(0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Tooltip, {
									label: t("row.up"),
									side: "bottom",
									delayMs: 500,
									children: (0, react_jsx_runtime.jsx)("button", {
										type: "button",
										className: QueuePriorityPanel_module_css_default.action,
										"aria-label": t("row.up"),
										disabled: busy !== null || index === 0,
										onClick: () => {
											void move(row.id, "up");
										},
										children: (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconChevronUpOutline14, {})
									})
								}), (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Tooltip, {
									label: t("row.down"),
									side: "bottom",
									delayMs: 500,
									children: (0, react_jsx_runtime.jsx)("button", {
										type: "button",
										className: QueuePriorityPanel_module_css_default.action,
										"aria-label": t("row.down"),
										disabled: busy !== null || index === queue.length - 1,
										onClick: () => {
											void move(row.id, "down");
										},
										children: (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconChevronDownOutline14, {})
									})
								})]
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
		 * Register the locale dictionaries and mount the reorder panel as a
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
