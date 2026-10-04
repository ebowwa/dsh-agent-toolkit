// milestone-contract.test.mjs — pins the chain/sweep milestone convention
// (issue #185): the filer stamps the chain's milestone on every ticket that
// belongs to it (creating it if absent), and the shipped PR carries the
// closing ticket's milestone. Like the other conduct contracts, both the
// reference docs and the stamped behavior are pinned — a doc drift or a
// shipper regression here is an owned change, not a silent one.
//
// Issue #270: the DOC pins anchor on the substantive clause via
// proseHas() (tests/lib/prose.mjs) — casing-agnostic, wrap-agnostic,
// decoration-agnostic — so a sentence reflow (the PR #268 receipt:
// mid-sentence clause capitalized into its own sentence) does not red
// the pin, while deleting or rewording the rule away still does. The
// command-syntax pin (`gh issue edit ... --milestone`) and the
// structural heading pin stay exact: commands and headings are the
// substance, not prose.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { proseHas } from "./lib/prose.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(path.join(ROOT, p), "utf8");

test("the filing checklist carries the filer-stamps rule (filer sets the chain milestone, creating it if absent)", () => {
  const agents = read(".agents/README.md");
  // Rule pins (issue #270): tolerant on clause position/casing/wrapping,
  // strict on the clause itself.
  assert.ok(
    proseHas(agents, "Stamp the chain/sweep milestone (issue #185"),
    ".agents: the filer-stamps checklist rule",
  );
  assert.ok(proseHas(agents, "creating the milestone if absent"), ".agents: the create-if-absent rule");
  // Command syntax is exact syntax — the literal call a filer copies.
  assert.match(agents, /gh issue edit N --repo R --milestone "chain-anchor"/);
  // The standalone contract section (structural heading anchor).
  assert.match(agents, /## Standing contract: chain\/sweep milestones \(issue #185\)/);

  const contributing = read("CONTRIBUTING.md");
  assert.ok(
    proseHas(contributing, "Stamp the chain/sweep milestone (issue #185"),
    "CONTRIBUTING: the filer-stamps checklist rule",
  );
  assert.match(contributing, /gh issue edit N --repo R --milestone "chain-anchor"/);
});

test("the ship checklist carries the ship-carries rule (the PR takes the closing ticket's milestone)", () => {
  const agents = read(".agents/README.md");
  assert.ok(
    proseHas(agents, "closing ticket's milestone (issue #185"),
    ".agents: the ship-carries rule",
  );
  const contributing = read("CONTRIBUTING.md");
  assert.ok(
    proseHas(contributing, "The PR itself carries the closing ticket's milestone (issue #185"),
    "CONTRIBUTING: the ship-carries rule",
  );
});

test("issue #270: the ship-carries pin survives a PR-#268-class reflow of the live doc", () => {
  // The receipt: PR #268 split the mid-sentence clause
  // ('..."; the PR itself carries ...') into its own capitalized
  // sentence ('...". The PR itself carries ...') and the old
  // position-anchored pin red-lined. Replay the exact transform on the
  // live doc; the tolerant pin must still pass.
  const contributing = read("CONTRIBUTING.md");
  const clause = "The PR itself carries the closing ticket's milestone (issue #185";
  const reflowed = contributing.replace(
    /"; the PR itself carries the closing ticket's milestone/g,
    '". The PR itself carries the closing ticket\'s milestone',
  );
  if (reflowed !== contributing) {
    assert.ok(proseHas(reflowed, clause), "the reflowed doc still carries the rule (the pin grades the rule, not the sentence shape)");
  }
  // The pin still bites: gut the rule's substance and it goes red.
  const gutted = contributing.split("closing ticket's milestone").join("closing ticket's label");
  assert.ok(!proseHas(gutted, clause), "rewording the rule away must red the pin");
});

test("the shipper implements the carry: ship_milestone reads the closing ticket and stamps the PR", () => {
  const shipper = read("scripts/ship-changes.sh");
  assert.match(shipper, /ship_milestone\(\)/);
  assert.match(shipper, /DSH_CLOSING_TICKET/);
  assert.match(shipper, /gh pr edit "\$pr_num" --repo "\$DSH_SHIP_REPO" --milestone "\$ms"/);
  // degrade-or-loud: the carry is best-effort, warned, never a ship failure
  assert.match(shipper, /::warning::milestone carry FAILED/);
  // and the stamp actually fires on every opened PR
  assert.match(shipper, /ship_milestone "\$PR_NUM" "\$@"/);
});
