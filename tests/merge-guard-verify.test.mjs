// merge-guard-verify.test.mjs — contract pins for the merge-guard's OPT-IN
// independent-verification arm (MERGE_GUARD_VERIFY, issue #326).
//
// The receipt: the shared-account fleet cannot post approving reviews, so
// independent agent verification rode comment-only noise. The arm lets a
// merger make the gate-verify channel merge-relevant — WITHOUT changing
// the default. Pins, in the repo's test-as-contract style:
//
//   1. UNARMED (default) is byte-for-byte the #434 behavior: gates green
//      merges even with a SILENT verification channel, and the verify
//      tool is never consulted (zero calls).
//   2. ARMED + pass marker → merge proceeds.
//   3. ARMED + fail marker / silent channel → REFUSED (exit 1).
//   4. ARMED + unresolvable channel → refused FAIL-CLOSED (exit 2) —
//      an API failure is never readable as "no verification happened".
//   5. Ordering: the arm consults ONLY on the gates-green path — red
//      gates refuse before the channel is ever read (the channel is a
//      second signal on an already-green head, never a CI substitute).
//   6. ARMED + missing verify tool → unresolvable, not a silent pass.
//   7. An ambient MERGE_GUARD_CHECK=<other> cannot flip the harness legs
//      (issue #503 — the sibling merge-guard.test.mjs #483 pin, ported
//      to THIS file's own process/env).
//
// Hermetic: the gates-side stub gh (MERGE_GUARD_GH) serves check runs and
// records `pr merge` argv (the merge-guard.test.mjs pattern); the
// channel-side stub gh (PR_VERIFICATION_GH) serves the PR view + comments.
// Both bake their fixture dir as absolute paths — no env leakage between
// the two stub gh identities.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, chmodSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const GUARD = path.join(ROOT, "scripts", "merge-guard.sh");

const HEAD = "0123456789abcdef0123456789abcdef01234567";
const leg = (over = {}) => ({
  id: over.id ?? 1,
  name: over.name ?? "gates",
  head_sha: over.head_sha ?? HEAD,
  status: over.status ?? "completed",
  conclusion: over.conclusion ?? "success",
});

/** Gates-side stub: check-runs + pr view + pr merge capture. */
const gatesStub = (t, legs) => {
  const dir = mkdtempSync(path.join(tmpdir(), "mg-verify-gates-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(path.join(dir, "pr-view.json"), JSON.stringify({
    number: 326, headRefOid: HEAD, url: "https://github.com/owner/repo/pull/326",
  }));
  writeFileSync(path.join(dir, "check-runs.json"), JSON.stringify({ total_count: legs.length, check_runs: legs }));
  writeFileSync(path.join(dir, "gh"), `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "${dir}/gates-gh.log"
if [ "$1" = "pr" ] && [ "$2" = "view" ]; then cat "${dir}/pr-view.json"; exit 0; fi
if [ "$1" = "api" ]; then cat "${dir}/check-runs.json"; exit 0; fi
if [ "$1" = "pr" ] && [ "$2" = "merge" ]; then printf '%s\\n' "$@" >> "${dir}/merge-capture"; exit 0; fi
echo "gates stub: unexpected call: $*" >&2
exit 64
`);
  chmodSync(path.join(dir, "gh"), 0o755);
  return dir;
};

/** Channel-side stub: pr view + issue comments for pr-verification.mjs. */
const channelStub = (t, comments, { apiFail = false } = {}) => {
  const dir = mkdtempSync(path.join(tmpdir(), "mg-verify-channel-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(path.join(dir, "pr-view.json"), JSON.stringify({
    number: 326, headRefOid: HEAD, url: "https://github.com/owner/repo/pull/326",
  }));
  writeFileSync(path.join(dir, "comments.json"), JSON.stringify(comments));
  if (apiFail) writeFileSync(path.join(dir, "api-fail"), "1");
  writeFileSync(path.join(dir, "gh"), `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "${dir}/channel-gh.log"
if [ "$1" = "--version" ]; then echo "stub gh"; exit 0; fi
if [ "$1" = "pr" ] && [ "$2" = "view" ]; then cat "${dir}/pr-view.json"; exit 0; fi
if [ "$1" = "api" ]; then
  [ -f "${dir}/api-fail" ] && { echo "stub: api fails" >&2; exit 1; }
  cat "${dir}/comments.json"
  exit 0
fi
echo "channel stub: unexpected call: $*" >&2
exit 64
`);
  chmodSync(path.join(dir, "gh"), 0o755);
  return dir;
};

const marker = (id, body) => ({
  id, user: { login: "sibling" }, body,
  html_url: `https://github.com/owner/repo/pull/326#issuecomment-${id}`,
});

const runGuard = (t, { legs = [leg()], comments = [], armed = false, apiFail = false, tool = null } = {}) => {
  const gates = gatesStub(t, legs);
  const channel = channelStub(t, comments, { apiFail });
  const env = {
    ...process.env,
    MERGE_GUARD_GH: path.join(gates, "gh"),
    PR_VERIFICATION_GH: path.join(channel, "gh"),
    MERGE_GUARD_VERIFY_TOOL: tool ?? path.join(ROOT, "scripts", "pr-verification.mjs"),
  };
  // The legs pin a `gates`-named check run (scripts/merge-guard.sh reads
  // CHECK="${MERGE_GUARD_CHECK:-gates}"): an ambient MERGE_GUARD_CHECK=<other>
  // on a lane would ride the process.env spread, flip the guard's filter to a
  // name no leg carries, and turn every green leg red (issue #503 — the
  // env-construction flavor of the lane-leak class, the sibling
  // merge-guard.test.mjs #483 delete applied to THIS harness; this file is a
  // separate process from the sibling, so the sibling's delete never masks
  // it). The harness never arms the name deliberately — it has no
  // MERGE_GUARD_CHECK literal at all — so the delete is unconditional.
  delete env.MERGE_GUARD_CHECK;
  if (armed) env.MERGE_GUARD_VERIFY = "on";
  const r = spawnSync("bash", [GUARD, "merge", "326", "--squash"], {
    encoding: "utf8", env, cwd: gates,
  });
  return { r, gates, channel };
};

