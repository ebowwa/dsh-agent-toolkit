// merge-guard.test.mjs — contract pins for scripts/merge-guard.sh and the
// gh-scrub-shim hook that arms it (issue #434).
//
// The receipt: PR #422 merged at 2026-10-04T12:17:56Z while its `gates`
// check run (37201311833) was still QUEUED — it never ran, and zero
// completed CI runs have ever graded the head that landed. The issue's
// acceptance shape: a merge-time guard that refuses to merge while the PR's
// check is not completed/success, treating queued/cancelled as NOT green,
// and NEVER polling until green. Pins, in the repo's test-as-contract
// style:
//
//   1. GREEN is exactly {status=completed, conclusion=success} on the PR's
//      HEAD SHA — queued / in_progress / cancelled / failure / absent /
//      wrong-SHA all refuse (the stale-green legs are the ones a "just look
//      for a green run" implementation gets wrong). Since FleetTower issue
//      #1132, "absent" is per-name: the DEFAULT name (`gates`) is a guess
//      about the consumer repo's gates.yml, so when no run carries it the
//      guard grades the head by the rollup — ≥1 completed+success run ON the
//      head SHA and no red conclusion passes loudly; reds-present or
//      nothing-green refuses; an EXPLICIT MERGE_GUARD_CHECK never falls
//      back.
//   2. ONE snapshot: exactly one check-runs API call per check, even on
//      the refusal path — no sleep/poll/retry loop may ever appear.
//   3. Fail-closed: unresolvable states (no gh, PR unresolvable) refuse
//      rather than pass (REVIEW.md's scrub rule, applied to merges).
//   4. The shim hook arms only when GH_MERGE_GUARD=on (the driver stamps
//      it), refuses fail-closed when armed and unresolvable, and leaves
//      the legacy unarmed behavior byte-identical (the #159 `pr merge -m`
//      boolean pin keeps passing).
//   5. The driver actually arms it next to the shim env contract and
//      carries the arm through GITHUB_ENV (the #251 later-step belt).
//
// Hermetic: a stub gh serves fixtures from a temp dir, counts its api
// calls, and records any `pr merge` argv; no network, no real repo.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, chmodSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const GUARD = path.join(ROOT, "scripts", "merge-guard.sh");
const SHIM = path.join(ROOT, "scripts", "gh-scrub-shim");
const SCRUB = path.join(ROOT, "scripts", "scrub-output.mjs");
const DRIVER = path.join(ROOT, "scripts", "run-dsh-agent.sh");

const HEAD = "0123456789abcdef0123456789abcdef01234567";
const HEAD2 = "fedcba9876543210fedcba9876543210fedcba98";

// --- fixture: a stub gh that serves fixtures, counts api calls, records ----

const fixture = (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "merge-guard-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(path.join(dir, "pr-view.json"),
    JSON.stringify({ number: 434, headRefOid: HEAD, url: "https://github.com/owner/repo/pull/434" }));
  writeFileSync(path.join(dir, "check-runs.json"), JSON.stringify({ total_count: 0, check_runs: [] }));
  writeFileSync(path.join(dir, "gh"), `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$MG_STUB_DIR/gh.log"
if [ "$1" = "pr" ] && [ "$2" = "view" ]; then
  [ -f "$MG_STUB_DIR/pr-fail" ] && { echo "stub: pr view fails" >&2; exit 1; }
  cat "$MG_STUB_DIR/pr-view.json"
  exit 0
fi
if [ "$1" = "api" ]; then
  printf 'x\\n' >> "$MG_STUB_DIR/api-count"
  cat "$MG_STUB_DIR/check-runs.json"
  exit 0
fi
if [ "$1" = "pr" ] && [ "$2" = "merge" ]; then
  printf '%s\\n' "$@" >> "$MG_STUB_DIR/merge-capture"
  exit 0
fi
echo "stub: unexpected call: $*" >&2
exit 64
`);
  chmodSync(path.join(dir, "gh"), 0o755);
  return dir;
};

const leg = (over = {}) => ({
  id: over.id ?? 1,
  name: over.name ?? "gates",
  head_sha: over.head_sha ?? HEAD,
  status: over.status ?? "completed",
  conclusion: over.conclusion ?? "success",
});

const setLegs = (dir, legs) =>
  writeFileSync(path.join(dir, "check-runs.json"),
    JSON.stringify({ total_count: legs.length, check_runs: legs }));

