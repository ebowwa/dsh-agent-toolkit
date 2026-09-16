# dsh-system-prompt-editor

A live, file-backed **system-prompt block** for a persistent dsh web
install — with **scope levels**: one override per chat, one per workspace,
a global fallback.

```
<dir>/<sessionId>.md            this chat   (session-<uuid>.md)
<dir>/workspace-<id>.md         this workspace
~/.dsh/system-prompt.md         every chat  (global)
```

`<dir>` defaults to `~/.dsh/system-prompts`. **First non-empty level
wins**; absent/empty levels fall through. Writing empty content at the
session or workspace level *clears* the override (one-deep `.bak` kept);
the global block must stay non-empty (clearing it is refused).

Package name `@local/dsh-system-prompt-editor` — the `@local/` prefix is
the convention for hand-mounted dsh packages.

## What it mounts

Two halves, both live without restarting dsh:

1. **A prompt section** `deployment:user-prompt` (order 9000 — after tool
   guidance at ≤2800, before the persona suffix at 10200) whose text is a
   *function*, re-resolved at **every prompt assembly** (the agent loop
   assembles per step). A write therefore applies to the **next LLM call
   of every running session**, not the next boot. `interpolate: false`
   keeps the user's text literal — a stray `{{...}}` can't trip the
   variable validator; an empty chain renders no section at all, so the
   plugin is inert until something is written.
2. **Agent tools** so sessions themselves can read and edit the block:
   - `read_system_prompt` → the effective block (or `full: true` for the
     whole rendered prompt), plus which level is effective and which are set.
   - `write_system_prompt` (`content`, optional `scope`
     `session|workspace|global`, optional `append`) → atomic tmp+rename
     write, one-deep `.bak`, size cap. Empty content at session/workspace
     scope clears the override.

## Resolution details

- The workspace level resolves via the harness `workspaceRegistry`
  service: **registry membership first**, then
  `realpath(session cwd) === workspace.path`. Registry paths are
  realpath-canonicalized — on macOS that means `/private/var` spellings,
  which is why the tests canonicalize their fixtures.
- The current session is located via `agent.session.id` +
  `agent.session.header.cwd`.
- Config (from the patch row): `file` (global block, default
  `~/.dsh/system-prompt.md`), `dir` (scoped blocks, default
  `~/.dsh/system-prompts`), `maxChars` read cap (16384), `maxWriteChars`
  (65536), `disabled`.

## Mount (persistent web install)

Unlike `tool-search-compose` (a per-cell launcher mount), these packages
target a **persistent** dsh web install, mounted by hand into the
install's runtime module tree:

```sh
DSH_RUNTIME=<path to the install's runtime/node_modules>
cp -R plugins/dsh-system-prompt-editor "$DSH_RUNTIME/@local/"
mkdir -p ~/.dsh/profiles/node_modules/@local
ln -sfn "$DSH_RUNTIME/@local/dsh-system-prompt-editor" \
    ~/.dsh/profiles/node_modules/@local/dsh-system-prompt-editor
```

The profile row lives in `~/.dsh/profiles/web/cordis.patch.yml`
(hot-watched — editing it loads/unloads plugin rows in the running
server, no restart):

```yaml
- insert:
    - id: system-prompt-editor
      name: "/absolute/path/to/@local/dsh-system-prompt-editor/lib/hot.js"
      config:
        file: "~/.dsh/system-prompt.md"
        dir: "~/.dsh/system-prompts"
        disabled: false
```

Verify resolution from BOTH chains before adding the row:

```sh
cd ~/.dsh/profiles && node --input-type=module \
  -e "import('@local/dsh-system-prompt-editor').then(m => console.log(Object.keys(m)))"
```

**Do not symlink the runtime copy at this repo.** Node realpaths a
symlinked module into the repo directory, where the `@deepseek-ai/*`
peers don't resolve — the next boot fails the fiber import (an
unresolvable plugin row at boot crash-loops). Real-dir copies stay
self-contained; sync changes by copying.

## Shipping node-half changes to a running dsh (the module-cache trap)

The running process caches module URLs: a same-URL re-import returns the
stale module forever, and a config-only diff never re-imports at all.
That is why the patch row's `name:` above points at **`lib/hot.js`** (a
one-line re-export shim over `lib/index.js`) instead of the package
name. The fresh-URL swap recipe, with the full reasoning, is in
`lib/hot.js`'s header comment — short version: put the new code at a
*fresh* filename, disable the row, re-point `name:` at the fresh file,
re-enable, then collapse the copy back to a shim. Two writes, never one
(the entry group creates new entries before removing stale ones — a
one-write name swap collides on the still-registered tools/section).
Browser-half changes (in the `-ui` sibling) need no swap — a tab reload
picks them up.

## Tests

```sh
node test/smoke.mjs   # run from the MOUNTED copy (needs @deepseek-ai/* peers)
```

17 checks, offline (mock ctx + the real registered section/tools; no dsh
process, no browser).
