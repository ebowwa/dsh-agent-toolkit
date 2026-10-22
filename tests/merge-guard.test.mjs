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
//   6. The rollup reads ALL pages of the head's check runs (issue #566):
//      the endpoint defaults to per_page=30, so a red parked beyond page 1
//      used to be invisible and a red head PASSED ANYGREEN. The guard now
//      requests ?per_page=100 and pages until the fetched count covers
//      total_count — still ONE snapshot, never a poll loop. The stub gh
//      serves real page shapes (paged calls get per_page slices, unpaged
//      calls get the default-30 truncation), so a regression to the bare
//      call reopens the exact blind spot the pins grade.
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
import { GUARD_INPUT_AMBIENT, scrubGuardInputAmbient } from "./lib/guard-env.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const GUARD = path.join(ROOT, "scripts", "merge-guard.sh");
const SHIM = path.join(ROOT, "scripts", "gh-scrub-shim");
const SCRUB = path.join(ROOT, "scripts", "scrub-output.mjs");
const DRIVER = path.join(ROOT, "scripts", "run-dsh-agent.sh");

const HEAD = "0123456789abcdef0123456789abcdef01234567";
const HEAD2 = "fedcba9876543210fedcba9876543210fedcba98";

// The lane-arm exports as THIS process found them (issue #612): captured at
// module load, before any test runs, so the laundering detector at the end of
// the shim section can grade every arming pin's restore against the true
// caller state — an arming pin that finally-DELETEs instead of restoring
// scrubs an armed lane's export out of the test process, and this capture is
// what proves the loss.
const LANE_ARMS_AT_LOAD = {
  GH_MERGE_GUARD: process.env.GH_MERGE_GUARD,
  GH_MERGE_GUARD_CHECK: process.env.GH_MERGE_GUARD_CHECK,
  MERGE_GUARD_CHECK: process.env.MERGE_GUARD_CHECK,
  MERGE_GUARD_VERIFY: process.env.MERGE_GUARD_VERIFY,
  MERGE_GUARD_VERIFY_TOOL: process.env.MERGE_GUARD_VERIFY_TOOL,
};

// --- fixture: a stub gh that serves fixtures, counts api calls, records ----

