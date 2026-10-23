// scrub-output.test.mjs — contract pin for the scrubber's date-rule modes
// (ebowwa/FleetTower#301). The default mode redacts date-shaped strings
// (output surfaces: timestamps correlate working hours); GitHub-bound mode
// (DSH_SCRUB_KEEP_DATES=1, selected by gh-scrub-shim / git-scrub-shim) KEEPS
// dates — authored prose legitimately carries them and rewriting at POST
// time corrupts the STORED text. Credential and PII shapes are redacted in
// every mode: the fix must not widen the leak surface.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

const SCRUB = path.join(path.dirname(new URL(import.meta.url).pathname), "..", "scripts", "scrub-output.mjs");

function scrub(input, env = {}) {
  const r = spawnSync("node", [SCRUB], {
    input,
    env: { ...process.env, ...env },
    encoding: "utf8",
  });
  assert.equal(r.status, 0, `scrubber exited ${r.status}: ${r.stderr}`);
  return r.stdout;
}

const ISO_DATE = "landed 2026-09-26 in one pass";
const SLASH_DATE = "due 3/14/26 per the census";
const TOKEN = "ghp_" + "a1B2c3D4e5F6g7H8i9J0k1L2m3";

test("default mode redacts date shapes (output surfaces)", () => {
  assert.ok(scrub(ISO_DATE).includes("[redacted:date]"), "ISO date redacted");
  assert.ok(scrub(SLASH_DATE).includes("[redacted:date]"), "slash date redacted");
});

test("KEEP_DATES mode passes dates through untouched (GitHub-bound text)", () => {
  const env = { DSH_SCRUB_KEEP_DATES: "1" };
  assert.ok(scrub(ISO_DATE, env).includes("2026-09-26"), "ISO date survives");
  assert.ok(!scrub(ISO_DATE, env).includes("[redacted:date]"), "no placeholder minted");
  assert.ok(scrub(SLASH_DATE, env).includes("3/14/26"), "slash date survives");
});

test("KEEP_DATES still redacts credential shapes — the fix does not widen the leak surface", () => {
  const env = { DSH_SCRUB_KEEP_DATES: "1" };
  const out = scrub(`token ${TOKEN} dated 2026-09-26`, env);
  assert.ok(out.includes("[redacted:token]"), "gh token shape redacted");
  assert.ok(!out.includes("a1B2c3D4e5F6"), "token body gone");
  assert.ok(out.includes("2026-09-26"), "date kept beside it");
});

test("KEEP_DATES still redacts SSN shapes (secret tier, both modes)", () => {
  const env = { DSH_SCRUB_KEEP_DATES: "1" };
  assert.ok(scrub("ssn 123-45-6789", env).includes("[redacted:ssn]"));
});

// ---- fine-grained PATs (issue #608) -----------------------------------------
// A fine-grained PAT rides `GH_PAT_*` env names (e.g. GH_PAT_EBOWWA_FINEGRAINED)
// in agent shells, and its `github_pat_…` value (~93 chars) transits tool
// output unredacted when a plain `env`/`grep` prints it. Two fixes, pinned
// here:
//   1. Layer 2's github_pat_ shape rule must redact the class in EVERY mode
//      (secret tier — no surface may widen), and
//   2. Layer 1 sweeps the scrub env for ANY `GH_PAT_*` name and registers the
//      VALUE as an exact-match rule, so a rendering that defeats the shape
//      rule's word boundaries (token glued to word chars) still redacts.
// Synthetic token in the real ~93-char shape (github_pat_ + 22 + "_" + 59) —
// never a real credential.
const PAT_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
const FINE_PAT = "github_pat_" +
  Array.from({ length: 22 }, (_, i) => PAT_ALPHABET[(i * 7 + 3) % PAT_ALPHABET.length]).join("") +
  "_" +
  Array.from({ length: 59 }, (_, i) => PAT_ALPHABET[(i * 13 + 5) % PAT_ALPHABET.length]).join("");
const FINE_NAME = "GH_PAT_EBOWWA_FINEGRAINED";

test("issue #608: fine-grained PAT value redacted in the env-line shape (default mode)", () => {
  const out = scrub(`${FINE_NAME}=${FINE_PAT}\n`);
  assert.ok(out.includes("[redacted:token]"), "github_pat_ shape redacted");
  assert.ok(!out.includes("github_pat_"), "no raw fine-grained PAT survives");
  assert.ok(!out.includes(FINE_PAT.slice(11, 31)), "token body gone");
});

test("issue #608: fine-grained PAT is redacted in EVERY mode (secret tier — no surface widens)", () => {
  for (const env of [{}, { DSH_SCRUB_KEEP_DATES: "1" }, { SECRETS_ONLY: "1" }]) {
    const out = scrub(`${FINE_NAME}=${FINE_PAT}\n`, env);
    assert.ok(out.includes("[redacted:token]"), `redacted under ${JSON.stringify(env)}`);
    assert.ok(!out.includes("github_pat_"), `no raw PAT under ${JSON.stringify(env)}`);
    assert.ok(!out.includes(FINE_PAT.slice(11, 31)), `token body gone under ${JSON.stringify(env)}`);
  }
});

