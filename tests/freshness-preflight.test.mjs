// freshness-preflight.test.mjs — pins BOTH halves of the freshness
// preflight contract (factory#840; issue #524 for the connectivity half):
// every dispatched task carries the exact merge-base/connectivity/rebase/
// same-scope procedure, so a stale-base PR cannot mint a duplicate of
// already-landed work without the agent being told to check — and the
// deterministic half (ship-changes.sh open_pr preflight) is pinned here
// too, in source AND behavior: a bounded-deepen clone must never grade a
// phantom base tip (#495 shipped "rebased on origin/main (366a954)" while
// its fork point was #517-era 0f46679).

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const driverSrc = readFileSync(path.join(ROOT, "scripts", "run-dsh-agent.sh"), "utf8");
const SHIPPER = path.join(ROOT, "scripts", "ship-changes.sh");
const shipperSrc = readFileSync(SHIPPER, "utf8");

// Same construction as ship-changes.test.mjs (not imported: importing a
// test file runs its suite): drop exactly the transient driver-shim dirs so
// the shipper under test drives REAL git, and keep the rest of the ambient
// PATH (tests-lint forbids hard-coding system dirs).
const ambientPathWithoutDriverShims = (p = process.env.PATH || "") =>
  p
    .split(path.delimiter)
    .filter((dir) => !path.basename(dir).startsWith("dsh-shim."))
    .join(path.delimiter);

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
  const shipper = readFileSync(path.join(ROOT, "scripts", "ship-changes.sh"), "utf8");
  assert.match(shipper, /freshness_preflight\(\)/, "the preflight function");
  assert.match(shipper, /FRESH="\$\(freshness_preflight "\$head_b"\)"/,
    "open_pr runs the preflight BEFORE gh pr create");
  const createIdx = shipper.indexOf("gh pr create --repo");
  const freshIdx = shipper.indexOf('FRESH="$(freshness_preflight');
  assert.ok(freshIdx > -1 && createIdx > freshIdx, "preflight precedes the mint");
  assert.match(shipper, /force-with-lease/, "the re-push never clobbers blindly");
  assert.match(shipper, /freshness UNVERIFIED/, "degrade names itself instead of failing the ship");
});

// ── issue #524: the preflight must PROVE base-tip currency before grading it ──

test("the driver block proves base-tip connectivity and refuses the unprovable (#524)", () => {
  assert.ok(driverSrc.includes("git merge-base --is-ancestor \\$mb \\$tip"),
    "the connectivity proof (merge-base --is-ancestor)");
  assert.ok(driverSrc.includes("--deepen=\\$d"),
    "the bounded deepen-until-connected ladder");
  assert.ok(driverSrc.includes("PROVE the tip is CONNECTED before trusting any count"),
    "the proof-before-count rule, named");
  assert.ok(driverSrc.includes("freshness UNVERIFIED (tip <sha>)"),
    "the claim shape when currency cannot be proven");
  assert.ok(
    driverSrc.includes("NEVER rebase onto, or declare fresh against, a tip you"),
    "the refusal rule: no cure, no fresh claim, on an unproven tip");
});

test("the driver block discloses the graded tip in the PR body (#524)", () => {
  assert.ok(driverSrc.includes("freshness: origin/BASE @"),
    "the graded-tip disclosure shape");
  assert.ok(driverSrc.includes("A claim\n   without the tip SHA cannot be audited by review"),
    "the unauditable-claim rationale (#495's phantom 366a954)");
});

test("the shipper fetches the base ref EXPLICITLY, so a single-branch --depth clone still resolves a tip (#524)", () => {
  // The worker's production clone is --depth 1 (single-branch): a bare
  // `git fetch origin <base>` fills only FETCH_HEAD there and the tip read
  // resolves nothing — the refspec must write refs/remotes/origin/<base>.
  assert.match(
    shipperSrc,
    /git fetch origin "\+refs\/heads\/\$base:refs\/remotes\/origin\/\$base"/,
    "the initial fetch writes the tracking ref");
});

