# dsh-session-id

A copy button for the active session id, in the dsh web chat header (next to
the system-prompt editor's pen button and the ⋯ cluster). Hover shows the
full id; click copies it. The copied value is the exact `session-<uuid>`
form that `session.list`, the RPC surface, and dispatch tooling expect —
no more retyping ids from URLs or logs.

Package name `@local/dsh-session-id`, two halves:

- **Node half** (`lib/index.js`): a deliberate stub. The chat header hands
  the active session id to `conversation.session.header.utilities` slot
  entries as a standard prop, and copying is pure client-side clipboard
  work — there is nothing for the host to do. The stub exists only so the
  package can mount as a `cordis.patch.yml` row; that mount is what makes
  `dsh-client-modules` serve the package's browser bundle (the `dsh.client`
  manifest in `package.json`).
- **Browser half** (`lib/client.js`): a dsh client plugin declared in
  `package.json` under `dsh.client` (`inject`, `platform: "web"`). One
  `window.__ModuleLoader__.load({id, factory})` call; the factory only
  *registers* (lazy) — React and the shell UI primitives come from the
  statically seeded requireables (`react`, `react/jsx-runtime`,
  `@deepseek-ai/dsh-client-ui-primitives`), CSS ships as a
  `<style data-plugin data-plugin-css>` tag. Mounts into the
  `conversation.session.header.utilities` slot; locale dictionaries (en +
  zh) register under the `session-id-ui` namespace.

## UX notes

- The button renders **only while a session is open** (the slot is
  session-scoped); the blank/Hero view shows nothing — same lifecycle as
  every other header utility.
- Tooltip always carries the full id (`Session id: session-…`, or
  `Copied session id: …` right after a click); after a copy the icon flips
  to a check and tints for ~1.6 s.
- All React hooks run before the no-session early return, so hook order is
  stable across renders.
- Copy goes through `navigator.clipboard.writeText` with a
  `document.execCommand("copy")` textarea fallback for contexts where the
  async API is withheld.

## Mount contract (persistent web install)

1. Copy the package into the install's runtime `@local/` tree
   (`node_modules/@local/dsh-session-id`) — a **real directory copy**, not
   a symlink back into this repo (Node realpath resolution leaves the
   `@deepseek-ai/*` peers unresolvable from the repo dir — a boot-time
   fiber failure; same rule as the system-prompt plugins).
2. Symlink it into the profile module tree so both resolution chains see
   it: `ln -sfn <runtime>/node_modules/@local/dsh-session-id
   <profile>/node_modules/@local/dsh-session-id`. Verify both chains
   (`node --input-type=module -e "import('@local/dsh-session-id')…`)
   **before** adding the patch row — an unresolvable `@local` insert is a
   boot-crash recipe.
3. Add the row to the web profile's `cordis.patch.yml` (hot-watched —
   loads in the running server, no restart):
   ```yaml
   - insert:
       - id: session-id-ui
         name: "@local/dsh-session-id"
         config:
           disabled: false
   ```
4. Browser half: open tabs pick it up on their next page load (reload the
   tabs). Host-half *code* changes need the fresh-URL live-swap recipe
   (`lib/hot.js` shim) — the running process caches module URLs; see the
   `dsh-system-prompt-ui` README for the recipe.

## Test

Offline smoke test — no dsh process, no browser. Exercises the stub node
half, then executes `lib/client.js` in a vm with stub seeds, a stub
`navigator.clipboard`, and a minimal DOM for the legacy fallback path:

```sh
node test/smoke.mjs
```
