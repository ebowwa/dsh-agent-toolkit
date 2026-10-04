/**
 * Environmental fence for this plugin's smoke suite (issue #358).
 *
 * A bare clone has not run scripts/install-plugin-smoke-deps.mjs yet, so
 * the workspace packages lib/index.js imports (@deepseek-ai/*, @local/*)
 * do not resolve — the smoke then dies with a raw ERR_MODULE_NOT_FOUND
 * stack that reads as PLUGIN BREAKAGE, not as the box-state gap it is
 * (three guaranteed reds on every fresh-clone bare `node --test` gate).
 *
 * The lib import must be DYNAMIC through guardedImport(): a static import
 * of the lib fails at LINK time, before any module body (and this fence)
 * could classify it. guardedImport classifies instead:
 *
 *   - missing-PACKAGE class ("Cannot find package '...'"): skip LOUD —
 *     `SKIP\t<plugin>\t<reason>` + exit 0 — the environmental outcome,
 *     mirroring the lane-plugins SKIP lines (a skip carries its reason;
 *     a red here was never a substantive finding).
 *   - anything else (a missing relative module = real repo breakage, or
 *     a substantive lib error): rethrow — the smoke stays honestly red.
 */
import { readFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

export async function guardedImport(specifier, parentUrl) {
	try {
		return await import(new URL(specifier, parentUrl).href);
	} catch (error) {
		const message = error?.code === "ERR_MODULE_NOT_FOUND" ? String(error?.message ?? "") : "";
		const missing = message.match(/^Cannot find package '([^']+)'/);
		if (!missing) throw error;
		console.log(
			`SKIP\t${pkg.name ?? "plugin"} smoke\t` +
			`workspace deps not installed (bare clone?) — cannot resolve ${missing[1]}; ` +
			`run node scripts/install-plugin-smoke-deps.mjs once (issue #358)`,
		);
		process.exit(0);
	}
}
