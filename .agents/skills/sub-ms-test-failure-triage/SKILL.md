---
name: sub-ms-test-failure-triage
description: A test that fails with a sub-millisecond reported duration is a fixture-spawn death (runner/parallelism casualty), not an assertion race. Use when a suite fails intermittently under full-suite or machine load but passes in isolation, or when failure durations look impossibly fast.
---

# Sub-ms test failure triage (read the duration first)

A failing test whose reported duration is <5ms did not run its body — the
fixture spawn died before the test began. Treating that as an assertion race
or a product bug sends the fix to the wrong file.

## Procedure

1. **Read the reported duration first.** Sub-ms = the test never executed;
   the harness printed the failure row for a spawn that died. Skip the diff.
2. **Prove the runner's parallelism model empirically**: run the suite at the
   observed failing concurrency vs `-j 1` / single-file runs. If isolation is
   green and only parallel loads fail, the suite outgrew the runner's
   concurrency (shared ports, tmpdirs, DBs, or process-wide singletons).
3. **Find the shared resource the fixtures collide on** — fixed ports, shared
   tmp paths, env vars, global singletons. Fix at the fixture (dynamic port,
   per-worker tmpdir), not in the test body.
4. **Guard it**: add the collision to the suite's own watchdog/serialization
   only where a real ordering requirement exists; otherwise fix the fixture
   isolation. Never "fix" by retrying the test — retries launder the race.

## Pitfalls

- A wholesale-red suite (every test failing at once) with sub-ms durations is
  usually ONE fixture/infra dependency dying at setup (network fetch, missing
  build artifact), not N independent bugs.
- Load-order flake in CI-only: reproduce with the CI runner's core count, not
  your local default.