const ghLog = (dir) => readFileSync(path.join(dir, "gh.log"), "utf8").split("\n").filter(Boolean);
const apiCalls = (dir) => ghLog(dir).filter((l) => l.startsWith("api ")).length;
const mergeCapture = (dir) =>
  existsSync(path.join(dir, "merge-capture"))
    ? readFileSync(path.join(dir, "merge-capture"), "utf8").split("\n").filter(Boolean)
    : null;

/** Run the guard in `mode` with `args` against a fixture dir. */
const runGuard = (t, mode, args, { legs = [], env = {} } = {}) => {
  const dir = fixture(t);
  setLegs(dir, legs);
  const baseEnv = {
    ...process.env,
    MG_STUB_DIR: dir,
    MERGE_GUARD_GH: path.join(dir, "gh"),
  };
  // The legs pin a `gates`-named check run (scripts/merge-guard.sh reads
  // CHECK="${MERGE_GUARD_CHECK:-gates}"): an ambient MERGE_GUARD_CHECK=<other>
  // on a lane would ride the process.env spread, flip the guard's filter to a
  // name no leg carries, and turn every green leg red (issue #483 — the
  // env-construction flavor of the REVIEW.md lane-leak class, same shape as
  // the #479 fix in runShim below). "Default" must mean default on every
  // machine. Delete BEFORE the caller-env spread so a deliberate override
  // still wins.
  delete baseEnv.MERGE_GUARD_CHECK;
  // Same class, second pair of carriers (issue #487): scripts/merge-guard.sh
  // also reads MERGE_GUARD_VERIFY and MERGE_GUARD_VERIFY_TOOL ("Independent
  // verification (issue #326) — OPT-IN via MERGE_GUARD_VERIFY=on"). An armed
  // lane exporting MERGE_GUARD_VERIFY=on rides the same process.env spread
  // and arms the verify leg under EVERY harness leg — flipping the harness's
  // own GREEN leg red (the verify leg then needs the real pr-verification
  // tool against a stubbed gh). "Default" must mean default on every
  // machine. Delete BEFORE the caller-env spread so a deliberate arm in a
  // specific test still wins.
  delete baseEnv.MERGE_GUARD_VERIFY;
  delete baseEnv.MERGE_GUARD_VERIFY_TOOL;
  const res = spawnSync("bash", [GUARD, mode, ...args], {
    encoding: "utf8",
    cwd: dir,
    env: { ...baseEnv, ...env },
  });
  return { res, dir };
};

/** Run the gh-scrub-shim with the merge guard against a fixture dir. */
const runShim = (t, argv, { legs = [], guardEnv = {} } = {}) => {
  const dir = fixture(t);
  setLegs(dir, legs);
  const env = {
    ...process.env,
    GH_SCRUB_REAL: path.join(dir, "gh"),
    SCRUB_SCRIPT: SCRUB,
    MG_STUB_DIR: dir,
    GH_MERGE_GUARD_SCRIPT: GUARD,
    TMPDIR: dir,
  };
  // "GH_MERGE_GUARD unset" must mean unset (issue #479): this helper spreads
  // process.env, so on a lane that exports GH_MERGE_GUARD=on the ambient arm
  // rode through the spread and the unset leg took the armed branch — green
  // on a dev box, red on any armed lane (the env-construction flavor of the
  // REVIEW.md lane-leak class). Delete BEFORE the guardEnv spread so an
  // armed test still overrides the arm deliberately.
  delete env.GH_MERGE_GUARD;
  // Same class for the guard's check-name stamp (FleetTower #1132 pins): an
  // ambient GH_MERGE_GUARD_CHECK would flip the unset-default legs into
  // explicit-assertion semantics machine-dependently. (The general
  // runShim-carrier audit lives in issue #490; this delete covers only the
  // var these pins introduce.)
  delete env.GH_MERGE_GUARD_CHECK;
  // Same class, the #490 carrier pair: the shim's guard invocation
  // (scripts/gh-scrub-shim — `MERGE_GUARD_GH="$REAL" bash "$MERGE_GUARD"
  // check …`) only PREFIXES an assignment to the inherited env, it never
  // strips one, so an ambient MERGE_GUARD_VERIFY=on / MERGE_GUARD_VERIFY_TOOL
  // on a lane rides this spread through the shim into the guard's verify_gate
  // (scripts/merge-guard.sh) and arms the verify leg under EVERY armed+green
  // shim leg — the tool then grades the stubbed fixture gh and the leg reds
  // (green on a dev box, red on an armed lane; the #479/#483/#487 failure
  // shape, fourth carrier). Delete BEFORE the guardEnv spread so a deliberate
  // arm in a specific test still wins.
  delete env.MERGE_GUARD_VERIFY;
  delete env.MERGE_GUARD_VERIFY_TOOL;
  const res = spawnSync("bash", [SHIM, ...argv], {
    encoding: "utf8",
    cwd: dir,
    env: { ...env, ...guardEnv },
  });
  return { res, dir };
};

