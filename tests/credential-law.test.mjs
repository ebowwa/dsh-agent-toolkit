// credential-law.test.mjs — repo-wide pins for the REVIEW.md credential law
// ("Credentials never ride argv anywhere") and the run-block env-seam
// routing rule.
//
// Regression anchor: issue #246 → PR #247 (conflicted against a moved main;
// redo ticket #266). The #246 defect: the agent-dispatch flight-recorder
// step built its git remote as a credential URL —
// https://x-access-token:${GH_TOKEN}@github.com/... — putting the token on
// git's argv (ps-readable to same-user processes on shared boxes) and
// persisting it in the temp clone's .git/config remote URL; the same step
// interpolated raw ${{ github.repository }} / ${{ github.run_id }} straight
// into bash (the injection seam the env-routing rule closes). The YAML half
// landed on main via 2e5e526 ("Closes #246") together with STEP-SCOPED pins
// in tests/resolve-push-token.test.mjs ("agent-dispatch.yml: flight recorder
// keeps the token off argv and ${{ }} out of the run block" — one file, one
// step). This file is the redo's remaining delta, done fresh at current
// main: the same law pinned REPO-WIDE, so a credential that rides argv or a
// raw interpolation in ANY workflow — including future ones — fails gates,
// not just the one step the original defect lived in:
//
//   1. no workflow builds a credential-URL remote (userinfo in a
//      github.com URL = token on git's argv AND in .git/config);
//   2. no workflow puts a credential on argv via `git -c ...extraheader`
//      or `curl -H "Authorization: ..."` — REVIEW.md's other two named
//      argv shapes (env-fed GIT_CONFIG_COUNT / header-file curl config
//      are the sanctioned seams);
//   3. no workflow interpolates raw ${{ }} into a run: block (block
//      scalar or inline) — run-block context flows through step env:
//      the REPO_FULL_NAME / FLIGHT_RUN_ID / DSH_KEEP_SESSIONS seam.
//
// These tests fail without the fix: restore the credential-URL remote, an
// argv credential, or a raw run-block interpolation in any workflow and
// this suite goes red. The step-scoped pins (the remote line, the env-var
// declarations, resolver ordering) stay where they live, in
// resolve-push-token.test.mjs — no duplication here.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WF_DIR = path.join(ROOT, ".github", "workflows");

const workflowFiles = () =>
  readdirSync(WF_DIR)
    .filter((n) => n.endsWith(".yml") || n.endsWith(".yaml"))
    .sort();

const readWorkflow = (f) => readFileSync(path.join(WF_DIR, f), "utf8");

// Every run: block in a workflow: block scalars (run: |, run: >-, run: |2,
// … — content = strictly deeper lines until a non-blank dedent to/below the
// key's column, the same semantics scripts/workflow-lint.mjs enforces) plus
// inline single-line `run: command` values. env:/with:/if: values are NOT
// run blocks — ${{ }} there is the sanctioned seam this suite demands.
// Returns [{line, text}] with 1-based line numbers.
const runBlocks = (text) => {
  const blocks = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const header = /^(\s*)run:\s*(.*)$/.exec(lines[i]);
    if (!header) continue;
    const [, keyIndent, value] = header;
    if (value && !/^[|>]/.test(value)) {
      blocks.push({ line: i + 1, text: value });
      continue;
    }
    // block scalar (or empty value with deeper content): consume deeper
    // lines so a `run:` INSIDE block text (a heredoc writing a workflow,
    // say) is content, not a nested header
    const body = [];
    let j = i + 1;
    for (; j < lines.length; j++) {
      const l = lines[j];
      if (l.trim() === "") {
        body.push(l);
        continue;
      }
      if (/^ */.exec(l)[0].length <= keyIndent.length) break;
      body.push(l);
    }
    blocks.push({ line: i + 1, text: body.join("\n") });
    i = j - 1;
  }
  return blocks;
};

test("no workflow builds a credential-URL remote (token on git's argv)", () => {
  // any userinfo segment in a github.com URL — x-access-token:<tok>,
  // user:<pat>, oauth2:<tok> — is the #246 shape: bash expansion puts the
  // full credential URL on argv (ps-readable to same-user processes) and
  // git persists it in .git/config. REVIEW.md: credentials never ride argv.
  const credentialUrl = /https:\/\/[^"'/\s@]+:[^"'\s]*@github\.com/;
  for (const f of workflowFiles()) {
    assert.doesNotMatch(
      readWorkflow(f),
      credentialUrl,
      `${f}: credential-URL remote puts the token on git's argv and in .git/config ` +
        `(REVIEW.md credential law; cf. the GIT_CONFIG_COUNT env seam in agent-dispatch.yml)`,
    );
  }
});

test("no workflow puts a credential on argv (git -c extraheader, curl -H auth header)", () => {
  // REVIEW.md names three argv shapes: a git -c value, a curl -H header,
  // any command-line argument. The URL shape is pinned above; these are
  // the other two. Env-fed GIT_CONFIG_COUNT / header-file curl config are
  // the sanctioned seams. Comment lines are skipped — prose about the law
  // is not the law breaking.
  const gitC = /git\s+-c\s+[^\n]*extraheader/i;
  const curlH = /curl[^#\n]*\s-H\s*["'][^'\n]*(authorization|bearer|token)/i;
  for (const f of workflowFiles()) {
    const codeLines = readWorkflow(f)
      .split(/\r?\n/)
      .filter((l) => !/^\s*#/.test(l));
    for (const l of codeLines) {
      assert.ok(
        !gitC.test(l),
        `${f}: 'git -c …extraheader' carries the credential on argv — use the env-fed GIT_CONFIG_COUNT seam`,
      );
      assert.ok(
        !curlH.test(l),
        `${f}: 'curl -H <auth header>' carries the credential on argv — use header-file curl config`,
      );
    }
  }
});

test("no workflow interpolates raw ${{ }} into a run: block", () => {
  // Run-block context must flow through step env (the REPO_FULL_NAME /
  // FLIGHT_RUN_ID / DSH_KEEP_SESSIONS seam): raw ${{ }} in bash is the
  // injection seam, and it hides which values the script consumes. All of
  // them — ${{ github.* }}, ${{ secrets.* }}, ${{ inputs.* }} — belong in
  // env: mappings where they are visible and quoted once.
  for (const f of workflowFiles()) {
    for (const { line, text } of runBlocks(readWorkflow(f))) {
      assert.ok(
        !text.includes("${{"),
        `${f}: raw \${{ }} interpolated into a run: block at line ${line} — ` +
          `route the context through a step env: var (cf. REPO_FULL_NAME / FLIGHT_RUN_ID)`,
      );
    }
  }
});