const fixture = (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "merge-guard-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(path.join(dir, "pr-view.json"),
    JSON.stringify({ number: 434, headRefOid: HEAD, url: "https://github.com/owner/repo/pull/434" }));
  writeFileSync(path.join(dir, "check-runs.json"), JSON.stringify({ total_count: 0, check_runs: [] }));
  writeFileSync(path.join(dir, "legs-all.json"), JSON.stringify({ total_count: 0, check_runs: [] }));
  writeFileSync(path.join(dir, "gh"), `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$MG_STUB_DIR/gh.log"
if [ "$1" = "pr" ] && [ "$2" = "view" ]; then
  [ -f "$MG_STUB_DIR/pr-fail" ] && { echo "stub: pr view fails" >&2; exit 1; }
  cat "$MG_STUB_DIR/pr-view.json"
  exit 0
fi
if [ "$1" = "api" ]; then
  printf 'x\\n' >> "$MG_STUB_DIR/api-count"
  # Issue #566: the guard now pages check-runs (?per_page=100&page=N). Serve
  # REAL GitHub page shapes from legs-all.json. A PAGED call sees the full
  # page slice the endpoint would return; an UNPAGED call — the regression
  # shape — sees only the endpoint's default per_page=30 truncation, so a
  # guard that stops paging reopens the page-1 blind spot these pins grade.
  if printf '%s' "$*" | grep -q 'per_page=100'; then
    page="$(printf '%s' "$*" | sed -n 's/.*[?&]page=\\([0-9][0-9]*\\).*/\\1/p')"
    [ -n "$page" ] || page=1
    MG_STUB_DIR="$MG_STUB_DIR" node -e '
      const { readFileSync } = require("fs");
      const path = require("path");
      const dir = process.env.MG_STUB_DIR;
      const page = Number(process.argv[1]);
      const all = JSON.parse(readFileSync(path.join(dir, "legs-all.json"), "utf8")).check_runs;
      const slice = all.slice((page - 1) * 100, page * 100);
      process.stdout.write(JSON.stringify({ total_count: all.length, check_runs: slice }));
    ' "$page"
  else
    MG_STUB_DIR="$MG_STUB_DIR" node -e '
      const { readFileSync } = require("fs");
      const path = require("path");
      const dir = process.env.MG_STUB_DIR;
      const all = JSON.parse(readFileSync(path.join(dir, "legs-all.json"), "utf8")).check_runs;
      process.stdout.write(JSON.stringify({ total_count: all.length, check_runs: all.slice(0, 30) }));
    '
  fi
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

const setLegs = (dir, legs) => {
  // legs-all.json is the FULL page-ordered run set the page-aware stub
  // slices (issue #566); check-runs.json stays written for any arg-blind
  // consumer that still reads it.
  writeFileSync(path.join(dir, "legs-all.json"),
    JSON.stringify({ total_count: legs.length, check_runs: legs }));
  writeFileSync(path.join(dir, "check-runs.json"),
    JSON.stringify({ total_count: legs.length, check_runs: legs }));
};

const ghLog = (dir) => readFileSync(path.join(dir, "gh.log"), "utf8").split("\n").filter(Boolean);
const apiCalls = (dir) => ghLog(dir).filter((l) => l.startsWith("api ")).length;
const mergeCapture = (dir) =>
  existsSync(path.join(dir, "merge-capture"))
    ? readFileSync(path.join(dir, "merge-capture"), "utf8").split("\n").filter(Boolean)
    : null;

// The guard-input ambient names live in ONE shared home (issues #490/#503):
// tests/lib/guard-env.mjs exports the set and the scrub, and BOTH this suite
// and tests/merge-guard-verify.test.mjs import them, so a suite cannot narrow
// the set on its own file again. Every direct-guard env construction below
// scrubs that set before the caller's own spread, so "default" means default
// on every machine and a deliberate per-test stamp (applied after the scrub)
// still wins. #503 is the runShim site this unified: it deleted the
// GH_MERGE_GUARD pair plus MERGE_GUARD_CHECK while leaving
// MERGE_GUARD_VERIFY / MERGE_GUARD_VERIFY_TOOL ambient. MERGE_GUARD_GH is
// deliberately NOT in the set: it selects the gh binary, every leg sets it
// explicitly after the spread, and scrubbing it would break the
// missing-binary leg.

/** Run the guard in `mode` with `args` against a fixture dir. */
const runGuard = (t, mode, args, { legs = [], env = {} } = {}) => {
  const dir = fixture(t);
  setLegs(dir, legs);
  const baseEnv = {
    ...process.env,
    MG_STUB_DIR: dir,
    MERGE_GUARD_GH: path.join(dir, "gh"),
  };
  // The ambient guard-input names must not reach the guard's grading here —
  // an ambient MERGE_GUARD_CHECK=<other> would flip the guard's filter to a
  // name no leg carries (issue #483), an ambient MERGE_GUARD_VERIFY=on would
  // arm the verify leg under EVERY harness leg (issue #487) — the
  // env-construction flavor of the REVIEW.md lane-leak class, same shape as
  // the #479 fix in runShim below. The shared scrub runs BEFORE the
  // caller-env spread so a deliberate override still wins (issue #612
  // unified the per-site deletes into the one helper).
  scrubGuardInputAmbient(baseEnv);
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
  // Fifth carrier of the same class (issue #553): the shim's guard invocation
  // (scripts/gh-scrub-shim) exports MERGE_GUARD_CHECK only when the driver
  // actually stamped GH_MERGE_GUARD_CHECK, and its guard call only PREFIXES
  // MERGE_GUARD_GH to the inherited env — assignments add, they never strip —
  // so an ambient MERGE_GUARD_CHECK=<other> on a lane rides this spread
  // through the shim into the guard, flips CHECK_EXPLICIT
  // (CHECK="${MERGE_GUARD_CHECK:-gates}"), and every armed+green shim leg
  // refuses on a name no leg carries.
  //
  // #503 is this delete's narrowness: the list covered GH_MERGE_GUARD,
  // GH_MERGE_GUARD_CHECK and MERGE_GUARD_CHECK, so MERGE_GUARD_VERIFY /
  // MERGE_GUARD_VERIFY_TOOL still rode the spread into every shim leg's guard
  // call — a shim leg on an armed lane graded an arm its fixture never set.
  // Scrub the WHOLE guard-input set through the one shared helper
  // (tests/lib/guard-env.mjs, issues #490/#503) BEFORE the guardEnv spread, so
  // a deliberate stamp in a specific test still wins.
  scrubGuardInputAmbient(env);
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

test("guard: a red beyond the default page-1 truncation refuses — the rollup reads ALL pages (issue #566)", (t) => {
  // GitHub's check-runs endpoint defaults to per_page=30; the guard used to
  // grade the rollup from page 1 only, so a head with >30 check runs could
  // park a red beyond page 1 and PASS ANYGREEN (issue #566). Pin the fix on
  // the issue's literal shape: 45 runs (beyond the default 30), the ONLY
  // red at position 35, every other run green on the SAME head SHA — the
  // rollup must see it and refuse ROLLUPRED, in the same ONE snapshot (a
  // single ?per_page=100 call covers 45 runs).
  const { res, dir } = runGuard(t, "check", ["434"], {
    legs: Array.from({ length: 45 }, (_, i) => {
      const id = i + 1;
      return id === 35 ? leg({ id, name: "job-35", conclusion: "failure" }) : leg({ id, name: `job-${id}` });
    }),
  });
  assert.equal(res.status, 1, `a page-2-of-30 red must refuse even with 34 green page-1 runs (stderr: ${res.stderr})`);
  assert.match(res.stderr, /red check run/);
  assert.match(res.stderr, /job-35/, "the refusal must name the beyond-page-1 red");
  assert.equal(apiCalls(dir), 1, "45 runs arrive in ONE ?per_page=100 call — still one snapshot");
});

test("guard: a red on page 2 of per_page=100 refuses — the rollup pages to total_count (issue #566)", (t) => {
  // The per_page bump alone is not enough: a head with >100 check runs
  // still truncates at 100, so the rollup must keep paging until the
  // fetched count covers the API's total_count. Pin the loop: 145 runs, the
  // ONLY red at position 131 (page 2 at per_page=100), everything else
  // green on the SAME head SHA — the rollup must fetch BOTH pages and
  // refuse ROLLUPRED. When the stub gets an UNPAGED call (the #566
  // regression shape) it serves only the default-30 truncation, so this
  // leg also reds on a guard that stopped requesting per_page.
  const { res, dir } = runGuard(t, "check", ["434"], {
    legs: Array.from({ length: 145 }, (_, i) => {
      const id = i + 1;
      return id === 131 ? leg({ id, name: "job-131", conclusion: "failure" }) : leg({ id, name: `job-${id}` });
    }),
  });
  assert.equal(res.status, 1, `a page-2 red must refuse even with 130 green page-1 runs (stderr: ${res.stderr})`);
  assert.match(res.stderr, /red check run/);
  assert.match(res.stderr, /job-131/, "the refusal must name the page-2 red");
  assert.equal(apiCalls(dir), 2, "the rollup must read page 1 AND page 2 (one snapshot, both pages)");
});

test("guard source: the check-runs rollup requests per_page=100 and sizes itself against total_count (issue #566)", () => {
  const src = readFileSync(GUARD, "utf8");
  assert.match(src, /per_page=100/, "the rollup must request the API's maximum page size");
  assert.doesNotMatch(src, /check-runs" 2>&1\)/, "the bare unpaged call (the #566 truncation) must be gone");
  assert.match(src, /total_count/, "the loop must size itself against the API's total_count");
  assert.match(src, /ONE snapshot/, "the paged fetch is still ONE snapshot, never a poll loop");
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
  //
  // Save-and-RESTORE, never delete (issue #553): this pin sits early in the
  // file, and a `finally { delete … }` here would permanently scrub an armed
  // lane's export out of this test process — every leg declared AFTER the pin
  // (sections 2–6, every shim leg included) would then be graded DE-ARMED
  // even where the lane exports the arm, laundering exactly the failure shape
  // this file pins against (the whole file ran 39-green on an armed lane
  // while the isolated armed+green shim leg ran red). Restore the caller's
  // value so an armed lane stays armed for them; on a clean box the restore
  // IS a delete (it was unset).
  const savedCheckEnv = process.env.MERGE_GUARD_CHECK;
  process.env.MERGE_GUARD_CHECK = "ci/ambient-not-gates";
  try {
    const { res, dir } = runGuard(t, "check", ["434"], { legs: [leg()] });
    assert.equal(res.status, 0, `the harness 'gates' default must beat the ambient name (stderr: ${res.stderr})`);
    assert.match(res.stdout, /GREEN — 'gates' completed\/success/, "the guard still graded the gates leg");
    assert.equal(apiCalls(dir), 1);
  } finally {
    if (savedCheckEnv === undefined) delete process.env.MERGE_GUARD_CHECK;
    else process.env.MERGE_GUARD_CHECK = savedCheckEnv;
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
    delete process.env.MERGE_GUARD_VERIFY;
    delete process.env.MERGE_GUARD_VERIFY_TOOL;
  }
});

test("pin: the shared guard-input scrub covers the full grading set and a deliberate stamp still wins (issue #612 pin)", () => {
  // The raw-spread legs outside runGuard graded only their own hand-rolled
  // deletes; the scrub SET itself had no pin (issue #612 site 2). Arm the
  // lane INSIDE this process, ride the spread the legs ride, and grade the
  // helper's output: none of the guard-input names may survive, and a name
  // stamped AFTER the scrub (the deliberate-arm contract) must win.
  // Save-and-RESTORE around the arm, like every in-process arming pin.
  const saved = {
    check: process.env.MERGE_GUARD_CHECK,
    verify: process.env.MERGE_GUARD_VERIFY,
    tool: process.env.MERGE_GUARD_VERIFY_TOOL,
  };
  process.env.MERGE_GUARD_CHECK = "ci/ambient-not-gates";
  process.env.MERGE_GUARD_VERIFY = "on";
  process.env.MERGE_GUARD_VERIFY_TOOL = "/nonexistent/pr-verification.mjs";
  try {
    // The SET itself is pinned by literal name — iterating GUARD_INPUT_AMBIENT
    // here would let a narrowed const narrow this pin with it (the exact drift
    // this pin exists to refuse).
    assert.deepEqual(
      GUARD_INPUT_AMBIENT,
      ["MERGE_GUARD_CHECK", "MERGE_GUARD_VERIFY", "MERGE_GUARD_VERIFY_TOOL"],
      "the guard-input ambient set must stay the full grading set scripts/merge-guard.sh reads",
    );
    const scrubbed = scrubGuardInputAmbient({ ...process.env, MERGE_GUARD_GH: "/stub/gh" });
    for (const name of ["MERGE_GUARD_CHECK", "MERGE_GUARD_VERIFY", "MERGE_GUARD_VERIFY_TOOL"]) {
      assert.ok(!(name in scrubbed), `the ambient ${name} must not reach the guard's grading`);
    }
    scrubbed.MERGE_GUARD_CHECK = "guard-tests";
    assert.equal(scrubbed.MERGE_GUARD_CHECK, "guard-tests", "a deliberate stamp after the scrub must win");
  } finally {
    if (saved.check === undefined) delete process.env.MERGE_GUARD_CHECK;
    else process.env.MERGE_GUARD_CHECK = saved.check;
    if (saved.verify === undefined) delete process.env.MERGE_GUARD_VERIFY;
    else process.env.MERGE_GUARD_VERIFY = saved.verify;
    if (saved.tool === undefined) delete process.env.MERGE_GUARD_VERIFY_TOOL;
    else process.env.MERGE_GUARD_VERIFY_TOOL = saved.tool;
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
  // Raw process.env spread (issues #487/#612): the ambient guard-input names
  // must not reach the guard's grading here either — the SAME scrub runGuard
  // enforces, through the same helper so the sites can never drift (issue
  // #612: this leg deleted only MERGE_GUARD_VERIFY/_TOOL while its comment
  // claimed every MERGE_GUARD_*, letting an ambient MERGE_GUARD_CHECK ride
  // into the guard outcome-neutrally — exit 2 fires before check-name
  // grading — but the first change that let this leg reach grading would
  // flip it machine-dependently, the #483 shape).
  const env = scrubGuardInputAmbient({
    ...process.env,
    MG_STUB_DIR: dir,
    MERGE_GUARD_GH: path.join(dir, "gh"),
  });
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
  // Same shared scrub (issue #612): an ambient guard-input name rides this
  // raw spread exactly as it rides runGuard's — the helper keeps this leg on
  // the identical contract instead of a narrower hand-rolled delete pair.
  // MERGE_GUARD_GH is set explicitly below (the missing-binary shape), which
  // is why the helper deliberately leaves it alone.
  const env = scrubGuardInputAmbient({
    ...process.env,
    MERGE_GUARD_GH: "/nonexistent/merge-guard-gh",
  });
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
  //
  // Save-and-RESTORE, never delete (the #553 rule; this pin was the last
  // finally-delete holdout — issue #612): a `finally { delete … }` here
  // would permanently scrub an armed lane's GH_MERGE_GUARD export out of
  // this test process — every leg declared AFTER the pin would be graded
  // DE-ARMED even where the lane exports the arm, laundering exactly the
  // failure shape this file pins against. Restore the caller's value so an
  // armed lane stays armed for them; on a clean box the restore IS a delete
  // (it was unset).
  const savedGuardEnv = process.env.GH_MERGE_GUARD;
  process.env.GH_MERGE_GUARD = "on";
  try {
    const { res, dir } = runShim(t, ["pr", "merge", "12", "-m"], { guardEnv: {} });
    assert.equal(res.status, 0, `the harness 'unset' must beat the ambient arm (stderr: ${res.stderr})`);
    assert.match(res.stderr, /merge guard INACTIVE/);
    assert.deepEqual(mergeCapture(dir), ["pr", "merge", "12", "-m"]);
  } finally {
    if (savedGuardEnv === undefined) delete process.env.GH_MERGE_GUARD;
    else process.env.GH_MERGE_GUARD = savedGuardEnv;
  }
});

