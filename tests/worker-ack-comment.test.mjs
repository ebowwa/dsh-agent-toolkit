// worker-ack-comment.test.mjs — ack_comment's marker handling (issue #573).
//
// The marker is operator-configurable (DSH_WORKER_ACK_MARKER) and used to
// be string-interpolated into the `gh api --jq` filter: any jq
// metacharacter in it (" \ ] |) shattered the expression, and the
// `2>/dev/null || echo 0` swallow degraded EVERY failure to "no ack found"
// — the worker then posted a FRESH ack comment on every trigger instead of
// editing the newest one in place, with no surfaced error. Contract pins:
//   1. the marker rides a jq env variable ($ENV — gh api has no --arg):
//      the filter is the exact constant literal live-verified against real
//      gh, the marker never appears in the gh argv, and the env
//      passthrough carries the marker's exact value;
//   2. newest-match semantics survive: the LAST carrying comment wins,
//      and no match → 0 (the caller's fresh-ack contract) — evaluated by
//      a real jq when the box has one, skipped otherwise (the env stub
//      cannot honestly evaluate gojq);
//   3. a genuine gh failure degrades to 0 on stdout but surfaces typed
//      stderr — the old `2>/dev/null` swallow must stay dead.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WORKER = path.join(ROOT, "scripts", "dsh-worker.sh");

// The exact filter the worker must pass to gh api — a constant literal
// (no interpolation of the marker), live-verified against real gh: $ENV is
// a supported construct in gh's embedded jq and carries the marker's
// exact value (verified by an env round-trip), while the old interpolated
// form parse-errors on the same marker ("failed to parse jq expression").
const FILTER = '[.[] | select((.body // "") | contains($ENV.ACK_MARKER)) | .id][-1] // 0';

const HAS_JQ = spawnSync("jq", ["--version"], { encoding: "utf8" }).status === 0;

function readFnSource(file, name) {
  const s = readFileSync(file, "utf8");
  const start = s.indexOf(`${name}() {`);
  assert.ok(start !== -1, "function missing: " + name);
  let depth = 0, i = start;
  for (; i < s.length; i++) {
    if (s[i] === "{") depth++;
    if (s[i] === "}") { depth--; if (depth === 0) break; }
  }
  assert.ok(depth === 0 && i < s.length, "unbalanced braces in " + name);
  return s.slice(start, i + 1) + "\n";
}

const extractAckComment = () => readFnSource(WORKER, "ack_comment");

