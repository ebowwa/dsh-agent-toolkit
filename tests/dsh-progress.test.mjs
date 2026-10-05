// dsh-progress.test.mjs — contract pin for the live session-trace renderer's
// argument preview (ebowwa/FleetTower#1233). The renderer feeds the Actions
// log, and the node's 300-char stderr tail + terminal-detail prose cut that
// stream into every claims-ledger `result` and fleet-digest `done:` row: a
// bare String() coercion of a structured argument value minted
// `todos: [object Object]×7` onto five done rows (2026-10-05). Structured
// argument values must render as JSON — never as coercion debris — while
// string values keep the old bare shape byte-for-byte (the JSON quoting is
// reserved for non-strings).
import { spawnSync } from "node:child_process";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

const PROGRESS = path.join(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
  "scripts",
  "dsh-progress.mjs",
);

function render(lines) {
  const r = spawnSync("node", [PROGRESS], { input: lines, encoding: "utf8" });
  assert.equal(r.status, 0, `renderer exited ${r.status}: ${r.stderr}`);
  return r.stdout;
}

const SEVEN_TODOS = Array.from({ length: 7 }, (_, i) => ({
  content: `todo ${i + 1}`,
  status: "completed",
}));

test("todo_write's array-of-records argument renders as JSON, never coercion debris", () => {
  const evt = {
    type: "tool/call",
    data: { name: "todo_write", arguments: JSON.stringify({ todos: SEVEN_TODOS }) },
  };
  const out = render(JSON.stringify(evt) + "\n");
  assert.match(out, /^tool: todo_write — todos: \[/, "structured value renders as JSON after the key");
  assert.ok(out.includes('"content":"todo 1"'), "the records themselves are visible");
  assert.doesNotMatch(out, /\[object\s*Object\]/, "no String() coercion debris");
});

test("the #1233 wreck pair (todo_write call + its result) renders clean end-to-end", () => {
  const call = {
    type: "tool/call",
    data: { name: "todo_write", arguments: JSON.stringify({ todos: SEVEN_TODOS }) },
  };
  const result = {
    type: "tool/result",
    data: {
      message: {
        content: [
          {
            type: "tool-result",
            content: [{ type: "text", text: "Updated todo list: 0 pending, 0 in progress, 7 completed." }],
          },
        ],
      },
    },
  };
  const out = render(JSON.stringify(call) + "\n" + JSON.stringify(result) + "\n");
  assert.ok(out.includes("result: Updated todo list: 0 pending, 0 in progress, 7 completed."));
  assert.doesNotMatch(out, /\[object\s*Object\]/, "the ledger-wreck shape never re-mints");
});

test("a structured value under a KNOWN key renders as JSON too (same coercion path)", () => {
  const evt = {
    type: "tool/call",
    data: {
      name: "write",
      arguments: JSON.stringify({ content: [{ type: "text", text: "hi" }] }),
    },
  };
  const out = render(JSON.stringify(evt) + "\n");
  assert.match(out, /^tool: write — content: \[\{"type":"text"/);
  assert.doesNotMatch(out, /\[object\s*Object\]/);
});

test("string argument values keep the old bare shape — no JSON quoting introduced", () => {
  const evt = {
    type: "tool/call",
    data: { name: "bash", arguments: JSON.stringify({ command: "bun test scripts/" }) },
  };
  const out = render(JSON.stringify(evt) + "\n");
  assert.equal(out, "tool: bash — command: bun test scripts/\n");
});

test("unparseable argument payloads still render (the catch path is unchanged)", () => {
  const evt = { type: "tool/call", data: { name: "bash", arguments: "not json at all" } };
  const out = render(JSON.stringify(evt) + "\n");
  assert.equal(out, "tool: bash — not json at all\n");
});