test("shim: an ambient MERGE_GUARD_CHECK=<other> cannot flip the armed+green shim leg (issue #553 pin)", (t) => {
  // The #553 defect is invisible on a clean dev box: the shim's guard
  // invocation only PREFIXES MERGE_GUARD_GH to its inherited env, and it
  // exports MERGE_GUARD_CHECK only when the driver stamped
  // GH_MERGE_GUARD_CHECK — so an ambient MERGE_GUARD_CHECK on the lane rides
  // runShim's process.env spread through the shim into the guard, flips
  // CHECK_EXPLICIT, and the armed+green leg refuses on a name no leg carries
  // (the #479/#483/#487/#490 shape, fifth carrier). Arm the lane INSIDE this
  // process so the shim env's hermeticity is graded on every machine (the
  // #479/#483 pin shape, applied to the shim's forward). Save-and-RESTORE in
  // the finally: like every pin that arms the lane inside this process, this
  // one must never launder an armed lane's export for the legs after it —
  // the #483 pin's finally-delete did exactly that (issue #553).
  const savedCheckEnv = process.env.MERGE_GUARD_CHECK;
  process.env.MERGE_GUARD_CHECK = "guard-tests";
  try {
    const { res, dir } = runShim(t, ["pr", "merge", "12", "-m"], {
      legs: [leg()],
      guardEnv: { GH_MERGE_GUARD: "on" },
    });
    assert.equal(res.status, 0, `the ambient name must not flip the armed+green shim leg (stderr: ${res.stderr})`);
    assert.match(res.stdout, /GREEN — 'gates' completed\/success/, "the guard still graded the gates leg");
    assert.deepEqual(mergeCapture(dir), ["pr", "merge", "12", "-m"]);
  } finally {
    if (savedCheckEnv === undefined) delete process.env.MERGE_GUARD_CHECK;
    else process.env.MERGE_GUARD_CHECK = savedCheckEnv;
  }
});

