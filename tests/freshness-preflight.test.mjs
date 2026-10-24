// freshness-preflight.test.mjs — pins the agent-side freshness preflight
// contract block (factory#840): every dispatched task carries the exact
// merge-base/rebase/same-scope procedure, so a stale-base PR cannot mint a
// duplicate of already-landed work without the agent being told to check.
// The deterministic half (ship-changes.sh open_pr preflight) is behavior-
// pinned in ship-changes.test.mjs.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { spawnSync, execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SHIPPER = path.join(ROOT, "scripts", "ship-changes.sh");
const driverSrc = readFileSync(path.join(ROOT, "scripts", "run-dsh-agent.sh"), "utf8");

test("the driver task carries the freshness-preflight block (factory#840)", () => {
  assert.match(driverSrc, /## Freshness preflight — re-check the base before you mint the PR \(factory#840\)/,
    "the block heading, with the issue ref");
  assert.match(driverSrc, /git merge-base HEAD origin\/BASE/, "the merge-base command");
  assert.match(driverSrc, /git rev-parse origin\/BASE/, "the base-tip command");
  assert.match(driverSrc, /git rev-list --count \\?\$\{?mb/, "the behind count");
  assert.match(driverSrc, /git rebase origin\/BASE/, "the rebase cure");
  assert.match(driverSrc, /--unshallow/, "the shallow-clone escape hatch");
  assert.match(driverSrc, /same-scope check/i, "the same-scope overlap fold");
  assert.match(driverSrc, /adopt the landed PR as vehicle of record/, "the adopt-don't-duplicate rule");
});

test("the block is appended UNCONDITIONALLY (outside the REPLY_TARGET guard, like the standing contract)", () => {
  const append = driverSrc.indexOf('TASK="${TASK}\n\n## Freshness preflight');
  const guard = driverSrc.indexOf('if [ "${REPLY_TARGET:-}" != "" ]; then');
  assert.ok(append > -1, "the freshness append exists");
  assert.ok(guard > -1, "the REPLY_TARGET guard exists");
  assert.ok(append < guard, "the freshness append precedes the REPLY_TARGET guard");
});

test("the deterministic half exists: ship-changes.sh mints the PR only after its preflight", () => {
  const shipper = readFileSync(SHIPPER, "utf8");
  assert.match(shipper, /freshness_preflight\(\)/, "the preflight function");
  assert.match(shipper, /FRESH="\$\(freshness_preflight "\$head_b"\)"/,
    "open_pr runs the preflight BEFORE gh pr create");
  const createIdx = shipper.indexOf("gh pr create --repo");
  const freshIdx = shipper.indexOf('FRESH="$(freshness_preflight');
  assert.ok(freshIdx > -1 && createIdx > freshIdx, "preflight precedes the mint");
  assert.match(shipper, /force-with-lease/, "the re-push never clobbers blindly");
  assert.match(shipper, /freshness UNVERIFIED/, "degrade names itself instead of failing the ship");
});

// Issue #526: `git rev-parse <ref>` WITHOUT --verify does not fail quiet on an
// unknown ref — it echoes the literal argument to stdout and exits 128, and the
// `|| true` swallowed the status, so a missing tracking ref captured the string
// "origin/main" as the tip (non-empty garbage the emptiness guard cannot see
// through). The pin runs the REAL function, extracted verbatim from the script
// (a rename or move fails the extraction loudly), against a clone whose
// remote.origin.fetch refspec is empty: `git fetch origin main` then succeeds
// and writes FETCH_HEAD only, never refs/remotes/origin/main — the exact shape
// from the ticket's repro.
test("issue #526: a missing origin/<base> ref degrades NAMING the ref — never a garbage tip", () => {
  const shipper = execFileSync("bash",
    ["-c", `sed -n '/^freshness_preflight() {/,/^}/p' "${SHIPPER}"`], { encoding: "utf8" });
  assert.match(shipper, /freshness_preflight\(\)/, "the extraction found the function");
  const dir = mkdtempSync(path.join(tmpdir(), "freshness-526-"));
  try {
    const bare = path.join(dir, "remote.git");
    const work = path.join(dir, "work");
    const git = (args, cwd) => {
      const r = spawnSync("git", args, { cwd, encoding: "utf8" });
      assert.equal(r.status, 0, `fixture git ${args.join(" ")} failed: ${r.stderr}`);
      return r;
    };
    git(["init", "--bare", "-q", "-b", "main", bare], dir);
    git(["init", "-q", "-b", "master", work], dir);
    git(["config", "user.email", "t@t"], work);
    git(["config", "user.name", "t"], work);
    writeFileSync(path.join(work, "a.txt"), "base\n");
    git(["add", "a.txt"], work);
    git(["commit", "-q", "-m", "base"], work);
    git(["remote", "add", "origin", bare], work);
    git(["push", "-q", "origin", "master:main"], work);
    // No tracking ref on the way back in: the fetch below succeeds (rc 0) and
    // still leaves refs/remotes/origin/main absent (the push above may have
    // opportunistically written one, so drop it).
    git(["config", "--unset", "remote.origin.fetch"], work);
    git(["update-ref", "-d", "refs/remotes/origin/main"], work);
    const res = spawnSync("bash", ["-c", `set -uo pipefail\n${shipper}\nfreshness_preflight master`], {
      cwd: work, encoding: "utf8", env: { ...process.env, DSH_SHIP_BASE: "main" },
    });
    assert.equal(res.status, 0, `the preflight never fails the ship:\n${res.stderr}`);
    assert.match(res.stdout, /freshness UNVERIFIED \(origin\/main unresolvable\)/,
      "the miss names the REF — the pre-fix run captured the garbage tip and reported the merge-base arm instead");
    assert.doesNotMatch(res.stdout, /merge-base unresolvable/,
      "the garbage-tip arm is gone: a missing ref is a REV-PARSE miss, not a merge-base miss");
    assert.match(res.stderr, /rev-parse --verify failed/,
      "the worker log names the failing read, so the degrade is diagnosable");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- issue #524: disclose the GRADED tip, and prove the graph connects it ---
//
// Under a bounded-deepen clone the tracking ref can resolve to a phantom tip,
// so `behind=0` becomes a claim about a tree that is not the merge tree, and
// the preflight's own output ("rebased on origin/main (366a954)") describes
// history nobody graded. The ticket's fallback direction is the one pinned
// here: every outcome states the visible tip's SHA and its distance, so a
// reviewer can see the staleness the preflight used to hide; and a merge-base
// the tip cannot provably reach (the #651 graft class) ships UNVERIFIED
// rather than "fresh".

/** A bare remote with main@A pushed, plus a work clone sitting on that commit
 * with a `feature` branch at the same commit (never checked out). Returns the
 * dir and the git runner; the caller pushes more or runs the preflight. */
function stagePreflightFixture(t) {
  const dir = mkdtempSync(path.join(tmpdir(), "freshness-524-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bare = path.join(dir, "remote.git");
  const work = path.join(dir, "work");
  const other = path.join(dir, "other");
  const git = (args, cwd) => {
    const r = spawnSync("git", args, { cwd, encoding: "utf8" });
    assert.equal(r.status, 0, `fixture git ${args.join(" ")} failed: ${r.stderr}`);
    return r;
  };
  git(["init", "--bare", "-q", "-b", "main", bare], dir);
  git(["init", "-q", "-b", "main", work], dir);
  git(["config", "user.email", "t@t"], work);
  git(["config", "user.name", "t"], work);
  git(["remote", "add", "origin", bare], work);
  writeFileSync(path.join(work, "a.txt"), "base\n");
  git(["add", "a.txt"], work);
  git(["commit", "-q", "-m", "base"], work);
  git(["push", "-q", "origin", "main"], work);
  git(["branch", "-q", "feature"], work);
  // A second clone (shared history, so it can fast-forward the bare's main).
  git(["clone", "-q", bare, other], dir);
  git(["config", "user.email", "t@t"], other);
  git(["config", "user.name", "t"], other);
  return { dir, work, other, git };
}

/** Run the REAL freshness_preflight (extracted verbatim: a rename or move
 * fails this loudly) inside the fixture clone. */
function runPreflight(shipper, cwd, headBranch) {
  const res = spawnSync("bash",
    ["-c", `set -uo pipefail\n${shipper}\nfreshness_preflight ${headBranch}`],
    { cwd, encoding: "utf8", env: { ...process.env, DSH_SHIP_BASE: "main" } });
  assert.equal(res.status, 0, `the preflight never fails the ship:\n${res.stderr}`);
  return res;
}

const extractPreflight = () => execFileSync("bash",
  ["-c", `sed -n '/^freshness_preflight() {/,/^}/p' "${SHIPPER}"`], { encoding: "utf8" });

test("issue #524: the fresh arm DISCLOSES the graded tip and its distance — no silent fresh", (t) => {
  const shipper = extractPreflight();
  const { work, git } = stagePreflightFixture(t);
  git(["fetch", "-q", "origin"], work);
  const tip = git(["rev-parse", "origin/main"], work).stdout.trim();
  const res = runPreflight(shipper, work, "feature");
  assert.match(res.stdout, new RegExp(`fresh \\(origin/main @ ${tip.slice(0, 7)}, behind=0\\)`),
    `the fresh arm names the tip it graded (got: ${JSON.stringify(res.stdout.trim())})`);
});

test("issue #524: the stale arm DISCLOSES the base tip it graded, not just the distance", (t) => {
  const shipper = extractPreflight();
  const { work, other, git } = stagePreflightFixture(t);
  // Advance main behind the work clone's back: work still sits at A.
  writeFileSync(path.join(other, "b.txt"), "landed\n");
  git(["add", "b.txt"], other);
  git(["commit", "-q", "-m", "main moves on"], other);
  git(["push", "-q", "origin", "main"], other);
  git(["fetch", "-q", "origin"], work);
  const tip = git(["rev-parse", "origin/main"], work).stdout.trim();
  const res = runPreflight(shipper, work, "feature");
  assert.match(res.stdout,
    new RegExp(`stale, no rebase attempted \\(feature was 1 behind origin/main @ ${tip.slice(0, 7)}\\)`),
    `the stale arm names the tip AND the distance (got: ${JSON.stringify(res.stdout.trim())})`);
});

test("issue #524: the merge-base must be provably connected to the tip before any count grades it", () => {
  const shipper = readFileSync(SHIPPER, "utf8");
  assert.match(shipper, /git merge-base --is-ancestor "\$mb" "\$tip"/,
    "the anti-graft connectivity proof is present");
  assert.match(shipper, /freshness UNVERIFIED \(merge-base not connected to origin\/\$base @ \$tip7\)/,
    "an unconnected merge-base degrades to a typed UNVERIFIED, never a fresh claim");
  const proofIdx = shipper.indexOf('git merge-base --is-ancestor "$mb" "$tip"');
  const countIdx = shipper.indexOf('git rev-list --count "$mb..origin/$base"');
  assert.ok(proofIdx > -1 && countIdx > proofIdx,
    "the proof runs BEFORE the behind count (a severed graph must never reach the count)");
  const freshIdx = shipper.indexOf('echo "fresh (origin/$base @ $tip7, behind=0)"');
  assert.ok(freshIdx > proofIdx, "the fresh disclosure sits behind the proof too");
});
