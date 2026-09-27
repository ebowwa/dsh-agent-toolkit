---
name: factory-arch-conformance
description: The github-activity-tracker's mock-first layer rules — primitives/1o/2o/3o boundaries, barrels, the arch probe, and where new code actually goes. Use when writing code in the factory repo, choosing a file location, or when `bun run arch` fails.
---

# Factory arch conformance

The factory repo is **mock-first and layer-bound**; `bun run arch` enforces it at every gate. The layers, what belongs where, and the traps:

## The layers (a module may never import HIGHER)

- **`primitives/`** — pure canonical data + pure folds. No I/O, no business logic, no Octokit. May import only primitives.
- **`1o/`** — the pipeline spine + `integrations/` (ports + live/mock adapters), `processing/`, `phases/`. Phases are DUMB and idempotent — no transition logic (the orchestrator owns transitions).
- **`2o/`** — `orchestrator/` — the state machine that controls 1o.
- **`3o/`** — measurement over the running system; may import anything below.
- **Adapters (cli/ web/)** — presentational side effects only (spinners, cache, DOM, SQLite).

## Where new code goes (the decision that trips agents)

1. Pure decision logic (a rulebook, a fold, a classifier)? → `primitives/` — NEW FILE, 1-file-1-concern, exported through the per-directory `index.ts` barrel, never deep-path imports.
2. A GitHub call? → widen the port interface (`1o/integrations/.../client.ts`) + implement in the live client + **mock parity in the same PR** (`implements GHClient` is compiler-enforced — the mock, both cassettes, and every test double must grow the method together).
3. A decision ABOUT when/what to run? → the orchestrator (2o), not a phase.
4. Test fixtures go in the test tree; cross-tick scratch goes on `ctx.state.data`, never module memory.

## Common arch failures

- Importing from a deep path (`@gh-tracker/core/lib/...`) instead of the public barrel — the probe flags it.
- A primitive gaining an `await` or an octokit reference — move the I/O to 1o, keep the fold pure.
- A phase growing `if (state === X) transition(...)` — that belongs to 2o.
- Forgetting mock parity on a port widening — typecheck fails across the test doubles; fix ALL of them in the same commit.

## The gates

`bun run typecheck && bun run test && bun run arch` (+ `bun run lint` — core+cli+web, pre-existing `any`s warn, don't add to them). The review stage re-runs all of them AND mutation-checks your tests. The branch model is the convergence policy (`docs/decisions/2026-08-23-branch-convergence-policy.md`): ship from `dsh/*`, land reviewed PRs on `main`; hold-ups only as `wip/<reason>` — the scaffolding/dev split it replaced is retired (shapes still don't pivot mid-PR; see the "DO NOT PIVOT" rules in CLAUDE.md).