// --- 1. the GREEN rule: exactly completed+success on the head SHA ----------

test("guard: completed+success on the head SHA is GREEN", (t) => {
  const { res } = runGuard(t, "check", ["434"], { legs: [leg()] });
  assert.equal(res.status, 0, `green must pass (stderr: ${res.stderr})`);
  assert.match(res.stdout, /GREEN/);
});

test("guard: queued refuses (the #422 receipt state)", (t) => {
  const { res } = runGuard(t, "check", ["434"], { legs: [leg({ status: "queued", conclusion: null })] });
  assert.equal(res.status, 1, "queued must refuse");
  assert.match(res.stderr, /NOT green/);
  assert.match(res.stderr, /queued/);
});

test("guard: in_progress refuses", (t) => {
  const { res } = runGuard(t, "check", ["434"], { legs: [leg({ status: "in_progress", conclusion: null })] });
  assert.equal(res.status, 1);
  assert.match(res.stderr, /in_progress/);
});

test("guard: cancelled refuses (explicit #434 requirement)", (t) => {
  const { res } = runGuard(t, "check", ["434"], { legs: [leg({ conclusion: "cancelled" })] });
  assert.equal(res.status, 1);
  assert.match(res.stderr, /cancelled/);
});

test("guard: completed+failure refuses", (t) => {
  const { res } = runGuard(t, "check", ["434"], { legs: [leg({ conclusion: "failure" })] });
  assert.equal(res.status, 1);
  assert.match(res.stderr, /failure/);
});

test("guard: no check run on the head at all refuses (the never-ran case)", (t) => {
  const { res } = runGuard(t, "check", ["434"], { legs: [] });
  assert.equal(res.status, 1);
  assert.match(res.stderr, /no 'gates' check run graded head/);
});

test("guard: a green run under a DIFFERENT name grades the head when no 'gates' run exists (FleetTower #1132 fallback)", (t) => {
  // The FleetTower #1132 receipt: consumer repos name their gates jobs
  // `guard-tests` / `notebooks-gist-reconcile`, so the hardcoded default
  // refused EVERY merge on EVERY green head ("no 'gates' check run graded
  // head a40574f" issued while the rollup showed both jobs SUCCESS on
  // exactly that SHA). The default name is a guess about the consumer
  // repo's gates.yml — when no run carries it, the guard grades the head by
  // the #434 semantics that actually matter: completed/success ON this head
  // SHA. Wrong-SHA still refuses below; this leg is same-SHA.
  const { res } = runGuard(t, "check", ["434"], {
    legs: [leg({ name: "guard-tests" }), leg({ id: 2, name: "notebooks-gist-reconcile" })],
  });
  assert.equal(res.status, 0, `a green head must pass under a foreign default name (stderr: ${res.stderr})`);
  assert.match(res.stdout, /GREEN/);
  assert.match(res.stdout, /no 'gates' check run graded head/, "the pass must stay loud about the name miss");
  assert.match(res.stdout, /guard-tests/, "the pass must name what actually graded the head");
});

test("guard: a RED sibling refuses even when another check is green (no 'gates' run — the #784/#748 class)", (t) => {
  // The fallback must never become a "find any green run" bypass: a head
  // whose real gate failed while an advisory sibling passed is the #748
  // merge-on-green class. Reds present + greens present refuses, and names
  // the explicit-name escape (the #1132 workaround parameter).
  const { res } = runGuard(t, "check", ["434"], {
    legs: [leg({ name: "guard-tests", conclusion: "failure" }), leg({ id: 2, name: "notebooks-gist-reconcile" })],
  });
  assert.equal(res.status, 1, "a red sibling must refuse even with a green sibling");
  assert.match(res.stderr, /red check run/);
  assert.match(res.stderr, /MERGE_GUARD_CHECK=/, "the refusal must name the explicit-name escape");
});

