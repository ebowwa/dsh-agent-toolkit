// drift-gate.test.mjs — the release gate must stay fail-closed.
//
// Regression anchor: drift-check run 34803136038 (BLOCK verdict, 2026-09-14).
// The gate HELD: the release agent BLOCKed the dsh-bot → dsh-agent-toolkit
// rename (a breaking env/input contract riding the auto-propagating moving
// tag) and the tagging step exited 1 without tagging, releasing, advancing
// @v1, or notifying consumers — the incident stayed a red run instead of a
// fleet-bricking tag. NOTHING pinned that property: a refactor that admits
// BLOCK, drops the gate, reorders propagation ahead of the verdict, severs
// the GITHUB_ENV handoff, or reviews a narrower surface than it propagates
// would all have gone green. These tests fail without the fix — mutate
// drift-check.yml accordingly (e.g. `TAG|TAG-WITH-FINDINGS|BLOCK)`, delete
// the `exit 1`, move the `case` below `git tag`, hard-code VERDICT, drop a
// pathspec family, or add a workflow_call workflow the paths filter does
// not match) and this suite goes red.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (...p) => readFileSync(path.join(ROOT, ...p), "utf8");
const wf = read(".github", "workflows", "drift-check.yml");

/** The full YAML block of a workflow step, found by its `name:`. */
const stepBlock = (name) => {
  const lines = wf.split("\n");
  const i = lines.findIndex((l) => l.trim() === `- name: ${name}`);
  assert.notEqual(i, -1, `step "${name}" must exist in drift-check.yml`);
  const indent = lines[i].match(/^(\s*)-/)[1].length;
  const out = [];
  for (let k = i + 1; k < lines.length; k++) {
    const l = lines[k];
    if (l.trim() === "") { out.push(l); continue; }
    const m = l.match(/^(\s*)-/);
    if (m && m[1].length <= indent) break; // next step / dedent out of steps:
    out.push(l);
  }
  return out.join("\n");
};

/** The run-block of a workflow step, found by its `name:`, dedented. */
const stepRun = (name) => {
  const lines = stepBlock(name).split("\n");
  let j = lines.findIndex((l) => /^\s+run:\s*\|\s*$/.test(l));
  assert.ok(j !== -1, `step "${name}" must have a literal run block`);
  let contentIndent = null;
  const body = [];
  for (let k = j + 1; k < lines.length; k++) {
    if (lines[k].trim() === "") { body.push(""); continue; }
    const m = lines[k].match(/^(\s+)\S/);
    if (!m) break;
    if (contentIndent === null) contentIndent = m[1].length;
    if (m[1].length < contentIndent) break;
    body.push(lines[k].slice(contentIndent));
  }
  const script = body.join("\n");
  assert.ok(script.trim().length > 0, `step "${name}" run block must not be empty`);
  return script;
};

const AGENT_STEP = "Agent reviews its own diff (release gate)";
const TAG_STEP = "Tag + release + notify (only on TAG verdicts)";

/** drift-check.yml's push-path trigger patterns. */
const pushPaths = () => {
  const m = wf.match(/paths:\n((?:\s+-[^\n]+\n)+)/);
  assert.ok(m, "drift-check.yml must filter its push trigger with paths:");
  return [...m[1].matchAll(/^\s+- '?([^'\n]+)'?\s*$/gm)].map((x) => x[1]);
};

/** The scope step's `git diff --stat` pathspec tokens. */
const diffPathspec = () => {
  const script = stepRun("What changed since the last tag?");
  const m = script.match(/git diff --stat[^\n|]*?--[ \t]+([^\n|]+)/);
  assert.ok(m, "the scope step must scope its diff with an explicit pathspec");
  return m[1].trim().split(/\s+/).map((t) => t.replace(/^'|'$/g, ""));
};

/** Family key: trigger patterns and pathspecs spell the same surface. */
const family = (t) => t.replace(/\/\*\*$/, "");

/** Mini-glob: a trigger pattern against a repo-relative path. */
const globMatch = (pattern, p) =>
  new RegExp(
    "^" +
      pattern
        .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
        .replace(/\*\*/g, "\u0000")
        .replace(/\*/g, "[^/]*")
        .replace(/\u0000/g, ".*") +
      "$",
  ).test(p);