test("issue #608: the value of ANY GH_PAT_* env var is an exact-value rule (same-env sweep)", () => {
  // The value living in the scrub env is the exact shape that made the plain
  // `env` slip fatal. A rendering GLUED to word chars defeats the shape rule's
  // \b boundary — only the Layer-1 exact-value sweep can catch it: it must in
  // default mode AND in model-input mode (SECRETS_ONLY keeps credentials out
  // of what is sent to the provider).
  for (const env of [
    { [FINE_NAME]: FINE_PAT },
    { [FINE_NAME]: FINE_PAT, SECRETS_ONLY: "1" },
  ]) {
    const out = scrub(`zzz${FINE_PAT}zzz\n${FINE_NAME}=${FINE_PAT}\n`, env);
    assert.ok(
      out.includes(`[redacted:${FINE_NAME}]`),
      `exact value redacted under ${JSON.stringify(env)} — got: ${out}`,
    );
    assert.ok(!out.includes(FINE_PAT), `raw value gone under ${JSON.stringify(env)}`);
  }
});

test("SECRETS_ONLY interplay unchanged: dates already kept in model-input mode", () => {
  const out = scrub(ISO_DATE, { SECRETS_ONLY: "1" });
  assert.ok(out.includes("2026-09-26"), "model input keeps dates");
});

test("both transport shims select KEEP_DATES (the mode is wired, not just available)", () => {
  const root = path.join(path.dirname(new URL(import.meta.url).pathname), "..", "scripts");
  for (const shim of ["gh-scrub-shim", "git-scrub-shim"]) {
    const src = fs.readFileSync(path.join(root, shim), "utf8");
    assert.ok(
      src.includes('DSH_SCRUB_KEEP_DATES=1 node "$SCRUB"'),
      `${shim} runs the scrubber in KEEP_DATES mode`,
    );
    assert.ok(!/scrub_text\(\) \{ node "\$SCRUB"/.test(src), `${shim} has no bare-mode scrub_text left`);
  }
});

test("worker-authored GitHub-bound surfaces select their scrub mode by taxonomy (issue #152)", () => {
  const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "scripts");
  const keepSel = /DSH_SCRUB_KEEP_DATES=1 node "\$DSH_AGENT_TOOLKIT_DIR\/scripts\/scrub-output\.mjs"/g;

  // PROSE surface — the auto-created PR body (ebowwa/FleetTower#301 class:
  // a default-mode pre-scrub minted [redacted:date] one hop before the
  // KEEP_DATES shim, which could never restore it):
  //  - ship-changes.sh scrubs the PR body in KEEP_DATES mode, exactly once;
  //  - BOTH decoupled tee hops (dsh-worker.sh) keep dates on the record
  //    file that feeds that body — otherwise the fix at the shipper is a
  //    no-op: the date was already minted before it ever got there.
  const ship = fs.readFileSync(path.join(root, "ship-changes.sh"), "utf8");
  assert.equal(
    (ship.match(keepSel) || []).length, 1,
    "ship-changes.sh scrubs the PR body (authored prose) in KEEP_DATES mode exactly once",
  );
  const worker = fs.readFileSync(path.join(root, "dsh-worker.sh"), "utf8");
  assert.equal(
    (worker.match(keepSel) || []).length, 2,
    "both decoupled worker tee hops keep dates — the record feeds the prose PR body",
  );

  // OUTPUT surfaces — reply/review comment bodies stay default-mode: the
  // [redacted:date] there is BY DESIGN (timestamps correlate working
  // hours, scrub-output.mjs's own surface list). Their post-time scrub is
  // load-bearing now that the tee keeps dates.
  for (const surface of ["post-reply.sh", "review-pr.sh"]) {
    const src = fs.readFileSync(path.join(root, surface), "utf8");
    assert.ok(
      !src.includes("DSH_SCRUB_KEEP_DATES"),
      `${surface} stays default-mode: the comment's [redacted:date] is by design`,
    );
  }

  // The in-job YAML tee stays default too — its stdout IS the Actions log
  // (an output surface), so its tee'd record keeps minting the placeholder
  // into review bodies: a documented residual. agent-comment.yml /
  // agent-dispatch.yml rode the same rule and are removed with the in-job
  // agent mode (issue #264); agent-review.yml is the remaining in-job surface.
  const wfDir = path.join(root, "..", ".github", "workflows");
  for (const wf of ["agent-review.yml"]) {
    const src = fs.readFileSync(path.join(wfDir, wf), "utf8");
    assert.ok(
      !src.includes("DSH_SCRUB_KEEP_DATES"),
      `${wf} tee stays default-mode (the Actions log is an output surface)`,
    );
  }
});
