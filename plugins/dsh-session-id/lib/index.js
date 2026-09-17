/**
 * Host half of the session-id copy button.
 *
 * The entire feature lives in the browser (lib/client.js): the chat header
 * hands the active session id to `conversation.session.header.utilities`
 * slot entries as a standard prop, and copying is pure client-side
 * clipboard work — no server data, no route. This entry exists so the
 * package can mount as a row in the web profile's cordis patch layer;
 * that mount is what makes dsh-client-modules serve the package's browser
 * bundle (the `dsh.client` manifest in package.json).
 *
 * Disable the button by setting the row's config.disabled: true.
 */
//#region lib/index.js
/** Cordis plugin name used by loader diagnostics. */
export const name = "session-id-ui";
/** No host services are needed. */
export const inject = [];

/** Plugin apply: intentionally empty (browser-only feature). */
export function apply() {}
//#endregion
