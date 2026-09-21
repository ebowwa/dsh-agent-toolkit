# @local/dsh-reflex

Reflex engine tools for the DeepSeek Harness — a cordis plugin that registers
nine `reflex_*` session tools plus a `reflex_command` escape hatch, all as
thin clients for the Reflex command server (JSON over TCP, default
`127.0.0.1:49173`).

**One engine, many hosts.** The engine runs inside the Gauge host (its TCC
grants apply); this plugin is a stateless client and duplicates nothing.

## Tools
`reflex_status` · `reflex_windows` · `reflex_capture_display` ·
`reflex_capture_window` · `reflex_click` · `reflex_type` · `reflex_key` ·
`reflex_ax` · `reflex_command` (verbatim passthrough for the full engine
grammar).

## Install (dsh profile)
1. Profile dir `~/.dsh/profiles/reflex/`:
   - `package.json` — bundles `@deepseek-ai/dsh-base` + `@deepseek-ai/dsh-headless`,
     dependency `@local/dsh-reflex: file:/Users/ebowwa/Developer/dsh-plugin-reflex`
   - `cordis.patch.yml` — insert `id: reflex-tools, name: "@local/dsh-reflex"`,
     config `{ host, port, timeoutMs }`
   - `cordis.yml` — `[]` (generated root; edit the patch, not this)
   - `pnpm-workspace.yaml` — `packages: [.]`, `nodeLinker: hoisted`,
     `autoInstallPeers: false`
2. `dsh plugin --profile reflex install`
3. `dsh --profile reflex headless "Use reflex_status and report the build"` → done.

## Traps learned here (do not re-learn them)
- `defineTool` **parameters is a bare property map** — no `type: "object"`
  wrapper (the compiler reads each key as a property name; a `type` key
  throws "parameters.type must be a value schema object").
- **`render` lives INSIDE `output`** — top-level render is silently dropped
  and the harness fails with "userRender is not a function" on every call.
- Output schemas need **explicit** `additionalProperties` (`true` for
  dynamic engine payloads) — the compiler rejects implicit/missing.
- SecurityAgent (keychain dialogs) ignores ALL programmatic input — that path
  is human-only (see the `mini-keychain-unlock` skill).
