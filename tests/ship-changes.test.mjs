// ship-changes.test.mjs — hermetic tests for scripts/ship-changes.sh, the
// deterministic shipper shared by the legacy workflow AND the decoupled
// worker. No network: a local bare remote + a `gh` shim (PATH-prepended,
// the blessed construction) stand in for GitHub. The shipper must be the
// ONLY pusher: it creates the branch, commits the dirty work, pushes, and
// opens the PR through the shim — and its PR body is the SCRUBBED agent
// output, never the raw file (a planted token must come out [redacted]).

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, readFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SHIPPER = path.join(ROOT, "scripts", "ship-changes.sh");

// The dsh driver (run-dsh-agent.sh §2c) installs gh/git scrub shims into a
// per-process "$TMPDIR/dsh-shim.<pid>" dir at the FRONT of its child's PATH.
// When this suite runs inside such a child — an agent session running local
// gates — process.env.PATH carries those dirs WITHOUT the shim's env contract
// (GIT_SCRUB_REAL / SCRUB_SCRIPT are the driver's own exports, not ours), so
// a child inheriting the ambient PATH resolves `git` to the env-less shim,
// which fails loud ("GIT_SCRUB_REAL not set"), every git check in the shipper
// dies, and the note degrades to "nothing to ship — git checks could not run
// (UNVERIFIED)": no push, no branch. That is the long-"ambient" ship-changes
// red on agent-run lanes that clean CI cells never see (gates run
// 34803136058 follow-up). The shipper under test is the deterministic pusher
// and must drive REAL git (plus the stub gh), so drop exactly the transient
// driver-shim dirs and keep the rest of the ambient PATH — the tests-lint
// rule forbids hard-coding system dirs, and lane-installed CLIs must still
// resolve.
export const ambientPathWithoutDriverShims = (p = process.env.PATH || "") =>
  p
    .split(path.delimiter)
    .filter((dir) => !path.basename(dir).startsWith("dsh-shim."))
    .join(path.delimiter);

const git = (args, opts = {}) => spawnSync("git", args, { encoding: "utf8", ...opts });

// issue #623: a READ the asserts depend on must itself go red when it fails.
// spawnSync NEVER throws (the #582 receipt): `git(["ls-remote", ...]).stdout`
// comes back "" on a non-zero exit or a spawn-level error, so a negative
// absence-assert (`!refs.includes("dsh/auto-")`) passed VACUOUSLY — the suite
// stayed green while the probe read nothing, and a regression that both
// pushed a branch it should not AND broke the probe would have passed. Reads
// the asserts depend on assert status first and throw naming the exact call.
// (Composes with PR #589's `gitSetup`, the fixture-construction half: that
// helper guards fixture SETUP, this one guards runtime probes of the
// shipper's EFFECT — neither subsumes the other.)
const gitRead = (args, opts = {}) => {
  const r = spawnSync("git", args, { encoding: "utf8", ...opts });
  if (r.error || r.status !== 0) {
    throw new Error(
      `assert probe failed: git ${args.join(" ")} (exit ${r.status ?? "?"})\n${r.error ?? r.stderr}`,
    );
  }
  return r;
};

/** Build a fixture: bare remote + a work clone, plus a gh shim. Returns
 * paths the test drives through the shipper. */
