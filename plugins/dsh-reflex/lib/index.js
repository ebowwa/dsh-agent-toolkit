//#region @local/dsh-reflex
//
// Reflex engine tools for the DeepSeek Harness.
//
// ONE engine, many hosts: the Reflex automation engine runs inside the Gauge
// host (com.ebowwa.gauge) and speaks JSON over TCP on 127.0.0.1:49173 (bound
// to all interfaces, so remote machines on the tailnet can drive it too).
// This plugin is a thin client: every tool is one JSON request/response.
// It intentionally duplicates nothing — the engine's powers come from the
// Gauge host's TCC grants, and this client stays identity-free.
//
// Cordis plugin: registers session tools into the `tools` registry.
//
//#endregion
import { defineTool } from "@deepseek-ai/dsh-tools";
import { connect } from "node:net";

/** Cordis plugin name used by loader diagnostics. */
export const name = "reflex-tools";
/** The session-scoped `tools` registry. */
export const inject = ["tools"];

/** Normalize untrusted config into the shapes the client reads. */
export function normalizeConfig(config = {}) {
	return {
		host: typeof config.host === "string" && config.host.length > 0 ? config.host : "127.0.0.1",
		port: typeof config.port === "number" && config.port > 0 && config.port <= 65535 ? config.port : 49173,
		timeoutMs: typeof config.timeoutMs === "number" && config.timeoutMs >= 3000 && config.timeoutMs <= 300000 ? Math.floor(config.timeoutMs) : 90000,
		allowPrivateHosts: true
	};
}

//#region transport
/**
 * One Reflex request: JSON in, one JSON line out. The server tolerates
 * newline-less payloads and closes per connection (one shot per connect —
 * simplest correct framing; the engine keeps no per-connection state).
 */
function request(config, payload, timeoutMs) {
	return new Promise((resolve) => {
		const socket = connect({ host: config.host, port: config.port });
		let buffered = "";
		let settled = false;
		const finish = (value) => {
			if (settled) return;
			settled = true;
			socket.destroy();
			resolve(value);
		};
		const timer = setTimeout(() => finish({ ok: false, command: payload.command ?? "?", errors: [`reflex: timed out after ${timeoutMs}ms`] }), timeoutMs);
		socket.setTimeout(timeoutMs);
		socket.on("timeout", () => finish({ ok: false, command: payload.command ?? "?", errors: [`reflex: socket timeout after ${timeoutMs}ms`] }));
		socket.on("error", (err) => finish({ ok: false, command: payload.command ?? "?", errors: [`reflex: ${err.message}`] }));
		socket.on("data", (chunk) => {
			buffered += chunk.toString("utf8");
			const newlineAt = buffered.indexOf("\n");
			if (newlineAt === -1) return;
			clearTimeout(timer);
			const line = buffered.slice(0, newlineAt).trim();
			socket.destroy();
			if (!line) return finish({ ok: false, command: payload.command ?? "?", errors: ["reflex: empty response line"] });
			try {
				finish(JSON.parse(line));
			} catch (error) {
				finish({ ok: false, command: payload.command ?? "?", errors: [`reflex: unparseable response: ${String(error).slice(0, 200)}`] });
			}
		});
		socket.on("connect", () => {
			socket.write(JSON.stringify(payload) + "\n");
		});
	});
}

async function reflexCall(config, payload) {
	const result = await request(config, payload, config.timeoutMs);
	const systemPrompt = undefined;
	if (result.ok === false && systemPrompt !== undefined) {
		// surface engine-side failures in the system prompt area the model reads
		// first — one section, always the latest error, replaced in place.
		systemPrompt.section({
			name: "tool:reflex_last_error",
			order: 113,
			text: `reflex: last ${result.command} attempt failed — ${JSON.stringify(result.errors ?? []).slice(0, 300)}`
		});
	}
	return result;
}
//#endregion

//#region tool bodies
const ENGINE_NOTE = "The engine runs inside the Gauge host on this machine (TCC-granted); captures save to paths on that machine.";

function statusTool(config) {
	return defineTool({
		name: "reflex_status",
		description: `Identify the local Reflex automation engine: build identity, plugin versions, Accessibility/Screen Recording permission state, and reachability. Use first when any reflex_* tool misbehaves. ${ENGINE_NOTE}`,
		parameters: {},
		output: {
			schema: { type: "object", additionalProperties: true },
			render: (_args, value) => [{ type: "text", text: JSON.stringify(value, null, 2) }]
		},
		timeoutMs: config.timeoutMs,
		isConcurrencySafe: () => true,
		async execute() {
			return reflexCall(config, { command: "status" });
		}
	});
}

