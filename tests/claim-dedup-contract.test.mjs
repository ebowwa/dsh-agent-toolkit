// claim-dedup-contract.test.mjs — contract fixtures for the claim-time
// carrier check (issue #414).
//
// Contract under test: never work a ticket a live carrier PR already
// holds. The lane-pass claim protocol picked a ticket by fleet priority
// but never asked whether a sibling cell already claimed it — so
// concurrent cells independently raced the SAME open ticket and each
// shipped its own PR (measured 2026-10-04 on this repo: ~60 open PRs;
// #361 carried 8 carriers, #330 carried 7, #358 carried 5, #385 carried
// 4, six more tickets carried 3 each — while genuinely unclaimed tickets
// sat idle). This is the CLAIM-step hole: #320 is dedup before FILING a
// found: ticket, #321 was tickets duplicating LANDED work; neither asks
// "does an open carrier already hold the ticket I am about to work?".
//
// Three surfaces, one protocol — these fixtures pin ALL THREE and keep
// them in agreement (the shape mirrors tests/branch-hygiene-contract.test.mjs):
//
//   behavioral — a stub agent booted on the no-arg DEFAULT_TASK path (the
//   scheduled maintenance roam) captures the task it was launched with,
//   and the carrier-check step must be present in it: the check command,
//   the live-carrier semantics, the skip-to-next rule, and the declared
//   skip line.
//
//   structural — the driver's DEFAULT_TASK string, the standing contract
//   doc (.agents/README.md), and the decoupled trigger's fallback TASK
//   (.github/workflows/agent-dispatch-thin.yml) each carry the rule with
//   its operative phrases, and the three surfaces agree. A drift between
//   them, or a revert of any one, goes red here. The workflow's fallback
//   is the decoupled-mode copy of the same lane-pass preamble — REVIEW.md
//   § Decoupled worker: a change to one mode that silently drifts the
//   other is a defect (gap found on issue #449; PR #427 saw it too but
//   shipped a second, conflicting pin instead of extending this one).

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(ROOT, "scripts", "run-dsh-agent.sh");
const CONTRACT_DOC = path.join(ROOT, ".agents", "README.md");
const THIN_DISPATCH = path.join(ROOT, ".github", "workflows", "agent-dispatch-thin.yml");

// --- behavioral: the scheduled roam's booted task carries the rules -------