test("the shipper proves connectivity, deepens bounded, and skips the cure on an unproven tip (#524)", () => {
  assert.match(shipperSrc, /git merge-base --is-ancestor "\$mb" "\$tip"/,
    "the connectivity proof");
  assert.match(shipperSrc, /git fetch --deepen="\$step" origin "\+refs\/heads\/\$base:refs\/remotes\/origin\/\$base"/,
    "the #519-shaped bounded deepen ladder, same explicit refspec");
  const ladder = shipperSrc.indexOf("for step in 1 2 4");
  assert.ok(ladder > -1, "the ladder runs at most 1+2+4 — budget, not unbounded deepen");
  const refusal = shipperSrc.indexOf("freshness UNVERIFIED (unconnected base tip");
  assert.ok(refusal > -1, "the refusal names the tip it could not connect");
  const cure = shipperSrc.indexOf('git rebase "origin/$base"');
  assert.ok(cure > refusal, "the cure is UNREACHABLE past the refusal arm — no rebase on an unproven tip");
  assert.match(shipperSrc, /fresh \(origin\/\$base @ \$tip7, behind=0\)/,
    "the fresh path discloses the graded tip (auditable freshness claim)");
  assert.match(shipperSrc, /rebased onto origin\/\$base @ \$tip7 \(was \$behind behind\)/,
    "the cure discloses the tip it rebased onto");
});

// ── behavior: the extracted function driven against hermetic fixtures ──

const freshnessFnSource = () => {
  const start = shipperSrc.indexOf("freshness_preflight() {");
  assert.ok(start > -1, "the function exists");
  const end = shipperSrc.indexOf("\n}", start);
  assert.ok(end > -1, "the function closes at column 0");
  return shipperSrc.slice(start, end + 2);
};

/** Build a fixture remote + work clone; run freshness_preflight in it.
 * opts: forkBehind (dsh/x forked N commits below the main tip), depth
 * (clone --depth, 0 = complete), advanceMain (commits added to main after
 * the fork), side (dsh/x forks from a side commit main can never provide —
 * the truly severed graph). Returns { dir, work, beforeHead, stdout, ... }. */
const runPreflight = ({ forkBehind = 0, depth = 0, advanceMain = 0, side = false } = {}) => {
  const dir = mkdtempSync(path.join(tmpdir(), "freshness-preflight-"));
  const script = `
set -eu
T=\${1:?}; FORK=\${2:?}; DEPTH=\${3:?}; ADV=\${4:?}; SIDE=\${5:?}
git init -q --bare "\$T/b.git"
git init -q "\$T/s"
cd "\$T/s"
git config user.email t@example.test
git config user.name t
for i in 1 2 3 4 5 6; do echo "\$i" > "f\$i.txt"; git add "f\$i.txt"; git commit -qm "c\$i"; done
if [ "\$SIDE" -gt 0 ]; then
  git checkout -q main~4
  git checkout -qb side
  for i in 1 2 3 4 5 6 7 8 9 10 11; do echo "s\$i" > "s\$i.txt"; git add "s\$i.txt"; git commit -qm "s\$i"; done
fi
if [ "\$SIDE" -gt 0 ]; then
  git checkout -qb dsh/x
else
  if [ "\$FORK" -gt 0 ]; then git checkout -q "main~\$FORK"; fi
  git checkout -qb dsh/x
fi
echo x > x.txt
git add x.txt
git commit -qm d1
git checkout -q main
git remote add o "\$T/b.git"
git push -q o main dsh/x
if [ "\$SIDE" -gt 0 ]; then git push -q o side; fi
if [ "\$ADV" -gt 0 ]; then
  git clone -q "\$T/b.git" "\$T/adv"
  cd "\$T/adv"
  git config user.email t@example.test
  git config user.name t
  for i in $(seq 1 "\$ADV"); do echo "a\$i" > "a\$i.txt"; git add "a\$i.txt"; git commit -qm "a\$i"; done
  git push -q origin main
fi
if [ "\$DEPTH" -gt 0 ]; then
  git clone -q --depth "\$DEPTH" -b dsh/x "file://\$T/b.git" "\$T/w"
else
  git clone -q -b dsh/x "file://\$T/b.git" "\$T/w"
fi
cd "\$T/w"
git config user.email t@example.test
git config user.name t
git rev-parse HEAD
`;
  const setup = spawnSync("bash", ["-c", script, "setup", dir, String(forkBehind), String(depth), String(advanceMain), String(side ? 1 : 0)],
    { encoding: "utf8", env: { ...process.env, PATH: ambientPathWithoutDriverShims() } });
  assert.equal(setup.status, 0, `fixture setup failed: ${setup.stderr}`);
  const beforeHead = setup.stdout.trim();
  const fnFile = path.join(dir, "freshness-fn.sh");
  writeFileSync(fnFile, freshnessFnSource());
  const run = spawnSync("bash", ["-c",
    `set -u\nsource "${fnFile}"\nDSH_SHIP_BASE=main freshness_preflight dsh/x`],
    { cwd: path.join(dir, "w"), encoding: "utf8",
      env: { ...process.env, PATH: ambientPathWithoutDriverShims() } });
  return { dir, work: path.join(dir, "w"), beforeHead, stdout: run.stdout, stderr: run.stderr, status: run.status };
};

