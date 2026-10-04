// carrier-dedup-contract.test.mjs — contract fixtures for the lane-pass
// claim dedup (issue #414).
//
// Contract under test: ONE OPEN TICKET, ONE LIVE CARRIER. The lane-pass
// protocol picks a ticket by fleet priority but never asked whether an
// open carrier PR already existed for it — so concurrent cells
// independently claimed the SAME open ticket and each shipped its own PR
// (measured 2026-10-04 on this repo: ~60 open PRs, one ticket raced by 8
// cells: #361 → #365/#367/#368/#370/#372/#373/#375/#379, while genuinely
// unclaimed tickets sat idle). The claim step now dedups BEFORE work
// starts:
//
//   1. CHECK — `gh pr list --repo R --state open`, match the issue ref
//      N in the open PR titles/bodies;
//   2. LIVE BLOCKS — an open carrier updated within the last 3 days
//      means the ticket is taken: skip to the next qualifying ticket
//      and say so in the exit summary;
//   3. STALE YIELDS — a carrier closed without merge, or open but
//      untouched for 3+ days, is stale: take the ticket over and name
//      the superseded carrier PR in the exit summary.
//
// Distinct from the #320 pre-file dedup (comment on the existing
// found: ticket instead of minting a duplicate) — this is the CLAIM
// step, one stage earlier: do not start work another carrier already
// carries. #327's branch-name uniqueness mint is the same
// same-claim-collision class on the branch axis; this is the ticket
// axis.
//
// Four surfaces, one protocol — these fixtures pin ALL of them and keep
// them in agreement (the shape mirrors
// tests/branch-hygiene-contract.test.mjs):
//
//   scripts/run-dsh-agent.sh      DEFAULT_TASK — the driver's lane-pass
//                                 preamble, stamped into every taskless
//                                 maintenance roam;
//   .github/workflows/            the dispatch fallback TASK — the
//   agent-dispatch-thin.yml       workflow's copy of the same preamble;
//   .agents/README.md             the reference text (the stamped
//                                 contracts' full prose home);
//   CLAUDE.md                     the review ground truth names the rule
//                                 so a surface drift is reviewable.
//
// A drift between the two preambles, a revert of the dedup clause, or a
// bound edit (3 days) that lands on one surface only goes red here.
//
// Structural by design: the BEHAVIORAL leg — the booted task reaching
// the agent with this preamble intact — is already pinned by
// tests/run-dsh-agent.test.mjs's DEFAULT_TASK roam test (it boots the
// driver with a stub agent and asserts the task text); this file pins
// the clause's presence and cross-surface agreement without spawning
// anything.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DRIVER = path.join(ROOT, "scripts", "run-dsh-agent.sh");
const WORKFLOW = path.join(ROOT, ".github", "workflows", "agent-dispatch-thin.yml");
const CONTRACT_DOC = path.join(ROOT, ".agents", "README.md");
const ORIENTATION_DOC = path.join(ROOT, "CLAUDE.md");

const read = (p) => readFileSync(p, "utf8");

// The operative markers every preamble surface must carry. These are
// the contract's verbs, not decorative prose: the gh read that
// constructs the check, the live/stale bound, the skip, and the two
// exit-summary receipts (skip reason + superseded-carrier name).
const PREAMBLE_MARKERS = [
  /gh pr list --repo/,
  /--state open/,
  /NO live carrier PR/,
  /updated within the last 3 days/,
  /3\+ days/,
  /closed without merge/,
  /skip to the next qualifying ticket/,
  /name the superseded carrier/,
  /exit summary/,
];

// The lane-pass preamble is ONE shell line on each surface; asserting
// against the extracted line (not the whole file) means a marker that
// wanders into a comment does not vacuously satisfy the pin — the
// clause rides the prompt the agent actually receives.
const defaultTaskLine = (src) => {
  const line = src.split("\n").find((l) => l.startsWith('DEFAULT_TASK="${DEFAULT_TASK:-'));
  return line;
};

