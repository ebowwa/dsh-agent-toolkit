# HYGIENE.md — messiness audit of dsh-bot and github-activity-tracker

Surveyed 2026-09-16 (unattended survey agent); cleanup executed the same day.
**No remote pushes; no branch deletions.** All findings cite exact commands
and captured output.

## Cleanup execution status

| Item | Status |
|---|---|
| dsh-bot: remove ghost `gat2/` ignore + README test-invocation note | **DONE** — commit `4cb624e`; tests re-run: 190/190 pass |
| dsh-bot: TODO sweep | **DONE (no-op)** — all 8 grep hits are `XXXXXX` in `mktemp` templates, i.e. false positives; nothing actionable |
| gat: branch triage | **DONE** — `BRANCHES.md` committed (`1af1ce0`); 13 branches provably merged (safe-to-delete), 7 with unique commits; NOTHING deleted |
| gat: land dbg-sweep | **DONE** — merged `dsh/notebooks-dbg-sweep` into local main as `4728cdc` (no conflicts); full `bun run test` green post-merge |
| gat: collapse duplicate smoke scripts | **DONE (corrected finding)** — no duplication exists; the root `scripts/` never contained smoke scripts, root npm scripts already point at the single canonical copies in `cli/repositorytracker/scripts/` |
| gat: README PATH note | **DONE** — in commit `1af1ce0` |

### Left for user decision

1. Delete the 13 merged `dsh/*` branches (see gat `BRANCHES.md` — one
   `git branch -d` command).
