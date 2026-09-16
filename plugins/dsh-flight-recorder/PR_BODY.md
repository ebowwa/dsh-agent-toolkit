# PR body (draft — deepseek-ai/deepseek-harness)

**Title:** feat(jobs): durable job events written to the owner session

## Summary

The jobs registry now records its own lifecycle as log-only SessionEvents on
the owner's session:

- `job/spawn` — at admission (after the record is registered and cannot fail).
- `job/status` — non-terminal transitions (`stopping` on kill and on owner
  teardown).
- `job/done` — settlement with the producer outcome (status, detail,
  final output for final-output kinds).
- `job/output` — every delta a consuming read returns.

No new package, no mount row, no runtime dependency: the emission lives in
`jobs-local` at the exact points where the facts exist, and reaches the
owner's session through the `Agent` the registry already receives
(`owner.session.append`). Unowned jobs have no session to write to and
record nothing. Payload types are owned by the jobs contract package
(`@deepseek-ai/dsh-jobs/types`, now exported) via `SessionEventMap`
declaration merging; the persistence catalog and `known-event-types` are
regenerated.

## Deliberate design lines

- **Append failures are logged and contained.** Job events are log
  completeness — an append failure never fails admission, settlement, or a
  read.
- **The owner-visible read is untouched.** `job/output` records exactly the
  delta the read returned; read returns and completion notices are unchanged
  (asserted in tests).
- **A stream job's unread tail is not captured.** The output cursor is
  single and consuming; draining it would empty the owner's own
  post-settlement readback. Settlement still carries the producer outcome's
  detail.
- **Unowned jobs record nothing** — there is no session to write to.

## NOT-verified

- Not verified against live session-storage I/O mid-run: the tests use
  detached sessions (`Session.create`), so append interaction with the
  persistence coordinator's buffering under concurrent settlement is
  untested.
- Not verified on Windows.
- The `settle` path appends before completion-listener delivery; ordering
  against a listener that itself appends to the same session in the same
  tick is untested.

## Gates run (local)

- `pnpm run build:lib:host` — passes.
- `tsc -b packages/jobs/jobs-local` — clean.
- `vitest run packages/jobs` — 6 files, 127 tests, all pass (4 new specs in
  `jobs-local/tests/durable-job-events.spec.ts`).
- `vitest run packages/core/session packages/bundle/base` — all pass
  (session 626-line suite and base composition spec unaffected).
- `oxlint` on `packages/jobs` + `packages/core/session` — 0 errors.
- `gen-persistence-catalog --check` — passes.

## Scope note

Loader/plugin-layer activity is intentionally OUT of this PR: the
per-fiber event volume (thousands per session attach) belongs in a
telemetry-seam discussion, not in the durable session log. A follow-up can
propose that seam separately.
