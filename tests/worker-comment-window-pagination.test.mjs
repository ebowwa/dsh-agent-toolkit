// worker-comment-window-pagination.test.mjs — the newest-comment window
// every list-comments scan in dsh-worker.sh reads (issues #581, #588),
// through the CRLF-aware shared helper (issue #591).
//
// The list-comments routes (issues AND pulls) return ASCENDING (oldest
// first; `direction` is ignored — measured on issue #100, receipt in
// #581), so the first per_page=100 page holds the thread's OLDEST 100
// comments. Five sites used to scan exactly that page:
//   - ack_comment took the last ack-marker match WITHIN it — past 100
//     thread comments the ack is structurally outside the page, so every
//     trigger posted a FRESH ack (issue #581's dup-ack spam);
//   - trusted_task took the last trusted /dsh match within it — past 100
//     comments the just-posted trigger is outside the window, so the
//     dispatch was silently LOST or an ANCIENT /dsh comment ran as the
//     task (issue #588's lost/wrong-task dispatch);
//   - fetch_context served "recent comments (last 8)" from the oldest 100
//     and harvested dsh:msg blocks from the oldest 100 (issue #588).
// The fix routes every scan through newest_window_jq, which scans the
// header block of `gh api -i` for rel="last" and pages to the NEWEST
// per_page=100 window in at most two calls.
//
// Contract pins:
//   1. a >100-comment thread: the rel="last" page (the newest 100) is the
//      scanned window — the ack at comment ~120 is found (exactly one
//      ack, no fresh post), the newest trusted trigger wins over page 1's
//      ancient one, in at most two gh calls;
//   2. the ENVELOPE is the real gh >= 2.95.0 -i shape: status line ending
//      LF, every header AND the blank separator ending CRLF (cli/cli
//      pkg/cmd/api/api.go printHeaders) — the old $'\n\n' split never
//      fired on a real envelope (issue #591); an LF-only envelope
//      (shims, degraded proxies) parses too;
//   3. an EMPTY page-1 filter result still pages — command substitution
//      strips trailing newlines, so the envelope must be captured to a
//      TEMP FILE; a "$()"-captured empty body eats the separator's final
//      newline and the split silently fails exactly when page 1 has no
//      match;
//   4. the PR-review fallback paginates the pulls route the same way;
//   5. a failed LAST-page fetch never falls back onto page 1's ancient
//      ids — the caller's no-match fallthrough (issue-body issuance, or
//      the fresh-ack path) runs instead;
//   6. no trusted match → the issue-body/title issuance still runs (the
//      #474 shape survives the rewrite);
//   7. fetch_context's recent-8 is the newest 8 of the newest window, and
//      the dsh:msg harvest sees newest-window blocks — page 1's ancient
//      blocks are never a substitute when the newest window has none;
//   8. a single-page thread (no Link header) scans its one page in ONE gh
//      call per scan;
//   9. the ack marker reaches the filter as $ENV.ACK_MARKER, never
//      interpolated (issue #573): a metacharacter marker still matches.
//
// The consumers are extracted from the worker and driven directly through
// a gh shim (same pattern as worker-smoke.test.mjs) — no real API call
// ever leaves the box; filters are graded by a real jq running in its -r
// (raw top-level scalar) mode, mirroring gh's embedded evaluator (go-gh
// pkg/jq EvaluateFormatted), when the box has jq — skipped otherwise (the
// shim cannot honestly evaluate gojq).

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WORKER = path.join(ROOT, "scripts", "dsh-worker.sh");

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

// The REAL gh -i header block bytes (cli/cli pkg/cmd/api/api.go
// printHeaders): the status line ends LF, EVERY header line ends CRLF.
// The BLANK separator is the shim's job (it appends `\r\n` after the
// header block, the real gh 2.95.0 separator byte shape — issue #591).
const envelopeHeaders = (headerLines, eol = "crlf") =>
  "HTTP/2.0 200 OK\n" +
  headerLines.map((l) => l + (eol === "crlf" ? "\r\n" : "\n")).join("");

