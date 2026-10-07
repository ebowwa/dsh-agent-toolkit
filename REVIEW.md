# REVIEW.md — what review checks in this repo

Review rules for dsh-bot, applied by the dsh review stage (and any human).

## Correctness

- Shell scripts pass bash -n; node scripts pass node --check (gates enforces
  both — a review that skipped gates is invalid on its face).
- A merge lands only on a gates check that is completed/success ON THE
  MERGED HEAD (issue #434): `gh pr merge` runs behind the merge guard
  (`scripts/merge-guard.sh`, armed by the driver via the gh-scrub-shim) —
  a PR whose gates run is queued, in-progress, cancelled, failed, or absent
  on its head SHA must not merge, and the guard takes ONE snapshot (never a
  poll-until-green loop). The receipt: PR #422 merged while its gates run
  sat queued and never ran — zero completed CI runs graded the head it
  landed. Since FleetTower issue #1132, an ABSENT run under the DEFAULT
  name (`gates`) means the guard grades the head by the rollup instead of
  refusing: consumer repos name their gates jobs differently, and a
  hardcoded default refused every merge on every green head of those repos
  — the fallback passes only ≥1 completed/success run ON the head SHA with
  no red conclusion on it, and an EXPLICIT `MERGE_GUARD_CHECK` keeps the
  strict assertion (no fallback). Branch protection with required status
  checks is the owner-side
  backstop; bypassing or disarming the guard to land a change is a defect
  of the same class as skipping gates.
- Workflow files pass `scripts/workflow-lint.mjs` (gates enforces it): a
  structurally invalid workflow — e.g. a step dedented out of its `steps:`
  sequence, the run-32705244305 class — parses nowhere and 422s every
  dispatch; it must never merge green again.
- Tests construct a lane-installed CLI's absence either with an explicit
  BIN seam (e.g. `DOPPLER_BIN=/nonexistent/…`) or with a fully hermetic
  PATH containing ONLY prepared shim dirs (runtime-interpolated, no
  system dir traversed, ambient PATH not re-included — the construction
  `tests/resolve-push-token.test.mjs` uses; blessed review r2 finding 5)
  — never by restricting PATH to a subset of system dirs: the dsh lanes
  install the real CLIs there, so the restriction constructs nothing —
  the test is green on a dev machine and takes the wrong branch on a
  lane (gates run 32933615526). `scripts/tests-lint.mjs` rejects the
  pattern (gates enforces it via the corpus test).
- Scrubbing is fail-closed: if the scrubber cannot run, the pipeline must
  abort rather than pass unscrubbed text onward. Any change that makes a
  scrub failure non-fatal is rejected.
- Secrets never appear in logs, comments, PR text, or workflow echoes.
  Env names must avoid KEY/PASSWORD/SECRET/TOKEN patterns in agent-visible
  contexts.
- Credentials never ride argv anywhere: a token passed as a git `-c`
  value, a curl `-H` header, or any command-line argument is rejected —
  argv is ps-readable to same-user processes on shared boxes. Env-based
  git config (`GIT_CONFIG_COUNT`), header-file curl config, and
  `.git/config` extraheaders are the sanctioned seams (this rule was
  earned on the resolve-push-token review rounds).

## Decoupled worker

- The worker scripts (`dsh-worker.sh`, `ship-changes.sh`, `post-reply.sh`,
  `review-pr.sh`) are shared with the CI flow where behavior overlaps; a
  change to one mode that silently drifts the other is a defect. Their env
  contracts must keep the DSH_*/GITHUB_* fallback shape so both callers
  work.
- Queue labels are NOT a trust mechanism: `dsh/queued` must only ever be
  acted on after the worker re-derives the trigger's trust from the
  comments API. A worker change that trusts the label alone is rejected.
- Reviews are queue items too (`dsh/review` via `agent-review-thin.yml`):
  this repo's own review path must not dispatch a runner-holding review
  workflow (`agent-review.yml` on `[self-hosted, dsh]`) — reviews run on
  the worker or in-session. Reintroducing a runner-holding review shell
  for dsh-bot itself is a defect.
- The worker review must never auto-approve: verdicts are label actions
  ONLY from `review-verdict.mjs`'s line-strict parse; an absent or
  unparseable verdict sets NO labels and must surface for a human. The
  rules contract is read from the PR's BASE ref — a PR must not be able to
  edit the REVIEW.md that grades it.
- Independent verification of a sibling PR rides the `gate-verify:`
  comment channel (issue #326): the fleet mints every PR under one shared
  account, so `gh pr review --approve` is structurally impossible for any
  agent — the verifying agent posts a PR comment whose line
  `gate-verify: pass` (or `gate-verify: fail`) IS the verification,
  parsed line-strict by `scripts/gate-verify.mjs` (label REQUIRED — a
  bare `pass` line in prose never qualifies) and aggregated per PR by
  `scripts/pr-verification.mjs` (last marker wins; comment bodies never
  pass through — only verdict + id/author/URL). The marker is evidence,
  never an auto-approval: labels still come only from `review-verdict.mjs`,
  the review stage receives prior markers as CLAIMS to check (an
  unreproducible claim is a finding, the honesty rule), and the merge
  guard weighs the channel only when explicitly armed
  (`MERGE_GUARD_VERIFY=on`) — an unarmed guard is gates-only, so comment
  markers can never block or green-light a merge silently. The shipper is
  deliberately NOT a consumer: its window closes at PR creation, while
  verification attaches to an already-open PR.

## Workflow discipline

- Workflows state their runner-lane impact in a comment when it changes.
- Reusable workflows run in the CALLER's context: caller's runners, token,
  secrets — anything consumed from the caller must be declared an input,
  never assumed present.
- Task/comment text reaches bash through env, never raw ${{ }} interpolation
  (injection seam — this repo fixed it once; do not reintroduce it).

## Honesty

- PR descriptions state what changed and what was NOT verified.
  Overstatement is a blocking defect, same as a bug.
- Evidence counts are pasted from the run's own summary block, never
  transcribed by hand (issue #433): a PR's "Tests / evidence" section
  quotes the runner's printed summary block — its `tests` / `pass` /
  `fail` / `skipped` lines (node --test emits them at the end of every
  run; `#`-prefixed TAP or `ℹ`-prefixed spec, depending on the
  reporter/node version — issue #556) — instead of a hand-written "N/N
  pass" claim. Hand-transcribed counts describe an
  earlier revision of the suite — the PR #415 receipt: the merged body
  said 5 pass / 6/6 / 446 where the tree it merged ran 8 tests / 497.
  A count that overstates is a blocking defect under the rule above;
  one that understates is non-blocking but still a defect to correct —
  a merged PR's evidence section is the record later bisects trust
  against.
- Failures surface as typed errors with context; no swallowed exits.