test("guard: nothing green on the head under a foreign default name refuses (the never-ran case)", (t) => {
  const { res } = runGuard(t, "check", ["434"], {
    legs: [leg({ name: "guard-tests", status: "queued", conclusion: null })],
  });
  assert.equal(res.status, 1);
  assert.match(res.stderr, /no 'gates' check run graded head/);
  assert.match(res.stderr, /never ran green/);
});

test("guard: a green run for a STALE head SHA under a foreign name still refuses (re-push stale green)", (t) => {
  // The SHA filter is shared by the fallback — a green run for a previous
  // head is not green, whatever the job is named (issue #434).
  const { res } = runGuard(t, "check", ["434"], {
    legs: [leg({ name: "guard-tests", head_sha: HEAD2 })],
  });
  assert.equal(res.status, 1);
  assert.match(res.stderr, /no 'gates' check run graded head/);
});

test("guard: an EXPLICIT MERGE_GUARD_CHECK is an assertion — a green foreign-name run never satisfies it", (t) => {
  // The #1132 workaround (`GH_MERGE_GUARD_CHECK=<job>`) keeps ALL guard
  // semantics intact: the named check counts only when a run carries it, so
  // an explicit name with no matching run refuses instead of falling back.
  const { res } = runGuard(t, "check", ["434"], {
    legs: [leg()],
    env: { MERGE_GUARD_CHECK: "guard-tests" },
  });
  assert.equal(res.status, 1);
  assert.match(res.stderr, /no 'guard-tests' check run/);
  assert.match(res.stderr, /#422 receipt/, "the explicit path keeps the original fail-closed wording");
});

test("guard: exactly ONE check-runs call on the fallback green path — no polling", (t) => {
  const { dir } = runGuard(t, "check", ["434"], { legs: [leg({ name: "guard-tests" })] });
  assert.equal(apiCalls(dir), 1, "the fallback must decide from the same ONE snapshot");
});

test("guard: a green run for a STALE head SHA is not green (re-push stale green)", (t) => {
  const { res } = runGuard(t, "check", ["434"], { legs: [leg({ head_sha: HEAD2 })] });
  assert.equal(res.status, 1);
  assert.match(res.stderr, /no 'gates' check run/);
});

test("guard: an ambient MERGE_GUARD_CHECK=<other> cannot flip the harness legs (issue #483 pin)", (t) => {
  // The #483 defect is invisible on a clean dev box: the legs above pin a
  // `gates`-named check, but the guard reads CHECK="${MERGE_GUARD_CHECK:-gates}"
  // — on a lane that exports MERGE_GUARD_CHECK=<other> the name rode the
  // process.env spread, the filter matched no leg, and every green leg went
  // red. Arm the lane INSIDE this process so the harness env's hermeticity is
  // graded on every machine, not just on mis-configured lanes (the #479 pin
  // shape, applied to the guard's own default).
  process.env.MERGE_GUARD_CHECK = "ci/ambient-not-gates";
  try {
    const { res, dir } = runGuard(t, "check", ["434"], { legs: [leg()] });
    assert.equal(res.status, 0, `the harness 'gates' default must beat the ambient name (stderr: ${res.stderr})`);
    assert.match(res.stdout, /GREEN — 'gates' completed\/success/, "the guard still graded the gates leg");
    assert.equal(apiCalls(dir), 1);
  } finally {
    delete process.env.MERGE_GUARD_CHECK;
  }
});

test("guard: an ambient MERGE_GUARD_VERIFY=on cannot arm the verify leg through the harness (issue #487 pin)", (t) => {
  // The #487 defect is invisible on a clean dev box: the guard reads
  // MERGE_GUARD_VERIFY and MERGE_GUARD_VERIFY_TOOL ("OPT-IN via
  // MERGE_GUARD_VERIFY=on", issue #326) — on a lane that exports
  // MERGE_GUARD_VERIFY=on the arm rode runGuard's process.env spread, the
  // verify leg ran under EVERY harness leg, and the harness's own GREEN leg
  // went red (it then needs the real pr-verification tool against a stubbed
  // gh). Arm the lane INSIDE this process — both names, the tool pointing at
  // a path that cannot exist — so the harness env's hermeticity is graded on
  // every machine, not just on mis-configured lanes (the #479/#483 pin
  // shape, applied to the guard's verify opt-in).
  //
  // Save-and-RESTORE, never delete (issue #490): this pin sits early in the
  // file, and a `finally { delete … }` here would permanently scrub an armed
  // lane's export out of this test process — every leg declared AFTER the pin
  // (all of sections 2–6, every shim leg included) would then be graded
  // DE-ARMED even where the lane exports the arm, laundering exactly the
  // failure shape this file pins against (the whole file ran green on an
  // armed lane while the isolated armed+green shim leg ran red). Restore the
  // caller's values so an armed lane stays armed for them; on a clean box the
  // restore IS a delete (both were unset).
  const savedVerifyEnv = {
    verify: process.env.MERGE_GUARD_VERIFY,
    tool: process.env.MERGE_GUARD_VERIFY_TOOL,
  };
  process.env.MERGE_GUARD_VERIFY = "on";
  process.env.MERGE_GUARD_VERIFY_TOOL = "/nonexistent/pr-verification.mjs";
  try {
    const { res } = runGuard(t, "check", ["434"], { legs: [leg()] });
    assert.equal(res.status, 0, `the ambient verify arm must not flip the GREEN leg (stderr: ${res.stderr})`);
    assert.match(res.stdout, /GREEN/);
    assert.doesNotMatch(
      `${res.stdout}${res.stderr}`,
      /independent verification/i,
      "the verify leg must not run at all under the harness",
    );
  } finally {
    if (savedVerifyEnv.verify === undefined) delete process.env.MERGE_GUARD_VERIFY;
    else process.env.MERGE_GUARD_VERIFY = savedVerifyEnv.verify;
    if (savedVerifyEnv.tool === undefined) delete process.env.MERGE_GUARD_VERIFY_TOOL;
    else process.env.MERGE_GUARD_VERIFY_TOOL = savedVerifyEnv.tool;
  }
});

// --- 2. ONE snapshot: the no-poll pin ---------------------------------------

test("guard: exactly ONE check-runs call on the refusal path — no polling", (t) => {
  const { dir } = runGuard(t, "check", ["434"], { legs: [leg({ status: "queued", conclusion: null })] });
  assert.equal(apiCalls(dir), 1, "a queued verdict must not trigger any second API call");
});

test("guard: exactly ONE check-runs call on the green path", (t) => {
  const { dir } = runGuard(t, "check", ["434"], { legs: [leg()] });
  assert.equal(apiCalls(dir), 1);
});
test("guard source: no sleep/poll loop anywhere in the guard", () => {
  const src = readFileSync(GUARD, "utf8");
  assert.doesNotMatch(src, /\bsleep\b/, "the guard must not sleep");
  assert.doesNotMatch(src, /\bwhile\s+true\b/, "the guard must not loop until green");
  assert.match(src, /ONE snapshot/, "the guard still documents its one-shot contract");
});

// --- 3. fail-closed on unresolvable states ----------------------------------

test("guard: unresolvable PR refuses (exit 2), never passes", (t) => {
  const dir = fixture(t);
  writeFileSync(path.join(dir, "pr-fail"), "1");
  // Raw process.env spread (issue #487): the ambient MERGE_GUARD_* names must
  // not reach the guard's grading here either — same delete-before-spread
  // contract runGuard enforces.
  const env = {
    ...process.env,
    MG_STUB_DIR: dir,
    MERGE_GUARD_GH: path.join(dir, "gh"),
  };
  delete env.MERGE_GUARD_VERIFY;
  delete env.MERGE_GUARD_VERIFY_TOOL;
  const res = spawnSync("bash", [GUARD, "check", "434"], {
    encoding: "utf8",
    cwd: dir,
    env,
  });
  assert.equal(res.status, 2);
  assert.match(res.stderr, /cannot resolve PR/);
});

test("guard: missing gh binary refuses (exit 2)", (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "merge-guard-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const env = {
    ...process.env,
    MERGE_GUARD_GH: "/nonexistent/merge-guard-gh",
  };
  delete env.MERGE_GUARD_VERIFY;
  delete env.MERGE_GUARD_VERIFY_TOOL;
  const res = spawnSync("bash", [GUARD, "check", "434"], {
    encoding: "utf8",
    cwd: dir,
    env,
  });
  assert.equal(res.status, 2);
  assert.match(res.stderr, /missing\/not executable/);
});

