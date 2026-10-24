// gates-merge-authority.test.mjs — pins the merge-gate authority contract
// (issue #431): PR #419 merged while its PR-level `gates` check was still
// queued (zero CI signal at merge time), and the resolution is DOCUMENTED,
// not enforced — the main-side `gates` run fired by the merge push itself
// grades the change post-merge, so a PR-level check pending at merge time
// is accepted, not an incident. Pins:
//   - CLAUDE.md carries both halves of the contract (tolerant proseHas
//     anchors, issue #270 — an editorial reflow must not red-line a doc
//     rule), and the run-them-before-pushing rule survives beside the
//     acceptance (classifying the merge-time signal must not read as
//     waiving the local-gates rule);
//   - revert guard: gates.yml keeps its push-to-main trigger — the leg the
//     authority claim rests on (drop it and a pending-at-merge merge means
//     the change is graded by nothing).
// Branch protection is the owner's separate lever (a repo setting, not a
// tree change), and this repo's shipper opens PRs and never merges, so
// there is no shipper-side wait to pin here.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { proseHas } from "./lib/prose.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(path.join(ROOT, p), "utf8");

test("issue #431: CLAUDE.md names the main-side merge-push run the authoritative grade", () => {
  const doc = read("CLAUDE.md");
  assert.ok(
    proseHas(
      doc,
      "the main-side run fired by the merge push itself is the authoritative grade (issue #431)",
    ),
    "CLAUDE.md must state that the main-side merge-push gates run is the authoritative grade",
  );
});

test("issue #431: CLAUDE.md accepts a PR-level gates check pending at merge time", () => {
  const doc = read("CLAUDE.md");
  assert.ok(
    proseHas(
      doc,
      "a PR-level `gates` check still pending at merge time is accepted, not an incident",
    ),
    "CLAUDE.md must state that pending-at-merge is accepted, so reviewers stop reading it as an incident",
  );
});

test("issue #431: the run-them-before-pushing rule survives beside the acceptance", () => {
  const doc = read("CLAUDE.md");
  assert.ok(
    proseHas(doc, "The gates are the CI steps — run them before pushing"),
    "classifying the merge-time signal must not waive the run-them-before-pushing rule",
  );
});

test("issue #431 revert guard: gates.yml still fires on push to main", () => {
  const gates = read(".github/workflows/gates.yml");
  assert.match(
    gates,
    /push:\s*\n\s*branches:\s*\[main\]/,
    "the main-side trigger is the leg the authority contract rests on — it must stay",
  );
});

test("issue #680: the gates job budget outlives the slowest observed pass, so a busy box cannot erase main's verdict", () => {
  const gates = read(".github/workflows/gates.yml");
  const m = /^\s{4}timeout-minutes:\s*(\d+)\s*$/m.exec(gates);
  assert.ok(m, "the gates job declares a timeout-minutes budget");
  const budget = Number(m[1]);
  assert.equal(budget, 20, "the cap is 20 minutes (issue #680), not the load-sensitive 10");
  assert.ok(budget > 10, "never back under the cap that cancelled a passing run");
  assert.match(gates, /8m50s/, "the rationale cites the measured under-load duration");
  assert.match(gates, /40062597588/, "and the run the old cap cancelled, so the number is auditable");
  assert.match(
    gates,
    /LOAD\s*\n\s*#?\s*signal|LOAD signal/,
    "and states that a timeout here is a load signal, not a test signal",
  );
});
