# dsh-bot

The reusable agent-loop toolkit: comment-triggered `/dsh` coding agents
(DeepSeek Harness headless + GLM via Z.AI/Doppler), adversarial review
stage, deterministic shipper, and enforced output/input scrubbing — as
**reusable workflows** (`workflow_call`) that consumer repos adopt with
~15-line event shells.

Two execution modes:

- **Decoupled (recommended)** — `agent-comment-thin.yml` + `scripts/dsh-worker.sh`.
  The trigger is a ~20s job on the self-hosted `dsh` lane (owner directive:
  nothing on github-hosted; ack + enqueue via the `dsh/queued` label); the
  agent, shipper, reply, and adversarial review run out-of-band
  on the always-on worker (factory pool boxes). Consumers need **no
  extra secrets**. See `docs/decoupled-worker.md`.
- **Legacy execution** — the old mode: the agent runs inside the Actions
  job that holds a `dsh` self-hosted runner for up to 120 min
  (`agent-comment.yml`, `agent-dispatch.yml`). Kept for the migration
  window; removed at the next major version.

## What's shared here

| File | Purpose |
|---|---|
| `.github/workflows/agent-comment-thin.yml` | DECOUPLED trigger: ack (dsh:ack marker) + enqueue (dsh/queued label); self-hosted `dsh` lane, ~20s |
| `.github/workflows/agent-review-thin.yml` | DECOUPLED review trigger: enqueue a review (dsh/review label) on any PR — self-hosted `dsh` lane, ~15s; the worker runs the review |
| `.github/workflows/agent-dispatch-thin.yml` | DECOUPLED task trigger: creates a task issue (dsh/task label, options in a marker block) — legacy input surface kept for programmatic callers; the worker runs the task |
| `.github/workflows/agent-comment.yml` | LEGACY comment loop: context fetch → scrub → agent → ship → reply → review dispatch |
| `.github/workflows/agent-review.yml` | LEGACY adversarial review stage (rules + gates + verdict + labels) |
| `.github/workflows/agent-dispatch.yml` | LEGACY manual/scheduled task entry |
| `.github/workflows/drift-check.yml` | self-reviewing release agent: reviews its own main-branch diff, tags + releases only on an approved verdict (TAG / TAG-WITH-FINDINGS), advances the moving `@v1` pin, then notifies `DSH_BOT_CONSUMERS` (repo variable: comma/space-separated `owner/repo` list) via `repository_dispatch` — each consumer opens its own bump PR |
| `scripts/dsh-worker.sh` | the out-of-band worker: poll → claim (label) → run driver → ship → reply → review (see docs/decoupled-worker.md) |
| `scripts/ship-changes.sh` | deterministic shipper, shared by the legacy workflow AND the worker (never trust the model to push) |
| `scripts/post-reply.sh` | thread reply (ack-comment edit or fresh comment), shared by both modes |
| `scripts/review-pr.sh` | worker-side adversarial review (REVIEW.md from the PR base; verdict → labels) |
| `scripts/review-verdict.mjs` | line-strict verdict extraction (APPROVE / REQUEST CHANGES; fail-closed on absence) |
| `scripts/run-dsh-agent.sh` | driver: dsh install, settings bootstrap, gh/git identity, scrub shims, live trace, Doppler exec; head model via `DSH_MODEL`, subagent/subagent_fork children via `DSH_SUBAGENT_MODEL` (unset = inherit the head); local web search + fetch via `DSH_WEB_SEARCH_CELLS` (per-cell, default off); composition search tool via `DSH_SEARCH_COMPOSE=1` (default off); boot accounting (issue #96): per-attempt boot tombstones (`$DSH_HOME/boot-tombstones.jsonl`), failure classification (environmental boot deaths surface immediately instead of consuming the throttle-wave retry ladder), and a bounded transcript archive (`$DSH_HOME/transcript-archive/`, `DSH_ARCHIVE_KEEP`) outside the node boot sweep's reach |
| `plugins/tool-search-compose/` | the composition search tool — counts, file-lists, case-folding, context, total result caps, path/mtime ordering in one search call (see its README for the packaging contract) |
| `plugins/tool-session-query/` | vendored build of the five model-facing session history tools (`session_search` et al., issue #110) — the native search behind verify-before-dismissal; mount is declared in `config/lane-plugins.json`, not a launcher flag |
| `plugins/dsh-system-prompt-editor/` + `plugins/dsh-system-prompt-ui/` | scoped, live-editable system-prompt block for a persistent web install — session → workspace → global chain (first non-empty wins), agent read/write tools, and a chat-header editor dialog; see each README for the mount contract |
| `plugins/dsh-flight-recorder/` | transcript blind-spot recorder — `job/*` lifecycle/output events and `plugin/*` loader-fiber activity into session logs plus a host-side firehose; history-preserving repo import (unmounted on the persistent install pending the dsh-session event-type hotfix — see its README coupling note) |
| `plugins/dsh-session-id/` | chat-header copy button for the active session id (full `session-<uuid>` form) — pure browser feature over the `conversation.session.header.utilities` slot; stub host half exists only to make the patch row mountable |
| `plugins/dsh-queue-priority/` | full queue control for a chat's pending prompts from the web UI — cookie-authed host route: move (ONE durable adjacent swap on the next-turn inbox, `agent/inbox/spliced`), plus stock-mirroring delete / edit / steer and fork (duplicate in place) + a dock panel under the composer with per-row action buttons |
| `plugins/dsh-stream-watchdog/` | stalled-stream recovery for the LLM layer — wraps the outermost `llm/stream` waterfall with a per-chunk idle timer; a stream that opens and goes silent (the "chat randomly stopped mid turn" failure: nothing in the stack idle-times-out, and the retry policy only fires on a thrown failure) is closed and reclassified as the retryable `TIMEOUT` finish chunk, so `dsh-llm-retry` re-issues the step with its own backoff instead of the turn hanging forever |
| `scripts/scrub-output.mjs` | redaction (creds/PII/SSH keys in both directions; IP/host/path/date on outputs) |
| `scripts/gh-scrub-shim`, `git-scrub-shim` | the scrubber BETWEEN agent and GitHub/git |
| `scripts/dsh-progress.mjs` | live JSON trace of reasoning/tool events |
| `scripts/workflow-lint.mjs` | structural workflow-YAML lint (block-indent consistency; gates runs it — run 32705244305 regression) |
| `scripts/tests-lint.mjs` | structural test-source lint: (1) rejects PATH assignments that hard-code system dirs without the ambient PATH — they cannot construct a lane-installed CLI's absence (run 32933615526 regression); (2) rejects a spawn of `run-dsh-agent.sh` whose env does not pin `DSH_RETRY_BACKOFF_S` — the driver's failure path walks the production retry backoff (180s+600s), so an unpinned failing stub wedges the suite past any spawn budget until `status` comes back `null` (runs 34748403843/34788769043/34795917609/34803136058; the corpus test rides `node --test`) |
| `scripts/drift-verdict.mjs` | line-strict verdict extraction for drift-check (TAG / TAG-WITH-FINDINGS / BLOCK; fail-closed on absence) + scrubbed review-body surfacing to the run log |
| `scripts/resolve-push-token.sh` | Doppler-first git push credential for agent jobs, shared by the legacy workflows and the worker (the checkout's ephemeral token cannot push workflows) |
| `config/settings.zai.yaml` | DSH settings template (zai provider, glm-5.3) |
| `config/dsh-worker.env.example` | worker env template (GH_TOKEN, DSH_WORKER_REPOS; chmod 600) |
| `config/models.yaml` | model catalog for consumers — the provider/model ids the Z.AI coding endpoint serves (what `DSH_MODEL` / `DSH_WORKER_MODEL` accept) |
| `.agents/` | agent-contract docs for dispatched agents — communication conduct, verify-before-dismissal skill, and the issue-relationships protocol (issue #115: part tickets as blockedBy-chained sub-issues, `found:` tickets relatesTo their source, redos relatesTo predecessors, exit-summary relationship receipts); the prompt assembly appends the block, `tests/relationships-contract.test.mjs` pins it |
| `docs/decoupled-worker.md` | full decoupled-mode guide: queue semantics, trust model, security posture, factory-box install |

## Testing

Run the suite with the glob form:

```bash
node --test tests/*.test.mjs
```

Do NOT use the directory form (`node --test tests/`) — under Node 26 it
fails with `MODULE_NOT_FOUND` before running anything.

## Adopting (consumer repo)

**Decoupled (recommended):** copy `examples/dsh-agent-thin.yml` into
`.github/workflows/` — that is the entire consumer side (trust gate +
~20s trigger). Nothing else, no secrets. (The worker must be deployed and
list your repo in its `DSH_WORKER_REPOS`.)

**Legacy:** 1. Runners labeled `dsh` (optionally `big`), secret
`DOPPLER_SERVICE_TOKEN` (Doppler config holding `ZAI_API_KEY`), runner PATH
with `node gh doppler`. 2. Three thin shells in `.github/workflows/` — see
`examples/` for copy-paste versions. 3. Write your own `REVIEW.md` (the
review contract is repo-specific).

## Versioning

Consumers pin `@v1` (moving major tag). Breaking changes bump the major.
drift-check advances `v1` to each new release it tags. There is no bare
`v` moving tag: drift-check used to advance an undocumented `v` instead of
`v1`, leaving every pinned consumer frozen on v1.0.9 through 33 releases
(issue #38) — `v` is retired. Scrubber/security fixes land as minors and
reach consumers only through a drift-check bump PR merged by each repo's
own gates + review — the audit gate. Nothing propagates silently.

## Local web search + fetch (per-cell, default off)

The launcher can mount [`@local/dsh-web-search-browser`](https://github.com/ebowwa/HelloMacOScreator/tree/main/web-search-browser)
— a key-free `ctx.web` provider that searches free engine result pages and
fetches arbitrary URLs via the cell's own headless Chromium — as a
regenerated `--patch` overlay, exactly like the subagent-model stamp:

- `DSH_WEB_SEARCH_CELLS` (workflow input `web-search-browser-cells`) — a
  comma-separated list of runner names. The provider mounts ONLY when the
  job's `RUNNER_NAME` is listed; unset/empty is off on every cell. This is
  the per-cell adoption gate: a runner name is earned by provisioning the
  cell (a complete plugin copy at `DSH_WEB_SEARCH_BROWSER_PATH`, default
  `~/.dsh/profiles/node_modules/@local/dsh-web-search-browser`) and passing
  its live smoke (one search + one fetch through the provider on that
  machine). A listed runner without its copy fails loud — a plugin that
  cannot resolve is a dead mount, never a working one.
- `DSH_WEB_SEARCH_BROWSER_BROWSERS` — optional space-separated browser
  binary paths pinned into the provider row. Each entry must be a plain
  `[A-Za-z0-9._/@+-]` path and an existing executable file; either check
  fails loud (a pin containing a space splits at the separator before the
  charset test, so the filesystem check is what rejects it). Some CI cells
  have no working full-browser new-headless session (the render hangs with
  no DOM) while the standalone `chrome-headless-shell` binary works; the
  provider's `browsers` config is the supported seam for that.

The overlay restates the bundle's `web` row (`searchProvider:
headless-browser`) and `tool-web` row (`fetch: true`, 60s budgets) — patch
rows replace whole plugin config — and inserts the provider row through the
loader's `insert:` grammar (a bare row whose id is unknown only warns and
is silently skipped). No API key is involved anywhere; search and fetch
both run locally on the cell.

## Composition search tool (default off)

`DSH_SEARCH_COMPOSE=1` mounts [`plugins/tool-search-compose/`](plugins/tool-search-compose/README.md)
— one `search` call replacing the `grep | head/wc/sort` pipe shapes
(per-file counts, file lists, case-folding, context, a total result cap,
path/mtime ordering). The plugin ships as a real package that the launcher
copies into the profile module tree, where its `@deepseek-ai/*` deps resolve
through the profile's flat fallback — the packaging that failed at f2972e7,
where the overlay pointed at the bare in-tree script path and resolved
nothing. Requires no per-cell provisioning; unset stays a byte-identical
launch line.

## Prior-session search (verify-before-dismissal, on by default where declared)

`config/lane-plugins.json` carries three `session-*` entries (issue #110) that
turn the shipped-but-off session search into working tools for dispatched
agents:

- `session-persistence-jsonl` (**profile-config** seam) — the shipped row
  roots persistence at the (job-fresh) home's `sessions/`; the restatement
  roots it at the box-shared `~/.dsh/sessions`, so every dispatched job reads
  AND writes the box's accumulated history. This is the load-bearing half of
  "shared": without it the index derives from an empty corpus and every
  search silently returns nothing.
- `session-query-sqlite` (**profile-config** seam) — the backend ships in
  every profile as `path: ':memory:'`, `openAt: never` (FTS5 search
  deliberately off). The restatement turns it on with `openAt: first-search`
  (boot unaffected; an unopenable index fails one search, never activation)
  and hands out a **per-job db file under the shared** `~/.dsh/session-index/`
  — ONE shared file would break the backend's single-process-owner contract:
  it reconciles under `BEGIN IMMEDIATE` with no busy timeout, and
  `node:sqlite` throws immediately on lock contention, so the worker's
  parallel slots would flake every search. The index is the backend's own
  "dedicated disposable database"; the durable half of sharing is the corpus
  row above.
- `tool-session-query` (**plugin** seam) — the five model-facing tools
  (`session_search`, `session_event_search`, `session_trace`,
  `session_event_trace`, `session_event_read`). The build is vendored at
  [`plugins/tool-session-query/`](plugins/tool-session-query/README.md)
  because no `dsh` release depends on it and the upstream git tree has no
  built `lib/`; it is gated on the backend shipping in the profile tree.

Honest scope: cross-session authorization is exact-`cwd` (upstream package
contract), so visibility is per-box per-workdir — same-lane jobs on a box see
each other's history; other boxes' history is invisible.
[`.agents/skills/verify-before-dismissal/`](.agents/skills/verify-before-dismissal/SKILL.md)
teaches the workflow: search the claim's own words before dismissing, cite
the prior session, and only then write the disposition.

## System-prompt plugins (persistent web install, mounted by hand)

[`plugins/dsh-system-prompt-editor/`](plugins/dsh-system-prompt-editor/README.md)
+ [`plugins/dsh-system-prompt-ui/`](plugins/dsh-system-prompt-ui/README.md)
— a live, **scoped** system-prompt block: this-chat → workspace → global
markdown files, first non-empty wins, re-resolved at every prompt assembly
so a write applies to the next LLM call of every running session (no
restart). The editor package mounts the prompt section plus
`read_system_prompt` / `write_system_prompt` agent tools; the ui package
adds a chat-header button + scope-tabbed dialog over a cookie-authenticated
host route, reusing the editor's resolution helpers so dialog and prompt
can never disagree.

These target a **persistent** dsh web install (hand-mounted into its
runtime `@local/` tree + a hot-watched `cordis.patch.yml` row), not a
per-cell launcher mount — the READMEs carry the mount contract, the
module-cache live-swap recipe (`lib/hot.js` shims), and the
no-symlinks-into-this-repo rule (Node realpath leaves the
`@deepseek-ai/*` peers unresolvable — a boot-time fiber failure).

## Session-id copy button (persistent web install, mounted by hand)

[`plugins/dsh-session-id/`](plugins/dsh-session-id/README.md) — a chat-header
copy button for the active session id (the full `session-<uuid>` form, the
exact string the RPC surface and dispatch tooling expect). Pure browser
feature over the same `conversation.session.header.utilities` slot as the
system-prompt dialog; the host half is a stub whose only job is making the
patch row mountable so `dsh-client-modules` serves the browser bundle. Same
mount contract as above.

## Queue priority (persistent web install, mounted by hand)

[`plugins/dsh-queue-priority/`](plugins/dsh-queue-priority/README.md) —
full control of a chat's pending prompt queue before turns start: move,
delete, edit, steer, fork. The stock dock hides its edit/remove/steer
behind a collapsed header once >1 item queues, so this panel carries the
whole set and stays visible at ≥1 pending prompt. The stock
`session/updateQueue` RPC has no move or fork; the inbox's public `splice`
covers the move natively as one adjacent swap journaled as a single
`agent/inbox/spliced` event (atomic against turn claiming — no
remove+insert gap where a moved prompt could be skipped), and fork is a
structuredClone with a fresh id spliced directly below the original — also
one durable event. Delete / edit / steer mirror the stock handler's
semantics (steer refused while no turn is running, `409
session/steer-unavailable`). Browser half is a numbered "Queue order" dock
panel (order 21, under the stock Queue dock) with per-row buttons:
chevrons, pencil (inline editor), trash, send, copy. Same mount contract
as above (route hot-loads via the patch row; browser half ships on tab
reload; future node-half code changes need a NEW fresh-URL copy — the
installed row points at `lib/hot.js`, now a re-export shim).
