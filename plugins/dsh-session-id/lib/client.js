window.__ModuleLoader__.load({
	id: "@local/dsh-session-id",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let react_jsx_runtime = require("react/jsx-runtime");
		let _deepseek_ai_dsh_client_ui_primitives = require("@deepseek-ai/dsh-client-ui-primitives");
		//#region lib/client/CopyIdAction.module.css
		const css = ".sidUi_button{width:28px;height:28px;color:var(--dsw-alias-label-secondary);cursor:pointer;background:0 0;border:none;border-radius:28px;flex:none;justify-content:center;align-items:center;padding:6px;display:inline-flex}.sidUi_button svg{width:15px;height:15px}.sidUi_button:hover{background:var(--dsw-alias-interactive-bg-hover)}.sidUi_button.sidUi_copied{color:var(--dsw-alias-state-business-primary)}";
		const tagId = "@local/dsh-session-id/CopyIdAction.module.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "@local/dsh-session-id";
			tag.dataset.pluginCss = tagId;
			tag.textContent = css;
			document.head.appendChild(tag);
		}
		var CopyIdAction_module_css_default = {
			"button": "sidUi_button",
			"copied": "sidUi_copied"
		};
		//#endregion
		//#region lib/client/locales.js
		/** Locale namespace owned by the session-id copy button. */
		const NS = "session-id-ui";
		/** Simplified-Chinese session-id strings. */
		const zh = {
			"header.copy": "复制会话 ID",
			"header.tooltip": "会话 ID:{id}",
			"header.copied": "已复制会话 ID:{id}"
		};
		/** English session-id strings. */
		const en = {
			"header.copy": "Copy session id",
			"header.tooltip": "Session id: {id}",
			"header.copied": "Copied session id: {id}"
		};
		//#endregion
		//#region lib/client/CopyIdAction.js
		/** How long the button shows its confirmed (check) state after a copy. */
		const COPIED_FEEDBACK_MS = 1600;

		/** Copy text through the async clipboard API, falling back to the
		 * legacy execCommand path for contexts where the API is withheld. */
		async function copyText(text) {
			try {
				await navigator.clipboard.writeText(text);
				return;
			} catch {}
			const area = document.createElement("textarea");
			area.value = text;
			area.setAttribute("readonly", "");
			area.style.position = "fixed";
			area.style.opacity = "0";
			document.body.appendChild(area);
			area.select();
			try {
				document.execCommand("copy");
			} catch {}
			document.body.removeChild(area);
		}

		/**
		* One header button that copies the active session id (the full
		* `session-<uuid>` form) to the clipboard. The tooltip always shows the
		* id; after a click the icon flips to a check and tints for ~1.6s.
		* All hooks run before the no-session early return so their order is
		* stable across renders.
		* @param props - Session runtime (sessionId) and the locale seat from the slot renderer.
		* @returns the copy button, or nothing when no session is active.
		*/
		function SessionIdHeaderAction(props) {
			const { t, sessionId } = props;
			const [copied, setCopied] = react.useState(false);
			const timer = react.useRef(null);
			react.useEffect(() => () => {
				if (timer.current !== null) clearTimeout(timer.current);
			}, []);
			if (sessionId === undefined || sessionId === null) return null;
			const copy = async () => {
				await copyText(sessionId);
				setCopied(true);
				if (timer.current !== null) clearTimeout(timer.current);
				timer.current = setTimeout(() => {
					setCopied(false);
					timer.current = null;
				}, COPIED_FEEDBACK_MS);
			};
			return (0, react_jsx_runtime.jsx)("button", {
				type: "button",
				className: copied ? `${CopyIdAction_module_css_default.button} ${CopyIdAction_module_css_default.copied}` : CopyIdAction_module_css_default.button,
				"aria-label": t("header.copy"),
				title: t(copied ? "header.copied" : "header.tooltip", { id: sessionId }),
				onClick: () => {
					void copy();
				},
				children: copied ? (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconCheckOutline16, {}) : (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconCopyOutline16, {})
			});
		}
		//#endregion
		//#region lib/client/index.js
		/** Browser plugin owning the session-id copy header action. */
		const inject = ["slots", "locale"];
		/**
		* Register the locale dictionaries and mount the copy button into the
		* chat header's utilities cluster (next to the system-prompt editor's
		* pen button and the ⋯ more-actions area).
		* @param ctx - browser context carrying the slots and locale services.
		*/
		function apply(ctx) {
			ctx.effect(() => ctx.locale.register(NS, {
				zh,
				en
			}), "session-id-ui: browser dictionaries");
			ctx.slots.inject("conversation.session.header.utilities", () => ctx.slots.register({
				name: "conversation.session.header.utilities",
				id: "session-id-ui",
				locale: NS,
				inject: () => ({})
			}, SessionIdHeaderAction));
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