function windowsTool(config) {
	return defineTool({
		name: "reflex_windows",
		description: `List windows on the engine machine: windowID, owner app, title, bounds, layer, frontmost/minimized state. Filter to one app with bundleID. The windowID feeds reflex_capture_window and the engine's window actions. ${ENGINE_NOTE}`,
		parameters: {
			bundleID: { type: "string", description: "Only windows of this bundle id (e.g. com.apple.Safari)." },
			limit: { type: "number", description: "Max windows returned (default 30)." },
			filter: { type: "string", description: "'all' (default) or 'user' for regular app windows only." },
			includeOffscreen: { type: "boolean", description: "Include off-screen/minimized windows (default true)." }
		},
		output: {
			schema: { type: "object", additionalProperties: true },
			render: (_args, value) => [{ type: "text", text: JSON.stringify(value, null, 2) }]
		},
		timeoutMs: config.timeoutMs,
		isConcurrencySafe: () => true,
		async execute(args) {
			return reflexCall(config, { command: "mac-windows", bundleID: args.bundleID, limit: args.limit ?? 30, filter: args.filter ?? "all", includeOffscreen: args.includeOffscreen ?? true });
		}
	});
}

function captureDisplayTool(config) {
	return defineTool({
		name: "reflex_capture_display",
		description: `Capture an entire display on the engine machine to a PNG file. Returns the file path on the ENGINE machine (read it via that machine's filesystem — for a remote engine, scp it). ${ENGINE_NOTE}`,
		parameters: {
			displayId: { type: "number", description: "Display id (reflex_status/display listing exposes these; main display is usually the lowest id)." },
			output: { type: "string", description: `Output path on the engine machine (default /tmp/reflex-capture-<ts>.png).` }
		},
		output: {
			schema: { type: "object", additionalProperties: true },
			render: (_args, value) => [{ type: "text", text: JSON.stringify(value, null, 2) }]
		},
		timeoutMs: Math.max(config.timeoutMs, 60000),
		isConcurrencySafe: () => false,
		async execute(args) {
			const output = args.output || `/tmp/reflex-capture-${Date.now()}.png`;
			return reflexCall(config, { command: "mac-capture-display", displayId: args.displayId, output });
		}
	});
}

function captureWindowTool(config) {
	return defineTool({
		name: "reflex_capture_window",
		description: `Capture one window on the engine machine to a PNG (windowID from reflex_windows). Optional hex/square coordinate overlay for click-targeting. ${ENGINE_NOTE}`,
		parameters: {
			windowID: { type: "number", required: true, description: "Window id (from reflex_windows)." },
			output: { type: "string", description: "Output path on the engine machine." },
			overlay: { type: "string", description: "'hex' coordinate overlay for click targeting, or 'none' (default)." }
		},
		output: {
			schema: { type: "object", additionalProperties: true },
			render: (_args, value) => [{ type: "text", text: JSON.stringify(value, null, 2) }]
		},
		timeoutMs: Math.max(config.timeoutMs, 60000),
		isConcurrencySafe: () => false,
		async execute(args) {
			const output = args.output || `/tmp/reflex-capture-${Date.now()}.png`;
			return reflexCall(config, { command: "mac-capture", windowID: args.windowID, output, overlay: args.overlay ?? "none" });
		}
	});
}

function clickTool(config) {
	return defineTool({
		name: "reflex_click",
		description: `Click at screen coordinates on the engine machine (coordinate pairs come from capture overlays or window bounds). Prefer AX actions (reflex_ax) when a role/label is known — clicks are the fallback for canvas/custom UI. ${ENGINE_NOTE}`,
		parameters: {
			x: { type: "number", required: true, description: "Screen x (global points)." },
			y: { type: "number", required: true, description: "Screen y (global points)." },
			doubleClick: { type: "boolean", description: "Double-click instead of single." }
		},
		output: {
			schema: { type: "object", additionalProperties: true },
			render: (_args, value) => [{ type: "text", text: JSON.stringify(value, null, 2) }]
		},
		timeoutMs: config.timeoutMs,
		isConcurrencySafe: () => false,
		async execute(args) {
			return reflexCall(config, { command: "mouse", action: args.doubleClick ? "doubleclick" : "click", x: args.x, y: args.y });
		}
	});
}