const workflowTaskLine = (src) => {
  const line = src.split("\n").find((l) => l.includes('TASK="Routine maintenance task:'));
  return line;
};

test("the driver's DEFAULT_TASK carries the claim-time carrier dedup clause (issue #414)", () => {
  const line = defaultTaskLine(read(DRIVER));
  assert.ok(line, "DEFAULT_TASK assignment line must exist in scripts/run-dsh-agent.sh");
  for (const marker of PREAMBLE_MARKERS) {
    assert.match(
      line,
      marker,
      `DEFAULT_TASK must carry the dedup clause marker ${marker} — the lane-pass roam boots agents with this text (issue #414)`,
    );
  }
  // The issue ref rides the preamble itself so a dispatched agent can
  // cite the rule it is following, not just obey it.
  assert.match(line, /issue #414/, "DEFAULT_TASK names the contract's issue");
});

test("the agent-dispatch-thin fallback TASK carries the same clause — two surfaces, one protocol (issue #414)", () => {
  const line = workflowTaskLine(read(WORKFLOW));
  assert.ok(line, "fallback TASK line must exist in agent-dispatch-thin.yml");
  for (const marker of PREAMBLE_MARKERS) {
    assert.match(
      line,
      marker,
      `the workflow fallback TASK must carry the dedup clause marker ${marker} — a drift between the two preambles is the defect class this pin exists for (issue #414)`,
    );
  }
  assert.match(line, /issue #414/, "the workflow fallback TASK names the contract's issue");
});

test("both preambles agree on the live/stale bound — 3 days, verbatim, on each surface", () => {
  const driverLine = defaultTaskLine(read(DRIVER));
  const workflowLine = workflowTaskLine(read(WORKFLOW));
  assert.ok(driverLine && workflowLine, "both preamble lines must exist");
  // Same bound on both surfaces: editing one and not the other is the
  // drift the pin rejects.
  for (const line of [driverLine, workflowLine]) {
    assert.match(line, /updated within the last 3 days/, "live-carrier bound is 'updated within the last 3 days'");
    assert.match(line, /untouched for 3\+ days/, "stale-carrier bound is 'untouched for 3+ days'");
  }
});

test(".agents/README.md documents the claim dedup as a standing contract with the rule's verbs", () => {
  // Markdown reflows prose (hard-wrapped at ~76 cols); markers match the
  // flattened text so a wrap is not a drift — but an absent clause is.
  const flat = read(CONTRACT_DOC).replace(/\s+/g, " ");
  assert.match(flat, /## Standing contract: lane-pass claim dedup \(issue #414\)/, "the standing-contract section exists");
  assert.match(flat, /One open ticket, one live carrier/, "the one-line contract statement");
  assert.match(flat, /gh pr list --repo R --state open/, "the check command");
  assert.match(flat, /skip to the next qualifying ticket/, "the live-carrier skip rule");
  assert.match(flat, /closed without merge/, "the stale-carrier takeover rule names closed-without-merge");
  assert.match(flat, /3\+ days/, "the stale-carrier takeover rule names the 3+ day bound");
  assert.match(flat, /tests\/carrier-dedup-contract\.test\.mjs/, "the reference names this pin");
});

test("CLAUDE.md (review ground truth) names the rule and its pin — surface drift is reviewable", () => {
  const flat = read(ORIENTATION_DOC).replace(/\s+/g, " ");
  assert.match(flat, /One open ticket, one live carrier \(claim dedup, #414\)/, "the rules list carries the claim-dedup rule");
  assert.match(flat, /gh pr list --repo R --state open/, "the rule states the check command");
  assert.match(flat, /carrier-dedup-contract\.test\.mjs/, "the rule names the structural pin");
  assert.match(flat, /Change one surface, change all three/, "the rule states the drift prohibition");
});