test("the tagging step admits only TAG verdicts and fails closed otherwise", () => {
  const script = stepRun(TAG_STEP);
  const caseAt = script.indexOf('case "$VERDICT" in');
  assert.notEqual(caseAt, -1, "the tagging step must gate propagation on $VERDICT");
  const end = script.indexOf("esac", caseAt);
  assert.notEqual(end, -1, "the verdict case must be closed with esac");
  const caseBlock = script.slice(caseAt, end);

  const branch = caseBlock.match(/^[ \t]*([^*\s][^\n]*?)\)[ \t]/m);
  assert.ok(branch, "the verdict case must have a non-fallthrough branch");
  const labels = branch[1].split("|").map((s) => s.trim());
  assert.deepEqual(
    labels,
    ["TAG", "TAG-WITH-FINDINGS"],
    "the allowed set must be exactly TAG and TAG-WITH-FINDINGS — admitting BLOCK (run 34803136038's verdict) or anything else would auto-propagate a blocked release",
  );

  const fallthrough = caseBlock.match(/^[ \t]*\*[ \t]*\)[ \t]([^\n]*)/m);
  assert.ok(fallthrough, "the verdict case must keep a fallthrough branch");
  assert.match(
    fallthrough[1],
    /exit 1/,
    "the fallthrough (BLOCK / empty / off-contract verdict) must exit nonzero — fail closed, no tag",
  );
});

test("nothing propagates before the verdict gate", () => {
  const script = stepRun(TAG_STEP);
  const order = [
    ["esac", /esac/],
    ["git tag $NEXT", /git tag "\$NEXT"/],
    ["gh release create", /gh release create/],
    ["moving-tag advance", /git tag -f "\$MOVING" "\$NEXT"/],
    ["consumer notify", /repos\/\$repo\/dispatches/],
  ];
  let prev = -1;
  for (const [label, re] of order) {
    const m = script.match(re);
    assert.ok(m, `propagation step "${label}" must exist in the tagging step`);
    const at = m.index;
    assert.ok(
      at > prev,
      `"${label}" must run after the verdict gate and after every earlier propagation step — reordering notifies/releases on unreviewed or blocked verdicts`,
    );
    prev = at;
  }
});

test("the verdict reaches the gate from the agent step, never a literal", () => {
  const agent = stepBlock(AGENT_STEP);
  const publishAt = agent.indexOf('>> "$GITHUB_ENV"');
  assert.notEqual(publishAt, -1, "the agent step must publish through GITHUB_ENV");
  const verdictAt = agent.indexOf("VERDICT=");
  assert.ok(
    verdictAt !== -1 && verdictAt < publishAt,
    "the agent step must publish the parsed verdict (VERDICT=) through GITHUB_ENV",
  );
  assert.match(
    agent,
    /drift-verdict\.mjs/,
    "the verdict must come from scripts/drift-verdict.mjs's line-strict parse (revert guard)",
  );
  const gate = stepBlock(TAG_STEP);
  assert.match(
    gate,
    /VERDICT:[ \t]*\$\{\{ env\.VERDICT \}\}/,
    "the tagging step must consume the published env.VERDICT — a literal or local default would decouple the gate from the review",
  );
});

test("the review surface and the propagation surface agree", () => {
  const triggers = pushPaths().map(family).sort();
  const pathspec = diffPathspec().map(family).sort();
  assert.ok(triggers.length > 0, "the push trigger must list surfaces");
  assert.deepEqual(
    pathspec,
    triggers,
    "the scope step's diff pathspec must cover exactly the trigger surfaces — a surface the workflow fires for but does not review (or reviews but never fires for) ships or stalls silently",
  );

  const task = stepRun(AGENT_STEP);
  assert.match(
    task,
    /Scope: git diff \$\{BASE\}\.\.HEAD/,
    "the review task must state the diff scope it reviews",
  );
  for (const t of triggers) {
    const short = t.split("/").pop(); // the task may use the basename phrasing
    assert.ok(
      task.includes(t) || task.includes(short),
      `the review task must name every scoped surface ("${t}") — the agent can only review what the task tells it to`,
    );
  }
});

test("every consumer-adoptable workflow is inside the release gate's review surface", () => {
  const triggers = pushPaths();
  const adoptable = readdirSync(path.join(ROOT, ".github", "workflows"))
    .filter((n) => n.endsWith(".yml"))
    .filter((n) => /^\s+workflow_call:\s*$/m.test(read(".github", "workflows", n)));
  assert.ok(
    adoptable.length >= 6,
    `the repo must still expose its reusable-workflow adoption surface (found ${adoptable.length})`,
  );
  for (const w of adoptable) {
    const p = `.github/workflows/${w}`;
    assert.ok(
      triggers.some((t) => globMatch(t, p)),
      `reusable workflow "${w}" is consumer-adoptable (workflow_call) but drift-check does not fire for it — a breaking change to it would ride the moving tag without ever being reviewed or released (the run-34803136038 class)`,
    );
  }
});
