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

  // The legacy YAML tees stay default too — their stdout IS the Actions
  // log (an output surface), so their tee'd record keeps minting the
  // placeholder into legacy PR bodies: a documented residual, legacy
  // removal is the planned next major.
  const wfDir = path.join(root, "..", ".github", "workflows");
  for (const wf of ["agent-comment.yml", "agent-dispatch.yml", "agent-review.yml"]) {
    const src = fs.readFileSync(path.join(wfDir, wf), "utf8");
    assert.ok(
      !src.includes("DSH_SCRUB_KEEP_DATES"),
      `${wf} tee stays default-mode (the Actions log is an output surface)`,
    );
  }
});
