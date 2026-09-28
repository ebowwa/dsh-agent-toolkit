---
name: submodule-part-race-check
description: Before editing a "part"-scoped ticket whose work lives in a submodule (or mirrors an open sibling PR), diff-check the live submodule main and open-PR census, and after building a commit, git-diff against any existing carrier branch to detect tree-identical duplication BEFORE pushing. Use whenever a claim touches a submodule-pinned rule/row or a redo-of-a-redo.
---

# Submodule part race check (detect the duplicate carrier before you push)

Distilled from the factory gate-env receipt saga (2026-09-28): seven "part"
attempts churned on one ticket because peers landed/merged mid-flight and
every attempt rebuilt the same tree. The check costs two `git diff`s.

## Procedure

1. **Pre-flight census** (before editing): `gh pr list` in the submodule repo
   for rows/rules touching your file; note every open PR's head sha.
2. **If a peer PR merged mid-work**: `git show origin/main:<file>` to verify it
   already covers your acceptance. If yes, close your duplicate with
   `gh pr close N` and post the done marker citing the existing PR — do NOT
   push a duplicate head.
3. **On the consumer repo**, bump the gitlink to the merged sha only; never
   re-edit files the submodule already owns.
4. **Post-build dedupe**: compare your commit to every pre-existing dispatch
   branch for the same ticket — `git diff <carrier-branch-sha> HEAD`. If EMPTY,
   the tree is identical: post the done marker citing the existing PR instead
   of pushing a duplicate head.

## Guardrails

- Re-run the census immediately before `git push` — the race window is the
  whole session, and peers merge during it.
- A done marker pointing at a PR that later goes DIRTY does not re-open your
  part: check the marker's target state before assuming the slot is free.