// --- 4. the merge wrapper: check, then exec gh pr merge ---------------------

test("wrapper: green check execs gh pr merge with argv verbatim", (t) => {
  const { res, dir } = runGuard(t, "merge", ["434", "-m"], { legs: [leg()] });
  assert.equal(res.status, 0, `wrapper must merge through (stderr: ${res.stderr})`);
  assert.deepEqual(mergeCapture(dir), ["pr", "merge", "434", "-m"]);
});

test("wrapper: queued check refuses and gh pr merge is NEVER exec'd", (t) => {
  const { res, dir } = runGuard(t, "merge", ["434", "-m"], { legs: [leg({ status: "queued", conclusion: null })] });
  assert.equal(res.status, 1);
  assert.equal(mergeCapture(dir), null, "the merge must not run behind a refused check");
});

test("wrapper: finds the PR target around pr merge's value flags", (t) => {
  const { res, dir } = runGuard(t, "merge", ["--squash", "--subject", "land it", "434", "-m"], { legs: [leg()] });
  assert.equal(res.status, 0, `stderr: ${res.stderr}`);
  assert.ok(ghLog(dir).some((l) => l.startsWith("pr view 434 ")), "the guard must check PR 434, not a flag value");
  assert.deepEqual(mergeCapture(dir), ["pr", "merge", "--squash", "--subject", "land it", "434", "-m"]);
});