test("issue #414: the DEFAULT_TASK maintenance roam boots with the claim-time carrier check in the task (stub agent sees it)", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "dsh-claim-dedup-"));
  const bin = path.join(dir, "bin");
  const runnerTemp = path.join(dir, "runner");
  mkdirSync(bin);
  mkdirSync(runnerTemp);

  // Same hermetic harness as tests/branch-hygiene-contract.test.mjs:
  // doppler exec stub, dsh stub that answers --version then dumps its
  // argv (one per line) to $TASK_CAPTURE, zstd/gh stubs, no cell probing,
  // no network. TASK_CAPTURE is deliberately NOT a DSH_*/*KEY*/*TOKEN*
  // name — dsh strips both classes from the child env.
  writeFileSync(path.join(bin, "doppler"), "#!/bin/sh\nshift; shift\nexec \"$@\"\n");
  writeFileSync(
    path.join(bin, "dsh"),
    [
      "#!/bin/sh",
      'case "$1" in --version) echo "dsh-stub-0.0.0" >&2; exit 0;; esac',
      'for a in "$@"; do printf \'%s\\n\' "$a"; done > "$TASK_CAPTURE"',
      "echo STUB-FINAL-ANSWER",
      "exit 0",
    ].join("\n") + "\n",
  );
  writeFileSync(path.join(bin, "zstd"), "#!/bin/sh\nexit 0\n");
  writeFileSync(path.join(bin, "gh"), "#!/bin/sh\nexit 0\n");
  for (const f of readdirSync(bin)) spawnSync("chmod", ["+x", path.join(bin, f)]);

  const capture = path.join(dir, "task-argv.txt");
  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    HOME: dir,
    RUNNER_TEMP: runnerTemp,
    DOPPLER_SERVICE_TOKEN: "stub-token",
    DSH_KEEP_SESSIONS: "",
    TASK_CAPTURE: capture,
    DSH_RETRY_BACKOFF_S: "0", // tests-lint rule 2: every driver spawn pins the seam
    GH_BIN: path.join(bin, "gh"),
    DOPPLER_BIN: path.join(bin, "doppler"),
    CELL_PROBE_DIRS: "",
  };
  delete env.DEFAULT_TASK; // pin the in-script default, not an ambient override
  delete env.GH_TOKEN; // skip the gh-identity block entirely
  delete env.GITHUB_ENV; // no workflow env file to publish to
  delete env.DSH_HOME; // force the job-scoped home under RUNNER_TEMP
  delete env.DSH_PERSISTENT_HOME;
  delete env.DSH_SESSION_PATH_FILE;
  delete env.THREAD_CONTEXT; // no thread-context wrapper around the task
  delete env.REPLY_TARGET; // dispatched-task mode: the append must be unconditional

  // NO task argument: this is the scheduled no-arg boot path whose task is
  // the in-script DEFAULT_TASK — the roam every carrier race originated
  // from. The check must ride that exact text.
  const proc = spawnSync("bash", [SCRIPT], { encoding: "utf8", env, timeout: 60_000 });
  assert.equal(proc.status, 0, `driver must succeed (stderr: ${proc.stderr?.slice(-400)})`);

  const argv = readFileSync(capture, "utf8");
  // The task is everything after the first two argv lines
  // (`--profile`, `headless`) — the task itself is multi-line.
  const task = argv.trimEnd().split("\n").slice(2).join("\n");
  assert.match(task, /Routine maintenance task: work ONLY repositories owned by the github\.com\/ebowwa account/,
    "sanity: the booted task must be the DEFAULT_TASK roam");

  // The check itself, as a runnable command with the title-scoped search:
  assert.match(task, /claim-time carrier check \(issue #414\)/);
  assert.match(task, /gh pr list --repo <repo> --state open --search "N in:title"/);

  // The live-carrier semantics and the skip rule:
  assert.match(task, /an open PR whose title or body carries the ticket ref is a live carrier/);
  assert.match(task, /the ticket is taken: skip to the next qualifying ticket by that same order/);
  assert.match(task, /say so in the exit summary/);

  // The declared skip line — the receipt that the check ran:
  assert.match(task, /one line per skip: skipped: #N — live carrier #M/);

  rmSync(dir, { recursive: true, force: true });
});

// --- structural: driver string + contract doc + thin fallback carry the rule

test("issue #414: the driver's DEFAULT_TASK, the standing contract doc, and the thin-dispatch fallback TASK carry the carrier check and agree", () => {
  const src = readFileSync(SCRIPT, "utf8");
  const doc = readFileSync(CONTRACT_DOC, "utf8");
  const workflow = readFileSync(THIN_DISPATCH, "utf8");

  // The driver's claim preamble (DEFAULT_TASK) carries the rule. In the
  // script source the search quotes are backslash-escaped (the string is
  // double-quoted shell); the booted text has them literally — pinned in
  // both forms across the two legs.
  const defaultTaskLine = src.split("\n").find((l) => l.startsWith("DEFAULT_TASK="));
  assert.ok(defaultTaskLine, "the DEFAULT_TASK assignment must exist");
  assert.match(defaultTaskLine, /gh pr list --repo <repo> --state open --search \\"N in:title\\"/,
    "the carrier-check command rides the claim preamble");
  assert.match(defaultTaskLine, /claim-time carrier check \(issue #414\)/);
  assert.match(defaultTaskLine, /the ticket is taken: skip to the next qualifying ticket/);
  assert.match(defaultTaskLine, /skipped: #N — live carrier #M/);

  // The preamble sits BEFORE the argv seam it defaults into, so the
  // scheduled no-arg boot inherits the check (the run-dsh-agent.test.mjs
  // #361 pins keep the seam itself a two-step form).
  const seam = src.indexOf('TASK="${1:-}"');
  assert.ok(seam > -1, "the argv seam exists");
  assert.ok(src.indexOf("DEFAULT_TASK=") < seam,
    "DEFAULT_TASK must be defined before the seam that falls back to it");

  // The contract doc carries the standing-contract section with the same
  // operative pieces: the check command, the live definition, the
  // skip-and-declare rule with its exact-shape example, and the
  // acceptance sentence. (docFlat is whitespace-normalized because the
  // doc hard-wraps at ~78 cols — the LIVE definition spans two lines.)
  const docFlat = doc.replace(/\s+/g, " ");
  assert.match(doc, /## Standing contract: claim-time carrier dedup \(issue #414\)/);
  assert.match(doc, /CLAIM-TIME CARRIER CHECK/);
  assert.match(doc, /gh pr list --repo R --state open --search "N in:title"/);
  assert.match(docFlat, /A carrier is LIVE while it is open, not closed-without-merge, and not stale/);
  assert.match(doc, /SKIP AND DECLARE/);
  assert.match(doc, /skipped: #405 — live carrier #413/);
  assert.match(doc, /Acceptance — no duplicate carriers from this session:/);

  // The decoupled trigger's fallback TASK carries the same clauses
  // (issue #449). The empty-input fallback is the decoupled-mode copy of
  // the driver's lane-pass preamble, so like the driver source it is a
  // double-quoted shell string and pins the ESCAPED search-quote form.
  assert.match(workflow, /claim-time carrier check \(issue #414\)/,
    "thin-dispatch fallback: the check is named as the claim-time gate");
  assert.match(workflow, /gh pr list --repo <repo> --state open --search \\"N in:title\\"/,
    "thin-dispatch fallback: the carrier-check command rides the fallback TASK");
  assert.match(workflow, /is a live carrier/,
    "thin-dispatch fallback: the live-carrier semantics ride the fallback TASK");
  assert.match(workflow, /\(open, not closed-without-merge, not stale\)/,
    "thin-dispatch fallback: the live/stale definition rides the fallback TASK");
  assert.match(workflow, /the ticket is taken: skip to the next qualifying ticket by that same order/,
    "thin-dispatch fallback: the skip rule rides the fallback TASK");
  assert.match(workflow, /say so in the exit summary/,
    "thin-dispatch fallback: the declare rule rides the fallback TASK");
  assert.match(workflow, /skipped: #N — live carrier #M/,
    "thin-dispatch fallback: the declared skip-line shape rides the fallback TASK");

  // Cross-surface agreement on the two phrases a reader must be able to
  // trust wherever they read the rule from: the check command's shape
  // (`gh pr list ... --state open --search`) and the skip-line label.
  for (const surface of [
    ["driver", src],
    ["contract doc", doc],
    ["thin-dispatch fallback", workflow],
  ]) {
    const [name, text] = surface;
    assert.match(text, /gh pr list --repo .+ --state open --search/,
      `${name}: the check command's operative shape`);
    assert.match(text, /skip(ped)?:? .{0,3}#/,
      `${name}: the skip declaration rides the surface`);
  }
});
