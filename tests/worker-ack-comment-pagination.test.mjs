// worker-ack-comment-pagination.test.mjs — ack_comment's window over the
// thread (issue #581).
//
// The list-issue-comments route returns comments ASCENDING (oldest first;
// `direction` is ignored on this route — measured on issue #100) while the
// ack is posted at trigger time, among the NEWEST comments. ack_comment
// used to scan exactly the first per_page=100 page: past 100 thread
// comments that window holds the thread's OLDEST 100, the marker is
// structurally outside it, the filter returns `// 0`, and every trigger
// posts a FRESH ack — the #573 fresh-ack symptom reachable by thread
// length alone, no misconfiguration. Contract pins:
//   1. the rel="last" page (the newest 100) is the scanned window on a
//      multi-page thread — fetched via `?page=N` from the Link header of
//      the `gh api -i` envelope, in at most two calls, and an ANCIENT
//      page-1 match NEVER wins (the old code returned the oldest ack);
//   2. a single-page thread (no Link header) and a headerless body (a
//      shim, a degraded proxy) scan the one page they hold;
//   3. the fresh-ack fallback survives the cliff intact: no match on the
//      last page → 0 (including the exactly-at-100 boundary, where
//      rel="last" names the one-past-end empty page — self-healing);
//   4. a genuine gh failure degrades to 0 on stdout with typed stderr on
//      EITHER call — a last-page failure never falls back to page-1's
//      ancient ids;
//   5. the marker rides the $ENV passthrough (issue #573's contract,
//      re-pinned on the paginating shape): never interpolated into argv.
//
// ack_comment is extracted from the worker and driven directly through a
// gh shim (same pattern as tests/worker-ack-comment.test.mjs) — no real
// API call ever leaves the box; the filter is graded by a real jq when
// the box has one, skipped otherwise (the shim cannot honestly evaluate
// gojq).

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WORKER = path.join(ROOT, "scripts", "dsh-worker.sh");

// The constant filter literal both gh calls must carry ($ENV marker
// contract from issue #573 — re-pinned here because this rewrite touches
// both call sites).
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