test("wrapper: with no target arg it resolves the current branch PR", (t) => {
  const { res, dir } = runGuard(t, "merge", ["-m"], { legs: [leg()] });
  assert.equal(res.status, 0, `stderr: ${res.stderr}`);
  assert.ok(ghLog(dir).some((l) => /^pr view --json/.test(l)), "bare gh pr view resolves the current branch");
});

// --- 5. the shim hook: armed / off / unset / misarmed ------------------------

test("shim: armed + queued merge REFUSES and the real gh never runs", (t) => {
  const { res, dir } = runShim(t, ["pr", "merge", "12", "-m"], {
    legs: [leg({ status: "queued", conclusion: null })],
    guardEnv: { GH_MERGE_GUARD: "on" },
  });
  assert.equal(res.status, 1, `the shim must refuse (stderr: ${res.stderr})`);
  assert.match(res.stderr, /merge REFUSED by the gates guard/);
  assert.equal(mergeCapture(dir), null, "the real gh must never exec behind a refused check");
});

test("shim: armed + green merge passes through, -m reaches gh verbatim", (t) => {
  const { res, dir } = runShim(t, ["pr", "merge", "12", "-m"], {
    legs: [leg()],
    guardEnv: { GH_MERGE_GUARD: "on" },
  });
  assert.equal(res.status, 0, `stderr: ${res.stderr}`);
  assert.deepEqual(mergeCapture(dir), ["pr", "merge", "12", "-m"],
    "the #159 boolean-flag pin holds under the guard too");
});

test("shim: armed + a FleetTower-shaped head (guard-tests green, no 'gates' run) passes — the #1132 end-to-end", (t) => {
  // The shim must NOT manufacture an explicit check name: with
  // GH_MERGE_GUARD_CHECK unset the guard takes its repo-agnostic default,
  // so a head graded by differently-named jobs merges instead of refusing
  // (the exact FleetTower #1118/#1132 refusal on a fully-green head).
  const { res, dir } = runShim(t, ["pr", "merge", "12", "-m"], {
    legs: [leg({ name: "guard-tests" }), leg({ id: 2, name: "notebooks-gist-reconcile" })],
    guardEnv: { GH_MERGE_GUARD: "on" },
  });
  assert.equal(res.status, 0, `stderr: ${res.stderr}`);
  assert.deepEqual(mergeCapture(dir), ["pr", "merge", "12", "-m"]);
});

test("shim: armed + a stamped GH_MERGE_GUARD_CHECK keeps assertion semantics (refuses when absent)", (t) => {
  // A driver-stamped name rides through as an explicit assertion: it counts
  // only when a run carries it — never the #1132 fallback (the issue's
  // "the parameter exists for exactly this" workaround semantics).
  const { res, dir } = runShim(t, ["pr", "merge", "12", "-m"], {
    legs: [leg()],
    guardEnv: { GH_MERGE_GUARD: "on", GH_MERGE_GUARD_CHECK: "guard-tests" },
  });
  assert.equal(res.status, 1);
  assert.match(res.stderr, /no 'guard-tests' check run/);
  assert.equal(mergeCapture(dir), null);
});