test("pin: no leg of this file bare-deletes a lane arm from process.env — restores are save-and-RESTORE (issue #612 pin)", () => {
  // The #553/#612 laundering class as one structural line of defense: a
  // `finally { delete process.env.<lane arm>; }` permanently scrubs an armed
  // lane's export for every leg declared after the arming pin. This pin
  // reads this file's OWN source and refuses the bare-delete STATEMENT shape
  // — a line that is exactly a delete of a lane-arm name from process.env.
  // The legitimate restores never match (they are guarded:
  // `if (saved… === undefined) delete …`), and the harness helpers delete
  // from their local env objects, never from process.env. Scoped to the arm
  // names this branch's pins own and that are save-restored on this base —
  // GH_MERGE_GUARD (the #479 pin, healed by #612), GH_MERGE_GUARD_CHECK and
  // MERGE_GUARD_CHECK (the #483/#553 pins) ; the MERGE_GUARD_VERIFY/_TOOL
  // pair joins the same rule with PR #550's #490 heal, whose #487 pin still
  // carries the older shape on the pre-#550 base.
  const src = readFileSync(fileURLToPath(import.meta.url), "utf8");
  assert.doesNotMatch(
    src,
    /^\s*delete process\.env\.(GH_MERGE_GUARD|GH_MERGE_GUARD_CHECK|MERGE_GUARD_CHECK);?\s*$/m,
    "a bare `delete process.env.<lane arm>` launders an armed lane's export (issues #553/#612) — save-and-restore instead",
  );
});

