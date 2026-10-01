---
name: conflict-recovery
description: When your branch conflicts with the dominant branch — update-branch healing vs genuine divergence, the heal-first ladder, when supersede is correct, and what lands where. Use when a PR shows dirty/mergeable:false, a review won't fire for lack of a merge ref, or after sibling PRs merged first.
---

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

## The submodule-bump exception (mechanical resolution beats supersede)

A conflict on a pure submodule-pointer PR (diff touches only the gitlink path, e.g. `gat`) is NOT "two deliberate approaches" — both sides are pointer bumps, and the correct resolution is the union. A supersede/refile here re-mints the same bump and re-races the same sibling (second-merger-wins churn). Resolve mechanically:

1. **Read both pointers**: `git ls-tree <pr-branch> <sub>` and `git ls-tree main <sub>` (base pin too, for context).
2. **Fetch the submodule repo directly** (clone it standalone — do not trust the claim workspace's submodule checkout; re-provisioned workdirs have been seen with its origin swapped to the superproject — verify `remote.origin.url` against `.gitmodules` first).
3. **Ancestry test**: `git merge-base --is-ancestor <main-pin> <pr-pin>` → if true, resolve to the PR pin (fast-forward). Symmetric case → resolve to main's pin. If they are diverged siblings off a shared base → continue.
4. **Merge the engine tips**: in the standalone submodule clone, `git merge` the two SHAs (bumps in different files merge clean; commit with a message naming both carriers), push to the submodule's default branch.
5. **Re-point and push**: merge main into the PR branch, resolve the gitlink to the merged tip (`git update-index --cacheinfo 160000,<merged-sha>,<sub>` then `git add <sub>`), commit, push. Gates re-run; land green.
6. **Close the loop**: the sibling redo issues whose scope rode the absorbed tip are done-but-open — close them with receipts naming the landed PR and the merged submodule tip.

Only use this for gitlink-only PRs. If the PR also carries superproject code, use the ladder above.

## Prevention beats recovery

- Branch off the CURRENT dominant head late (right before working, not right after reading the ticket).
- One concern per PR — broad PRs collide with more siblings.
- If your ticket's root cause got fixed by a sibling mid-flight: stop, verify the sibling's fix, ship only the residual (and say so in the body). Two agents racing one fix conflicts with EACH OTHER by construction.