// The live Link-header shape (measured on real threads): rel="next" then
// rel="last", per_page BEFORE page in the query string — a bare *"page="*
// match would also land on per_page=, so the parse MUST anchor on
// [&?]page=. godotengine/godot#1 measured rel="last" => page=8.
const LINK_LINE =
  'Link: <https://api.github.com/repositories/1/issues/588/comments?per_page=100&page=2>; rel="next", ' +
  '<https://api.github.com/repositories/1/issues/588/comments?per_page=100&page=3>; rel="last"';

// A gh shim speaking the real -i envelope, fixture-keyed by ROUTE CLASS
// (issues vs pulls) and by page: GH_P1_<CLS> / GH_LAST_<CLS> are payload
// files, GH_LINK_<CLS> a ready-made header-block file (exact bytes),
// GH_RC1_<CLS> / GH_RCLAST_<CLS> failure injections. The last-page fetch
// is detected by *"&page="* — the worker's second call always reads
// "...per_page=100&page=N". Filters are graded with jq -r (gh's embedded
// evaluator prints top-level scalars raw — go-gh pkg/jq).
const fixture = () => {
  const dir = mkdtempSync(path.join(tmpdir(), "worker-window-page-test-"));
  const shim = path.join(dir, "shim");
  const logs = path.join(dir, "logs");
  mkdirSync(shim, { recursive: true });
  mkdirSync(logs, { recursive: true });
  const ghLog = path.join(logs, "gh-argv.log");
  writeFileSync(path.join(shim, "gh"), `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$GH_LOG"
endpoint="" filter="" envelope=no; prev=""
for a in "$@"; do
  [ "$prev" = "--jq" ] && filter="$a"
  case "$a" in repos/*) endpoint="$a" ;; esac
  [ "$a" = "-i" ] && envelope=yes
  prev="$a"
done
if [ -z "$endpoint" ]; then
  [ -n "\${GH_VIEW_RC:-}" ] && exit "\$GH_VIEW_RC"
  [ -s "\${GH_VIEW:-}" ] && cat "\$GH_VIEW"
  exit 0
fi
case "$endpoint" in
  */pulls/*)
    payload="\${GH_P1_PULLS:-}"; lastp="\${GH_LAST_PULLS:-}"
    linkf="\${GH_LINK_PULLS:-}"; rc="\${GH_RC1_PULLS:-}"; rcl="\${GH_RCLAST_PULLS:-}" ;;
  *)
    payload="\${GH_P1_ISSUES:-}"; lastp="\${GH_LAST_ISSUES:-}"
    linkf="\${GH_LINK_ISSUES:-}"; rc="\${GH_RC1_ISSUES:-}"; rcl="\${GH_RCLAST_ISSUES:-}" ;;
esac
is_last=no
case "$endpoint" in *"&page="*) is_last=yes ;; esac
[ "\$is_last" = yes ] && rc="\$rcl" && payload="\$lastp"
if [ -n "\$rc" ] && [ "\$rc" != 0 ]; then exit "\$rc"; fi
[ "$envelope" = yes ] && [ -s "\$linkf" ] && { cat "\$linkf"; printf '\\r\\n'; }
if [ -n "\$filter" ] && command -v jq >/dev/null 2>&1 && [ -s "\$payload" ]; then
  jq -r "\$filter" < "\$payload"
  exit "\$?"
fi
exit 0
`);
  spawnSync("chmod", ["+x", path.join(shim, "gh")]);

  const wf = (name, obj) => {
    const f = path.join(dir, name);
    if (obj !== undefined) writeFileSync(f, typeof obj === "string" ? obj : JSON.stringify(obj));
    return f;
  };
  // run <consumerFnNames...> <invoke-snippet> — assemble a harness with
  // the worker's own set flags, the named functions verbatim, and the
  // caller's invocation; returns the spawn result.
  const run = (fnNames, snippet, extraEnv = {}) => {
    const script = path.join(dir, "harness.sh");
    writeFileSync(script,
      "set -euo pipefail\n" +
      fnNames.map((n) => readFnSource(WORKER, n)).join("") +
      snippet);
    return spawnSync("bash", [script], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${shim}${path.delimiter}${process.env.PATH}`,
        GH_LOG: ghLog,
        ...extraEnv,
      },
    });
  };
  const calls = () => readFileSync(ghLog, "utf8").split("\n").filter((l) => l.includes("repos/"));
  const cleanup = () => rmSync(dir, { recursive: true, force: true });
  return { dir, run, calls, wf, cleanup };
};

const trigger = (id, body, assoc = "OWNER") => ({ id, body, user: { type: "User", login: "op" }, author_association: assoc });
const plain = (id, body = "an ordinary reply") => ({ id, body, user: { type: "User", login: "dev" }, author_association: "CONTRIBUTOR" });

test("ack_comment on a >100-comment thread: the rel=last page holds the ack at comment ~120 — exactly one ack id, no fresh post, through the REAL CRLF envelope", { skip: HAS_JQ ? false : "no jq binary on this box" }, () => {
  const f = fixture();
  try {
    // Page 1 (the thread's OLDEST 100) carries NO ack — the old scan
    // returned 0 here and every trigger posted a fresh ack (issue #581).
    // The rel=last page (comments 101-200) carries the ack at id 9090.
    const res = f.run(
      ["newest_window_jq", "ack_comment"],
      'printf "ACK:%s" "$(ack_comment owner/repo 588)"\n',
      {
        ACK_MARKER: "dsh:ack",
        GH_P1_ISSUES: f.wf("p1.json", [plain(12), plain(13), plain(14)]),
        GH_LAST_ISSUES: f.wf("last.json", [plain(301), trigger(9090, "ack dsh:ack posted at comment ~120"), plain(303)]),
        GH_LINK_ISSUES: f.wf("link.txt", envelopeHeaders([LINK_LINE])),
      },
    );
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /ACK:9090/, "the ack id from the newest window is returned, not 0");
    assert.doesNotMatch(res.stdout, /HTTP\/2/, "no envelope leakage into the id");
    const cs = f.calls();
    assert.equal(cs.length, 2, `exactly two gh calls (envelope + last page):\n${cs.join("\n")}`);
    assert.ok(cs[0].includes("-i"), "the first call is the -i envelope");
    assert.match(cs[1] ?? "", /&page=3/, "the second call fetches the rel=last page");
  } finally {
    f.cleanup();
  }
});

test("ack_comment: metacharacter ACK_MARKER (\" \\\\ ] |) is passed as $ENV, never interpolated — the marker still matches (issue #573 contract)", { skip: HAS_JQ ? false : "no jq binary on this box" }, () => {
  const f = fixture();
  try {
    // A marker full of jq metacharacters shatters an interpolated filter;
    // in the $ENV form it is just data. Single-page thread (no Link).
    const marker = 'dsh[ack] "quoted"';
    const res = f.run(
      ["newest_window_jq", "ack_comment"],
      'printf "ACK:%s" "$(ack_comment owner/repo 588)"\n',
      {
        ACK_MARKER: marker,
        GH_P1_ISSUES: f.wf("p1.json", [trigger(42, `some ${marker} ack`), plain(13)]),
        GH_LINK_ISSUES: f.wf("link.txt", envelopeHeaders(["Content-Type: application/json; charset=utf-8"])),
      },
    );
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /ACK:42/, `a metacharacter marker still finds its ack: ${res.stdout}`);
  } finally {
    f.cleanup();
  }
});

test("ack_comment: no ack anywhere returns 0 (the fresh-ack path) on a single-page thread — ONE gh call", { skip: HAS_JQ ? false : "no jq binary on this box" }, () => {
  const f = fixture();
  try {
    const res = f.run(
      ["newest_window_jq", "ack_comment"],
      'printf "ACK:%s" "$(ack_comment owner/repo 588)"\n',
      {
        ACK_MARKER: "dsh:ack",
        GH_P1_ISSUES: f.wf("p1.json", [plain(1), plain(2)]),
        GH_LINK_ISSUES: f.wf("link.txt", envelopeHeaders(["Content-Type: application/json; charset=utf-8"])),
      },
    );
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /ACK:0/, "no ack => 0 => the caller posts a fresh ack");
    const cs = f.calls();
    assert.equal(cs.length, 1, `single-page thread is ONE call:\n${cs.join("\n")}`);
  } finally {
    f.cleanup();
  }
});

test("ack_comment: a failed LAST-page fetch never falls back to page 1's ancient ack — 0 (fresh ack), not a wrong edit", { skip: HAS_JQ ? false : "no jq binary on this box" }, () => {
  const f = fixture();
  try {
    // Page 1 carries the thread's OLDEST ack (as a single page it WOULD
    // match), but the rel=last fetch fails: the honest answer is 0 (fresh
    // ack), never an edit of an ancient comment.
    const res = f.run(
      ["newest_window_jq", "ack_comment"],
      'printf "ACK:%s" "$(ack_comment owner/repo 588)"\n',
      {
        ACK_MARKER: "dsh:ack",
        GH_P1_ISSUES: f.wf("p1.json", [trigger(7, "old dsh:ack"), plain(8)]),
        GH_LAST_ISSUES: f.wf("last.json", []),
        GH_RCLAST_ISSUES: "1",
        GH_LINK_ISSUES: f.wf("link.txt", envelopeHeaders([LINK_LINE])),
      },
    );
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /ACK:0/, "a failed last-page fetch => 0, never page 1's ancient ack id");
  } finally {
    f.cleanup();
  }
});

test("an LF-only envelope (test shims, degraded proxies) parses the rel=last page too", { skip: HAS_JQ ? false : "no jq binary on this box" }, () => {
  const f = fixture();
  try {
    const out = path.join(f.dir, "task.raw");
    const res = f.run(
      ["newest_window_jq", "trusted_task"],
      `trusted_task owner/repo 588 false "${out}"\nprintf 'TASK:%s' "$(cat "${out}")"\n`,
      {
        GH_P1_ISSUES: f.wf("p1.json", [trigger(12, "/dsh ancient task from 2026")]),
        GH_LAST_ISSUES: f.wf("last.json", [trigger(9090, "/dsh the LF-envelope trigger")]),
        GH_LINK_ISSUES: f.wf("link.txt", envelopeHeaders([LINK_LINE], "lf")),
      },
    );
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /TASK:\/dsh the LF-envelope trigger/);
  } finally {
    f.cleanup();
  }
});

test("an EMPTY page-1 filter result on a multi-page thread still paginates — no $() newline-strip eats the envelope separator", { skip: HAS_JQ ? false : "no jq binary on this box" }, () => {
  const f = fixture();
  try {
    // Page 1 carries NO trusted match (the common >100-comment shape:
    // chatter only) — its empty jq output must not break the envelope
    // split, or the helper silently degrades to scanning page 1 forever.
    const out = path.join(f.dir, "task.raw");
    const res = f.run(
      ["newest_window_jq", "trusted_task"],
      `trusted_task owner/repo 588 false "${out}"\nprintf 'TASK:%s' "$(cat "${out}")"\n`,
      {
        GH_P1_ISSUES: f.wf("p1.json", [plain(13), plain(14)]),
        GH_LAST_ISSUES: f.wf("last.json", [plain(301), trigger(9090, "/dsh the just-posted trigger")]),
        GH_LINK_ISSUES: f.wf("link.txt", envelopeHeaders([LINK_LINE])),
      },
    );
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /TASK:\/dsh the just-posted trigger/);
    const cs = f.calls();
    assert.match(cs[1] ?? "", /&page=3/, `the rel=last page was fetched despite the empty page-1 result:\n${cs.join("\n")}`);
  } finally {
    f.cleanup();
  }
});

test("trusted_task on a >100-comment thread: the newest window is scanned through the REAL CRLF envelope — the newest trigger wins, page 1's ancient /dsh never runs", { skip: HAS_JQ ? false : "no jq binary on this box" }, () => {
  const f = fixture();
  try {
    // Page 1 (the thread's OLDEST 100) carries an ANCIENT trusted /dsh —
    // the old first-page scan returned exactly that body and ran the
    // WRONG task with a fresh ack (issue #588's worst case).
    const out = path.join(f.dir, "task.raw");
    const res = f.run(
      ["newest_window_jq", "trusted_task"],
      `trusted_task owner/repo 588 false "${out}"\nprintf 'TASK:%s' "$(cat "${out}")"\n`,
      {
        GH_P1_ISSUES: f.wf("p1.json", [trigger(12, "/dsh ancient task from 2026"), plain(13), plain(14)]),
        GH_LAST_ISSUES: f.wf("last.json", [plain(301), plain(302), trigger(9090, "/dsh the just-posted trigger")]),
        GH_LINK_ISSUES: f.wf("link.txt", envelopeHeaders([LINK_LINE])),
      },
    );
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /TASK:\/dsh the just-posted trigger/);
    assert.doesNotMatch(res.stdout, /ancient task/);
    assert.doesNotMatch(res.stdout, /HTTP\/2/, "no envelope leakage into the task");
    const cs = f.calls();
    assert.equal(cs.length, 2, `exactly two gh calls (envelope + last page):\n${cs.join("\n")}`);
    assert.ok(cs[0].includes("-i"), "the first call is the -i envelope");
    assert.match(cs[1] ?? "", /&page=3/, "the second call fetches the rel=last page");
  } finally {
    f.cleanup();
  }
});

test("trusted_task PR-review fallback paginates the pulls route the same way", { skip: HAS_JQ ? false : "no jq binary on this box" }, () => {
  const f = fixture();
  try {
    const out = path.join(f.dir, "task.raw");
    const res = f.run(
      ["newest_window_jq", "trusted_task"],
      `trusted_task owner/repo 588 true "${out}"\nprintf 'TASK:%s' "$(cat "${out}")"\n`,
      {
        // issue-comments route: nothing trusted anywhere (single page,
        // real no-Link header block)
        GH_P1_ISSUES: f.wf("p1.json", [plain(1), plain(2)]),
        GH_LINK_ISSUES: f.wf("link.txt", envelopeHeaders(["Content-Type: application/json; charset=utf-8"])),
        // pulls route: multi-page, ancient trusted trigger on page 1
        GH_P1_PULLS: f.wf("p1-pulls.json", [trigger(12, "@dsh-agent ancient review task")]),
        GH_LAST_PULLS: f.wf("last-pulls.json", [plain(400), trigger(9091, "/dsh the fresh review trigger")]),
        GH_LINK_PULLS: f.wf("link-pulls.txt", envelopeHeaders([LINK_LINE.replace(/issues\/588/g, "pulls/588")])),
      },
    );
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /TASK:\/dsh the fresh review trigger/);
    assert.doesNotMatch(res.stdout, /ancient review task/);
    const cs = f.calls();
    assert.ok(cs.some((l) => l.includes("/pulls/") && l.includes("&page=")), `the pulls route is paginated:\n${cs.join("\n")}`);
  } finally {
    f.cleanup();
  }
});

test("a failed last-page fetch NEVER falls back onto page 1's ancient trigger — the issue-body issuance runs instead", { skip: HAS_JQ ? false : "no jq binary on this box" }, () => {
  const f = fixture();
  try {
    const out = path.join(f.dir, "task.raw");
    const res = f.run(
      ["newest_window_jq", "trusted_task"],
      `trusted_task owner/repo 588 false "${out}"\nprintf 'TASK:%s' "$(cat "${out}")"\n`,
      {
        GH_P1_ISSUES: f.wf("p1.json", [trigger(12, "/dsh ancient task from 2026", "OWNER")]),
        GH_LINK_ISSUES: f.wf("link.txt", envelopeHeaders([LINK_LINE])),
        GH_LAST_ISSUES: f.wf("last.json", []),
        GH_RCLAST_ISSUES: "1", // the rel=last page fetch FAILS
        GH_VIEW: f.wf("view.json", { body: "/dsh the issue body task", title: "a title", authorAssociation: "OWNER" }),
      },
    );
    assert.equal(res.status, 0, res.stderr);
    // body issuance emits the BARE task (the /dsh prefix is stripped —
    // the #474 shape), never the ancient comment
    assert.match(res.stdout, /TASK:the issue body task/);
    assert.doesNotMatch(res.stdout, /ancient task/);
  } finally {
    f.cleanup();
  }
});

test("no trusted match on a single-page thread: the issue-body/title issuance still runs (the #474 shape)", { skip: HAS_JQ ? false : "no jq binary on this box" }, () => {
  const f = fixture();
  try {
    const out = path.join(f.dir, "task.raw");
    const res = f.run(
      ["newest_window_jq", "trusted_task"],
      `trusted_task owner/repo 588 false "${out}"\nprintf 'TASK:%s' "$(cat "${out}")"\n`,
      {
        GH_P1_ISSUES: f.wf("p1.json", [plain(1), plain(2)]),
        GH_LINK_ISSUES: f.wf("link.txt", ""),
        GH_VIEW: f.wf("view.json", { body: "/dsh the issue body task", title: "a title", authorAssociation: "OWNER" }),
      },
    );
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /TASK:the issue body task/);
    const cs = f.calls();
    assert.equal(cs.length, 1, `single-page thread is ONE call:\n${cs.join("\n")}`);
  } finally {
    f.cleanup();
  }
});

test("fetch_context recent-8: the newest 8 of the NEWEST window, never page 1's tail; an empty msg harvest writes a TRULY empty file", { skip: HAS_JQ ? false : "no jq binary on this box" }, () => {
  const f = fixture();
  try {
    const outdir = path.join(f.dir, "ctx");
    mkdirSync(outdir, { recursive: true });
    const res = f.run(
      ["newest_window_jq", "fetch_context"],
      `fetch_context owner/repo 588 "${outdir}"\n`,
      {
        GH_P1_ISSUES: f.wf("p1.json", [plain(1, "page-1 tail comment A"), plain(2, "page-1 tail comment B")]),
        GH_LAST_ISSUES: f.wf("last.json", [
          plain(301, "old-but-newest-window 1"), plain(302, "old-but-newest-window 2"),
          trigger(303, "fresh comment three"), trigger(304, "fresh comment four"),
        ]),
        GH_LINK_ISSUES: f.wf("link.txt", envelopeHeaders([LINK_LINE])),
        GH_VIEW: f.wf("view.json", { body: "issue body", title: "a title" }),
      },
    );
    assert.equal(res.status, 0, res.stderr);
    const ctx = readFileSync(path.join(outdir, "thread-context.txt"), "utf8");
    assert.match(ctx, /fresh comment four/, "the newest window's newest comments are served");
    assert.match(ctx, /fresh comment three/);
    assert.doesNotMatch(ctx, /page-1 tail comment/, "page 1's ancient tail is never served as recent");
    assert.doesNotMatch(ctx, /agent messages on this thread/, "no msg blocks — the section stays absent");
    const msgs = readFileSync(path.join(outdir, "agent-messages.txt"), "utf8");
    assert.equal(msgs, "", "an empty harvest leaves an EMPTY file (pin 3: no stray newline)");
  } finally {
    f.cleanup();
  }
});

test("fetch_context dsh:msg harvest reads the newest window; page 1's ancient blocks are never a substitute", { skip: HAS_JQ ? false : "no jq binary on this box" }, () => {
  const f = fixture();
  try {
    const outdir = path.join(f.dir, "ctx");
    mkdirSync(outdir, { recursive: true });
    const block = (from, text) => `<!-- dsh:msg from:${from} to:* type:note --> ${text} <!-- /dsh:msg -->`;
    const res = f.run(
      ["newest_window_jq", "fetch_context"],
      `fetch_context owner/repo 588 "${outdir}"\n`,
      {
        GH_P1_ISSUES: f.wf("p1.json", [plain(1, block("ancient-agent", "stale message from page 1"))]),
        GH_LAST_ISSUES: f.wf("last.json", [plain(301), trigger(9090, block("agent-a", "hello from the newest window"))]),
        GH_LINK_ISSUES: f.wf("link.txt", envelopeHeaders([LINK_LINE])),
        GH_VIEW: f.wf("view.json", { body: "issue body", title: "a title" }),
      },
    );
    assert.equal(res.status, 0, res.stderr);
    const ctx = readFileSync(path.join(outdir, "thread-context.txt"), "utf8");
    assert.match(ctx, /hello from the newest window/, "the newest-window block is harvested");
    assert.match(ctx, /agent messages on this thread/);
    assert.doesNotMatch(ctx, /stale message from page 1/, "an ancient page-1 block is never a substitute");
  } finally {
    f.cleanup();
  }
});

test("single-page thread: ONE gh call per scan, the one page scanned directly (no Link header)", { skip: HAS_JQ ? false : "no jq binary on this box" }, () => {
  const f = fixture();
  try {
    const outdir = path.join(f.dir, "ctx");
    mkdirSync(outdir, { recursive: true });
    const res = f.run(
      ["newest_window_jq", "fetch_context"],
      `fetch_context owner/repo 588 "${outdir}"\n`,
      {
        GH_P1_ISSUES: f.wf("p1.json", [plain(1), plain(2, "the actual newest comment")]),
        GH_LINK_ISSUES: f.wf("link.txt", envelopeHeaders(["Content-Type: application/json; charset=utf-8"])),
        GH_VIEW: f.wf("view.json", { body: "issue body", title: "a title" }),
      },
    );
    assert.equal(res.status, 0, res.stderr);
    const ctx = readFileSync(path.join(outdir, "thread-context.txt"), "utf8");
    assert.match(ctx, /the actual newest comment/);
    const cs = f.calls();
    assert.equal(cs.length, 2, `exactly two calls (recent-8 scan + msg scan):\n${cs.join("\n")}`);
    assert.ok(cs.every((l) => !l.includes("&page=")), "no second page fetch on a single-page thread");
  } finally {
    f.cleanup();
  }
});

test("the pinned window contract is structurally present: newest_window_jq backs ALL five gh api comment sites (no first-page-only scan survives)", () => {
  const w = readFileSync(WORKER, "utf8");
  assert.match(w, /newest_window_jq\(\) \{/, "the helper exists");
  // Every *list-comments* per_page=100 call in the worker lives inside
  // the helper — the ONLY per_page=100 call outside it is the
  // issues-poll (a different route, --paginate, line 203). Five consumer
  // sites are pinned verbatim (their filters must not drift back to a
  // first-page scan).
  const fnSpan = (name) => {
    const s = w.indexOf(`${name}() {`);
    assert.ok(s !== -1, "function missing: " + name);
    let depth = 0, i = s;
    for (; i < w.length; i++) {
      if (w[i] === "{") depth++;
      if (w[i] === "}") { depth--; if (depth === 0) break; }
    }
    return [s, i];
  };
  const [helperStart, helperEnd] = fnSpan("newest_window_jq");
  for (const m of [...w.matchAll(/gh api "[^"]*comments\?per_page=100/g)]) {
    assert.ok(m.index >= helperStart && m.index <= helperEnd,
      `no first-page-only comment scan outside the helper: ${m[0]}`);
  }
  for (const site of [
    'newest_window_jq "repos/${repo}/issues/${num}/comments" \'\n    [.[] | select',
    'newest_window_jq "repos/${repo}/pulls/${num}/comments"',
    "newest_window_jq \"repos/${repo}/issues/${num}/comments\" \\\n      '.[-8:][]",
    "newest_window_jq \"repos/${repo}/issues/${num}/comments\" \\\n    '.[] | .body | scan",
    'ACK_MARKER="$ACK_MARKER" newest_window_jq',
  ]) {
    assert.ok(w.includes(site), `site pinned: ${site.split("\n")[0]}`);
  }
  // the ack filter stays a constant literal reading $ENV.ACK_MARKER —
  // the marker never rides the worker's string interpolation
  assert.match(w, /contains\(\$ENV\.ACK_MARKER\)/, "the ack filter reads $ENV.ACK_MARKER");
});