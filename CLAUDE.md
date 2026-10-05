# CLAUDE.md — orientation for working in dsh-agent-toolkit (dsh-bot)

This repo is the **reusable agent-loop toolkit**: comment-triggered `/dsh`
coding agents, the adversarial review stage, the deterministic shipper, and
enforced output/input scrubbing — shipped as reusable `workflow_call`
workflows that consumer repos adopt with ~15-line event shells. It is a
scripts-only repo: **no build, no root `package.json`** — scripts and tests
run straight off the tree on Node.

## The rules

- **Work lands on `main` via reviewed PR.** `gates.yml` fires on every push
  to `main` and every PR (job `gates`, self-hosted `dsh` cell, 10-minute
  timeout). The main-side run fired by the merge push itself is the
  authoritative grade (issue #431): a PR-level `gates` check still
  pending at merge time is accepted, not an incident — the self-hosted
  cell can lag for hours, and the merged tree is graded by the main-side
  run either way. This classifies the merge-time signal only; the
  run-them-before-pushing rule below is unchanged.
- **The gates are the CI steps — run them before pushing:**
  1. Every script parses: `node --check` for `.mjs`/`.js`, `bash -n` for
     shell (gates runs both over `scripts/`).
  2. Every workflow YAML parses for real: no tabs, structural lint via
     `node scripts/workflow-lint.mjs`, and no plain scalar with colon-space
     in a step name. An invalid workflow does not error — GitHub silently
     fails its registration and every dispatch 422s.
  3. Unit tests: bare `node --test` in CI; locally use the glob form
     `node --test tests/*.test.mjs`. Do NOT use the directory form
     (`node --test tests/`) — under Node 26 it fails `MODULE_NOT_FOUND`
     before running anything. The glob form also SKIPS the plugin
     smoke suites — bare discovery runs every `test/` directory too,
     a shell glob does not — so after touching `plugins/`, verify with
     the parity form
     `node --test tests/*.test.mjs plugins/*/test/smoke.mjs`, the
     exact set CI grades (issue #301). The plugin smoke tests need the
     `@deepseek-ai/*` / `@local/*` dep install first — on a bare clean
     checkout run `node scripts/install-plugin-smoke-deps.mjs` once (it
     converges the peer closure, installs once, and verifies the tree;
     reruns are no-ops); without it those smokes fail environmentally,
     not substantively.
     **Inside an agent session, gate with the bounded runner**
     (`node scripts/test-gate.mjs`, issue #398): the bare invocation has
     no per-suite bound, so one suite wedged by an ambient seam holds the
     whole gate until the cell's external kill with zero diagnostics. The
     bounded runner grades the same suites with a per-suite watchdog
     (`DSH_TEST_GATE_TIMEOUT_S`, default 120s) and reports HANG with the
     pinpoint recipe — a suite that cannot run hermetically fails loud
     naming the seam, never hangs the gate.
- **Review findings cite rules.** `REVIEW.md` is this repo's review
  contract; the review stage reads it (and this file) as ground truth, and
  every finding must cite a rule from it. The review contract is
  repo-specific: write your own `REVIEW.md`, don't inherit one.
- **Scrubbing is fail-closed.** If the scrubber cannot run, the pipeline
  must abort rather than pass unscrubbed text onward; a change that makes a
  scrub failure non-fatal is rejected (REVIEW.md).
- **Tests are contract pins, not just coverage.** `tests/*.test.mjs` pin
  the workflow run-blocks, the driver's stamped agent contracts, and the
  lint patterns (`scripts/tests-lint.mjs` rejects PATH assignments that
  hard-code system dirs and spawns of the driver without a pinned retry
  backoff). A behavior change without a pin is an unowned change.
- **One execution mode: decoupled.** The trigger workflows
  (`agent-comment-thin.yml` + friends) ack + enqueue; the agent, shipper,
  reply, and review run on the out-of-band worker (`scripts/dsh-worker.sh`).
  The legacy in-job agent mode (`agent-comment.yml` / `agent-dispatch.yml`,
  the 120-min runner-holding job) is removed (issue #264); the thin
  triggers + the worker are the only agent execution path.

## Where things live

- `README.md` — the file map: every workflow, script, plugin, and config
  file with its purpose; testing, adoption, versioning.
- `CONTRIBUTING.md` — agent conduct: the discovery protocol (`found:` issues
  with receipts, never silent scope-creep), issue relationships, branch
  hygiene, workdir hygiene (issues #333/#374 — random mint, recorded-path
  re-entry, owner-marker belt), exit-summary shapes. Stamped into every
  dispatched task by `scripts/run-dsh-agent.sh`; pinned by
  `tests/agent-contract.test.mjs`.
- `REVIEW.md` — the review rules the adversarial review stage applies.
- `.agents/` — the standing agent contracts the driver stamps into tasks;
  `docs/decoupled-worker.md` — the worker's queue semantics and trust model.
- `config/` — settings template, model catalog, lane-plugin manifest, fleet
  manifest; `examples/` — consumer copy-paste workflow shells.