2. The 5 stale unmerged gat branches (`gist-scaffold-target`,
   `queued-claim-ttl`, `ram-probe`, `review-claims-native`,
   `self-hosted-only`) — rebase or drop; two reference open issues (#447, #680).
3. dsh-bot legacy workflow mode removal (next major) — deliberate, needs
   sign-off.
4. cordis-plugin greenfield (gat as a dsh plugin) — never started; a new
   project, not a cleanup.
5. The dbg-sweep merge exists on LOCAL main only — pushing is the user's call.

---

## Repo 1: `/Users/ebowwa/Developer/dsh-bot`

### What it is

The reusable agent-loop toolkit: comment-triggered `/dsh` coding agents,
adversarial review stage, deterministic shipper, output/input scrubbing —
shipped as GitHub **reusable workflows** that consumer repos adopt with
~15-line event shells. Two modes: decoupled (worker out-of-band, recommended)
and legacy (agent inside the Actions job). Entry points: `.github/workflows/*`,
`scripts/dsh-worker.sh`, `scripts/run-dsh-agent.sh`. No package.json — it is
a pure shell/Node-script + workflows repo; its "test suite" is `node --test tests/`.

### Current state

- Branch `main`, working tree **clean** (`git status --short` → empty).
- `git log --oneline -15`: healthy, recent work is the dsh-flight-recorder
  plugin import (`fd7610d`, `e57d3c3`) and BOT_PAT → TOWER_PROBE_PAT renames.

### Test suite: PASSING

```
node --test tests/*.test.mjs
ℹ tests 190   ℹ pass 190   ℹ fail 0   (56s)
```
(`node --test tests/` — directory form — **fails** with `MODULE_NOT_FOUND`
under Node v26.4.0; the glob form `tests/*.test.mjs` is the correct
invocation. Minor footgun, not a product bug.)

### Messiness findings

1. **`.gitignore` names a ghost: `gat2/`** — the only line in `.gitignore`
   (`cat .gitignore` → `gat2/`). The directory does not exist anywhere
   (`ls examples/gat2` → No such file or directory). Evidence of a scratch
   copy of github-activity-tracker that was made and deleted but whose
   ignore entry stayed. Low priority; harmless but confusing.
2. **TODO/FIXME density: very low.** `grep -rEc "TODO|FIXME|HACK|XXX"`
   over scripts/workflows: only 4 files, 8 hits total
   (`resolve-push-token.sh` 2, `run-dsh-agent.sh` 4, `drift-check.yml` 1,
   `agent-review.yml` 1) — and spot-checks show most are regression-anchor
   prose, not open work. Nothing actionable.
3. **No dead scripts.** All 16 entries in `scripts/` are referenced from
   the README's shared-files table, and all 18 files in `tests/` map to a
   script or workflow. No orphans found.
4. **Shebangs/exec bits: clean.** Every script in `scripts/` has a shebang
   and is `-rwxr-xr-x`; the audit loop produced zero NOSHEBANG lines.
5. **Root hygiene: clean.** Root holds only `.gitignore`, `README.md`,
   `REVIEW.md` + the six intended directories. Nothing belongs elsewhere.
6. **Legacy mode is scheduled removal, not rot**: `agent-comment.yml`,
   `agent-dispatch.yml`, `agent-review.yml` (and matching `examples/`) are
   documented as "removed at the next major version" (README). That is a
   planned cleanup item, not accidental mess.

### Prioritized cleanup plan (each ≈ one commit)

| # | Item | Effort |
|---|---|---|
| 1 | Remove the stale `gat2/` line from `.gitignore` | 2 min |
| 2 | Document in README that tests are invoked as `node --test tests/*.test.mjs` (or add a tiny runner script) so the directory-form failure doesn't bite | 10 min |
| 3 | Sweep the 8 TODO/FIXME hits: convert real ones to issues, delete stale ones | 30 min |
| 4 | Execute the planned legacy-mode removal (`agent-comment.yml`, `agent-dispatch.yml`, `agent-review.yml` + legacy examples + README rows) at next major | half a day |

**Overall: this repo is NOT messy.** Tests green, tree clean, structure
intentional. The user's "got a bit messy" impression most likely attaches
to repo 2 below, or to the sheer number of `dsh/*` branches (see gat).

---

## Repo 2: `/Users/ebowwa/Developer/github-activity-tracker`

### What it is

A work-record system for the whole ecosystem: every repo on disk, forge
accounts, runners — GitHub as one structured source, not the subject. Bun
(≥1.3) workspaces monorepo: `packages/core` (shared logic), `cli/repositorytracker`
(`gh-tracker` CLI), `web` (Vite + React dashboard with Vercel API routes).
Note: the dispatch tower already lives in its own repo (`FleetTower`,
extracted 2026-09-05).

### Current state

- Branch `dsh/notebooks-dbg-sweep` (tracks origin), working tree **clean**
  (`git status --short` → empty).
- **2 commits ahead of `origin/main`** (`git rev-list --left-right --count
  origin/main...HEAD` → `0 2`): `4577e08` "notebooks: sweep the six dbg
  scratch scripts" and `212366e` "notebooks: every generated umbrella opens
  with its place on the shelf". This unmerged branch is the main "open"
  item — the sweep the branch name promises is committed but not landed.
- **16 local `dsh/*` branches** not on origin's main listing
  (`dsh/done-marker-custody`, `dsh/gates-hotfix`, `dsh/review-claims-native`,
  `dsh/queued-claim-ttl`, …). This is almost certainly what the user meant
  by "messy" — a pile of agent-created branches of unknown merge status.
- `notebooks/dist/` is **gitignored** (generated), `notebooks/legacy/` +
  `notebooks/parts/` are tracked (~100 files) — intentional per the
  notebooks work.

### Test suite: PASSING (all three workspaces)

```
bun run test   # = test:core && test:cli && test:web, chain exit 0
packages/core:          1640 tests, 114 files, 0 fail (18s)
cli/repositorytracker:   548 tests,  42 files, 0 fail (133s)
web:                      31 tests,   4 files, 0 fail (0.4s)
```
(Note: `bun` is NOT on the default PATH of a fresh shell — `bun: command
not found` until `export PATH="$HOME/.bun/bin:$PATH"`. Wrapper scripts and
agents hit this; the repo's preflight presumably handles it.)

### Messiness findings

1. **The `dsh/*` branch pile** (16 branches). Some names suggest merged
   work (`dsh/gates-hotfix`, `dsh/no-comment-triggers`); others may be
   abandoned. Needs a triage pass: `git branch --merged origin/main` →
   delete; the rest → inspect or open tracking issues. *This is the single
   biggest messiness item in either repo.*
2. **Unmerged 2-commit branch** `dsh/notebooks-dbg-sweep` — land it (PR or
   direct merge after gates) to close the loop its own commits opened.
3. **`.env` and `doppler.yaml` are 0600 and untracked** (correct!), but
   `.env` contains a live `GITHUB_TOKEN` (file header says "managed via
   doppler secrets get"). No leak — just noting the credential sits in the
   working tree; `git check-ignore .env` confirms it's ignored.
4. **TODO/FIXME density: low.** Excluding `node_modules`, ~18 hits across
   core/cli/web/scripts — e.g. `packages/core/src/test/primitives/tower/issue-policy.test.ts`
   (4), `.../tickets.ts` (3), `intake.ts` (2). Background noise, not debt.
5. **No stale-dep drift found**: `bun.lock` present, `node_modules` hoisted
   (237 entries), workspace deps (`@octokit/*`, `date-fns`, eslint 9,
   typescript ~5.9.3) all consistent between manifests and lockfile.
6. **Minor duplication**: `scripts/smoke-store.ts` / `scripts/smoke-live.ts`
   re-export from `cli/repositorytracker/scripts/` (root-level `smoke:*`
   npm scripts point at the CLI copies; the `scripts/` copies are thin
   aliases). Harmless; could be collapsed into one location.

### The cordis-plugin question

**It was never started.** Evidence:

- `grep -rni "cordis"` across the repo (excluding node_modules/.git) hits
  only **two files**, both incidental mentions of the *dsh harness's*
  `cordis.patch.yml` (dsh's own config mechanism), not any plugin code:
  - `docs/build/dsh-agent-bot.md:274` — "the headless profile's
    `cordis.patch.yml` (or a `--patch` overlay…)"
  - `packages/core/src/runtimes/any/primitives/repos/versions.ts:168` —
    "the upstream-clone noise class (clones of cordis, bun, …)" (cordis as
    an example of an upstream repo, not a plugin target).
- `find . -name "plugin.json" -o -name "*.cordis*"` (excluding node_modules)
  → **zero results**.
- The actual dsh-harness integration that DOES exist: 13 in-repo skills at
  `.dsh/skills/` (`ship-and-exit`, `pr-body-dod`, `gh-cli-techniques`,
  `conflict-recovery`, …) and `scripts/bump-dshbot-pins.sh` (keeps this
  repo's dsh-agent-toolkit workflow pins tagged).

If the cordis-plugin idea is revived, the natural shape would be packaging
`.dsh/skills/` + the `gh-tracker` CLI as a dsh plugin — that is greenfield
work, nothing to migrate.

### Prioritized cleanup plan (each ≈ one commit)

| # | Item | Effort |
|---|---|---|
| 1 | Triage the 16 `dsh/*` branches: delete merged ones, open issues for the rest (`git branch --merged origin/main` as the first cut) | 30–60 min |
| 2 | Land `dsh/notebooks-dbg-sweep` (2 commits) via the repo's normal gates/PR flow | 15 min + CI |
| 3 | Collapse the duplicate smoke scripts (`scripts/smoke-*.ts` vs `cli/repositorytracker/scripts/`) | 20 min |
| 4 | Add a README note that `bun` must be on PATH (`~/.bun/bin`) for the root scripts | 5 min |
| 5 | Sweep the ~18 in-source TODO/FIXME hits | 1 h |

**Overall: the code is healthy (2,219 tests green, clean tree, no dep
drift); the messiness is branch-level**, which no test suite can see —
consistent with the user's impression.

---

## Cross-repo summary

| | dsh-bot | github-activity-tracker |
|---|---|---|
| Working tree | clean | clean |
| Tests | 190/190 pass | 1640 + 548 + 31, all pass |
| Biggest issue | legacy-mode removal is pending (planned) | 16 stale `dsh/*` branches + 1 unmerged branch |
| Cordis plugin | n/a | never started; only doc mentions |
| Est. total cleanup | ~1 h (excluding major-version legacy removal) | ~2–3 h |