// One fixture serves every scenario: a gh shim that logs its argv and the
// ACK_MARKER it actually received, routes the payload through a real jq
// when one exists (so the filter's semantics are graded, not restubbed),
// and can fail with a caller-supplied code + stderr. ack_comment is
// extracted from the worker (same pattern as tests/worker-worktree.test.mjs)
// and driven directly — no real API call ever leaves the box.
const fixture = () => {
  const dir = mkdtempSync(path.join(tmpdir(), "worker-ack-test-"));
  const shim = path.join(dir, "shim");
  const logs = path.join(dir, "logs");
  mkdirSync(shim, { recursive: true });
  mkdirSync(logs, { recursive: true });
  const ghLog = path.join(logs, "gh-argv.log");
  const ghEnvLog = path.join(logs, "gh-env.log");
  writeFileSync(path.join(shim, "gh"), `#!/usr/bin/env bash
printf '%s\\n' "$@" >> "\$GH_LOG"
printf '%s\\n' "\${ACK_MARKER-UNSET}" >> "\$GH_ENV_LOG"
[ -n "\${GH_STDERR:-}" ] && printf '%s\\n' "\$GH_STDERR" >&2
if [ -n "\${GH_RC:-}" ] && [ "\$GH_RC" != 0 ]; then exit "\$GH_RC"; fi
filter="" prev=""
for a in "$@"; do
  [ "$prev" = "--jq" ] && filter="$a"
  prev="$a"
done
if [ -n "$filter" ] && command -v jq >/dev/null 2>&1 && [ -f "\${GH_PAYLOAD:-/nonexistent}" ]; then
  jq -c "$filter" < "\$GH_PAYLOAD"
  exit "$?"
fi
[ -f "\${GH_PAYLOAD:-/nonexistent}" ] && cat "\${GH_PAYLOAD}"
exit 0
`);
  spawnSync("chmod", ["+x", path.join(shim, "gh")]);

  const runAck = ({ marker, payload, rc, stderr }) => {
    const payloadFile = path.join(dir, "payload.json");
    if (payload !== undefined) writeFileSync(payloadFile, JSON.stringify(payload));
    const script = path.join(dir, "ack-harness.sh");
    writeFileSync(script, `set -uo pipefail\n${extractAckComment()}\nack_comment owner/repo 573\n`);
    return spawnSync("bash", [script], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${shim}${path.delimiter}${process.env.PATH}`,
        ...(marker === undefined ? {} : { ACK_MARKER: marker }),
        GH_LOG: ghLog,
        GH_ENV_LOG: ghEnvLog,
        GH_PAYLOAD: payloadFile,
        ...(rc === undefined ? {} : { GH_RC: String(rc) }),
        ...(stderr === undefined ? {} : { GH_STDERR: stderr }),
      },
    });
  };
  const argvLog = () => readFileSync(ghLog, "utf8");
  const envLog = () => readFileSync(ghEnvLog, "utf8").trim();
  const cleanup = () => rmSync(dir, { recursive: true, force: true });
  return { runAck, argvLog, envLog, cleanup };
};

// A marker from the exact metacharacter class the issue names (" \ ] |).
const NASTY = 'dsh:ack "x" \\| ]//(';

test("the filter is the constant $ENV literal — the marker never rides the argv", () => {
  const f = fixture();
  try {
    const res = f.runAck({ marker: NASTY, payload: [] });
    assert.equal(res.status, 0, res.stderr);
    const argv = f.argvLog();
    assert.ok(argv.includes("--jq"), "gh must be called with --jq");
    assert.ok(argv.includes(FILTER), `the filter must be the live-verified constant literal:\n${argv}`);
    assert.ok(!argv.includes(NASTY), "the marker must NOT be interpolated into the argv");
    assert.equal(f.envLog(), NASTY, "the env passthrough must carry the marker's exact value");
  } finally { f.cleanup(); }
});

test("metacharacter marker matches literally: the carrying comment's id comes back", { skip: HAS_JQ ? false : "no jq binary on this box" }, () => {
  const f = fixture();
  try {
    const res = f.runAck({
      marker: NASTY,
      payload: [
        { id: 11, body: "an ordinary reply" },
        { id: 4242, body: `<!-- ${NASTY} -->` },
      ],
    });
    assert.equal(res.status, 0, res.stderr);
    assert.equal(res.stdout.trim(), "4242", "contains($ENV.ACK_MARKER) must match the marker literally");
  } finally { f.cleanup(); }
});

test("newest-match semantics survive: the LAST carrying comment wins", { skip: HAS_JQ ? false : "no jq binary on this box" }, () => {
  const f = fixture();
  try {
    const res = f.runAck({
      marker: "dsh:ack",
      payload: [
        { id: 7, body: "<!-- dsh:ack -->" },
        { id: 31, body: "<!-- dsh:ack -->" },
        { id: 99, body: "no marker here" },
      ],
    });
    assert.equal(res.status, 0, res.stderr);
    assert.equal(res.stdout.trim(), "31");
  } finally { f.cleanup(); }
});

test("no carrying comment → 0 (the caller's fresh-ack contract)", { skip: HAS_JQ ? false : "no jq binary on this box" }, () => {
  const f = fixture();
  try {
    const res = f.runAck({
      marker: "dsh:ack",
      payload: [{ id: 5, body: "just chatter" }],
    });
    assert.equal(res.status, 0, res.stderr);
    assert.equal(res.stdout.trim(), "0");
  } finally { f.cleanup(); }
});

test("a genuine gh failure degrades to 0 on stdout but surfaces typed stderr (no 2>/dev/null swallow)", () => {
  const f = fixture();
  try {
    const res = f.runAck({
      marker: "dsh:ack",
      payload: undefined,
      rc: 7,
      stderr: "gh: API rate limit exceeded for worker",
    });
    assert.equal(res.stdout.trim(), "0", "the worker must keep functioning (fresh-ack fallback)");
    assert.match(res.stderr, /API rate limit exceeded/, "the failure must be visible in the worker log");
  } finally { f.cleanup(); }
});

test("a jq type error (null body handling is in the constant) still ends in the 0 fallback with stderr surfaced", { skip: HAS_JQ ? false : "no jq binary on this box" }, () => {
  const f = fixture();
  try {
    // A null body entry exercises the (.body // "") guard inside FILTER.
    const res = f.runAck({
      marker: "dsh:ack",
      payload: [{ id: 5, body: null }, { id: 6, body: "<!-- dsh:ack -->" }],
    });
    assert.equal(res.status, 0, res.stderr);
    assert.equal(res.stdout.trim(), "6", "null bodies are guarded, not fatal");
  } finally { f.cleanup(); }
});