test("pin: both merge-guard suites scrub the SAME guard-input set from ONE helper (issues #490/#503)", () => {
  // #490/#503 are one defect class: a suite that inherits a guard-input var it
  // means to control passes for the WRONG REASON — and only on a lane that
  // exports it, never on a clean dev box. The two suites were healed at
  // different times in different shapes (runGuard's set, merge-guard-verify's
  // bare `delete env.MERGE_GUARD_VERIFY`, runShim's delete list covering only
  // the GH_MERGE_GUARD pair plus MERGE_GUARD_CHECK), which is exactly how the
  // set drifted per-file in the first place. Both now import
  // tests/lib/guard-env.mjs; this pin grades that AGREEMENT from source, so a
  // re-narrowed per-file copy reds here instead of on an armed lane.
  const files = {
    "merge-guard.test.mjs": readFileSync(fileURLToPath(import.meta.url), "utf8"),
    "merge-guard-verify.test.mjs": readFileSync(path.join(ROOT, "tests", "merge-guard-verify.test.mjs"), "utf8"),
  };
  for (const [name, src] of Object.entries(files)) {
    assert.match(
      src,
      /^import \{[^}]*\bscrubGuardInputAmbient\b[^}]*\} from "\.\/lib\/guard-env\.mjs";$/m,
      `${name} must scrub the guard-input set through the one shared helper (tests/lib/guard-env.mjs)`,
    );
    assert.doesNotMatch(
      src,
      /^const GUARD_INPUT_AMBIENT = /m,
      `${name} must not re-declare the set locally — that is the #490/#503 drift shape`,
    );
    assert.doesNotMatch(
      src,
      /^\s*delete (?:env|baseEnv)\.MERGE_GUARD_(?:CHECK|VERIFY|VERIFY_TOOL);?\s*$/m,
      `${name} still hand-rolls a guard-input delete — scrub the shared set instead (#490/#503)`,
    );
  }
});

