// milestone-contract.test.mjs — pins the chain/sweep milestone convention
// (issue #185): the filer stamps the chain's milestone on every ticket that
// belongs to it (creating it if absent), and the shipped PR carries the
// closing ticket's milestone. Like the other conduct contracts, both the
// reference docs and the stamped behavior are pinned — a doc drift or a
// shipper regression here is an owned change, not a silent one.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(path.join(ROOT, p), "utf8");

test("the filing checklist carries the filer-stamps rule (filer sets the chain milestone, creating it if absent)", () => {
  const agents = read(".agents/README.md");
  // discovery-protocol checklist item (filing step)
  assert.match(agents, /Stamp the chain\/sweep milestone[^\n]*issue #185/);
  assert.match(agents, /creating the milestone if absent/);
  assert.match(agents, /gh issue edit N --repo R --milestone "chain-anchor"/);
  // the standalone contract section
  assert.match(agents, /## Standing contract: chain\/sweep milestones \(issue #185\)/);

  const contributing = read("CONTRIBUTING.md");
  assert.match(contributing, /6\. \*\*Stamp the chain\/sweep milestone\*\* \(issue #185\)/);
  assert.match(contributing, /gh issue edit N --repo R --milestone "chain-anchor"/);
});

test("the ship checklist carries the ship-carries rule (the PR takes the closing ticket's milestone)", () => {
  const agents = read(".agents/README.md");
  assert.match(agents, /closing ticket's milestone[^\n]*issue #185/);
  const contributing = read("CONTRIBUTING.md");
  assert.match(contributing, /the PR itself carries the closing ticket's milestone \(issue #185/);
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
