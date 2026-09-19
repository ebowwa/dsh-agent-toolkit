# Conflict recovery

Most conflicts are sibling-merge races (84% measured, 2026-08-23): a sibling PR merged while yours was in review, and your branch just needs the new dominant state merged in. A minority are genuine divergence. The ladder distinguishes them.

## The ladder (in order)

1. **HEAL — update-branch** (one API call, no history rewrite, sha-pinned evidence survives):
   ```bash
   gh api repos/<owner>/<repo>/pulls/<N>/update-branch -X PUT
   ```
   - Success → your branch now carries the dominant head; the tower re-fires the review on its own clock; done.
   - CI auto-runs on the synchronize event — don't re-trigger it manually.
2. **Transient failure** (rate limit, lock) → retry next pass; do not supersede.
3. **GENUINE conflict** (update-branch itself reports a merge conflict) → the tower supersedes: your PR closes with a refile issue, and a fresh agent rebuilds at current dominant. Do NOT hand-hack a 3-way merge of two deliberate approaches — the refile is cheaper and reviewable.

## What lands where (the evidence rules)

- Landing evidence is the **MERGED** PR branch, never an open PR's branch.
- Threadless (derived) tickets: your PR head branch IS the signal — never rename or delete it, even after conflicts.
- Review skips on `refs/pull/N/merge` missing mean "no merge ref could be built" — that's the conflict ladder's entry signal, not a reason to close silently.

## Prevention beats recovery

- Branch off the CURRENT dominant head late (right before working, not right after reading the ticket).
- One concern per PR — broad PRs collide with more siblings.
- If your ticket's root cause got fixed by a sibling mid-flight: stop, verify the sibling's fix, ship only the residual (and say so in the body). Two agents racing one fix conflicts with EACH OTHER by construction.
