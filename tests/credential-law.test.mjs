// credential-law.test.mjs — pins the REVIEW.md credential law across
// EVERY workflow file, not just the step that earned the rule.
//
// REVIEW.md (Correctness): "Credentials never ride argv anywhere: a token
// passed as a git `-c` value, a curl `-H` header, or any command-line
// argument is rejected — argv is ps-readable to same-user processes on
// shared boxes. Env-based git config (`GIT_CONFIG_COUNT`), header-file
// curl config, and `.git/config` extraheaders are the sanctioned seams."
//
// Regression anchor: issue #246 — the agent-dispatch flight-recorder step
// pushed GH_TOKEN into a `git remote add` credential URL (argv-visible,
// persisted into the temp clone's .git/config) and interpolated raw
// `${{ github.repository }}` / `${{ github.run_id }}` straight into bash.
// PR #247 carried this suite but conflicted and closed; the redo ticket is
// #266. PR #259 landed the workflow half (commit 2e5e526, "Closes #246")
// and pinned THAT ONE STEP inside tests/resolve-push-token.test.mjs —
// but a step-scoped pin cannot see a sibling workflow re-growing the same
// defect class, which is exactly how #246 happened (the file's own push
// step already used the sanctioned seam while the flight recorder didn't).
// These tests hold the law at repo scope: restore a credential-URL remote
// in ANY workflow, or interpolate ANY raw `${{ }}` into ANY run block,
// and this suite goes red. Main is clean today (verified 2026-10-04:
// zero credential URLs, zero run-block interpolations, zero curl -H /
// git -c token argv across all workflows).

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WF_DIR = path.join(ROOT, ".github", "workflows");

const workflowFiles = () =>
  readdirSync(WF_DIR).filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"));

const read = (f) => readFileSync(path.join(WF_DIR, f), "utf8");

// A credential URL is any https URL with user:password userinfo against
// github.com — the `x-access-token:<token>@` remote-add form of #246 is
// the instance that bit, but the law is about the class: whatever the
// userinfo names, a password on an argv-passed URL is ps-readable.
const CREDENTIAL_URL = /https:\/\/[^"'\s]*:[^@"'\/\s]*@github\.com/;

test("no workflow embeds credentials in a git remote URL (repo-wide law)", () => {
  for (const f of workflowFiles()) {
    const text = read(f);
    const hit = text.match(CREDENTIAL_URL);
    assert.ok(
      !hit,
      `${f}: credential URL "${hit?.[0]}" puts a token on git's argv and into .git/config (REVIEW.md: credentials never ride argv; use the GIT_CONFIG_COUNT env seam)`,
    );
  }
});

test("no workflow passes a token as a git -c value or curl -H header (repo-wide law)", () => {
  // The two argv forms REVIEW.md names besides the credential URL.
  // Env-fed git config and header-FILE curl config are the sanctioned
  // seams (cf. scripts/resolve-push-token.sh); a literal header/`-c`
  // value carrying a token on the command line is the rejected form.
  for (const f of workflowFiles()) {
    const text = read(f);
    for (const [i, line] of text.split("\n").entries()) {
      assert.ok(
        !/\bgit\b[^\n]*\s-c\s[^\n]*\b(GH_TOKEN|_PAT|TOKEN)\b/.test(line),
        `${f}:${i + 1}: git -c with a token value rides argv (REVIEW.md)`,
      );
      assert.ok(
        !/\bcurl\b[^\n]*-H\s*["'][^"']*(Authorization|token)[^"']*\$\{/.test(line),
        `${f}:${i + 1}: curl -H with an interpolated credential rides argv (REVIEW.md)`,
      );
    }
  }
});

test("no workflow interpolates raw ${{ }} into a run: block (repo-wide law)", () => {
  // The injection seam: bash never sees workflow expressions directly —
  // values arrive through step env: (the DSH_KEEP_SESSIONS / #239 rule).
  // Covers both `run: |` block bodies (tracked by indentation until the
  // block dedents) and single-line `run:` commands.
  for (const f of workflowFiles()) {
    const lines = read(f).split("\n");
    let inRun = false;
    let runIndent = 0;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const m = line.match(/^(\s*)run:/);
      if (!inRun && m) {
        const isBlock = /\|\s*$|>\s*$/.test(line);
        if (isBlock) {
          inRun = true;
          runIndent = m[1].length;
        } else if (/\$\{\{/.test(line)) {
          assert.fail(
            `${f}:${i + 1}: raw \${{ }} in a single-line run: command (injection seam; route it through step env:) — ${line.trim().slice(0, 72)}`,
          );
        }
        continue;
      }
      if (!inRun || line.trim() === "") continue;
      const ind = line.match(/^(\s*)/)[1].length;
      if (ind <= runIndent) {
        inRun = false;
        continue;
      }
      if (/\$\{\{/.test(line)) {
        assert.fail(
          `${f}:${i + 1}: raw \${{ }} interpolated into a run block (injection seam; route it through step env:) — ${line.trim().slice(0, 72)}`,
        );
      }
    }
  }
});

test("agent-dispatch flight recorder authenticates through the sanctioned env-config seam", () => {
  // Law-level parity with the step-scoped pins in
  // tests/resolve-push-token.test.mjs (PR #259): the seam itself must
  // stay — an env-fed GIT_CONFIG_COUNT extraheader, not a credential URL.
  // Pinned on the EXPORT lines, not a bare mention: the file's comment
  // block also says "GIT_CONFIG_COUNT", so a name-only match stays green
  // with the seam deleted (the #393 whole-file-string-match lesson).
  const w = read("agent-dispatch.yml");
  assert.match(w, /export GIT_CONFIG_COUNT=/, "expected the env-fed git config seam export");
  assert.match(
    w,
    /export GIT_CONFIG_KEY_0='http\.https:\/\/github\.com\/\.extraheader'/,
    "expected the extraheader key export",
  );
  assert.match(w, /export GIT_CONFIG_VALUE_0=/, "expected the extraheader value export");
});
