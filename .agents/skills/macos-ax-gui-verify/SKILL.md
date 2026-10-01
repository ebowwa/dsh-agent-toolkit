---
name: macos-ax-gui-verify
description: Drive and verify macOS GUI dialogs - app menus, tray items, alerts, sheets, and system TCC prompts - via the Accessibility API from an agent/mac-lane context. Use whenever a mac claim must press a button in a dialog, dismiss a permission prompt, prove a dialog is reachable/visible, or write an audit gate that walks another process's AX tree.
---

# macOS GUI verification via AX (activate, poll, press)

Distilled from the 2026-09-28 de-modal-park (#171/PR#173) and TCC-prompt
(#169/PR#174) investigations on the mac lane. The three laws: activate
through LaunchServices, poll for late AX trees, resolve sheets inside their
host window.

## 1. Launch via `open -a`, never by exec

A process spawned from an agent/daemon context renders its panels on screen
(CGWindowList shows them) but **never registers them with Accessibility**:
`kAXWindowsAttribute` stays empty and the system-wide hit-test at the panel
center returns `-25204`. `NSApp.activate(ignoringOtherApps:)` is denied by
LaunchServices for daemon-spawned processes, so no in-process fix can be
exercised there. Launching a registered bundle with `open -a` gives full
activation, after which windows enumerate immediately.

`open` refuses hand-built re-bundles (`-10825`) even after `lsregister` +
a valid deep ad-hoc signature - from `/tmp` and `~/Applications` alike.
If you need an interactive harness, it must live in something LaunchServices
will actually launch, or run from the operator's GUI session.

## 2. Sign ad-hoc or AMFI kills the build at exec

    xcodebuild ... CODE_SIGN_IDENTITY=- CODE_SIGN_STYLE=Manual DEVELOPMENT_TEAM=

An unsigned Debug binary dies at execve (AMFI); `CODE_SIGN_IDENTITY=""`
ships unsigned. `codesign --force --deep -s -` on an existing .app also works.

## 3. TCC/system prompts are late-AX, not AX-blind

The system mic prompt (`com.apple.UserNotificationCenter`) shows **0 AX
elements** for the first ~20-30s after spawn, then the full tree arrives
(AXSystemDialog window, labeled `Allow` / `Don't Allow` / `Help` buttons).
One-shot AX walks at t=0 return 0 elements and get misread as "AX-blind".
The answer is poll-with-deadline, then press:

    for i in $(seq 1 30); do
      tree=$(ax-walk "$pid") && [ -n "$tree" ] && break
      sleep 1
    done
    ax-press "$pid" 'Allow'   # by title; engine mac-resolve also sees all buttons

Cross-check with CGWindowList (window exists but not yet rendered = tree
not yet materialized, keep polling).

## 4. Sheets live inside their host window

An alert presented as a sheet is an `AXSheet` **child of the host window**,
not a top-level `AXWindow`. Audit gates that count top-level windows will
miss it and false-fail (or false-pass). Walk `AXWindow -> AXSheet`, and
press its buttons there. If a window/sheet hangs half off-screen (auto-fit
frames can push it out), pull the host back on-screen first - an
off-screen sheet is still AX-resolvable, but reflex captures will not show it.

## 5. Title and control gotchas

- App menu items: AppKit renames the standard `Preferences...` to
  `Settings…` (Unicode ellipsis) on current SDKs - match the RUNNING title,
  not the source string. Tray items keep ASCII dots.
- Tray/status-item presses flake ~50% under load (`-25204` class): retry 2-3x.
- Killing a stuck instance: SIGTERM is swallowed by graceful-shutdown paths;
  use SIGKILL. A launch-time modal wedges all menu action delivery until
  dismissed.
- TCC grants key on the built binary's PATH - a fresh DerivedData hash
  re-presents as untrusted and changes which prompts appear.

## 6. Receipts

GUI fixes ship transparently: `capture_display` before the change and after
(dialog states included), plus a main-thread `sample` showing where the run
loop sits (e.g. 2562/2562 samples in `-[NSAlert runModal]` = parked;
0 runModal frames after the fix = cleared). Commit captures under
`docs/reflex-receipts/<date-issue-slug>/` with a RECEIPTS.md summary.
