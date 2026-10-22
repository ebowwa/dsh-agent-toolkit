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