// A gh shim that speaks the -i envelope: headers (from GH_HEADERS, a
// file) + blank line + the jq result of GH_PAYLOAD for the paginating
// call, and the bare jq result of GH_LAST_PAYLOAD for the ?page= fetch.
// Both calls log argv and the ACK_MARKER they received; GH_RC fails the
// first call, GH_LAST_RC the second. The Link fixture URL mirrors the
// live shape measured on issue #100 (per_page first, page second).
const fixture = () => {
  const dir = mkdtempSync(path.join(tmpdir(), "worker-ack-page-test-"));
  const shim = path.join(dir, "shim");
  const logs = path.join(dir, "logs");
  mkdirSync(shim, { recursive: true });
  mkdirSync(logs, { recursive: true });
  const ghLog = path.join(logs, "gh-argv.log");
  const ghEnvLog = path.join(logs, "gh-env.log");
  writeFileSync(path.join(shim, "gh"), `#!/usr/bin/env bash
printf '%s\\n' "$@" >> "$GH_LOG"
printf '%s\\n' "\${ACK_MARKER-UNSET}" >> "$GH_ENV_LOG"
[ -n "\${GH_STDERR:-}" ] && printf '%s\\n' "\$GH_STDERR" >&2
endpoint="" filter="" prev="" envelope=no
for a in "$@"; do
  [ "$prev" = "--jq" ] && filter="$a"
  case "$a" in repos/*) endpoint="$a" ;; esac
  [ "$a" = "-i" ] && envelope=yes
  prev="$a"
done
is_last=no
# [&?]page= anchoring, same trap the worker's Link parse avoids: a bare
# *"page="* also matches per_page= on the FIRST call. The worker's
# last-page fetch is always "...per_page=100&page=N" — &page= is the
# unambiguous marker.
case "$endpoint" in *"&page="*) is_last=yes ;; esac
if [ -n "\${GH_RC:-}" ] && [ "\$GH_RC" != 0 ] && [ "\$envelope" = yes ]; then exit "\$GH_RC"; fi
if [ -n "\${GH_LAST_RC:-}" ] && [ "\$GH_LAST_RC" != 0 ] && [ "\$is_last" = yes ]; then exit "\$GH_LAST_RC"; fi
payload="\${GH_PAYLOAD:-/nonexistent}"
[ "\$is_last" = yes ] && [ -n "\${GH_LAST_PAYLOAD:-}" ] && payload="\$GH_LAST_PAYLOAD"
[ "\$envelope" = yes ] && [ -s "\${GH_HEADERS:-}" ] && printf '%s\\n\\n' "\$(cat "\$GH_HEADERS")"
if [ -n "$filter" ] && command -v jq >/dev/null 2>&1 && [ -f "\$payload" ]; then
  jq -c "$filter" < "\$payload"
  exit "\$?"
fi
[ -f "\$payload" ] && cat "\$payload"
exit 0
`);
  spawnSync("chmod", ["+x", path.join(shim, "gh")]);

  const runAck = ({ marker, payload, lastPayload, headers, rc, lastRc, stderr }) => {
    const writeFile = (name, obj) => {
      const f = path.join(dir, name);
      // Strings ride raw (a Link header must reach the parse verbatim);
      // objects are the JSON payloads.
      if (obj !== undefined) writeFileSync(f, typeof obj === "string" ? obj : JSON.stringify(obj));
      return f;
    };
    const payloadFile = writeFile("payload.json", payload);
    const lastFile = writeFile("last.json", lastPayload);
    const headersFile = writeFile("headers.txt", headers);
    const script = path.join(dir, "ack-harness.sh");
    writeFileSync(script, `set -uo pipefail\n${extractAckComment()}\nack_comment owner/repo 581\n`);
    return spawnSync("bash", [script], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${shim}${path.delimiter}${process.env.PATH}`,
        ...(marker === undefined ? {} : { ACK_MARKER: marker }),
        GH_LOG: ghLog,
        GH_ENV_LOG: ghEnvLog,
        GH_PAYLOAD: payloadFile,
        GH_LAST_PAYLOAD: lastFile,
        GH_HEADERS: headersFile,
        ...(rc === undefined ? {} : { GH_RC: String(rc) }),
        ...(lastRc === undefined ? {} : { GH_LAST_RC: String(lastRc) }),
        ...(stderr === undefined ? {} : { GH_STDERR: stderr }),
      },
    });
  };
  const argvLog = () => readFileSync(ghLog, "utf8");
  const calls = () => argvLog().split(/\n(?=api\n)/).filter((l) => l.includes("repos/"));
  const envLog = () => readFileSync(ghEnvLog, "utf8").trim().split("\n");
  const cleanup = () => rmSync(dir, { recursive: true, force: true });
  return { runAck, argvLog, calls, envLog, cleanup };
};

// The live Link-header shape (measured on issue #100, per_page=50):
// rel="next" then rel="last", per_page before page in the query string —
// the parse must key on [&?]page= so per_page= never matches.
const LINK3 = 'Link: <https://api.github.com/repositories/1/issues/581/comments?per_page=100&page=2>; rel="next", <https://api.github.com/repositories/1/issues/581/comments?per_page=100&page=3>; rel="last"';

const ack = (id) => ({ id, body: "<!-- dsh:ack -->" });
const plain = (id) => ({ id, body: "an ordinary reply" });

test("a >100-comment thread: the rel=last page is fetched and scanned — the newest ack wins over page 1's ancient one", { skip: HAS_JQ ? false : "no jq binary on this box" }, () => {
  const f = fixture();
  try {
    // Page 1 (the thread's OLDEST 100) carries an ANCIENT ack — the old
    // first-page-only scan returned 12 and edited a stale ack in place.
    const res = f.runAck({
      marker: "dsh:ack",
      payload: [ack(12), plain(13), plain(14)],
      lastPayload: [plain(301), plain(302), ack(9090)],
      headers: LINK3,
    });
    assert.equal(res.status, 0, res.stderr);
    assert.equal(res.stdout.trim(), "9090", "the last page's newest ack must win");
    const cs = f.calls();
    assert.equal(cs.length, 2, `exactly two gh calls (envelope + last page):\n${f.argvLog()}`);
    assert.ok(cs[0].includes("-i"), "the first call is the -i envelope");
    assert.ok(!/[?&]page=\d/.test(cs[0]), "the first call carries no page override");
    assert.ok(cs[1].includes("page=3"), "the second call fetches rel=last's page:\n" + cs[1]);
  } finally { f.cleanup(); }
});

test("a single-page thread (no Link header): the one page is scanned, newest match wins", { skip: HAS_JQ ? false : "no jq binary on this box" }, () => {
  const f = fixture();
  try {
    const res = f.runAck({
      marker: "dsh:ack",
      payload: [ack(7), plain(8), ack(31), plain(99)],
      headers: undefined,
    });
    assert.equal(res.status, 0, res.stderr);
    assert.equal(res.stdout.trim(), "31");
    assert.equal(f.calls().length, 1, "no second call without a Link header");
  } finally { f.cleanup(); }
});

test("a headerless body (a shim, a degraded proxy) is the whole response — single-page scan still answers", { skip: HAS_JQ ? false : "no jq binary on this box" }, () => {
  const f = fixture();
  try {
    const res = f.runAck({
      marker: "dsh:ack",
      payload: [plain(5), ack(6)],
      headers: undefined,
    });
    assert.equal(res.status, 0, res.stderr);
    assert.equal(res.stdout.trim(), "6");
  } finally { f.cleanup(); }
});

test("no match on the last page → 0: the fresh-ack contract survives the cliff", { skip: HAS_JQ ? false : "no jq binary on this box" }, () => {
  const f = fixture();
  try {
    const res = f.runAck({
      marker: "dsh:ack",
      payload: [ack(12)],
      lastPayload: [plain(301), plain(302)],
      headers: LINK3,
    });
    assert.equal(res.status, 0, res.stderr);
    assert.equal(res.stdout.trim(), "0");
  } finally { f.cleanup(); }
});

test("the exactly-at-100 boundary: rel=last names the one-past-end page, it scans empty → 0 (self-heals next trigger)", { skip: HAS_JQ ? false : "no jq binary on this box" }, () => {
  const f = fixture();
  try {
    const res = f.runAck({
      marker: "dsh:ack",
      payload: [ack(12)],
      lastPayload: [],
      headers: 'Link: <https://api.github.com/repositories/1/issues/581/comments?per_page=100&page=2>; rel="next", <https://api.github.com/repositories/1/issues/581/comments?per_page=100&page=2>; rel="last"',
    });
    assert.equal(res.status, 0, res.stderr);
    assert.equal(res.stdout.trim(), "0");
    assert.equal(f.calls().length, 2);
  } finally { f.cleanup(); }
});

test("a genuine gh failure on the envelope call degrades to 0 on stdout with typed stderr", () => {
  const f = fixture();
  try {
    const res = f.runAck({
      marker: "dsh:ack",
      payload: undefined,
      rc: 7,
      stderr: "gh: API rate limit exceeded for worker",
    });
    assert.equal(res.stdout.trim(), "0", "the worker keeps functioning (fresh-ack fallback)");
    assert.match(res.stderr, /API rate limit exceeded/, "the failure must be visible");
    assert.equal(f.calls().length, 1, "no last-page fetch after a failed envelope");
  } finally { f.cleanup(); }
});

test("a failure on the last-page fetch degrades to 0 — never a fallback to page 1's ancient ack ids", { skip: HAS_JQ ? false : "no jq binary on this box" }, () => {
  const f = fixture();
  try {
    const res = f.runAck({
      marker: "dsh:ack",
      payload: [ack(12)],
      lastPayload: [ack(9090)],
      headers: LINK3,
      lastRc: 7,
      stderr: "gh: HTTP 502",
    });
    assert.equal(res.status, 0);
    assert.equal(res.stdout.trim(), "0", "an ancient page-1 ack must NOT be the answer");
    assert.match(res.stderr, /HTTP 502/, "the failure must be visible");
    assert.equal(f.calls().length, 2, "the last-page fetch was attempted");
  } finally { f.cleanup(); }
});

test("an unparsable Link header degrades LOUDLY to the first-page scan (typed stderr note)", { skip: HAS_JQ ? false : "no jq binary on this box" }, () => {
  const f = fixture();
  try {
    const res = f.runAck({
      marker: "dsh:ack",
      payload: [plain(5)],
      headers: 'Link: <not-a-github-url>; rel="last"',
    });
    assert.equal(res.status, 0, res.stderr);
    assert.equal(res.stdout.trim(), "0");
    assert.match(res.stderr, /rel="last"/, "the degradation must be named on stderr");
  } finally { f.cleanup(); }
});

test("the marker never rides the argv; the $ENV passthrough carries it on BOTH calls (issue #573's contract on the paginating shape)", () => {
  const f = fixture();
  try {
    // gh absent-marker semantics: an unset marker nulls $ENV.ACK_MARKER
    // and jq errors — the per-command assignment must export it on every
    // call. NASTY covers the metacharacter class from the #573 issue.
    const NASTY = 'dsh:ack "x" \\| ]//(';
    const res = f.runAck({
      marker: NASTY,
      payload: [],
      lastPayload: [],
      headers: LINK3,
    });
    assert.equal(res.status, 0, res.stderr);
    const argv = f.argvLog();
    assert.ok(!argv.includes(NASTY), "the marker must NOT be interpolated into any argv");
    for (const line of f.envLog()) {
      assert.equal(line, NASTY, "each gh call must receive the marker's exact value");
    }
    assert.ok(argv.split("\n").filter((l) => l === FILTER).length === 2,
      "both calls carry the constant filter literal:\n" + argv);
  } finally { f.cleanup(); }
});
