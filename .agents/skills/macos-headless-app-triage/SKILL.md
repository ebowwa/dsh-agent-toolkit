---
name: macos-headless-app-triage
description: Build, sign, launch, and OBSERVE a self-built macOS app on a fleet mac node with no GUI session - background-build parallelism, ad-hoc signing to survive the sandbox, unified-log measure-first, historical log mining, and phased probe apps to isolate AppKit triggers. Use whenever a mac claim must reproduce or verify app behavior (indexing loops, dialogs, CPU spin, AX starvation, hangs) on a headless box.
---

# Headless macOS app triage (measure-first loop)

Distilled from the CoreSpotlight re-index investigation (2026-09-28, 180-tool
session) and the same-day quit-path hang diagnosis. The order is the skill:
build in background -> measure before concluding -> reproduce with a
controlled probe -> verify the fix hypothesis empirically.

## 1. Parallelize the long pole
Kick the Debug build off in the background FIRST (large apps: private SPM
deps, WhisperKit/Sparkle class), then read the code paths named in the ticket
while it compiles. Never serialize build -> read.

## 2. Ad-hoc sign before the first launch
An unsigned Debug build CRASHES AT BOOT opening its own sandbox container -
`SQLITE_AUTH 23` on the Core Data store. Before launch:

    codesign --force --deep -s - <App>.app

Check entitlements if the store path lives inside the app container.

## 3. Measure before concluding
- What does the binary actually LINK (`otool -L`)? Indirect framework
  behavior (e.g. AppKit -> CoreSpotlight donations) is invisible to source
  grep - the app never imports CoreSpotlight yet fires it per window update.
- Start the unified-log capture BEFORE launch:
  `log stream --predicate 'process == "<app>"' --style compact`
- Launch idle, let it reach steady state, THEN read. One event is not a
  loop - measure cadence over minutes before claiming a periodic mechanism.

## 4. Mine the historical log before re-producing
The incident you are investigating probably ran ON THIS BOX. The unified log
store keeps it:

    log show --last 48h --predicate 'process == "<app>"'

The original receipts carry the real trigger context - cheaper and truer
than a headless repro that cannot recreate GUI-session state.

## 5. Reproduce with a phased probe app
When live repro fails headless (System Events wedged, no AX host, no open
windows), build a minimal probe app with TIMED PHASES - settle -> title
churn -> orderFront churn -> alpha churn -> control - one log-capture window
per phase. Hard-won rules:
- A BARE BINARY DOES NOT TRIGGER APPKIT BEHAVIORS - the probe must be a
  proper .app bundle (Info.plist, bundle directory shape).
- Mirror the suspect stimulus 1:1 per phase. A phase-event 1:1 correlation
  IS the mechanism proof.
- Make the fix hypothesis the final phase (e.g. the opt-out API under
  identical churn). "Neither opt-out suppressed it" is a result, not a
  failure - report it and move to the next hypothesis.

## 6. Sample the stuck main thread
`sample <pid> 5` shows directly what the main thread is blocked on - it
found `NSAlert.runModal` holding since launch (a modal nested run loop that
an async `Task { @MainActor }` teardown can never drain). Cheaper and more
conclusive than inferring from logs.

## 7. Verify by reflex (mac TCC envelope)
The mac envelope grants Accessibility + ScreenCapture freely: launch the
app, `capture_display`, assert no error/dialog window, close popups you
find, quit and re-check. CLI/log assertions alone do not ship GUI work.

Keep the receipts - log excerpts with timestamps, the phase timeline, sample
output - the exit summary and PR body need them.
