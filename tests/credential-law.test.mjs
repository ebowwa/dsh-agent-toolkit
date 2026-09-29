// credential-law.test.mjs — pins the REVIEW.md credential law in the
// dispatch workflow files.
//
// Regression anchor: issue #246. The flight-recorder step in
// agent-dispatch.yml carried the token on argv via a credential URL
// (`https://x-access-token:${GH_TOKEN}@github.com/...`) — ps-readable to
// same-user processes on shared boxes — and interpolated raw
// `${{ github.repository }}` / `${{ github.run_id }}` straight into the
// run block (the injection seam CLAUDE.md forbids). The fix routes git
// auth through the sanctioned env seam (GIT_CONFIG_COUNT /
// GIT_CONFIG_KEY_n / GIT_CONFIG_VALUE_n extraheader) and the workflow
// expressions through env vars. These tests fail without the fix:
// restore the credential-URL remote or the raw interpolations and this
// suite goes red.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WF_DIR = path.join(ROOT, ".github", "workflows");

const read = (rel) => readFileSync(path.join(ROOT, rel), "utf8");

test("no workflow puts a token on argv via a credential-URL remote", () => {
  for (const f of readdirSync(WF_DIR)) {
    const text = readFileSync(path.join(WF_DIR, f), "utf8");
    assert.doesNotMatch(
      text,
      /https:\/\/[^"'\s]*x-access-token:[^"'\s]*@github\.com/,
      `${f}: credential-URL remote puts the token on git's argv (REVIEW.md: credentials never ride argv)`,
    );
  }
});

test("agent-dispatch flight recorder authenticates git via the env config seam", () => {
  const w = read(".github/workflows/agent-dispatch.yml");
  assert.match(w, /GIT_CONFIG_COUNT/);
  assert.match(w, /GIT_CONFIG_KEY_0/);
  assert.match(w, /GIT_CONFIG_VALUE_0/);
  assert.match(
    w,
    /http\.https:\/\/github\.com\/\.extraheader/,
    "expected the extraheader env-config auth pattern",
  );
});

test("agent-dispatch interpolates repository/run_id through the env seam", () => {
  const w = read(".github/workflows/agent-dispatch.yml");
  // The only raw ${{ }} left in the file must live in env:/with: values,
  // never in a run: block's bash.
  const runBlocks = [...w.matchAll(/^ {10}run: \|[\s\S]*?(?=^ {6}- |^\S|$)/gm)];
  for (const { 0: block } of runBlocks) {
    assert.doesNotMatch(
      block,
      /\$\{\{/,
      `raw \${{ }} interpolated into a run block (injection seam): ${block.slice(0, 80)}`,
    );
  }
  assert.match(w, /REPO_PATH: \$\{\{ github\.repository \}\}/);
  assert.match(w, /RUN_ID: \$\{\{ github\.run_id \}\}/);
});
