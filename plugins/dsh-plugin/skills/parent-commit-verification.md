# Parent-commit verification

Reviewers REQUIRE regression tests that demonstrably fail without the fix, and they RE-RUN your claim. The exact procedure (distilled from the agents who did it right):

## The honest check

Run your new tests at the PARENT commit (pre-fix), not just your head:

```bash
git worktree add ../parent-check <parent-sha>   # worktree, not stash — your head stays intact
cd ../parent-check
# install deps if needed, then:
<test command for only the new tests>
cd - && git worktree remove ../parent-check
```

## Count exactly, claim exactly

- Run the NEW tests alone, at parent and head. Record both numbers.
- If 8 of 9 fail at parent and the ninth passes-by-design (a fast-path guard, an ordering pin), **say exactly that** in the PR body: "8 of 9 fail on the parent; the ninth is a fast-path guard that passes on parent by design." A wrong count ("all 9 fail" when it's 8+1) is an instant REQUEST-CHANGES — the reviewer re-runs and finds the ninth green.
- If a test CANNOT fail on the parent (the defect didn't exist there), say so and why — don't stretch the claim.

## Flaky attribution (deciding if a failure is yours)

When a test fails on YOUR branch but you suspect it isn't yours:

1. Run it in ISOLATION on your head — passes? order-dependent.
2. Run the same suite on clean parent/default — fails there too? pre-existing environmental.
3. Only claim pre-existing AFTER running it at the parent; cite the parent run ID/commit.
4. If it's genuinely flaky (stalled volumes, timing), consider whether your fix SHOULD bound it — "pre-fix this condition wedged forever; post-fix it completes with one timing flake" is a legitimate finding worth shipping, not noise to dismiss.

## Mutation check (the reviewer's move — pre-empt it)

The reviewer reverts your fix and expects your tests to go red. Do it yourself first: revert the fix (keep the tests), run, confirm red, restore. A test that stays green with the fix reverted guards nothing.
