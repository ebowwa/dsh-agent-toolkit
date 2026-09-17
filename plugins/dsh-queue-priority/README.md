# dsh-queue-priority

Reorder a dsh chat's pending prompt queue from the web UI — bump any queued
prompt up or down before its turn starts. The stock queue is strict FIFO with
only edit/remove/steer actions; this adds the missing move.

Package name `@local/dsh-queue-priority`, two halves:

- **Node half** (`lib/index.js`): one cookie-authenticated host route,
  `POST /api/queue-priority` with `{sessionId, itemId, direction: "up" |
  "down"}`. The stock `session/updateQueue` RPC has no move action, but the
  agent loop's inbox exposes a public `splice(target, start, deleteCount,
  inserted)` with full array semantics — so a move is planned as a single
  adjacent swap, `splice("next-turn", lo, 2, [list[hi], list[lo]])`, journaled
  as exactly ONE `agent/inbox/spliced` durable event (the same shape the
  stock queue EDIT action writes via remove+insert). The handler is
  synchronous, so the swap is atomic against turn claiming — no interleaved
  consumption. Errors map to `400 bad-body`, `404 session/not-found`,
  `404 session/queue-item-not-found` (already consumed or unknown id), and
  `400 queue/at-edge` (first row up / last row down).
- **Browser half** (`lib/client.js`): a dsh client plugin declared in
  `package.json` under `dsh.client` (injects the locale + conversation UI
  packages, platform web). Registers a compact "Queue order (top runs
  first)" panel as a second `conversation.input.dock` entry (order 21, under
  the stock Queue dock): numbered pending prompts with per-item bump-up /
  bump-down buttons. Each click POSTs the host route; the store re-renders
  from the pushed projections. Locale dictionaries (en + zh) register under
  the `queue-priority` namespace.

## UX notes

- The panel renders only when **two or more** prompts are pending (nothing
  to reorder below that) and the queue is mutable — same gate as the stock
  dock (hidden while a subagent in non-continuable mode owns the session).
- All React hooks run before the early returns, so hook order is stable.
- A transient note confirms each move or surfaces the failure reason; bump
  buttons disable while a move is in flight (one at a time).

## Why one splice and not remove+insert

Remove+insert would journal two events and, between them, the inbox briefly
holds neither item — a turn claiming at that instant would skip the moved
prompt. The single adjacent swap is one journaled event, replays
mechanically in the projection fold, and is product-blessed: the stock
queue EDIT action already emits exactly one `agent/inbox/spliced` per edit
(via remove+insert in one call). Long-distance moves are reached by
repeated adjacent swaps — each click is one event, and the UI disables
buttons mid-move so the queue can't drift under a click storm.

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
(`lib/hot.js` re-exporting `lib/index.js`, re-created per change) or
restart; browser-half changes need only a tab reload.

## Test

Offline, touches no dsh process:

```sh
node plugins/dsh-queue-priority/test/smoke.mjs
```

24 checks: the pure swap planner (math + edge errors + applied order), the
route's validation and error mapping against a mock agents registry and
recording inbox, and the browser factory via a vm harness with stub module
seeds (registration only — panel rendering is exercised by loading the
page).
