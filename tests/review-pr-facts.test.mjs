// review-pr-facts.test.mjs — the PR-facts parse is fail-closed on a
// rate-limited gh response (issue #529).
//
// The bug class (the issue #527 sweep shape, item-level): under a 403/429
// throttle wave gh prints its human error AND the raw error body on
// STDOUT, so `PR_JSON="$(gh pr view ... || true)"` holds non-empty GARBAGE
// the `[ -n "$PR_JSON" ]` guard cannot catch. The old per-field
// `node -e 'JSON.parse(readFileSync(0))'` had no try/catch: the parse
// threw, the assignment failed, `set -e` killed review-pr.sh mid-item with
// a node stack trace — never reaching the typed `exit 2` ("review-pr: PR
// #N has no base/head"). While the `dsh/review` label stays on (the item
// is claimed only after the facts parse), the trace replays every sweep.
//
// The fix (the PR #528 poll_field shape): a guarded `pr_field` extractor —
// try/catch around the parse, a non-JSON body degrades to an EMPTY field —
// so garbage reaches the existing typed exit 2 instead of an uncaught
// throw. dsh-worker.sh:418 (the trust re-derivation) was already safe via
// its `|| true` (issue #529 receipts).
//
// Pinned here:
//   1. END-TO-END: a 403 garbage body on `gh pr view` stdout ⇒ exit 2 with
//      the TYPED "has no base/head" message and NO node stack trace.
//   2. END-TO-END: an EMPTY `gh pr view` stdout keeps the pre-existing
//      "cannot read PR" typed exit (the `|| true` arm is unchanged).
//   3. END-TO-END happy-path control: valid PR JSON parses and the script
//      proceeds PAST the facts gate (reaches the rules-contract gate).
//   4. STRUCTURAL: the three facts assignments route through the guarded
//      extractor; no unguarded `JSON.parse(readFileSync(0` assignment
//      remains in the PR-facts block.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REVIEW_PR = path.join(ROOT, "scripts", "review-pr.sh");
const read = (...p) => readFileSync(path.join(ROOT, ...p), "utf8");

// The review-pr-diff.test.mjs lesson: when this suite runs inside a dsh
// driver child, the ambient PATH carries the driver's transient scrub-shim
// dirs (dsh-shim.<pid>) WITHOUT their env contract; drop exactly those and
// keep the rest (tests-lint forbids hard-coding system dirs).
const ambientPathWithoutDriverShims = (p = process.env.PATH || "") =>
  p
    .split(path.delimiter)
    .filter((dir) => !path.basename(dir).startsWith("dsh-shim."))
    .join(path.delimiter);

// The 403 receipt body, verbatim the shape PR #528 pinned in
// worker-smoke.test.mjs: gh prints the human error on stderr AND the raw
// JSON error body on stdout.
const RATE_LIMIT_BODY = `gh: API rate limit exceeded for user ID 81942069. (HTTP 403)
{
\t"message": "API rate limit exceeded for user ID 81942069.",
\t"documentation_url": "https://docs.github.com/rest/rate-limit"
}
`;

// Run review-pr.sh with a `gh` shim whose `pr view` stdout is PR_VIEW_OUT.
// The facts gate sits BEFORE every other stage (rules fetch, diff, driver),
// so a run that dies at the facts gate needs no git fixture, no toolkit,
// no worktree — the failing exit arrives first.
const runFactsGate = ({ prViewStdout }) => {
  const dir = mkdtempSync(path.join(tmpdir(), "review-pr-facts-test-"));
  const shims = path.join(dir, "shim");
  mkdirSync(shims, { recursive: true });
  writeFileSync(path.join(shims, "gh"), `#!/usr/bin/env bash
printf '%s' '${prViewStdout.replace(/'/g, `'\\''`)}'
`);
  spawnSync("chmod", ["+x", path.join(shims, "gh")]);
  const res = spawnSync("bash", [REVIEW_PR], {
    encoding: "utf8",
    timeout: 30000,
    env: {
      ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("DSH_"))),
      GH_TOKEN: "fake-token",
      DSH_SHIP_REPO: "owner/repo",
      PR_NUM: "77",
      DSH_AGENT_TOOLKIT_DIR: dir, // unreached when the facts gate fails; a dir, not unset
      DSH_WORKTREE: dir,
      DSH_REVIEW_OUT: path.join(dir, "review-output.txt"),
      PATH: `${shims}${path.delimiter}${ambientPathWithoutDriverShims()}`,
    },
  });
  return { res, dir };
};

test("issue #529: a 403 garbage body on `gh pr view` stdout degrades to the typed exit 2 — never a JSON.parse crash", () => {
  const { res, dir } = runFactsGate({ prViewStdout: RATE_LIMIT_BODY });
  rmSync(dir, { recursive: true, force: true });
  assert.equal(res.status, 2, `the facts gate must fail TYPED (got ${res.status}):\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);
  assert.match(res.stderr, /review-pr: PR #77 has no base\/head/,
    "garbage must degrade to the existing typed message (the issue #529 ask)");
  assert.doesNotMatch(res.stderr, /SyntaxError/,
    "no uncaught JSON.parse throw may reach the item log");
  assert.doesNotMatch(res.stderr, /^\s+at /m,
    "no node stack trace may replay across the sweeps (the #527 crash-loop shape)");
});

test("issue #529: an EMPTY `gh pr view` stdout keeps the pre-existing 'cannot read PR' typed exit", () => {
  const { res, dir } = runFactsGate({ prViewStdout: "" });
  rmSync(dir, { recursive: true, force: true });
  assert.equal(res.status, 2, `expected the cannot-read exit (got ${res.status}):\nstderr:\n${res.stderr}`);
  assert.match(res.stderr, /review-pr: cannot read PR #77 in owner\/repo/);
  assert.doesNotMatch(res.stderr, /SyntaxError/);
});

test("issue #529 happy-path control: valid PR JSON parses and the run proceeds PAST the facts gate", () => {
  // Valid facts + a rules contract nowhere to be found (no base REVIEW.md,
  // no worktree copy) — the NEXT typed gate fires, proving base/head parsed.
  const { res, dir } = runFactsGate({
    prViewStdout: '{"baseRefName":"master","headRefName":"pr-branch","title":"fixture pr"}',
  });
  rmSync(dir, { recursive: true, force: true });
  assert.equal(res.status, 2, `expected the rules-contract exit (got ${res.status}):\nstderr:\n${res.stderr}`);
  assert.match(res.stderr, /review-pr: no REVIEW\.md at base master nor in the worktree/,
    "the facts must have parsed: BASE_REF=master reached the rules gate");
});

test("issue #529 structural: the three facts assignments route through the guarded extractor", () => {
  const src = read("scripts", "review-pr.sh");
  assert.match(src, /pr_field\(\) \{.*issue #529/,
    "the guarded extractor exists and names its issue");
  assert.match(src, /try \{ v = JSON\.parse\(s\)\[process\.argv\[1\]\]; \} catch \{ v = ""; \}/,
    "the extractor carries the poll_field try/catch shape");
  for (const field of ["baseRefName", "headRefName", "title"]) {
    assert.match(src, new RegExp(`\\$\\(pr_field "\\$PR_JSON" ${field}\\)`),
      `${field} must parse through the guarded extractor`);
  }
  assert.doesNotMatch(src, /JSON\.parse\(require\("fs"\)\.readFileSync\(0/,
    "no unguarded JSON.parse(readFileSync(0)) assignment may remain in review-pr.sh");
});
