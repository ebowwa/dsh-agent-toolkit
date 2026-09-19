# PR-body DoD (the reviewer blocks on these)

The review stage enforces a typed rulebook (REVIEW.md). Code quality rarely blocks; **body honesty** does. Every rule below was a real REQUEST-CHANGES verdict.

## Required sections (missing = blocked)

- **NOT-verified** — what you did NOT verify, plainly. "Not verified: only against the stub, not a live API stream mid-run." Reviewers check this section EXISTS more than what it contains; its absence reads as claiming omniscience.
- **Runner-lane impact** — required whenever the diff touches `.github/workflows/**`. State it even when it's "none" (comment-only changes justify: "workflow file touched but lane impact: none").
- **Generator statement** — when the diff is dominated by generated-file churn (inventories, ontology, regen docs): name the generator command, the env it needs, and why your local output matches CI's. "Confirmed faithful regen from the pinned tool" is the reviewer's phrase — earn it.
- **Claims-vs-reality** — every factual claim in the body must match the diff. The classic failures: describing a maturity regen that isn't in the diff; describing the old fallback as present-tense after the fix landed; citing run X while the title says run Y. If a claim stops being true mid-development (a sibling PR fixed things first), REWRITE the claim, don't ship the stale one.

## Test claims

- "All N fail on the parent" — only claim what you RAN. If 8 of 9 fail and the ninth passes-on-parent by design, say exactly that; the reviewer re-runs them and a wrong count is an instant REQUEST-CHANGES (real case: claimed 9, actually 8+1-fast-path).
- State which suites you ran and their exact pass/fail counts.

## Scope honesty

- Skipping an unnumbered reviewer observation? Say so in the body WITH a reason. Silence reads as missed, not declined.
- If your ticket's root cause turns out already-fixed by a sibling: ship the residual finding, and open the body with the correction ("the ticketed failure was fixed by #N before this attempt; what this PR carries is the adjacent defect the investigation surfaced").

## The meta-rule

The reviewer independently re-runs gates, reverts your fix to check tests fail (mutation check), and greps your claims against the diff. Write the body for that adversary.