function typeTool(config) {
	return defineTool({
		name: "reflex_type",
		description: `Type text into the focused control on the engine machine (focus first: reflex_click the field, or reflex_ax with an ax-action). Non-ASCII falls back to pasteboard+Cmd-V engine-side. ${ENGINE_NOTE}`,
		parameters: {
			text: { type: "string", required: true, description: "Text to type." },
			interval: { type: "number", description: "Milliseconds between keystrokes (default engine-chosen)." }
		},
		output: {
			schema: { type: "object", additionalProperties: true },
			render: (_args, value) => [{ type: "text", text: JSON.stringify(value, null, 2) }]
		},
		timeoutMs: Math.max(config.timeoutMs, 120000),
		isConcurrencySafe: () => false,
		async execute(args) {
			return reflexCall(config, { command: "type", text: args.text, interval: args.interval });
		}
	});
}

function keyTool(config) {
	return defineTool({
		name: "reflex_key",
		description: `Press a key on the engine machine: named keys (return, tab, escape, space, delete, up/down/left/right, f1-f12, letters, digits) optionally with modifiers, or a raw keycode. ${ENGINE_NOTE}`,
		parameters: {
			named: { type: "string", description: "Named key (return, tab, escape, space, delete, forwarddelete, home, end, pageup, pagedown, up, down, left, right, f1-f12, a-z, 0-9)." },
			keycode: { type: "number", description: "Raw macOS keycode (overrides named)." },
			flags: { type: "array", items: { type: "string" }, description: "Modifier flags: cmd, shift, option, control, fn." }
		},
		output: {
			schema: { type: "object", additionalProperties: true },
			render: (_args, value) => [{ type: "text", text: JSON.stringify(value, null, 2) }]
		},
		timeoutMs: config.timeoutMs,
		isConcurrencySafe: () => false,
		async execute(args) {
			return reflexCall(config, { command: "key", named: args.named, keycode: args.keycode, flags: args.flags });
		}
	});
}

function axTool(config) {
	return defineTool({
		name: "reflex_ax",
		description: `Accessibility action on the engine machine — the PREFERRED way to drive UI: press buttons, set values, focus fields by role/label/value/identifier instead of coordinates. Resolves uniquely or fails; add allowBackground for apps that are not frontmost. ${ENGINE_NOTE}`,
		parameters: {
			bundleID: { type: "string", required: true, description: "Target app bundle id (e.g. com.apple.Safari)." },
			action: { type: "string", required: true, description: "AX action: press, set, focus, increment, decrement..." },
			role: { type: "string", description: "Locator: AX role (AXButton, AXTextField...)." },
			label: { type: "string", description: "Locator: AX label/title." },
			value: { type: "string", description: "Locator or new value (for set)." },
			identifier: { type: "string", description: "Locator: AX identifier." },
			allowBackground: { type: "boolean", description: "Allow acting on a background app (default false: the engine brings it frontmost first)." }
		},
		output: {
			schema: { type: "object", additionalProperties: true },
			render: (_args, value) => [{ type: "text", text: JSON.stringify(value, null, 2) }]
		},
		timeoutMs: Math.max(config.timeoutMs, 30000),
		isConcurrencySafe: () => false,
		async execute(args) {
			return reflexCall(config, { command: "ax-action", bundleID: args.bundleID, action: args.action, role: args.role, label: args.label, value: args.value, identifier: args.identifier, allowBackground: args.allowBackground });
		}
	});
}

function commandTool(config) {
	return defineTool({
		name: "reflex_command",
		description: `Escape hatch: run ANY Reflex engine command verbatim (the full grammar lives in the engine's command server: mac-windows, mac-capture, mac-capture-display, mouse, type, key, ax-action, ax-set-value, mac-file, open-system-settings, mac-authorize, status...). Prefer the dedicated reflex_* tools when one fits. ${ENGINE_NOTE}`,
		parameters: {
			command: { type: "string", required: true, description: "Engine command name (e.g. mac-file, open-system-settings, mac-authorize)." },
			params: { type: "object", additionalProperties: true, description: "Command parameters as name→value, merged into the request." }
		},
		output: {
			schema: { type: "object", additionalProperties: true },
			render: (_args, value) => [{ type: "text", text: JSON.stringify(value, null, 2) }]
		},
		timeoutMs: Math.max(config.timeoutMs, 60000),
		isConcurrencySafe: () => false,
		async execute(args) {
			return reflexCall(config, { command: args.command, ...(args.params ?? {}) });
		}
	});
}
//#endregion

/** Register every Reflex tool into the session `tools` registry. */
export function apply(ctx, config) {
	const resolved = normalizeConfig(config);
	ctx.tools.register(
		statusTool(resolved),
		windowsTool(resolved),
		captureDisplayTool(resolved),
		captureWindowTool(resolved),
		clickTool(resolved),
		typeTool(resolved),
		keyTool(resolved),
		axTool(resolved),
		commandTool(resolved)
	);
}