const fixture = () => {
  const dir = mkdtempSync(path.join(tmpdir(), "ship-changes-test-"));
  const bare = path.join(dir, "remote.git");
  const work = path.join(dir, "work");
  const cache = path.join(dir, "cache");
  const shim = path.join(dir, "shim");
  const logs = path.join(dir, "logs");
  mkdirSync(cache, { recursive: true });
  mkdirSync(shim, { recursive: true });
  mkdirSync(logs, { recursive: true });

  git(["init", "--bare", "-q", bare], { cwd: dir });
  // Issue #575: pin the branch (-b master) AND assert the status — a bare
  // `git init` takes init.defaultBranch from the lane, and this fixture then
  // pushes a by-name `master`; spawnSync never throws, so a failed init would
  // be silent here. gitRead is the suite's status-asserting probe.
  gitRead(["init", "-q", "-b", "master", work]);
  git(["config", "user.name", "tester"], { cwd: work });
  git(["config", "user.email", "tester@example.com"], { cwd: work });
  writeFileSync(path.join(work, "a.txt"), "base content\n");
  git(["add", "a.txt"], { cwd: work });
  git(["commit", "-q", "-m", "base"], { cwd: work });
  git(["remote", "add", "origin", bare], { cwd: work });
  git(["push", "-q", "-u", "origin", "master"], { cwd: work });
  const head = git(["rev-parse", "HEAD"], { cwd: work }).stdout.trim();

  // gh shim: logs every call; answers pr create / pr view; copies the
  // --body-file it is handed for the scrub assertion.
  const ghLog = path.join(logs, "gh.log");
  const prBodyOut = path.join(logs, "pr-body.md");
  writeFileSync(path.join(shim, "gh"), `#!/usr/bin/env bash
echo "gh: $*" >> "$GH_LOG"
case " $* " in
  *" pr create "*)
    prev=""
    for a in "$@"; do
      if [ "$prev" = "--body-file" ]; then cp "$a" "$PR_BODY_OUT" 2>/dev/null || true; fi
      prev="$a"
    done
    echo "https://github.com/owner/repo/pull/999" ;;
  *" --json number "*) echo 99 ;;
  *" --json state "*) echo OPEN ;;
  *" --json milestone "*)
    # issue #185: the milestone lookup behind the shipper's carry step
    prev=""
    TICKET=""
    for a in "$@"; do
      if [ "$prev" = "view" ]; then TICKET="$a"; fi
      prev="$a"
    done
    case "$TICKET" in
      185) echo "alpha-sweep" ;;
      *)   echo "null" ;;
    esac ;;
  *" pr edit "*)
    echo "https://github.com/owner/repo/pull/999" ;;
  *) exit 0 ;;
esac
`);
  spawnSync("chmod", ["+x", path.join(shim, "gh")]);

  return { dir, bare, work, cache, shim, logs, ghLog, prBodyOut, head,
    env: (extra = {}) => ({
      GH_TOKEN: "fake-token", DSH_SHIP_REPO: "owner/repo", DSH_RUN_ID: "testrun",
      DSH_RUN_ATTEMPT: "1", DSH_WORKTREE: work, DSH_AGENT_TOOLKIT_DIR: ROOT,
      DSH_SHIP_CACHE: cache, DSH_AGENT_OUTPUT: path.join(cache, "dsh-agent-output.txt"),
      DSH_SHIP_NOTE_FILE: path.join(cache, "ship-note.txt"),
      DSH_PR_NUM_FILE: path.join(cache, "pr-num"),
      DSH_TASK_TITLE: "task title",
      REVIEW_WORKFLOW: "",
      GH_LOG: ghLog, PR_BODY_OUT: prBodyOut,
      PATH: `${shim}${path.delimiter}${ambientPathWithoutDriverShims()}`,
      ...extra,
    }) };
};