const merged = (gates) =>
  existsSync(path.join(gates, "merge-capture"))
    ? readFileSync(path.join(gates, "merge-capture"), "utf8").split("\n").filter(Boolean)
    : null;
const channelCalls = (channel) =>
  existsSync(path.join(channel, "channel-gh.log"))
    ? readFileSync(path.join(channel, "channel-gh.log"), "utf8").split("\n").filter(Boolean)
    : [];

test("UNARMED default: gates green merges with a SILENT channel; the channel is never consulted", (t) => {
  const { r, gates, channel } = runGuard(t, { comments: [] });
  assert.equal(r.status, 0, `expected merge, got: ${r.stderr}`);
  assert.ok(merged(gates)?.length, "pr merge ran");
  assert.equal(channelCalls(channel).length, 0, "unarmed guard must not read the channel");
});

test("ARMED + pass marker: merge proceeds", (t) => {
  const { r, gates } = runGuard(t, {
    armed: true,
    comments: [marker(1, "independent run: 443/443\ngate-verify: pass\n")],
  });
  assert.equal(r.status, 0, `expected merge, got: ${r.stdout} ${r.stderr}`);
  assert.ok(merged(gates)?.length, "pr merge ran");
  assert.match(r.stdout, /independent verification GREEN/);
});

test("ARMED + fail marker: REFUSED", (t) => {
  const { r, gates } = runGuard(t, { armed: true, comments: [marker(1, "gate-verify: fail\n")] });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /NOT pass/);
  assert.equal(merged(gates), null, "nothing merged");
});

test("ARMED + silent channel: REFUSED (exit 1, none is not pass)", (t) => {
  const { r, gates } = runGuard(t, { armed: true, comments: [marker(1, "just chatter\n")] });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /gate-verify channel on PR #326 is NOT pass/);
  assert.equal(merged(gates), null, "nothing merged");
});

test("ARMED + unresolvable channel: refused FAIL-CLOSED (exit 2)", (t) => {
  const { r, gates } = runGuard(t, { armed: true, comments: [], apiFail: true });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /unresolvable/);
  assert.equal(merged(gates), null, "nothing merged");
});

test("ARMED + missing verify tool: unresolvable, never a silent pass", (t) => {
  const { r, gates } = runGuard(t, {
    armed: true,
    comments: [marker(1, "gate-verify: pass\n")],
    tool: "/nonexistent/pr-verification.mjs",
  });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /verification tool is missing/);
  assert.equal(merged(gates), null, "nothing merged");
});

test("Ordering: RED gates refuse BEFORE the channel is ever read", (t) => {
  const { r, gates, channel } = runGuard(t, {
    legs: [leg({ conclusion: "queued" })],
    armed: true,
    comments: [marker(1, "gate-verify: pass\n")],
  });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /NOT green \(issue #434\)/);
  assert.equal(channelCalls(channel).length, 0, "the channel is a second signal on an already-green head");
});

test("an ambient MERGE_GUARD_CHECK=<other> cannot flip the harness legs (issue #503 pin)", (t) => {
  // The #503 defect is invisible on a clean dev box: the legs above pin a
  // `gates`-named check, but the guard reads CHECK="${MERGE_GUARD_CHECK:-gates}"
  // — on a lane that exports MERGE_GUARD_CHECK=<other> the name rode
  // runGuard's process.env spread, the filter matched no leg, and every
  // green leg went red (the exact #483 receipt, in this file's separate
  // process — the sibling merge-guard.test.mjs #483 pin never masked it).
  // Arm the lane INSIDE this process so the harness env's hermeticity is
  // graded on every machine, not just on mis-configured lanes (the
  // sibling #483 pin shape, applied to this harness's own legs). Both
  // directions pin: the UNARMED leg still merges silently, and the ARMED
  // legs still grade through the real filter.
  process.env.MERGE_GUARD_CHECK = "ci/ambient-not-gates";
  try {
    const unarmed = runGuard(t, { comments: [] });
    assert.equal(unarmed.r.status, 0, `the harness 'gates' default must beat the ambient name (stderr: ${unarmed.r.stderr})`);
    assert.ok(merged(unarmed.gates)?.length, "unarmed: pr merge ran");
    assert.equal(channelCalls(unarmed.channel).length, 0, "unarmed: the channel is never consulted");

    const armedPass = runGuard(t, {
      armed: true,
      comments: [marker(1, "independent run: 443/443\ngate-verify: pass\n")],
    });
    assert.equal(armedPass.r.status, 0, `armed: the leg still grades (stdout: ${armedPass.r.stdout} stderr: ${armedPass.r.stderr})`);
    assert.match(armedPass.r.stdout, /independent verification GREEN/, "armed: the pass marker still graded");
    assert.ok(merged(armedPass.gates)?.length, "armed: pr merge ran");

    const armedFail = runGuard(t, { armed: true, comments: [marker(1, "gate-verify: fail\n")] });
    assert.equal(armedFail.r.status, 1, "armed: the fail marker still grades");
    assert.match(armedFail.r.stderr, /NOT pass/, "armed: refusal is the arm's verdict, not a lost leg");
    assert.equal(merged(armedFail.gates), null, "armed: nothing merged");
  } finally {
    delete process.env.MERGE_GUARD_CHECK;
  }
});
