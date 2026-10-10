// scrub-env.test.mjs — contract pins for the agent-env secret sweep
// (dsh-agent-toolkit#608): the launchd-level `GH_PAT_*` fine-grained PAT
// class rides into every agent shell because the harness child-env strip
// covers only KEY/PASSWORD/SECRET/TOKEN names, and the session transcript
// keeps whatever a tool result echoes. The cure's injection half:
// scripts/scrub-env.mjs prints the NAMES to drop (never values) and
// run-dsh-agent.sh unsets them BEFORE the harness spawns — fail-closed
// (REVIEW.md scrubbing law: a sweep failure aborts, never an unswept
// launch). One behavior note the pins carry: the sweep must spare the
// provider route keys (the model route dies without ZAI_API_KEY) and the
// pipeline contract namespaces, or every lane reds environmentally.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SWEEP = path.join(ROOT, "scripts", "scrub-env.mjs");
const DRIVER = path.join(ROOT, "scripts", "run-dsh-agent.sh");
const SCRUB = path.join(ROOT, "scripts", "scrub-output.mjs");

// A fixture-shaped fine-grained PAT (issue #608's exact class, never a real
// token): github_pat_ + 36 more chars, matching the scrubber's shape rule.
const FINEGRAINED = "github_pat_" + "x".repeat(36);
const CLASSIC = "ghp_" + "a1B2c3D4e5F6g7H8i9J0k1L2m3";

function sweep(extraEnv = {}) {
  const env = {};
  // Hermetic: the AMBIENT env must not decide the result (issue #144
  // posture) — a suite running inside a dsh job carries the very vars this
  // sweep exists to catch. Only the fixtures below speak.
  for (const [k, v] of Object.entries(process.env)) {
    if (!/^(DSH_|DISPATCH_|GH_PAT|.*_P12$)/.test(k)) env[k] = v;
  }
  return spawnSync("node", [SWEEP], { encoding: "utf8", env: { ...env, ...extraEnv } });
}

function names(result) {
  assert.equal(result.status, 0, `sweep exited ${result.status}: ${result.stderr}`);
  return result.stdout.split("\n").filter(Boolean);
}

test("a launchd-style fine-grained PAT var is swept by VALUE shape under any name", () => {
  const got = names(sweep({ WEIRD_NAMED_VAR: FINEGRAINED }));
  assert.ok(got.includes("WEIRD_NAMED_VAR"), `expected WEIRD_NAMED_VAR in ${JSON.stringify(got)}`);
});

test("the *_PAT_* name class is swept even when the value shape is not recognized", () => {
  const got = names(sweep({ GH_PAT_SOMETHING_ELSE: "not-a-recognized-shape-value" }));
  assert.ok(got.includes("GH_PAT_SOMETHING_ELSE"), `expected name-segment sweep, got ${JSON.stringify(got)}`);
});

test("P12 signing blobs are swept by name segment (the #608-adjacent class)", () => {
  const got = names(sweep({ IOS_SIGNING_IDENTITY_P12: "MIIhpAIB" + "q".repeat(40) }));
  assert.ok(got.includes("IOS_SIGNING_IDENTITY_P12"), `expected P12 sweep, got ${JSON.stringify(got)}`);
});

test("PATTERN-like names are NOT swept — the segment rule is segment-anchored", () => {
  const got = names(sweep({ GITHUB_LABEL_PATTERN: "refs/heads/main" }));
  assert.ok(!got.includes("GITHUB_LABEL_PATTERN"), `segment rule overreached: ${JSON.stringify(got)}`);
});

test("the provider route key and pipeline contracts survive (no environmental red)", () => {
  const got = names(sweep({
    ZAI_API_KEY: "1234567890abcdef".repeat(2) + ".AbCdEfGh1234567890", // Z.AI-shaped on purpose
    GH_TOKEN: CLASSIC,
    DOPPLER_SERVICE_TOKEN: "dp.st.main.default." + "z".repeat(20),
    DSH_RUNNER_NAME: "test-cell",
    DISPATCH_FACE_ID: "ebowwa-p1",
  }));
  for (const kept of ["ZAI_API_KEY", "GH_TOKEN", "DOPPLER_SERVICE_TOKEN", "DSH_RUNNER_NAME", "DISPATCH_FACE_ID"]) {
    assert.ok(!got.includes(kept), `allowlist failed: ${kept} was swept`);
  }
});