test("shipper commits dirty work, pushes a dsh/auto branch, opens a PR through gh", () => {
  const f = fixture();
  try {
    // before-state (what the workflow/worker captures pre-agent)
    writeFileSync(path.join(f.cache, "dsh-before-sha"), f.head);
    writeFileSync(path.join(f.cache, "dsh-before-dsh-branches"), "");
    writeFileSync(path.join(f.cache, "dsh-before-open-prs"), "");
    // the agent's output, with a planted credential the PR body must scrub
    // and a planted date it must KEEP (the PR body is authored prose —
    // issue #152: a default-mode pre-scrub minted [redacted:date] into the
    // STORED GitHub text, the ebowwa/FleetTower#301 class)
    writeFileSync(path.join(f.cache, "dsh-agent-output.txt"),
      "done — summary: fixed the bug. landed 2026-09-26 in one pass. token ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ123456 used\n");
    // the agent left DIRTY work behind
    writeFileSync(path.join(f.work, "a.txt"), "base content\nagent changed it\n");

    const res = spawnSync("bash", [SHIPPER], { encoding: "utf8", env: f.env() });
    assert.equal(res.status, 0, res.stderr);

    // pushed branch exists on the remote
    const refs = gitRead(["ls-remote", f.bare]).stdout;
    assert.match(refs, /refs\/heads\/dsh\/auto-rtestruna1/);

    // PR was "opened" through the shim and its number recorded
    const log = readFileSync(f.ghLog, "utf8");
    assert.match(log, /pr create/);
    assert.equal(readFileSync(path.join(f.cache, "pr-num"), "utf8").trim(), "99");

    // ship note says shipped
    const note = readFileSync(path.join(f.cache, "ship-note.txt"), "utf8");
    assert.match(note, /shipped/);

    // the PR body carries the SCRUBBED output: [redacted], never the token —
    // and the prose date VERBATIM (keep-dates at the worker hop; the shim's
    // own keep-dates pass is pinned by scrub-shims.test.mjs, so the two
    // hops compose into the posted body)
    const body = readFileSync(f.prBodyOut, "utf8");
    assert.match(body, /fixed the bug/);
    assert.match(body, /\[redacted:token\]/);
    assert.ok(!body.includes("ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ123456"));
    assert.match(body, /landed 2026-09-26 in one pass/,
      "the PR body is authored prose: the date survives verbatim (issue #152)");
    assert.ok(!body.includes("[redacted:date]"),
      "no date placeholder minted into stored PR text (ebowwa/FleetTower#301 class)");
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});
test("scrubber failure aborts the ship fail-closed (issue #162): exit 3, no push, no PR, stderr surfaced", () => {
  const f = fixture();
  try {
    // A stub toolkit whose scrub-output.mjs fails like a real scrubber
    // fault: nonzero exit, typed error on stderr. DSH_AGENT_TOOLKIT_DIR is
    // the sanctioned seam — the shipper resolves the scrubber through it.
    const stubTk = path.join(f.dir, "stub-toolkit");
    mkdirSync(path.join(stubTk, "scripts"), { recursive: true });
    writeFileSync(path.join(stubTk, "scripts", "scrub-output.mjs"),
      "#!/usr/bin/env bash\necho 'scrub-output: simulated scrubber fault (issue #162 pin)' >&2\nexit 9\n");
    spawnSync("chmod", ["+x", path.join(stubTk, "scripts", "scrub-output.mjs")]);

    writeFileSync(path.join(f.cache, "dsh-before-sha"), f.head);
    writeFileSync(path.join(f.cache, "dsh-before-dsh-branches"), "");
    writeFileSync(path.join(f.cache, "dsh-before-open-prs"), "");
    // The agent's output carries a credential: with the scrubber down
    // NOTHING may reach GitHub. The pre-#162 `|| true` shipped a
    // header-only PR body silently; the fix aborts BEFORE the push.
    writeFileSync(path.join(f.cache, "dsh-agent-output.txt"),
      "done — token ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ123456 used\n");
    writeFileSync(path.join(f.work, "a.txt"), "base content\nagent changed it\n");

    const res = spawnSync("bash", [SHIPPER], {
      encoding: "utf8", env: f.env({ DSH_AGENT_TOOLKIT_DIR: stubTk }),
    });
    assert.equal(res.status, 3, `expected the fail-closed exit 3, got ${res.status}\n${res.stderr}`);

    // the scrubber's typed stderr surfaces to the step log, not /dev/null
    assert.match(res.stderr, /scrub FAILED/);
    assert.match(res.stderr, /simulated scrubber fault/);

    // abort happened BEFORE any GitHub write: no branch pushed, no PR opened
    const refs = gitRead(["ls-remote", f.bare]).stdout;
    assert.ok(!refs.includes("dsh/auto-"), "a scrubber failure must abort before the push");
    assert.ok(!existsSync(f.ghLog), "no PR may be opened when the scrubber failed");

    // the ship note records the degradation visibly
    const note = readFileSync(path.join(f.cache, "ship-note.txt"), "utf8");
    assert.match(note, /scrub failed/);
    assert.match(note, /NOT shipped/);
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});


test("clean worktree → nothing to ship, no PR opened, no branch created", () => {
  const f = fixture();
  try {
    writeFileSync(path.join(f.cache, "dsh-before-sha"), f.head);
    writeFileSync(path.join(f.cache, "dsh-before-dsh-branches"), "");
    writeFileSync(path.join(f.cache, "dsh-before-open-prs"), "");
    writeFileSync(path.join(f.cache, "dsh-agent-output.txt"), "nothing changed\n");

    const res = spawnSync("bash", [SHIPPER], { encoding: "utf8", env: f.env() });
    assert.equal(res.status, 0, res.stderr);
    const note = readFileSync(path.join(f.cache, "ship-note.txt"), "utf8");
    assert.match(note, /nothing to ship/);
    const refs = gitRead(["ls-remote", f.bare]).stdout;
    assert.ok(!refs.includes("dsh/auto-"));
    // gh is never called on a clean tree (no before-open-prs diffs, no
    // PRs to open) — the shim's log file must not even exist.
    assert.ok(!existsSync(f.ghLog), "no PR should be opened when nothing changed");
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test("missing repo context fails loudly (never ships to an unknown repo)", () => {
  const f = fixture();
  try {
    writeFileSync(path.join(f.cache, "dsh-before-sha"), f.head);
    writeFileSync(path.join(f.cache, "dsh-before-dsh-branches"), "");
    writeFileSync(path.join(f.cache, "dsh-before-open-prs"), "");
    const env = f.env({ DSH_SHIP_REPO: "" });
    delete env.GITHUB_REPOSITORY;
    const res = spawnSync("bash", [SHIPPER], { encoding: "utf8", env });
    assert.notEqual(res.status, 0);
    assert.match(res.stderr, /DSH_SHIP_REPO/);
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test("unrunnable git tree → note says UNVERIFIED, never a false 'verified' (PR45 F5)", () => {
  const f = fixture();
  try {
    // A worktree that is NOT a git repo: the before-state files exist, the
    // shipper's own git checks fail — the note must not claim verification.
    const notGit = path.join(f.dir, "not-a-repo");
    mkdirSync(notGit, { recursive: true });
    writeFileSync(path.join(f.cache, "dsh-before-sha"), "deadbeef");
    writeFileSync(path.join(f.cache, "dsh-before-dsh-branches"), "");
    writeFileSync(path.join(f.cache, "dsh-before-open-prs"), "");
    writeFileSync(path.join(f.cache, "dsh-agent-output.txt"), "no output\n");

    const res = spawnSync("bash", [SHIPPER], {
      encoding: "utf8", env: f.env({ DSH_WORKTREE: notGit }),
    });
    assert.equal(res.status, 0, res.stderr);
    const note = readFileSync(path.join(f.cache, "ship-note.txt"), "utf8");
    assert.match(note, /UNVERIFIED/);
    assert.ok(!note.includes("verified:"), "a non-git tree must never claim verification");
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test("shipper env PATH drops the driver's transient dsh-shim dirs, keeps the ambient PATH", () => {
  // The exact contamination shape run-dsh-agent.sh §2c produces: the shim
  // dir first, ambient dirs after. The filter must remove ONLY the
  // dsh-shim.* dir — dropping everything ambient would violate the
  // tests-lint rule (hard-coded restriction constructs no absence), keeping
  // it re-breaks the shipper inside an agent session.
  const sep = path.delimiter;
  const contaminated = [
    path.join(path.sep, "tmp", "dsh-shim.424242"),
    path.join(path.sep, "usr", "local", "bin"),
    path.join(path.sep, "usr", "bin"),
    path.join(path.sep, "opt", "homebrew", "bin"),
  ].join(sep);
  const filtered = ambientPathWithoutDriverShims(contaminated).split(sep);
  assert.ok(
    !filtered.includes(path.join(path.sep, "tmp", "dsh-shim.424242")),
    "the driver shim dir must not reach the shipper child",
  );
  assert.ok(
    filtered.includes(path.join(path.sep, "usr", "local", "bin")) &&
      filtered.includes(path.join(path.sep, "usr", "bin")) &&
      filtered.includes(path.join(path.sep, "opt", "homebrew", "bin")),
    "ambient entries must survive the filter",
  );
  // empty entries (PATH trailing colon = cwd semantics) pass through untouched
  assert.equal(ambientPathWithoutDriverShims(`${sep}${sep}`), `${sep}${sep}`);
});

test("the assert-side git read probe is itself asserting: a failed read goes red naming the call (issue #623)", () => {
  // ls-remote against a path that is not a repository exits non-zero and
  // prints nothing — the exact shape that used to make the negative
  // ls-remote asserts pass vacuously ("" contains no "dsh/auto-"). The
  // probe must throw BEFORE its caller can assert against empty stdout,
  // and the error must name the call so the red points at the read.
  const notARepo = path.join(tmpdir(), `ship-changes-test-notarepo-${process.pid}`);
  assert.throws(
    () => gitRead(["ls-remote", notARepo]),
    /assert probe failed: git ls-remote /,
    "a failed probe must throw naming the call, never hand back silent empty stdout",
  );
});
// --- milestone carry (issue #185) -------------------------------------------
// A shipped PR carries the closing ticket's milestone: the shipper resolves
// the ticket from DSH_CLOSING_TICKET or the PR body's "#N" closing
// reference, reads its milestone, and stamps the same one on the PR —
// best-effort (a milestone miss degrades with a warning, never fails a ship).

const shipFixture = (f, agentOutput) => {
  writeFileSync(path.join(f.cache, "dsh-before-sha"), f.head);
  writeFileSync(path.join(f.cache, "dsh-before-dsh-branches"), "");
  writeFileSync(path.join(f.cache, "dsh-before-open-prs"), "");
  writeFileSync(path.join(f.cache, "dsh-agent-output.txt"), agentOutput);
  writeFileSync(path.join(f.work, "a.txt"), "base content\nagent changed it\n");
  return spawnSync("bash", [SHIPPER], { encoding: "utf8", env: f.env() });
};

test("milestone carry: shipped PR inherits the closing ticket's milestone from the body's #N reference (issue #185)", () => {
  const f = fixture();
  try {
    const res = shipFixture(f,
      "done. Closes #185 — the chain ticket. landed 2026-09-26\n");
    assert.equal(res.status, 0, res.stderr);
    const log = readFileSync(f.ghLog, "utf8");
    // the carry ran: milestone lookup on the referenced ticket, then the
    // same milestone stamped on the created PR
    assert.match(log, /gh: issue view 185 --repo owner\/repo --json milestone/);
    assert.match(log, /gh: pr edit 99 --repo owner\/repo --milestone alpha-sweep/);
    // the note still ships normally (carry is additive, not the ship itself)
    const note = readFileSync(path.join(f.cache, "ship-note.txt"), "utf8");
    assert.match(note, /shipped/);
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test("milestone carry: DSH_CLOSING_TICKET takes precedence over the body scan (issue #185)", () => {
  const f = fixture();
  try {
    const res = shipFixture(f, "done. no refs here\n");
    assert.equal(res.status, 0, res.stderr);
    const log = readFileSync(f.ghLog, "utf8");
    assert.ok(!log.includes("milestone"), "no carry without a closing ticket or #N reference");
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }

  const g = fixture();
  try {
    const res = shipFixture(g, "done. see #42 for noise\n");
    assert.equal(res.status, 0, res.stderr);
    const env = g.env({ DSH_CLOSING_TICKET: "185" });
    const res2 = spawnSync("bash", [SHIPPER], { encoding: "utf8", env });
    assert.equal(res2.status, 0, res2.stderr);
    const log = readFileSync(g.ghLog, "utf8");
    assert.match(log, /gh: issue view 185 --repo owner\/repo --json milestone/,
      "the explicit closing ticket is looked up even when the body references another number");
    assert.match(log, /gh: pr edit 99 --repo owner\/repo --milestone alpha-sweep/);
  } finally {
    rmSync(g.dir, { recursive: true, force: true });
  }
});

test("milestone carry degrades, never fails the ship: ticket without a milestone ships clean (issue #185)", () => {
  const f = fixture();
  try {
    // #42 carries no milestone in the shim — the carry step finds nothing
    const res = shipFixture(f, "done. Closes #42\n");
    assert.equal(res.status, 0, res.stderr);
    const log = readFileSync(f.ghLog, "utf8");
    assert.match(log, /gh: issue view 42 --repo owner\/repo --json milestone/);
    assert.ok(!log.includes("pr edit"), "no pr edit when the closing ticket has no milestone");
    const note = readFileSync(path.join(f.cache, "ship-note.txt"), "utf8");
    assert.match(note, /shipped/);
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

// --- hollow-ship invariant (issue #565) ------------------------------------
// A branch tip equal to its stacking parent's head is not a change, and a
// green gate over it proves only that the parent's tree builds. Shipping it
// produced a DONE note for work that does not exist; the shipper now refuses
// (no push, no PR, exit 4) and names BOTH heads.
//
// Git-fixture budget declaration (the #1030 shape): this repo has no
// rig-timeout-guard script — the bound that actually kills a wedged suite is
// the per-suite watchdog in scripts/bounded-gate.mjs (DSH_TEST_GATE_TIMEOUT_S,
// 120s default). The budget is therefore declared ON the tests below and on
// every child spawn of the shipper, so a hung fixture reds this file inside
// the suite bound instead of being SIGKILLed by the gate with no diagnosis.
// The fixtures are local-only git (a bare remote under the temp dir); each
// leg is a handful of local git calls plus one shipper run.
const GIT_FIXTURE_BUDGET_MS = 120_000;

/** Build the stack: dsh/parent (already on the remote) + one stacked branch.
 * `ownCommits` = 0 makes the stacked tip equal to its parent's head (hollow);
 * >0 gives it real work beyond the parent. Returns the shas. */
const stackFixture = (f, child, ownCommits) => {
  gitRead(["checkout", "-q", "-b", "dsh/parent", "master"], { cwd: f.work });
  writeFileSync(path.join(f.work, "parent.txt"), "the parent's work\n");
  gitRead(["add", "parent.txt"], { cwd: f.work });
  gitRead(["commit", "-q", "-m", "parent work"], { cwd: f.work });
  const parentHead = gitRead(["rev-parse", "HEAD"], { cwd: f.work }).stdout.trim();
  gitRead(["push", "-q", "origin", "dsh/parent"], { cwd: f.work });
  gitRead(["checkout", "-q", "-b", child, "dsh/parent"], { cwd: f.work });
  // a branch name carries slashes (dsh/child) — flatten it for the file path
  const slug = child.replace(/[^A-Za-z0-9]+/g, "-");
  for (let i = 0; i < ownCommits; i++) {
    writeFileSync(path.join(f.work, `${slug}-own-${i}.txt`), `child work ${i}\n`);
    gitRead(["add", `${slug}-own-${i}.txt`], { cwd: f.work });
    gitRead(["commit", "-q", "-m", `child work ${i}`], { cwd: f.work });
  }
  const childHead = gitRead(["rev-parse", "HEAD"], { cwd: f.work }).stdout.trim();
  gitRead(["checkout", "-q", "master"], { cwd: f.work });
  return { parentHead, childHead };
};

test("hollow-ship (issue #565): a tip with no commit beyond its stacking parent is REFUSED, naming both heads", { timeout: GIT_FIXTURE_BUDGET_MS }, () => {
  const f = fixture();
  try {
    const { parentHead, childHead } = stackFixture(f, "dsh/hollow", 0);
    assert.equal(childHead, parentHead, "fixture shape: the stacked tip IS the parent's head");
    writeFileSync(path.join(f.cache, "dsh-before-sha"), f.head);
    writeFileSync(path.join(f.cache, "dsh-before-dsh-branches"), "dsh/parent\n");
    writeFileSync(path.join(f.cache, "dsh-before-open-prs"), "");
    writeFileSync(path.join(f.cache, "dsh-agent-output.txt"), "done: the parent work\n");

    const res = spawnSync("bash", [SHIPPER], {
      encoding: "utf8",
      timeout: GIT_FIXTURE_BUDGET_MS,
      env: f.env({ DSH_SHIP_STACK_PARENT: "dsh/parent" }),
    });
    assert.equal(
      res.status,
      4,
      `a hollow ship must be a RED ship (exit 4), got ${res.status}\n${res.stdout}\n${res.stderr}`,
    );
    // the refusal names both heads: the branch, its tip, the parent ref, the parent's head
    assert.match(res.stderr, /hollow ship REFUSED \(issue #565\)/);
    assert.match(res.stderr, /dsh\/hollow/);
    assert.match(res.stderr, /dsh\/parent/);
    assert.ok(res.stderr.includes(parentHead), "the stacking parent's head sha is named");
    assert.match(res.stderr, /no commit beyond its stacking parent/);

    // nothing reached GitHub: no remote branch, no PR
    const refs = gitRead(["ls-remote", f.bare]).stdout;
    assert.ok(!refs.includes("refs/heads/dsh/hollow"), "a hollow branch is never pushed");
    assert.ok(!existsSync(f.ghLog), "a hollow branch never opens a PR");

    // the note records the refusal and never reads DONE
    const note = readFileSync(path.join(f.cache, "ship-note.txt"), "utf8");
    assert.match(note, /hollow ship REFUSED/);
    assert.ok(!/shipped/i.test(note), `the note must not claim a ship: ${note}`);
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test("hollow-ship control (issue #565): the same stack ships once the tip carries a commit beyond its parent", { timeout: GIT_FIXTURE_BUDGET_MS }, () => {
  const f = fixture();
  try {
    const { parentHead, childHead } = stackFixture(f, "dsh/child", 1);
    assert.notEqual(childHead, parentHead, "fixture shape: the stacked tip is ahead of its parent");
    writeFileSync(path.join(f.cache, "dsh-before-sha"), f.head);
    writeFileSync(path.join(f.cache, "dsh-before-dsh-branches"), "dsh/parent\n");
    writeFileSync(path.join(f.cache, "dsh-before-open-prs"), "");
    writeFileSync(path.join(f.cache, "dsh-agent-output.txt"), "done: child work\n");

    const res = spawnSync("bash", [SHIPPER], {
      encoding: "utf8",
      timeout: GIT_FIXTURE_BUDGET_MS,
      env: f.env({ DSH_SHIP_STACK_PARENT: "dsh/parent" }),
    });
    assert.equal(res.status, 0, `a real change must ship green:\n${res.stdout}\n${res.stderr}`);
    assert.ok(!/REFUSED/.test(res.stderr), "no hollow refusal for a branch with real work");
    assert.match(gitRead(["ls-remote", f.bare]).stdout, /refs\/heads\/dsh\/child/, "the branch is pushed");
    assert.match(readFileSync(f.ghLog, "utf8"), /--head dsh\/child/, "the PR is opened for it");
    assert.match(readFileSync(path.join(f.cache, "ship-note.txt"), "utf8"), /shipped/);
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test("hollow-ship (issue #565): the invariant also holds with NO declaration — a branch equal to the PR base head is refused", { timeout: GIT_FIXTURE_BUDGET_MS }, () => {
  const f = fixture();
  try {
    // An agent branch that never got its commit: the tip is exactly the base
    // head. No DSH_SHIP_STACK_PARENT — the PR base IS the stacking parent,
    // which is the unstacked-branch shape of the same defect.
    gitRead(["branch", "dsh/empty", "master"], { cwd: f.work });
    writeFileSync(path.join(f.cache, "dsh-before-sha"), f.head);
    writeFileSync(path.join(f.cache, "dsh-before-dsh-branches"), "");
    writeFileSync(path.join(f.cache, "dsh-before-open-prs"), "");
    writeFileSync(path.join(f.cache, "dsh-agent-output.txt"), "done\n");

    const res = spawnSync("bash", [SHIPPER], {
      encoding: "utf8",
      timeout: GIT_FIXTURE_BUDGET_MS,
      env: f.env({ DSH_SHIP_BASE: "master" }),
    });
    assert.equal(res.status, 4, `an empty branch must not ship DONE:\n${res.stdout}\n${res.stderr}`);
    assert.match(res.stderr, /hollow ship REFUSED \(issue #565\)/);
    assert.ok(res.stderr.includes(f.head), "the base head sha is named");
    assert.ok(!gitRead(["ls-remote", f.bare]).stdout.includes("refs/heads/dsh/empty"));
    assert.ok(!existsSync(f.ghLog), "no PR for an empty branch");
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test("hollow-ship structural (issue #565): the invariant is wired at BOTH push sites and documented", () => {
  const s = readFileSync(SHIPPER, "utf8");
  assert.match(s, /hollow_ship_guard\(\) \{/, "the invariant exists as a function");
  assert.match(s, /hollow ship REFUSED \(issue #565\)/, "the refusal is typed and names the issue");
  assert.match(s, /DSH_SHIP_STACK_PARENT/, "the declaration seam is referenced");
  assert.match(
    s,
    /stacking parent %s \(head %s\)/,
    "the refusal names the parent ref AND its head — both heads",
  );
  const guardCalls = s.match(/HOLLOW="\$\(hollow_ship_guard/g) ?? [];
  assert.equal(guardCalls.length, 2, "both push sites are guarded: the dsh/* loop and the auto branch");
  assert.match(s, /\[ -z "\$HOLLOW_SHIP" \] \|\| exit 4/, "the refusal is a nonzero ship (exit 4)");
  assert.ok(!/for .* in .*retry/.test(s), "no retry loop was introduced");
});
