// milestone-contract.test.mjs — pins the chain/sweep milestone convention
// (issue #185): the filer stamps the chain's milestone on every ticket that
// belongs to it (creating it if absent), and the shipped PR carries the
// closing ticket's milestone. Like the other conduct contracts, both the
// reference docs and the stamped behavior are pinned — a doc drift or a
// shipper regression here is an owned change, not a silent one.
//
// Issue #270 doctrine for pins on human-editable prose (CONTRIBUTING.md,
// .agents/README.md): anchor on the SUBSTANTIVE CLAUSE, casing-agnostic and
// position-agnostic — no sentence-start article, no checklist index, no
// same-line-only spans — so a pin reds only when the RULE disappears, never
// when an edit reflows the sentence carrying it. Receipt: PR #268's conflict
// resolution re-flowed the #185 clause from a mid-sentence "; the PR itself
// carries…" into a standalone ". The PR itself carries…" and the old
// casing/position pin red'd a doc whose rule was intact (gates run
// 36835565733, `not ok 152 - the ship checklist carries the ship-carries
// rule`). The reflow matrix in the last test below proves both directions:
// every reflow shape of the #268 class stays green, every rule removal reds.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(path.join(ROOT, p), "utf8");

// The hardened prose pins (issue #270). `phrase()` builds a wrap-tolerant
// pattern from a rule phrase: every space may become any whitespace run (a
// markdown reflow breaks lines at spaces), words stay in order — the phrase
// survives any rewrap and dies on any word change. The `i` flag makes pins
// casing-agnostic: capitalization is presentation (PR #268 capitalized a
// reflowed sentence-start "the" and red'd a doc whose rule was intact), the
// words are the rule. Bounded lazy spans ([\s\S]{0,N}?) between clauses
// tolerate a sentence moving within its paragraph while still requiring BOTH
// substantive anchors — the rule phrase AND its issue #185 reference — so
// rewriting the rule away keeps the pin red. Window sizes cover the real
// inter-clause distances in both docs (≤ 80 chars to the #185 ref).
const phrase = (s) =>
  s.split(" ").map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("\\s+");
const PINS = {
  filerStampsRule: new RegExp(
    `${phrase("stamp the chain/sweep milestone")}[\\s\\S]{0,80}?issue #185`, "i"),
  shipCarriesRule: new RegExp(
    `${phrase("closing ticket's milestone")}[\\s\\S]{0,80}?issue #185`, "i"),
  shipCarriesRuleContributing: new RegExp(
    `${phrase("PR itself carries the closing ticket's milestone")}[\\s\\S]{0,80}?issue #185`, "i"),
  checklistStampItem: new RegExp(
    `\\*\\*${phrase("Stamp the chain/sweep milestone")}\\*\\*[\\s\\S]{0,40}?\\(issue #185\\)`, "i"),
};

test("the filing checklist carries the filer-stamps rule (filer sets the chain milestone, creating it if absent)", () => {
  const agents = read(".agents/README.md");
  // discovery-protocol checklist item (filing step) — reflow-hardened (#270)
  assert.match(agents, PINS.filerStampsRule);
  assert.match(agents, /creating the milestone if absent/);
  assert.match(agents, /gh issue edit N --repo R --milestone "chain-anchor"/);
  // the standalone contract section
  assert.match(agents, /## Standing contract: chain\/sweep milestones \(issue #185\)/);

  const contributing = read("CONTRIBUTING.md");
  assert.match(contributing, PINS.checklistStampItem);
  assert.match(contributing, /gh issue edit N --repo R --milestone "chain-anchor"/);
});

test("the ship checklist carries the ship-carries rule (the PR takes the closing ticket's milestone)", () => {
  const agents = read(".agents/README.md");
  assert.match(agents, PINS.shipCarriesRule);
  const contributing = read("CONTRIBUTING.md");
  assert.match(contributing, PINS.shipCarriesRuleContributing);
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

test("issue #270: prose pins survive sentence reflow and red only on rule removal", () => {
  // The #270 instance, verbatim shape: PR #268's conflict resolution moved
  // the #185 clause from a mid-sentence role ("; the PR itself carries…") to
  // a standalone capitalized sentence (". The PR itself carries…"), and the
  // old position/casing pin red'd a doc whose rule was fully intact.
  const shapes = {
    base: "…zero-orphan branch hygiene); the PR itself carries the closing ticket's milestone (issue #185 — `ship-changes.sh` stamps it from `DSH_CLOSING_TICKET`);",
    reflowedCapitalized: '…"ship-exit skill candidates". The PR itself carries the closing ticket\'s milestone (issue #185 — `ship-changes.sh` stamps it from `DSH_CLOSING_TICKET`);',
    reflowedWrapped: '…"ship-exit skill candidates". The PR itself carries the closing\nticket\'s milestone (issue #185 — `ship-changes.sh` stamps it);',
  };
  for (const [name, prose] of Object.entries(shapes)) {
    assert.match(prose, PINS.shipCarriesRuleContributing, `${name}: reflow must not red the pin`);
  }
  // receipt: the pre-#270 pin reds on exactly the reflow that shipped in #268
  const oldShipPin = /the PR itself carries the closing ticket's milestone \(issue #185/;
  assert.doesNotMatch(shapes.reflowedCapitalized, oldShipPin, "the pre-#270 pin is the regression being fixed");

  // rule removal must still red: the milestone-carry rule rewritten away,
  // even with the #185 reference kept elsewhere in the sentence.
  const shipRuleGone = '…"ship-exit skill candidates". The PR itself carries the closing ticket\'s label (issue #185 — `gh pr edit N --repo R --remove-label "x"`);';
  assert.doesNotMatch(shipRuleGone, PINS.shipCarriesRuleContributing, "rule removed ⇒ pin reds");

  // checklist renumbering must not red (the old pin hard-coded `5. `):
  const itemN = (n) => `${n}. **Stamp the chain/sweep milestone** (issue #185): a \`found:\` ticket`;
  assert.match(itemN(5), PINS.checklistStampItem);
  assert.match(itemN(7), PINS.checklistStampItem, "renumber must not red");
  const oldItemPin = /5\. \*\*Stamp the chain\/sweep milestone\*\* \(issue #185\)/;
  assert.doesNotMatch(itemN(7), oldItemPin, "receipt: the pre-#270 pin reds on renumber");
  const itemRuleGone = "7. **Stamp the sweep milestone** (issue #42): a `found:` ticket";
  assert.doesNotMatch(itemRuleGone, PINS.checklistStampItem, "rule removed ⇒ pin reds");

  // mid-sentence decapitalized + wrapped filing rule must not red either
  const filingWrapped = "the file step must stamp the chain/sweep milestone\n   on the ticket (issue #185 — one `gh issue edit` call)";
  assert.match(filingWrapped, PINS.filerStampsRule, "casing+wrap must not red");
  const filingGone = "the file step must stamp the chain label\n   on the ticket (issue #42)";
  assert.doesNotMatch(filingGone, PINS.filerStampsRule, "rule removed ⇒ pin reds");
});