test("shim: armed + a stamped GH_MERGE_GUARD_CHECK=<job> gates on that job when it IS green", (t) => {
  const { res, dir } = runShim(t, ["pr", "merge", "12", "-m"], {
    legs: [leg({ name: "guard-tests", conclusion: "failure" }), leg({ id: 2, name: "notebooks-gist-reconcile" })],
    guardEnv: { GH_MERGE_GUARD: "on", GH_MERGE_GUARD_CHECK: "notebooks-gist-reconcile" },
  });
  assert.equal(res.status, 0, `stderr: ${res.stderr}`);
  assert.deepEqual(mergeCapture(dir), ["pr", "merge", "12", "-m"]);
});

test("shim: armed + green still scrubs GitHub-bound text (guard never bypasses scrubbing)", (t) => {
  const { res, dir } = runShim(t, ["pr", "merge", "12", "-m", "-t", "ship ghp_a1B2c3D4e5F6g7H8i9J0k1L2m3"], {
    legs: [leg()],
    guardEnv: { GH_MERGE_GUARD: "on" },
  });
  assert.equal(res.status, 0, `stderr: ${res.stderr}`);
  const captured = readFileSync(path.join(dir, "merge-capture"), "utf8");
  assert.ok(captured.includes("[redacted:token]"), "the merge-commit title rode the scrubber");
  assert.ok(!captured.includes("a1B2c3D4e5F6"));
});

test("shim: armed + guard script missing refuses fail-closed", (t) => {
  const { res } = runShim(t, ["pr", "merge", "12", "-m"], {
    guardEnv: { GH_MERGE_GUARD: "on", GH_MERGE_GUARD_SCRIPT: "/nonexistent/merge-guard.sh" },
  });
  assert.equal(res.status, 1);
  assert.match(res.stderr, /missing\/not executable/);
});

test("shim: armed + misarmed value refuses rather than guessing", (t) => {
  const { res } = runShim(t, ["pr", "merge", "12", "-m"], {
    guardEnv: { GH_MERGE_GUARD: "yes-please" },
  });
  assert.equal(res.status, 1);
  assert.match(res.stderr, /misarmed/);
});

test("shim: GH_MERGE_GUARD=off is a LOUD ungated pass-through", (t) => {
  const { res, dir } = runShim(t, ["pr", "merge", "12", "-m"], {
    guardEnv: { GH_MERGE_GUARD: "off" },
  });
  assert.equal(res.status, 0);
  assert.match(res.stderr, /merge guard OFF/);
  assert.deepEqual(mergeCapture(dir), ["pr", "merge", "12", "-m"]);
});

test("shim: GH_MERGE_GUARD unset keeps the legacy behavior (loud INACTIVE note)", (t) => {
  const { res, dir } = runShim(t, ["pr", "merge", "12", "-m"], { guardEnv: {} });
  assert.equal(res.status, 0, `the unarmed shim must not change legacy behavior (stderr: ${res.stderr})`);
  assert.match(res.stderr, /merge guard INACTIVE/);
  assert.deepEqual(mergeCapture(dir), ["pr", "merge", "12", "-m"]);
});

test("shim: an ambient GH_MERGE_GUARD=on cannot arm through the harness (issue #479 pin)", (t) => {
  // The #479 defect is invisible on a clean dev box: the unset leg above is
  // only red where the lane itself exports GH_MERGE_GUARD=on. This pin arms
  // the lane INSIDE this process so the hermeticity of the harness env is
  // graded everywhere — without the delete-before-spread fix in runShim this
  // leg takes the armed branch and refuses, on any machine.
  process.env.GH_MERGE_GUARD = "on";
  try {
    const { res, dir } = runShim(t, ["pr", "merge", "12", "-m"], { guardEnv: {} });
    assert.equal(res.status, 0, `the harness 'unset' must beat the ambient arm (stderr: ${res.stderr})`);
    assert.match(res.stderr, /merge guard INACTIVE/);
    assert.deepEqual(mergeCapture(dir), ["pr", "merge", "12", "-m"]);
  } finally {
    delete process.env.GH_MERGE_GUARD;
  }
});

