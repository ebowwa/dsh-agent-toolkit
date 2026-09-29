---
name: pin-twin-compose-verification
description: Bump a consumer repo's submodule/gitlink pin when the pin base has diverged from the target repo's main (open-PR pin stack) — compose the pin by cherry-picking onto the current pin base instead of fast-forwarding, prove the compose was necessary with a negative control, and publish the composed tree as a twin PR so CI judges the exact consumed commit. Use whenever a gitlink bump would otherwise drag unrelated main-side commits into the consumer's build.
---

# Pin-twin compose verification (bump the pin, not the branch tip)

Distilled from a factory pin-twin investigation (2026-09-29): a naive gitlink
bump to a merged fix's branch tip silently pulled in main's divergence, and the
consumer gate went red for reasons the ticket never mentioned. The pin you
commit is a tree, not a label — it must contain exactly what you verified.

## Procedure

1. **Classify the pin before touching the gitlink**:

       git merge-base --is-ancestor <current-pin> origin/main && echo ff-ok

   - Ancestor ⇒ the pin fast-forwards; bump straight to the target tip.
   - Not an ancestor ⇒ the pin carries content main does not have (an open-PR
     pin stack). A naive trunk bump strands that content — compose instead.

2. **Compose**: `git checkout --detach <current-pin>` then
   `git cherry-pick <fix-commit>` (or re-apply the delta), and commit THAT tree
   as the pin. Never pin the fix's branch tip — it drags main's divergence in.

3. **Negative control as your receipt**: run the consumer's typecheck/tests
   against a checkout of the raw branch tip. A red consumer file proves the
   divergence was real and the compose was necessary — keep that output in the
   carrier PR.

4. **Publish the composed commit as a twin**: push it to a pinbase twin branch
   in the TARGET repo and open a PR there, so the target repo's own CI runs
   against the exact tree the consumer will consume. Pin the consumer gitlink
   to the twin head.

5. **Disclose residual risk**: if the twin PR is not yet merged when the
   consumer lands, note the open-head pin in the carrier's NOT-verified section
   so the next pin-bump knows to re-check.

## Guardrails

- One pin bump = one composed tree = one twin PR. Two consumers bumping the
  same submodule concurrently must reconcile pins (superset check: the winning
  pin must contain the loser's delta) before both merge.
- If the fix is already an ancestor of the current pin, do nothing — a no-op
  bump that rewrites the gitlink for appearance's sake is churn, not work.
