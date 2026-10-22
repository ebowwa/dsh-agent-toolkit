// guard-env.mjs — the ONE home for the merge-guard's ambient env scrubbing.
//
// The guard chain grades from the AMBIENT env: scripts/merge-guard.sh reads
// MERGE_GUARD_CHECK (the check-run name; CHECK / CHECK_EXPLICIT),
// MERGE_GUARD_VERIFY (arm the opt-in independent-verification leg) and
// MERGE_GUARD_VERIFY_TOOL (which tool that leg runs). A test leg that means
// "default" must not inherit any of them: on a lane that exports one, the leg
// armed/graded a name its fixture never staged and passed — or failed — for
// the wrong reason, and only on such a lane.
//
// Why one module (issues #490 + #503): the same scrub grew in three shapes —
// runGuard's set in tests/merge-guard.test.mjs, the bare
// `delete env.MERGE_GUARD_VERIFY` in tests/merge-guard-verify.test.mjs, and
// runShim's delete list, which covered only the GH_MERGE_GUARD pair plus
// MERGE_GUARD_CHECK. #490 is the drift class and #503 is its live site: the
// shim legs left MERGE_GUARD_VERIFY / MERGE_GUARD_VERIFY_TOOL ambient, so on
// an armed lane every shim fixture silently carried an arm it never set.
// Both suites now import THIS set and THIS helper, and a pin in
// tests/merge-guard.test.mjs grades that from source — the set cannot drift
// per-file again.
//
// MERGE_GUARD_GH is deliberately NOT in the set: it selects the gh binary,
// every leg constructs it explicitly after the scrub, and deleting it would
// break the missing-binary leg.

/** The MERGE_GUARD_* names scripts/merge-guard.sh reads for GRADING. */
export const GUARD_INPUT_AMBIENT = ["MERGE_GUARD_CHECK", "MERGE_GUARD_VERIFY", "MERGE_GUARD_VERIFY_TOOL"];

/**
 * Delete every guard-input name from `env` (in place) and return it.
 *
 * Call it BEFORE spreading a leg's deliberate stamps, so an explicit per-test
 * arm still wins over the scrub.
 */
export const scrubGuardInputAmbient = (env) => {
  for (const name of GUARD_INPUT_AMBIENT) delete env[name];
  return env;
};

/**
 * The GH_MERGE_GUARD* names scripts/gh-scrub-shim (and scripts/git-scrub-shim
 * via the same PATH contract) reads from the AMBIENT env:
 *   GH_MERGE_GUARD         on|off|unset — arm the merge-time gates hook
 *   GH_MERGE_GUARD_CHECK   the #1132 explicit check-run name, forwarded to
 *                          MERGE_GUARD_CHECK only when the driver stamped it
 *   GH_MERGE_GUARD_SCRIPT  the guard path (default ${SCRUB_SCRIPT%/*}/merge-guard.sh)
 *
 * Issue #563 is this set's receipt: the shim-spawn helpers scrubbed five names
 * by hand and GH_MERGE_GUARD_SCRIPT appeared NOWHERE, so on a lane exporting
 * it an "unset-default" merge leg located a different guard than the fixture
 * staged. The set is derived from the shim source and pinned (see
 * tests/scrub-shims.test.mjs).
 */
export const SHIM_GUARD_ENV = ["GH_MERGE_GUARD", "GH_MERGE_GUARD_CHECK", "GH_MERGE_GUARD_SCRIPT"];

/**
 * Everything a shim-spawn helper must scrub: the shim's own GH_MERGE_GUARD*
 * arms PLUS the guard-input names merge-guard.sh grades by, because the shim's
 * guard invocation only PREFIXES assignments — it never strips the inherited
 * env (the #490 receipt). MERGE_GUARD_GH is deliberately NOT here: gh-scrub-shim
 * itself prefixes it (`MERGE_GUARD_GH="$REAL" bash …`), so an ambient value
 * always loses and scrubbing it would prove nothing.
 */
export const SHIM_SCRUB_ENV = [...SHIM_GUARD_ENV, ...GUARD_INPUT_AMBIENT];

/** Delete the whole shim-scrub belt from `env` (in place) and return it. */
export const scrubShimScrubEnv = (env) => {
  for (const name of SHIM_SCRUB_ENV) delete env[name];
  return env;
};
