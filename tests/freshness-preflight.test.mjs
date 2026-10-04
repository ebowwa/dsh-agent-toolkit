// freshness-preflight.test.mjs — pins the agent-side freshness preflight
// contract block (factory#840): every dispatched task carries the exact
// merge-base/rebase/same-scope procedure, so a stale-base PR cannot mint a
// duplicate of already-landed work without the agent being told to check.
// The deterministic half (ship-changes.sh open_pr preflight) is behavior-
// pinned in ship-changes.test.mjs.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
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