test("behavior: a fresh complete clone discloses the graded tip and stays silent otherwise (#524)", () => {
  const r = runPreflight({ forkBehind: 0 });
  try {
    assert.match(r.stdout.trim(), /^fresh \(origin\/main @ [0-9a-f]{7}, behind=0\)$/,
      "the fresh note carries the graded tip SHA + distance");
  } finally {
    rmSync(r.dir, { recursive: true, force: true });
  }
});

test("behavior: a stale complete clone is cured and the note names the tip + distance (#524)", () => {
  const r = runPreflight({ forkBehind: 0, advanceMain: 2 });
  try {
    assert.match(r.stdout.trim(), /rebased onto origin\/main @ [0-9a-f]{7} \(was 2 behind\)/,
      "the cure note names the graded tip and the distance");
    const after = spawnSync("git", ["rev-parse", "HEAD~1"],
      { cwd: r.work, encoding: "utf8", env: { ...process.env, PATH: ambientPathWithoutDriverShims() } });
    const tip = spawnSync("git", ["rev-parse", "origin/main"],
      { cwd: r.work, encoding: "utf8", env: { ...process.env, PATH: ambientPathWithoutDriverShims() } });
    assert.equal(after.stdout.trim(), tip.stdout.trim(), "the head now sits on the graded base tip");
  } finally {
    rmSync(r.dir, { recursive: true, force: true });
  }
});

test("behavior: a shallow clone is still cured — the graph is connected before any count grades it (#524)", () => {
  // depth 2, fork 3 below the tip: inside the 1/2/4 ladder's reach whatever
  // path the fetch takes (some gits unshallow on the explicit refspec, some
  // need the ladder) — the outcome must be the cure either way.
  const r = runPreflight({ forkBehind: 3, depth: 2 });
  try {
    assert.match(r.stdout.trim(), /rebased onto origin\/main @ [0-9a-f]{7} \(was 3 behind\)/,
      "the shallow clone is cured with the graded tip disclosed");
  } finally {
    rmSync(r.dir, { recursive: true, force: true });
  }
});

test("behavior: a severed head (fork beyond the ladder's reach) cannot be graded and is NOT cured (#524)", () => {
  // The #524 phantom in its honest form: the head's fork point sits 12
  // commits of side history past anything main provides, and the depth-1
  // clone severs what it locally holds — the 1/2/4 ladder (reach 7) cannot
  // connect that graph, so the only honest outcome is the named UNVERIFIED
  // degrade, branch untouched.
  const r = runPreflight({ side: true, depth: 1 });
  try {
    assert.match(r.stdout.trim(), /freshness UNVERIFIED \(merge-base unresolvable\)/,
      "the ungradeable graph names itself instead of claiming fresh");
    const head = spawnSync("git", ["rev-parse", "HEAD"],
      { cwd: r.work, encoding: "utf8", env: { ...process.env, PATH: ambientPathWithoutDriverShims() } });
    assert.equal(head.stdout.trim(), r.beforeHead,
      "no cure ran on an ungradeable graph — HEAD untouched");
  } finally {
    rmSync(r.dir, { recursive: true, force: true });
  }
});
