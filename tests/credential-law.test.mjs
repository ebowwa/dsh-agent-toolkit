// tests/credential-law.test.mjs — the credential law + the run-block
// injection seam, pinned fleet-wide across EVERY workflow.
//
// Regression anchor: issue #246 — the agent-dispatch flight-recorder step
// embedded GH_TOKEN in the `git remote add` URL (bash expansion put the
// full credential URL on argv, ps-readable to same-user processes, and
// persisted it in the temp clone's .git/config remote URL) and
// interpolated ${{ github.repository }} / ${{ github.run_id }} raw into
// the run block. The cure landed as 2e5e526 ("Closes #246") with a
// STEP-specific pin in tests/resolve-push-token.test.mjs that guards only
// that one flight-recorder step.
//
// The LAW is general, and until this file nothing pinned it generally:
//   - REVIEW.md: "Credentials never ride argv anywhere: a token passed as
//     a git `-c` value, a curl `-H` header, or any command-line argument
//     is rejected — argv is ps-readable to same-user processes on shared
//     boxes. Env-based git config (`GIT_CONFIG_COUNT`), header-file curl
//     config, and `.git/config` extraheaders are the sanctioned seams."
//   - The env-routing rule (issue #239 class): no raw ${{ }} inside any
//     run block — GitHub-controlled context must flow through step env.
// A NEW workflow could regress either law silently; only the one step was
// pinned (issue #266, the PR #247 redo residual — the original carrier
// carried this test, the landed cure did not).
//
// Two layers, so the checker itself cannot rot:
//   1. hermetic fixtures — the exact #246 defect shapes MUST be flagged,
//      and the sanctioned seams MUST pass (no overreach);
//   2. the live tree — every workflow in .github/workflows stays clean.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WORKFLOWS_DIR = path.join(ROOT, ".github", "workflows");

// --- the checker -------------------------------------------------------------
//
// Extract every run-block CONTENT line (the bash GitHub Actions will exec)
// from a workflow body. Handles the three YAML shapes this repo uses:
//   run: |            block scalar (content = deeper-indented lines)
//   run: >-           folded scalar (same)
//   run: echo hi      inline value (content = the rest of the line)
// `${{ }}` anywhere in run content — comments included — is a violation:
// GitHub expands the expression before bash ever sees the line.

/** @returns {{file: string, no: number, text: string}[]} run-block content lines */
export function runBlockLines(text, file = "<memory>") {
  const out = [];
  const lines = text.split("\n");
  let runIndent = null; // indent of the `run:` keyword while inside its scalar
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const m = line.match(/^(\s*)run:(?:\s+(.*))?$/);
    if (runIndent === null) {
      if (!m) continue;
      const value = (m[2] ?? "").trim();
      if (value === "" || /^[|>][+-]?\d*$/.test(value)) {
        runIndent = m[1].length; // block/folded scalar: content follows
      } else {
        out.push({ file, no: i + 1, text: value }); // inline value IS content
      }
      continue;
    }
    if (line.trim() === "") continue; // blank lines stay inside the scalar
    const indent = line.match(/^\s*/)[0].length;
    if (indent <= runIndent) {
      runIndent = null; // scalar closed; this line may open the next one
      if (m) {
        const value = (m[2] ?? "").trim();
        if (value !== "" && !/^[|>][+-]?\d*$/.test(value)) out.push({ file, no: i + 1, text: value });
        else if (value === "" || /^[|>][+-]?\d*$/.test(value)) runIndent = m[1].length;
      }
      continue;
    }
    out.push({ file, no: i + 1, text: line });
  }
  return out;
}