test("DSH_ENV_SWEEP_KEEP exempts an exact name (the consumer escape hatch)", () => {
  const env = { MY_PROVIDER_KEY: "sk-" + "k".repeat(20) };
  assert.ok(names(sweep(env)).includes("MY_PROVIDER_KEY"), "shape sweep must fire without the hatch");
  assert.ok(!names(sweep({ ...env, DSH_ENV_SWEEP_KEEP: "MY_PROVIDER_KEY" })).includes("MY_PROVIDER_KEY"),
    "the hatch must exempt the named var");
});

test("stdout carries NAMES only — never a value (this output lands in run logs)", () => {
  const res = sweep({ GH_PAT_LOGHYGIENE: FINEGRAINED });
  assert.ok(!res.stdout.includes(FINEGRAINED), "a credential value printed to stdout");
  assert.ok(!res.stderr.includes(FINEGRAINED), "a credential value printed to stderr");
});

test("clean env: the sweep prints nothing (no false-positive noise on every run)", () => {
  const got = names(sweep());
  assert.deepEqual(got.filter(n => !/^(GH_PAT_EBOWWA|.*_P12$)/.test(n)), [],
    `unexpected sweeps on a fixture-clean env: ${JSON.stringify(got)}`);
});

// --- the driver seam (structural): fail-closed, before the harness spawn ---

test("the driver runs the sweep and treats a sweep failure as fatal (fail-closed)", () => {
  const src = readFileSync(DRIVER, "utf8");
  assert.match(src, /scrub-env\.mjs/, "driver must call scripts/scrub-env.mjs");
  const call = src.indexOf('ENV_SWEEP_NAMES="$(node "$SCRIPT_DIR/scrub-env.mjs")"');
  assert.ok(call !== -1, "sweep call not found verbatim");
  // The failure arm must exit nonzero — a `|| true` here would be a
  // non-fatal scrub failure, rejected by REVIEW.md.
  const arm = src.slice(call, call + 400);
  assert.match(arm, /exit 1/, "sweep failure must abort the run");
  assert.ok(!/scrub-env\.mjs"\)\s*"\s*\|\|\s*true/.test(src), "sweep failure must never degrade to `|| true`");
});

test("the sweep runs BEFORE the harness launch (an unset after `dsh --profile` protects nothing)", () => {
  const src = readFileSync(DRIVER, "utf8");
  const sweepAt = src.indexOf("2b-2. agent-env secret sweep");
  // lastIndexOf: the header prose MENTIONS the launch command early; the
  // real spawn is the last occurrence in the file.
  const launchAt = src.lastIndexOf("dsh --profile headless");
  assert.ok(sweepAt !== -1 && launchAt !== -1, "both seams must exist");
  assert.ok(sweepAt < launchAt, "sweep must precede the harness launch line");
});

// --- the scrubber half: exact env-held values redact on scrubbed surfaces ---

test("scrub-output.mjs Layer 1b: the env-held PAT value redacts even inside a composite string", () => {
  // The #608 transcript shape: `env` output wraps the value with name= and
  // neighboring lines; an exact-value rule kills it regardless of boundaries.
  const env = { ...process.env, GH_PAT_X608: FINEGRAINED };
  const r = spawnSync("node", [SCRUB], {
    input: `GH_PAT_X608=${FINEGRAINED}\nsuffix-${FINEGRAINED}-suffix\n`,
    env, encoding: "utf8",
  });
  assert.equal(r.status, 0);
  assert.ok(!r.stdout.includes(FINEGRAINED), "env-held value survived the scrubber");
  assert.ok(r.stdout.includes("[redacted:GH_PAT_X608]"), "placeholder names the source var");
});

test("scrub-output.mjs Layer 1b: SECRETS_ONLY (model-input) mode redacts the env-held value too", () => {
  const env = { ...process.env, GH_PAT_X608: FINEGRAINED, SECRETS_ONLY: "1" };
  const r = spawnSync("node", [SCRUB], { input: FINEGRAINED, env, encoding: "utf8" });
  assert.equal(r.status, 0);
  assert.ok(r.stdout.includes("[redacted:GH_PAT_X608]"), "secret tier must be active in SECRETS_ONLY");
});
