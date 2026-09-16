# dsh-system-prompt-ui

Web UI for the scoped system-prompt block (see the
[`dsh-system-prompt-editor`](../dsh-system-prompt-editor/) sibling): a small
list-pen icon button in the chat header (next to the ⋯ cluster) opens an
editor dialog with **scope tabs — This chat / Workspace · title / All
chats** — over a cookie-authenticated host route.

Package name `@local/dsh-system-prompt-ui`, two halves:

- **Node half** (`lib/index.js`): registers the host route
  `GET|PUT /api/system-prompt.block` via `ctx.connection.fetch.register`.
  `GET ?sessionId=…` returns
  `{sessionId, workspace:{id,title,path}|null, effective, blocks:{session,workspace,global}}`
  (each level: `file|null, set, chars, content` capped at 128K);
  `PUT` takes `{sessionId?, scope, content}` — same semantics as the editor
  tools (empty at session/workspace clears, empty global refused 400,
  workspace without membership refused 400, 64K write cap). The route rides
  the browser-gateway cookie fence for auth (401/403 before dispatch), so
  it is only reachable from the authenticated web UI.
  It **imports the resolution helpers from the editor package**
  (`readBlock`, `resolveLayout`, `readScoped`, `SCOPES`, …), so the dialog
  and the prompt can never disagree — mount both, and keep their
  `file`/`dir` config in sync.
- **Browser half** (`lib/client.js`): a dsh client plugin, declared in
  `package.json` under `dsh.client` (`inject`, `platform: "web"`). One
  `window.__ModuleLoader__.load({id, factory})` call; the factory only
  *registers* (lazy) — React and the shell UI primitives come from the
  statically seeded requireables (`react`, `react/jsx-runtime`,
  `@deepseek-ai/dsh-client-ui-primitives`), CSS ships as a
  `<style data-plugin data-plugin-css>` tag. Mounts into the
  `conversation.session.header.utilities` slot; locale dictionaries (en +
  zh) register under the `system-prompt-ui` namespace.

## UX notes

- First load lands on the **effective** scope; set levels show a dot on
  their tab; an "Active: <scope>" line names the winning level; the file
  path (or "(not set)") sits under the textarea.
- The header entry is a **direct icon button**, not a menu — the ⋯ cluster
  is per-plugin and not extensible, and a nested menu read worse here.
- Saving shows "applies from the next turn" — the editor package's section
  re-resolves per prompt assembly, so a save is live immediately.
- Chats in no workspace (Ungrouped) get a disabled workspace tab with a
  tooltip explaining why.

## Deploy / update flow

Same mount as the editor package (see its README — persistent web install,
real-dir copies, no symlinks). Two asymmetric rules, both restart-free:

- **Browser-half changes** ship via the client-modules rescan — the boot
  graph hash changes and open tabs need a **reload** (nothing server-side
  is cached).
- **Node-half changes** need the **fresh-URL swap** (module-URL caching —
  the row points at `lib/hot.js`; recipe in that shim's header and in the
  editor README). A swap copy of this package must import the editor via
  the relative `"../../dsh-system-prompt-editor/lib/hot.js"` (two levels
  up from `lib/`).

## Tests

```sh
node test/smoke.mjs   # run from the MOUNTED copy (needs the editor package mounted beside it)
```

13 checks, offline: the node half against a mock connection ctx + registry
with real `Request`/`Response` objects, and the client half executed in a
vm realm with stub seeds and a mock slots/locale ctx.