test("shim: the in-process lane-arm pins leave this process exactly as they found it (issue #612 pin)", () => {
  // Laundering detector, declared AFTER every pin above that arms a lane
  // name in-process (#483, #487, #479, #553, the #612 scrub pin): each of
  // those must RESTORE the caller's value in its finally — never
  // finally-delete it — or an armed lane's export is scrubbed out of this
  // test process and every leg after the arming pin is graded DE-ARMED (the
  // #553 receipt: the whole file ran 39-green on an armed lane while the
  // isolated armed+green shim leg ran red). Keep this leg after the arming
  // pins; moving it above them makes it vacuous. On a clean box it is
  // vacuous by construction (unset restores to unset); its teeth are the
  // armed lanes this fleet demonstrably runs. Scoped like the structural pin
  // above to the arms that are save-restored on this base — the
  // MERGE_GUARD_VERIFY/_TOOL names stay in the capture so their join with
  // PR #550's heal is a one-line scope extension.
  const graded = ["GH_MERGE_GUARD", "GH_MERGE_GUARD_CHECK", "MERGE_GUARD_CHECK"];
  for (const name of graded) {
    assert.equal(process.env[name], LANE_ARMS_AT_LOAD[name], `an arming pin laundered the lane's ${name} export out of this process`);
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
