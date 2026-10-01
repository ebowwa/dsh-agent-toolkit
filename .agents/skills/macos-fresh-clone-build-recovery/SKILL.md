---
name: macos-fresh-clone-build-recovery
description: Diagnose and fix a macOS Xcode/SPM repo that builds for the incumbent but fails on a FRESH clone — private SPM package refs, missing Package.resolved, branch-drift package pins, and $(HOME)-local xcframework/model paths. Use when "works on my machine", fresh-clone build failure, or bootstrap-script claims land on the mac lane.
---

# macOS fresh-clone build recovery

A repo whose build works on a warmed machine but not from a fresh clone has its
implicit environment encoded in four specific places. Check them in this order —
each is cheaper than the one after it, and any one alone is fatal to a fresh clone.

## The four failure sites (check in order)

1. **Private SPM package refs** — grep `project.pbxproj` for
   `XCRemoteSwiftPackageReference`. Any referenced repo the cloner cannot see
   (private, e.g. a consumables/models repo) hard-fails dependency resolution
   with no workaround short of credentials. Remedy: a bootstrap script that
   authenticates/fetches, or a vendored mirror. Say which in the README.

2. **Missing `Package.resolved`** — if the project uses SPM and
   `Package.resolved` is not committed, every clone resolves floating and may
   fetch versions the incumbent never tested. Commit the resolved file from the
   working machine. If a PR branch carries it, note that main lacks it (check
   whether the fix belongs on main, not just the PR).

3. **Branch-drift package pins** — a package ref with `branch = main` drifts
   under you. Pin it to an explicit commit. **Retarget, don't delete:** if the
   drifting ref is the *only* package link for a secondary target (e.g. an
   AppStore target's Frameworks phase + `packageProductDependencies`), removing
   ref + product dep breaks that target while the primary target keeps
   building. Point the product dep at the pinned ref instead — same shape the
   file already uses when two targets share one package ref.

4. **`$(HOME)`-local binary/model paths** — `xcframework` and model-fetch
   references like `$(HOME)/Developer/...` resolve only on the incumbent
   machine. Replace with a bootstrap fetch step; document the models' source
   and destination in the README.

## Receipt discipline

The claim is not done until a real fresh clone proves it: `git clone` into an
empty dir, run the bootstrap, build (`xcodebuild -project ... -scheme ... build`),
and post the build receipt. "It should work now" is the failure this skill exists
to end — the incumbent's machine cannot certify the fix.

README path notes rot fast: verify the documented project path (e.g. project may
live under `apps/<name>/`, not repo root) before telling the reader to build.

## Placement

Every part of this claim that needs Swift/Xcode to verify is mac-native — execute
on a mac node. Docs/CI-config parts are neutral, but verify them on mac anyway so
the receipts come from the same clone.