// Credential URL: userinfo baked into a URL (`https://<user>[:<pass>]@host`
// — the #246 shape `https://x-access-token:${GH_TOKEN}@github.com/...`).
// Does NOT match the sanctioned header CONSTRUCTION
// (`printf 'x-access-token:%s' "$GH_TOKEN"` — no URL, no userinfo).
const CRED_URL = /https:\/\/[^/"'`\s]+@/;

// Credential as a git argv value: `git -c http.<...>.extraheader=<value>`
// (REVIEW.md's first named rejection). Must catch `-c` BOTH directly after
// `git` (`git -c http.extraheader=x push`) and mid-args (`git clone url -c
// http.extraheader=x`) — the naive `\s+…\s-c` eats the only space in the
// first form and misses it. The empty `git -c credential.helper=`
// neutralizer carries no credential and must NOT match. (Known gap, same
// as any line-pinned lint: a `-c` split onto a `\`-continuation line.)
const GIT_C_ARGV = /(?:^|\s)git(?:\s[^\n]*?)?\s-c\s*\S*extraheader/;

// Credential as a curl argv value: `curl -H "Authorization: ..."`
// (REVIEW.md's second named rejection).
const CURL_H_ARGV = /curl[^\n]*-H[^\n]*(?:[Aa]uthorization|[Tt]oken)/;

function violations(lines) {
  return {
    rawInterpolation: lines.filter((l) => l.text.includes("${{")),
    credentialUrl: lines.filter((l) => CRED_URL.test(l.text)),
    argvCredential: lines.filter((l) => GIT_C_ARGV.test(l.text) || CURL_H_ARGV.test(l.text)),
  };
}

// --- layer 1: hermetic — the checker flags the defect class ------------------

test("credential-law checker: flags the exact #246 defect shapes", () => {
  const evil = [
    "jobs:",
    "  build:",
    "    runs-on: [self-hosted]",
    "    steps:",
    "      - name: old flight recorder",
    "        run: |",
    "          git remote add origin \"https://x-access-token:${GH_TOKEN}@github.com/${{ github.repository }}.git\"",
    "          git push origin tower-state",
    "      - name: argv -c",
    "        run: git -c http.https://github.com/.extraheader=\"AUTHORIZATION: basic $B64\" push",
    "      - name: argv -c mid-args",
    "        run: git clone --quiet https://github.com/o/r.git -c http.https://github.com/.extraheader=\"$B64\" dest",
    "      - name: curl header",
    "        run: curl -H \"Authorization: token ${GH_TOKEN}\" https://api.github.com/u",
    "      - name: inline interpolation",
    "        run: echo \"run ${{ github.run_id }}\"",
  ].join("\n");
  const v = violations(runBlockLines(evil, "evil.yml"));
  assert.equal(v.credentialUrl.length, 1, "credential URL must be flagged");
  assert.match(v.credentialUrl[0].text, /x-access-token/);
  assert.equal(v.rawInterpolation.length, 2, "raw ${{ }} flagged in block scalar AND inline run");
  assert.equal(v.argvCredential.length, 3, "git -c extraheader (both arg positions) AND curl -H Authorization flagged");
});

test("credential-law checker: the sanctioned seams pass (no overreach)", () => {
  const clean = [
    "jobs:",
    "  build:",
    "    steps:",
    "      - name: cured flight recorder",
    "        env:",
    "          GH_TOKEN: ${{ secrets.REPO_TOKEN }}",
    "          REPO_FULL_NAME: ${{ github.repository }}",
    "        run: |",
    "          git remote add origin \"https://github.com/${REPO_FULL_NAME}.git\"",
    "          export GIT_CONFIG_COUNT=1",
    "          export GIT_CONFIG_KEY_0='http.https://github.com/.extraheader'",
    "          export GIT_CONFIG_VALUE_0=\"AUTHORIZATION: basic $(printf 'x-access-token:%s' \"${GH_TOKEN}\" | base64)\"",
    "          git -c credential.helper= fetch -q origin tower-state",
    "          printf 'see https://github.com/ebowwa/dsh-agent-toolkit for the law' >&2",
    "      - name: folded scalar",
    "        run: >-",
    "          echo clean",
  ].join("\n");
  const v = violations(runBlockLines(clean, "clean.yml"));
  assert.deepEqual(v, { rawInterpolation: [], credentialUrl: [], argvCredential: [] });
  // env: lines are NOT run content — the env block above must never be scanned
  const contents = runBlockLines(clean, "clean.yml").map((l) => l.text).join("\n");
  assert.ok(!contents.includes("secrets.REPO_TOKEN"), "env: lines are not run-block content");
});

// --- layer 2: the live tree — every workflow, every run block ----------------

function liveLines() {
  const files = readdirSync(WORKFLOWS_DIR).filter((f) => /\.(yml|yaml)$/.test(f)).sort();
  assert.ok(files.length > 0, "workflow directory must exist and be non-empty");
  return files.flatMap((f) =>
    runBlockLines(readFileSync(path.join(WORKFLOWS_DIR, f), "utf8"), f));
}

test("every workflow run block: credentials never ride a URL or argv (REVIEW.md credential law)", () => {
  const v = violations(liveLines());
  const show = (xs) => xs.map((l) => `${l.file}:${l.no}: ${l.text.trim().slice(0, 100)}`).join("\n");
  assert.equal(v.credentialUrl.length, 0, `credential URLs on argv:\n${show(v.credentialUrl)}`);
  assert.equal(v.argvCredential.length, 0, `git -c / curl -H credentials on argv:\n${show(v.argvCredential)}`);
});

test("every workflow run block: no raw ${{ }} interpolation (env-routing rule, #239 class)", () => {
  const v = violations(liveLines());
  assert.equal(v.rawInterpolation.length, 0,
    `raw context interpolation in run blocks (route through step env):\n${
      v.rawInterpolation.map((l) => `${l.file}:${l.no}: ${l.text.trim().slice(0, 100)}`).join("\n")}`);
});
