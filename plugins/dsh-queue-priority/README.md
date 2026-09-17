# dsh-queue-priority

Full queue control for a dsh chat's pending prompts from the web UI — the
stock queue dock collapses behind a header toggle once more than one prompt
is queued, hiding its edit / remove / steer actions; this panel stays up and
carries the complete action set: **move, edit, delete, steer, fork**.

Package name `@local/dsh-queue-priority`, two halves:

- **Node half** (`lib/index.js`): one cookie-authenticated host route,
  `POST /api/queue-priority`:
  - `{sessionId, itemId, action: "up" | "down"}` — move. The stock
    `session/updateQueue` RPC has no move action, but the agent loop's inbox
    exposes a public `splice(target, start, deleteCount, inserted)` with full
    array semantics — a move is planned as a single adjacent swap,
    `splice("next-turn", lo, 2, [list[hi], list[lo]])`, journaled as exactly
    ONE `agent/inbox/spliced` durable event (the same shape the stock queue
    EDIT action writes via remove+insert). `direction` is still accepted as
    a v1 alias.
  - `{sessionId, itemId, action: "remove"}` — delete. Mirrors the stock
    remove (`inbox.remove`); the stock handler's extra
    `fileUploads.retirePrompt` call is skipped (the plugin context carries
    no fileUploads service — an orphaned upload record is harmless).
  - `{sessionId, itemId, action: "edit", text}` — rewrite the prompt text.
    Same contract as the stock edit: whole-content replace validated to
    text-only, non-whitespace text (`400 queue/edit-invalid` otherwise); the
    replacement is frozen and detached exactly like the stock path.
  - `{sessionId, itemId, action: "steer"}` — send the queued prompt into
    the running turn now. Mirrors the stock steer: refused with
    `409 session/steer-unavailable` unless `agent.status === "running"`,
    then `inbox.remove` + `agent.steer(message)` (next-step placement +
    driver wake).
  - `{sessionId, itemId, action: "fork"}` — duplicate the prompt directly
    below itself: `structuredClone` with a fresh `randomUUID()` id, spliced
    in ONE durable event, replay-exact. The copy edits and reorders like any
    other row — fork, tweak each copy, run variants back to back.

  Errors map to `400 bad-body`, `404 session/not-found`,
  `404 session/queue-item-not-found` (already consumed or unknown id),
  `400 queue/at-edge` (first row up / last row down), `400
  queue/edit-invalid`, and `409 session/steer-unavailable`. The handler body
  is synchronous, so every action is atomic against turn claiming. Scope is
  next-turn only (the panel lists queued items; next-step placement awaits a
  step boundary, so its order is not user-meaningful).
- **Browser half** (`lib/client.js`): a dsh client plugin declared in
  `package.json` under `dsh.client` (injects the locale + conversation UI
  packages, platform web). Registers a compact "Queue order (top runs
  first)" panel as a second `conversation.input.dock` entry (order 21, under
  the stock Queue dock): numbered pending prompts with per-row actions —
  bump-up / bump-down chevrons, pencil (inline edit, Enter saves / Escape
  cancels, disabled for rows with attachments), trash (delete), send (steer,
  enabled only while the session's turn is running), copy (fork). Each click
  POSTs the host route; the store re-renders from the pushed projections.
  Locale dictionaries (en + zh) register under the `queue-priority`
  namespace.

## UX notes

- Unlike the stock dock (collapsed behind a header toggle above one queued
  item), the panel renders whenever **one or more** prompts are pending and
  the queue is mutable — same mutability gate as the stock dock (hidden
  while a subagent in non-continuable mode owns the session). With a single
  row the chevrons disable and edit / delete / steer / fork still apply.
- All React hooks run before the early returns, so hook order is stable; an
  edit targeting a row the store already dropped closes itself instead of
  saving into a dead item.
- A transient note confirms each action or surfaces the failure reason;
  buttons disable while an action is in flight (one at a time).

## Why one splice and not remove+insert

Remove+insert would journal two events and, between them, the inbox briefly
holds neither item — a turn claiming at that instant would skip the moved
prompt. The single adjacent swap is one journaled event, replays
mechanically in the projection fold, and is product-blessed: the stock
queue EDIT action already emits exactly one `agent/inbox/spliced` per edit
(via remove+insert in one call). Long-distance moves are reached by
repeated adjacent swaps — each click is one event, and the UI disables
buttons mid-action so the queue can't drift under a click storm. Fork is
likewise one event: insert-only, so nothing is ever missing.

## Install

Deploy into a dsh install's `@local` namespace (both resolution chains —
the runtime tree and, if split, the profiles tree):

```sh
cp -R plugins/dsh-queue-priority <runtime>/node_modules/@local/dsh-queue-priority
ln -s <runtime>/node_modules/@local/dsh-queue-priority <profiles>/node_modules/@local/dsh-queue-priority  # if split
```

Then add a row to the web profile's `cordis.patch.yml`:

```yaml
- insert:
    - id: queue-priority
      name: "@local/dsh-queue-priority"
      config:
        disabled: false
```

The patch layer is hot-watched: the route goes live without a restart.
Open tabs pick up the browser half on their next reload. Disable with
`config.disabled: true` (the route stops registering; the browser panel
then errors visibly if clicked — reload the tab after disabling).

Note for future **node-half code changes**: the running process caches
module URLs, so point the patch row's `name` at a fresh-URL shim
(`lib/hot.js` re-exporting `lib/index.js`, re-created per change — the
installed row already points at `lib/hot.js`; put the full new code at a
NEW fresh URL, e.g. `lib/hot2.js`, and flip the row) or restart;
browser-half changes need only a tab reload.

## Test

Offline, touches no dsh process:

```sh
node plugins/dsh-queue-priority/test/smoke.mjs
```

45 checks: the pure swap planner (math + edge errors + applied order), the
edit / fork message builders (content replace, identity, freeze/detach),
the route's validation and error mapping against a mock agents registry and
recording inbox — including the stock-mirroring remove / edit / steer
semantics and fork's clone-below — and the browser factory via a vm harness
with stub module seeds (registration only — panel rendering is exercised by
loading the page).
