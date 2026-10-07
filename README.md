# dsh-bot

The reusable agent-loop toolkit: comment-triggered `/dsh` coding agents
(DeepSeek Harness headless + GLM via Z.AI/Doppler), adversarial review
stage, deterministic shipper, and enforced output/input scrubbing — as
**reusable workflows** (`workflow_call`) that consumer repos adopt with
~15-line event shells.

One execution mode — **decoupled** — `agent-comment-thin.yml` +
`scripts/dsh-worker.sh`. The trigger is a ~20s job on the self-hosted `dsh`
lane (owner directive: nothing on github-hosted; ack + enqueue via the
`dsh/queued` label); the agent, shipper, reply, and adversarial review run
out-of-band on the always-on worker (factory pool boxes). Consumers need
**no extra secrets**. See `docs/decoupled-worker.md`. (The old in-job mode —
the agent inside a 120-min Actions job, `agent-comment.yml` +
`agent-dispatch.yml` — is removed; issue #264.)

## What's shared here

| File | Purpose |
|---|---|
| `.github/workflows/agent-comment-thin.yml` | DECOUPLED trigger: ack (dsh:ack marker) + enqueue (dsh/queued label); self-hosted `dsh` lane, ~20s |
| `.github/workflows/agent-review-thin.yml` | DECOUPLED review trigger: enqueue a review (dsh/review label) on any PR — self-hosted `dsh` lane, ~15s; the worker runs the review |
| `.github/workflows/agent-dispatch-thin.yml` | DECOUPLED task trigger: creates a task issue (dsh/task label, options in a marker block) — legacy input surface kept for programmatic callers; the worker runs the task |
| `.github/workflows/agent-review.yml` | the in-job adversarial review stage (rules + gates + verdict + labels), usable as a reusable workflow — kept only for consumers who run the review inside their own Actions for hard machine-level isolation; this repo's own reviews ride the decoupled `dsh-review.yml` path, and the in-job AGENT mode (`agent-comment.yml` / `agent-dispatch.yml`) is removed (issue #264) |
| `.github/workflows/drift-check.yml` | self-reviewing release agent: reviews its own main-branch diff, tags + releases only on an approved verdict (TAG / TAG-WITH-FINDINGS), advances the moving `@v1` pin, then notifies `DSH_BOT_CONSUMERS` (repo variable: comma/space-separated `owner/repo` list) via `repository_dispatch` — each consumer opens its own bump PR. An EMPTY watched-path diff skips both the review and the tag green — zero agent passes (issues #231, #385); pinned by `tests/drift-empty-range.test.mjs` |
| `.github/workflows/dsh-review.yml` | DECOUPLED review enqueue for THIS repo (dogfooding the decouple it ships): workflow_dispatch (`pr` input) or issue_comment enqueues the review; the out-of-band worker (`dsh/review` label) runs `scripts/review-pr.sh` — the legacy `agent-review.yml` path (a held self-hosted runner for up to 45 min per review) is retired here; `cancel-in-progress: false` is load-bearing (the tower re-fires reviews on unreviewed PRs every tick) |
| `.github/workflows/fleet-manifest-drift.yml` | the standing registry's alignment fence (issue #397): runs `scripts/fleet-manifest-drift.mjs` against the live tower registry — on PRs touching the fence's own files (toolkit-side alignment breaks go red pre-merge) and on a daily schedule (the drift that matters is TOWER-side: only a clock catches a pool that moved without the manifest) |
| `.github/workflows/gates.yml` | this repo's own checks — push to main / PR / dispatch: every script must at least parse (`node --check` / `bash -n`, the no-extension scrub shims included) and the `tests/` suite must pass (no build — the honest minimum for a scripts-only repo); `scripts/workflow-lint.mjs` + `scripts/tests-lint.mjs` ride the same job |
| `.github/workflows/smoke-deps-canary.yml` | the fresh-runner canary for the plugin smoke-dep closure (issue #506): mints a PRISTINE tree (`git archive HEAD` — no `node_modules` by construction, so the installer's install-once fast path cannot fire), runs the real npm install leg against the live registry there, then grades the plugin smokes on the fresh tree. Red = a plugin spec the registry cannot satisfy, a registry that lost versions, or a smoke that only passes on a stale tree — the class the self-hosted cell's converged tree masked (#506: `dsh-reflex`'s `>=0.1.0` peer spec ETARGETed every fresh clone once #505's smoke made the plugin tested, while the cell's gates kept skipping npm entirely). Graded on PRs touching plugin specs/smokes or the installer (before merge), on a daily schedule (registry-side drift), and on dispatch; pinned by `tests/smoke-deps-canary.test.mjs` |
| `.github/workflows/cell-disk-guard.yml` | scheduled (every 4h, `[self-hosted, dsh]`) rotation of the burst pool's diag archive (issue #478): the seed cell's burst spawner preserves every ephemeral runner's `_diag` into `_diag-archive/` on reap — 2718 dirs and climbing on 2026-10-04, on the same 75G fs that a burst peak drives to 100%. Runs `scripts/cell-disk-guard.sh rotate` (keep 500 / age 14d, repo-variable overridable); a cell without the archive is a green nothing-to-rotate, and entries surviving over budget is a RED run (the #474 convention — rotation not landing is the state worth paging on). The canonical schedule is root-side (the spawner's reap chowns the archive root:root) — `cell-disk-guard.sh schedule` prints the units; this workflow is the belt over that suspenders |
| `.github/workflows/self-register-factory.yml` | fleet self-scaling: runs ON a dsh-agent-toolkit runner and registers THAT machine as a side-by-side executor for the factory repo (github-activity-tracker) — this repo's own runner is untouched; idempotent (skips when the install directory exists); dispatched when the factory queue is saturated and the box is idle |
| `.github/workflows/worker-deploy.yml` | ONE-DISPATCH out-of-band worker install on a factory box (workflow `name: deploy-worker`): calls `scripts/install-worker.sh` ON the box (idempotent), takes box diagnostics (keepalive alive? crond present? any sweeps run?), then a ONE-TIME activation sweep runs the worker in-job once per deploy to drain what is already queued — steady-state is the cron keepalive's job, never a held Actions runner |
| `.github/workflows/orphan-branch-sweep.yml` | the scheduled half of the branch-hygiene sweep (issue #453, contract #127): reaps remote `dsh/issue-*` branches with NO open PR behind them (the sessions' delete-on-close rule leaks — a dead cell before the PR step, a close without `--delete-branch`); runs `scripts/orphan-branch-sweep.sh list` weekly on the dsh cell, and only a MANUAL dispatch with `actuate=true` deletes — a schedule tick is always a dry run whose orphan list is the receipt |
| `scripts/dsh-worker.sh` | the out-of-band worker: poll → claim (label) → run driver → ship → reply → review (see docs/decoupled-worker.md). The claim-path trust re-derivation's issue-body parse is guarded INSIDE the node script — a non-JSON body (gh error text on stdout under a 403/429), or a JSON body that is not the gh issue envelope (GitHub's own 403/429 error bodies are JSON), degrades to an EMPTY task with ONE worker-log diagnostic, never an uncaught `JSON.parse`, never a silent "no trusted /dsh comment" close (issue #530); pinned by `tests/worker-smoke.test.mjs` |
| `scripts/re-pin-toolkit.sh` | the keepalive's GUARDED re-pin arm (issue #276): moves a lane box's shared toolkit checkout to the moving `v1` tag but REFUSES — one loud worker.log note per sweep, HEAD kept, sweep proceeds on the previous pin — while the tree carries tracked modifications or a working branch, so a tag advance never destroys in-flight agent work; called by the cron line `scripts/install-worker.sh` arms and by that installer's own refresh; quiet on success; pinned by `tests/re-pin-toolkit.test.mjs` |
| `scripts/install-worker.sh` | one-shot, IDEMPOTENT worker deployment for a factory box — `worker-deploy.yml` calls it ON the box (the self-register-factory pattern: a workflow may install a persistent per-user service; the keepalive needs no sudo): the toolkit checkout, the 0600 env file at `$DSH_WORKER_HOME/env` (the ONLY place credentials ever land — never the cron line, never the log), and the per-minute cron keepalive that re-pins the toolkit to the moving `v1` tag — the audited-release pin drift-check advances, so the worker's code updates itself only through the repo's own release gate; pinned by `tests/install-worker.test.mjs` |
| `scripts/dep-cache.sh` | per-repo node_modules cache keyed on the lockfile hash, restored into the claim checkout after the worker's checkout (best-effort; issue #189) — every restore that materialized a tree (cache hit or fresh install) is audited for the bun silent-skip (issue #190): bun omits a platform-mismatched MANDATORY dep with a zero exit where npm hard-errors (`notsup`), so the package.json mandatory direct deps are compared against the tree and each absent one is named in a WARNING (best-effort — never failing the claim); pinned by `tests/dep-cache.test.mjs` |
| `scripts/fleet-manifest-drift.mjs` | the standing registry's drift fence (issue #397): compares the injected `config/fleet-manifest.md` standing fleet context against the LIVE tower registry (FleetTower `fleet.manifest.json`); a node/OS that moved or vanished without the manifest stranding agents on a stale pool fails LOUD (exit 1, aligned-diff receipt) — never a silent map; invoked by the `fleet-manifest-drift.yml` workflow on fence-file PRs and on a daily schedule; pinned by `tests/fleet-manifest-drift.test.mjs` |
| `scripts/install-plugin-smoke-deps.mjs` | the plugin smoke-test dependency installer, called by gates.yml: computes the peer closure IN PROCESS against registry metadata and installs the resolved union ONCE (`--no-save --no-package-lock`), then verifies the tree — packages present, peers resolved, `@local` links intact — failing loudly before the suite; an already-converged tree skips npm entirely. The seed keeps EVERY tested plugin's spec per package name (issue #508: first-writer-wins let the loser of the readdir race vanish before npm saw it), and since npm's argv keeps only the LAST spec per name, a name two plugins seed is resolved against the registry first — one pinned version satisfying every declared range, or a loud refusal. The WALK side honors the same no-drop contract (issue #510): `localPeers` collects every @local plugin's peer range per name, distinct walk-derived ranges accumulate under a walk-only name, and a walk-accumulated multi-spec name resolves the same way (live receipt: `@deepseek-ai/cordis` arrives as `^4.0.1 + ~4.0.4` from two walked packages — pre-#510 one range's transitive peers never reached the install). Replaces the old per-round npm loop that oscillated on bare checkouts (issue #161); pinned by `tests/plugin-smoke-deps.test.mjs` + `tests/gates-plugin-deps.test.mjs` |
| `scripts/ship-changes.sh` | deterministic shipper, called by the worker at ship time (never trust the model to push) |
| `scripts/post-reply.sh` | thread reply (ack-comment edit or fresh comment), called by the worker |
| `scripts/review-pr.sh` | worker-side adversarial review (REVIEW.md from the PR base; verdict → labels); prior `gate-verify` markers surface to the reviewer as claims to check (issue #326) |
| `scripts/merge-guard.sh` | the merge-time gates guard (issue #434): ONE snapshot of the PR's check runs — merges pass only when the check (`MERGE_GUARD_CHECK`, default `gates`) is `completed`/`success` ON THE PR'S HEAD SHA; queued / in_progress / cancelled / failed / absent / wrong-SHA all refuse, and the guard never polls until green. Since FleetTower issue #1132 the DEFAULT name is repo-agnostic: consumer repos name their gates jobs differently (`guard-tests`, …), so when NO run named `gates` grades the head the guard grades it by the rollup — ≥1 `completed`/`success` run ON the head SHA and no red conclusion passes (loudly naming what graded the head); reds-present or nothing-green refuses, naming the explicit-name escape. An EXPLICIT `MERGE_GUARD_CHECK` is an assertion: it never falls back. Modes: `check [pr]` (exit 0 iff green) and `merge [gh pr merge args...]` (check, then exec). Fail-closed: unresolvable state refuses. OPT-IN independent-verification arm (issue #326): `MERGE_GUARD_VERIFY=on` additionally requires a passing `gate-verify` comment (a fail marker or a silent channel refuses); default OFF — gates-only. The gh-scrub-shim gates `gh pr merge` through it when the driver arms `GH_MERGE_GUARD=on`; pinned by `tests/merge-guard.test.mjs` |
| `scripts/gate-verify.mjs` | line-strict `gate-verify: pass|fail` marker extraction from a PR comment — the independent-verification channel (issue #326): the shared-account fleet cannot post approving reviews, so the verifying agent's marker line IS the verification; label REQUIRED (a bare `pass` in prose never qualifies), last marker wins, comment bodies never pass through; pinned by `tests/gate-verify.test.mjs` |
| `scripts/pr-verification.mjs` | per-PR aggregation of the gate-verify channel (issue #326): walks the PR's comments (paginated, oldest→newest) through `gate-verify.mjs`, reports the last marker with provenance (`pass|fail|none` + comment id/author/URL; `--json` for tooling; exit 0 pass / 1 no passing verification / 2 unresolvable fail-closed) — consumed by `review-pr.sh` (markers as claims to check) and `merge-guard.sh` under `MERGE_GUARD_VERIFY=on`; pinned by `tests/pr-verification.test.mjs` |
| `scripts/review-verdict.mjs` | line-strict verdict extraction (APPROVE / REQUEST CHANGES; fail-closed on absence) |
| `scripts/run-dsh-agent.sh` | driver: dsh install, settings bootstrap, gh/git identity, scrub shims, live trace, Doppler exec; head model via `DSH_MODEL`, subagent/subagent_fork children via `DSH_SUBAGENT_MODEL` (unset = inherit the head); local web search + fetch via `DSH_WEB_SEARCH_CELLS` (per-cell, default off); composition search tool via `DSH_SEARCH_COMPOSE=1` (default off); boot accounting (issue #96): per-attempt boot tombstones (`$DSH_HOME/boot-tombstones.jsonl`), failure classification (environmental boot deaths surface immediately instead of consuming the throttle-wave retry ladder), and a bounded transcript archive (`$DSH_HOME/transcript-archive/`, `DSH_ARCHIVE_KEEP`) outside the node boot sweep's reach; stamps the standing agent contracts (issues #113/#115/#127) into EVERY task — the discovery protocol (`found:` issue-filing with receipts, the exit-summary `filed-followups:` line, the no-scope-creep rule), the issue-relationships linking rules, and branch hygiene (same-session PR per branch, delete-on-close-without-merge, the `branches-left:` exit line), reference text in [`.agents/README.md`](.agents/README.md); fleet decomposition protocol (issue #114): injects the standing fleet context (`config/fleet-manifest.md` + a caller-live `DSH_FLEET_MANIFEST` snapshot), the work-plan-first step (parts + capability class per part), the modularize-and-file rule for parts the cell cannot run (self-contained tickets, #113 mechanism), and the mandatory exit-summary parts table |
| `scripts/settings-write.mjs` | the driver's settings write: PRESERVE by default (FleetTower #642) — the stamped template's keys win, every key the template does not manage (nested provider routes, per-route credential pins) survives every spawn via `preserveUnknownRoutes`, and the write is atomic. A symlinked settings path refuses the spawn LOUDLY (exit 2, the `lane-settings-guard` lstat rule); a missing YAML runtime or an unparseable existing file refuses too (exit 3) — there is NO unmerged-overwrite fallback. YAML ladder: Bun.YAML → `node:yaml` → js-yaml from the dsh install tree (the same parser that reads the file back). Pinned by `tests/settings-write.test.mjs` |
| `scripts/settings-normalize.mjs` | verbatim port of FleetTower #641's `settings-normalize.mjs`: `preserveUnknownRoutes()` (deep merge-preserve; original-only keys and route-array entries ride through verbatim) + `normalizeWritePreserving()` (guarded, atomic normalize-write). Goes away when upstream `@deepseek-ai/dsh-settings` ships a preserve-aware user-layer write — pin the upstream version then (FleetTower #642 work order 3) |
| `scripts/lane-settings-guard.mjs` | verbatim port of FleetTower #641's `lane-settings-guard.mjs`: the `lstat` symlink tripwire for lane settings — a symlink (or any non-regular-file) target refuses loudly and never follows the link (the air16 clobber class, FleetTower #640) |
| `plugins/tool-search-compose/` | the composition search tool — counts, file-lists, case-folding, context, total result caps, path/mtime ordering in one search call (see its README for the packaging contract) |
| `plugins/tool-session-query/` | vendored build of the five model-facing session history tools (`session_search` et al., issue #110) — the native search behind verify-before-dismissal; mount is declared in `config/lane-plugins.json`, not a launcher flag |
| `plugins/dsh-system-prompt-editor/` + `plugins/dsh-system-prompt-ui/` | scoped, live-editable system-prompt block for a persistent web install — session → workspace → global chain (first non-empty wins), agent read/write tools, and a chat-header editor dialog; see each README for the mount contract |
| `plugins/dsh-flight-recorder/` | transcript blind-spot recorder — `job/*` lifecycle/output events and `plugin/*` loader-fiber activity into session logs plus a host-side firehose; history-preserving repo import (unmounted on the persistent install pending the dsh-session event-type hotfix — see its README coupling note) |
| `plugins/dsh-session-id/` | chat-header copy button for the active session id (full `session-<uuid>` form) — pure browser feature over the `conversation.session.header.utilities` slot; stub host half exists only to make the patch row mountable |
| `plugins/dsh-queue-priority/` | full queue control for a chat's pending prompts from the web UI — cookie-authed host route: move (ONE durable adjacent swap on the next-turn inbox, `agent/inbox/spliced`), plus stock-mirroring delete / edit / steer and fork (duplicate in place) + a dock panel under the composer with per-row action buttons |
| `plugins/dsh-stream-watchdog/` | stalled-stream recovery for the LLM layer — wraps the outermost `llm/stream` waterfall with a per-chunk idle timer; a stream that opens and goes silent (the "chat randomly stopped mid turn" failure: nothing in the stack idle-times-out, and the retry policy only fires on a thrown failure) is closed and reclassified as the retryable `TIMEOUT` finish chunk, so `dsh-llm-retry` re-issues the step with its own backoff instead of the turn hanging forever |
| `plugins/dsh-reflex/` | Reflex engine tools for the DeepSeek Harness — a cordis plugin registering the eight `reflex_*` session tools plus a `reflex_command` escape hatch (nine registrations in total), all thin clients for the Reflex command server (JSON over TCP, default `127.0.0.1:49173`); the engine runs inside the Gauge host (its TCC grants apply), this plugin is a stateless client and duplicates nothing (see its README for the mount contract) |
| `scripts/sync-lane-plugins.sh` | keepalive-side half of the plugin delegation system: materializes the CANONICAL per-box copies of every external source declared in `config/lane-plugins.json`, at the manifest's PINNED ref — runs right after the `v1` tag checkout, so pins advance on tag bump; `--verify` checks state without mutating (keepalives run it `|| true`: loud, never blocking). Division of labor: THIS clones, the consult mounts — nothing here touches a lane home |
| `scripts/lane-plugins-consult.py` | spawn-side half of the plugin delegation system: `run-dsh-agent.sh` calls it immediately before the native web seam to read `config/lane-plugins.json` and emit tab-separated directives (ENV / PATCH / SKIP). Every gate fails SAFE — platform mismatch, node-glob mismatch, missing canonical copy, or missing package is a loud SKIP and the run proceeds without that plugin; a `require_probe` row without `probe_port` is itself a gate failure (loud SKIP, issue #256), never a mid-loop crash; pinned by `tests/lane-plugins.test.mjs` |
| `scripts/local-fleet-audit.sh` | the LOCAL plane of any occupancy audit (the air-native-linux incident): live dsh/node participant processes, service managers (launchd, systemd --user, cron), and dsh/node filesystem artifacts ON the machine it runs on — not just GitHub. Report-only: findings print loudly, exit stays 0 (an audit that fails CI teaches people to stop running it); run it on any machine that might be participating — laptops included; pinned by `tests/local-fleet-audit.test.mjs` |
| `scripts/cell-disk-guard.sh` | runner-cell disk guard for the burst pool (issue #478), two levers: `admit` — refuse a `seed-burst-*` mint when free space is under a floor with the SAME semantics as the gates pre-step (PR #477: default 2048 MiB via `CELL_DISK_FLOOR_MB`, `df -kP`, numbers printed, nonzero + loud under floor) — the spawner side ships as FleetTower's trough-aware spin gate (FleetTower#1018 / PR FleetTower#1052); `rotate` — prune `_diag-archive/` oldest-first (keep 500 / age 14d, env-overridable, `--dry-run`), never outside the archive dir, refusing a dir that is really a minted runner body, and exiting 1 with the BLOCKED list when root-owned entries survive (the reap chowns the archive root:root — `schedule` prints the root-side systemd units + crontab fallback); pinned by `tests/cell-disk-guard.test.mjs` |
| `scripts/orphan-branch-sweep.sh` | the retrospective branch-hygiene sweep (issue #453, contract #127): lists remote `dsh/issue-*` branches with NO open PR behind them (one `gh pr list --state open` census — the exact receipts' `gh pr list --head` per branch would be N calls) and deletes the confirmed orphans; refuses loudly on an unreadable census (never delete blind), dry-run by default (`sweep` needs `--yes`), fail-loud mid-sweep on a refused deletion; `list` prints the orphans for the scheduled workflow's receipt; pinned by `tests/branch-hygiene-sweep.test.mjs` |
| `scripts/scrub-output.mjs` | redaction (creds/PII/SSH keys in both directions; IP/host/path/date on outputs — dates KEPT in GitHub-bound text via `DSH_SCRUB_KEEP_DATES=1`, selected by the transport shims) |
| `scripts/gh-scrub-shim`, `git-scrub-shim` | the scrubber BETWEEN agent and GitHub/git (KEEP_DATES: authored prose carries dates; redacting at POST corrupts the stored body). Fail-closed (REVIEW.md): a scrubber failure aborts the invocation — the real binary is never exec'd with unscrubbed text. Both shims run the real binary as a child and unlink every scrubbed temp the moment it's done (issue #154 for gh's `*-file` calls, issue #180 for git's `-F`/`--file=`/`-F -` commit messages: the old `exec` tail leaked a post-scrub copy into TMPDIR on every path, success or failure); pinned by `tests/scrub-shims.test.mjs` |
| `scripts/dsh-progress.mjs` | live JSON trace of reasoning/tool events |
| `scripts/workflow-lint.mjs` | structural workflow-YAML lint (block-indent consistency; gates runs it — run 32705244305 regression) |
| `scripts/tests-lint.mjs` | structural test-source lint: (1) rejects PATH assignments that hard-code system dirs without the ambient PATH — they cannot construct a lane-installed CLI's absence (run 32933615526 regression); (2) rejects a spawn of `run-dsh-agent.sh` whose env does not pin `DSH_RETRY_BACKOFF_S` — the driver's failure path walks the production retry backoff (180s+600s), so an unpinned failing stub wedges the suite past any spawn budget until `status` comes back `null` (runs 34748403843/34788769043/34795917609/34803136058; the corpus test rides `node --test`) |
| `scripts/drift-verdict.mjs` | line-strict verdict extraction for drift-check (TAG / TAG-WITH-FINDINGS / BLOCK; fail-closed on absence) + scrubbed review-body surfacing to the run log |
| `scripts/resolve-push-token.sh` | Doppler-first git push credential for agent jobs, called by the worker (the checkout's ephemeral token cannot push workflows) |
| `config/settings.zai.yaml` | DSH settings template (zai provider, glm-5.3) |
| `config/fleet-manifest.md` | standing fleet context (issue #114): node registry (OS + lanes served, aligned with the tower's `fleet.manifest.json`) + the placement law (factory#60); injected into every dispatched task by the driver, overridable/extendable per launch with a live `DSH_FLEET_MANIFEST` snapshot |
| `config/fleet-priority.md` | the AUTHORITATIVE fleet repo-priority order the maintenance lanes pick issues by: tier 1 fleet-infra (dsh-agent-toolkit → FleetTower → factory → github-activity-tracker → GitActionsRunner → deepseek-harness) → tier 2 products → tier 3 owner-named only; also carries the sanctioned upstream-contribution table (ebowwa forks whose upstreams may receive PRs — cordis, bun, deepseek-harness) and the hard boundary: never work another account's repo on a label alone |
| `config/lane-plugins.json` | the lane-plugin delegation manifest — single source of truth for which dsh plugins mount WHERE, keyed by platform + node glob across three seams (`native-web` primes the runner's own web-search mount, `plugin` mounts compose-style packages, `profile-config` turns on a shipped-off capability); consulted at SPAWN time by `scripts/lane-plugins-consult.py`, external sources materialized by `scripts/sync-lane-plugins.sh`; every entry gates before mounting — a gated-out entry is a loud SKIP, never a dead mount |
| `config/dsh-worker.env.example` | worker env template (GH_TOKEN, DSH_WORKER_REPOS; chmod 600) |
| `config/models.yaml` | model catalog for consumers — the provider/model ids the Z.AI coding endpoint serves (what `DSH_MODEL` / `DSH_WORKER_MODEL` accept) |
| `config/system-prompts/` | lane system-prompt templates for the **system-prompt** seam (issue #254): each file is a managed `<!-- dsh:<entry-id> -->` marker block the consult merges into the lane home's system-prompt file (operator text outside the block is never touched); the macos template carries the standing reflex directive (handle non-TCC GUI dialogs via `reflex_*`, TCC consent dialogs owner-once) gated on the engine probe |
| `.agents/` | standing agent contracts for dispatched agents — the discovery protocol (issue #113: file `found:` tickets, never scope-creep), the issue-relationships protocol (issue #115: part tickets as blockedBy-chained sub-issues, `found:` tickets relatesTo their source, redos relatesTo predecessors, exit-summary relationship receipts), the branch-hygiene protocol (issue #127: same-session PR per branch, delete-on-close-without-merge, the `branches-left:` exit line, zero-orphan acceptance), the claim-time carrier dedup (issue #414: one open ticket, one live carrier — before working ticket N run `gh pr list --repo R --state open --search "N in:title"`; a live carrier blocks with a declared `skipped: #N — live carrier #M` exit line, a stale carrier — closed without merge or past its review window — yields to a named takeover), and the ship-exit SKILL CANDIDATE block grammar (a summary MAY carry one or more literal `SKILL CANDIDATE: <kebab-name>` / `WHEN TO USE:` / `THE PROCEDURE:` blocks inside the final result comment — additive to the existing exit-summary rules); the prompt assembly stamps the discovery, issue-relationships, and branch-hygiene contracts plus the skill grammar into every task, and the claim dedup rides the claim preambles (`DEFAULT_TASK` in `scripts/run-dsh-agent.sh` + the `agent-dispatch-thin.yml` empty-task fallback); pinned by `tests/agent-contract.test.mjs`, `tests/relationships-contract.test.mjs`, `tests/branch-hygiene-contract.test.mjs` + `tests/claim-dedup-contract.test.mjs` |
| `docs/decoupled-worker.md` | full decoupled-mode guide: queue semantics, trust model, security posture, factory-box install |
| `.agents/skills/decompose-by-capability/` | the agent-side decomposition contract (issue #114): work plan first (parts + capability class per part, factory#60 placement law), run-what-you-can / file-what-you-cannot as self-contained tickets (#113 mechanism, pile-gate honesty), and the exit-summary parts table; the driver injects the working version into every task |

## Testing

Run the suite with the glob form:

```bash
node --test tests/*.test.mjs
```

Do NOT use the directory form (`node --test tests/`) — under Node 26 it
fails with `MODULE_NOT_FOUND` before running anything.

The glob form skips the plugin smoke suites (`plugins/*/test/smoke.mjs`)
that CI's bare `node --test` also runs — after touching `plugins/`, use
the parity form instead (the smoke suites need their deps first:
`node scripts/install-plugin-smoke-deps.mjs` once on a bare checkout):

```bash
node --test tests/*.test.mjs plugins/*/test/smoke.mjs
```

## Adopting (consumer repo)

**Decoupled:** copy `examples/dsh-agent-thin.yml` into
`.github/workflows/` — that is the entire consumer side (trust gate +
~20s trigger). Nothing else, no secrets. (The worker must be deployed and
list your repo in its `DSH_WORKER_REPOS`.) There is no other adoption path
for the agent loop: the legacy in-job mode (`agent-comment.yml` /
`agent-dispatch.yml` + their example shells) is removed (issue #264).

Runners labeled `dsh` (optionally `big`), runner PATH with
`node gh doppler` on the lane; write your own `REVIEW.md` (the review
contract is repo-specific).

## Versioning

Consumers pin `@v1` (moving major tag). Breaking changes bump the major.
drift-check advances `v1` to each new release it tags. There is no bare
`v` moving tag: drift-check used to advance an undocumented `v` instead of
`v1`, leaving every pinned consumer frozen on v1.0.9 through 33 releases
(issue #38) — `v` is retired. Scrubber/security fixes land as minors and
reach consumers only through a drift-check bump PR merged by each repo's
own gates + review — the audit gate. Nothing propagates silently.

### Tag re-pointing (the convention, issue #231)

A published `vX.Y.Z` release tag is only ever moved by one mechanism, and
never by this repo: the CONSUMER's bump workflow (ebowwa/factory
`dsh-agent-toolkit-bump.yml`, `tagsync` job) re-points the tag named in its
merged bump-PR title to this repo's then-current main head, so the tag is
the tree the consumer's gates reviewed. Because bump PRs can merge OUT OF
ORDER, that move can drag an older published tag forward onto a newer
release's commit — v1.97.0 and v1.98.0 both landed on 47a4f683 this way,
making the `v1.97.0..v1.98.0` range empty while its release notes described
real content. Consequences consumers must expect: (1) a per-tag range
between two adjacent releases can be EMPTY even though both release notes
describe content — diff `vA..vB` yourself before trusting the notes;
(2) drift-check itself never moves or re-cuts a published tag (the
tag-collision fence refuses a pre-existing `$NEXT`) and refuses to cut a
release at all when its scoped diff is empty (the empty-range guard, pinned
by `tests/drift-empty-range.test.mjs`) — enforced twice: the scope step's
empty flag skips the run green before any agent pass, and the tag step's
HEAD==BASE belt skips the release green when HEAD still names the commit
BASE already names. A release tag always names a NEW commit.

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
