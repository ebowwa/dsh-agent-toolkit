---
name: redo-carries-review-findings
description: When redoing a PR that was closed unmerged with a review verdict (not merely conflicting), fetch the predecessor's reviews FIRST and carry every blocking finding into the redo diff. Use when minted "Redo at current main" tickets name a superseded or conflicted predecessor.
---

# Redo carries review findings (never re-derive past a verdict)

A redo of a reviewed-and-closed PR starts from the predecessor's review
state, not from zero. Dropping blocking findings re-earns them in round two.

## Procedure

1. **Fetch the predecessor's reviews before re-deriving**:
   `gh pr view <pred> --json reviews` — read every finding, blocking or not.
2. **Classify each finding**: if blocking (CHANGES_REQUESTED substance), the
   redo diff must carry the FIX — e.g. the dated amendment section, the
   renamed identifier, the added guard the finding names. Cosmetic-only
   findings may be noted and skipped, in writing.
3. **Verify the fix shape against the finding's own terms**: quote the
   finding in the PR body and answer it line-by-line ("finding X addressed
   at <file>:<line>").
4. **If the verdict was approval-quality** (zero blocking findings and the
   close was conflict/supersede only): pure re-parent is correct — replay the
   diff onto current main, run the compare against the dead base to predict
   conflicts, never rewrite the approach.
5. **Say what carried over in the PR body** — a "carries findings from #N"
   line with the dispositions. Reviewers then verify the carry, not the
   whole history.

## Pitfalls

- "Closed unmerged" has two flavors: CONFLICT-supersede (redo may be a
  re-parent) vs REVIEW-blocked close (redo must carry fixes). Read the close
  reason and the review thread before choosing.
- A predecessor whose findings were fixed on its branch AFTER the close
  (amendment commits) — fetch the branch tip, not the reviewed sha.