test("shim: an ambient MERGE_GUARD_VERIFY=on cannot arm the guard's verify leg through the shim (issue #490 pin)", (t) => {
  // The #490 defect is invisible on a clean dev box: the shim's guard
  // invocation only PREFIXES MERGE_GUARD_GH to its inherited env (assignments
  // add, they never strip), so on a lane that exports MERGE_GUARD_VERIFY=on
  // the arm rode runShim's process.env spread through the shim into the
  // guard's verify_gate and armed the verify leg under every armed+green shim
  // leg — the tool then graded the stubbed fixture gh and the leg went red
  // (the #479/#483/#487 shape, fourth carrier). Arm the lane INSIDE this
  // process — both names, the tool pointing at a path that cannot exist — so
  // the shim env's hermeticity is graded on every machine (the #479/#487 pin
  // shape, applied to the shim's forward). Save-and-RESTORE in the finally:
  // like the #487 pin above, this pin must never launder an armed lane's
  // export for the legs after it (issue #490).
  const savedVerifyEnv = {
    verify: process.env.MERGE_GUARD_VERIFY,
    tool: process.env.MERGE_GUARD_VERIFY_TOOL,
  };
  process.env.MERGE_GUARD_VERIFY = "on";
  process.env.MERGE_GUARD_VERIFY_TOOL = "/nonexistent/pr-verification.mjs";
  try {
    const { res, dir } = runShim(t, ["pr", "merge", "12", "-m"], {
      legs: [leg()],
      guardEnv: { GH_MERGE_GUARD: "on" },
    });
    assert.equal(res.status, 0, `the ambient verify arm must not flip the armed+green shim leg (stderr: ${res.stderr})`);
    assert.deepEqual(mergeCapture(dir), ["pr", "merge", "12", "-m"]);
    assert.doesNotMatch(
      `${res.stdout}${res.stderr}`,
      /independent verification/i,
      "the verify leg must not run at all under the shim harness",
    );
  } finally {
    if (savedVerifyEnv.verify === undefined) delete process.env.MERGE_GUARD_VERIFY;
    else process.env.MERGE_GUARD_VERIFY = savedVerifyEnv.verify;
    if (savedVerifyEnv.tool === undefined) delete process.env.MERGE_GUARD_VERIFY_TOOL;
    else process.env.MERGE_GUARD_VERIFY_TOOL = savedVerifyEnv.tool;
  }
});

test("shim: the guard hook only arms on the merge verb", (t) => {
  const { res, dir } = runShim(t, ["pr", "view", "12"], { guardEnv: { GH_MERGE_GUARD: "on" } });
  assert.equal(res.status, 0, `stderr: ${res.stderr}`);
  assert.ok(!res.stderr.includes("merge guard"), "non-merge verbs must not touch the guard");
  assert.deepEqual(mergeCapture(dir), null);
});

// --- 6. the driver actually arms the guard ----------------------------------

test("driver: stamps GH_MERGE_GUARD=on with the shim env contract", () => {
  const driver = readFileSync(DRIVER, "utf8");
  assert.match(driver, /export GH_MERGE_GUARD=on/);
  assert.match(driver, /export GH_MERGE_GUARD_SCRIPT="\$SCRIPT_DIR\/merge-guard\.sh"/);
  assert.match(
    driver,
    /GH_MERGE_GUARD=on[\s\S]*?merge-guard\.sh[\s\S]*?GH_SCRUB_REAL/,
    "the guard arm lives beside the shim env contract it extends",
  );
});

test("driver: carries the arm through GITHUB_ENV for later steps", () => {
  const driver = readFileSync(DRIVER, "utf8");
  assert.match(driver, /printf 'GH_MERGE_GUARD=%s\\n' "\$GH_MERGE_GUARD" >> "\$GITHUB_ENV"/);
  assert.match(driver, /printf 'GH_MERGE_GUARD_SCRIPT=%s\\n' "\$GH_MERGE_GUARD_SCRIPT" >> "\$GITHUB_ENV"/);
});

test("shim: the hook documents the no-poll requirement it enforces", () => {
  const shim = readFileSync(SHIM, "utf8");
  assert.match(shim, /ONE snapshot/, "the shim hook must name the one-shot contract");
  assert.match(shim, /NOT green/, "the shim hook must name the queued/cancelled rule");
});
