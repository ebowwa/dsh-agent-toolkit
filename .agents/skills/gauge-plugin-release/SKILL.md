# gauge-plugin-release

Ship a Gauge plugin version — the signed build, the catalog, the artifacts, and BOTH install paths. Use when bumping any `plugins/*` version, dispatching `plugins-release`, or when the mini runs a stale plugin.

## The full path (do ALL of it — none of it is optional)

**1. The code lands on `master` (the gauge repo's default branch is `master`, NOT `main`).**
```
git push origin HEAD    # from master
```

**2. Dispatch the release WITH INPUTS (a bare dispatch fails with "catalog entry not found: " — empty `$ID`):**
```
gh workflow run plugins-release -R ebowwa/gauge -f plugin=<name> -f bump=patch
# names: remotegauge | githubactions | aisessions
```
The workflow owns the version bump: it reads `plugin-catalog/plugins.json`, bumps it, rewrites `project.yml`, builds, signs, patches the catalog (sha256 + cache-bust), uploads to R2, verifies live, and commits the bumps back. NEVER hand-edit the catalog version — a manual bump plus the workflow's bump double-counts.

**3. Signing needs the Developer ID identity — it lives in the LOGIN keychain.**
After any mini reboot the login keychain re-locks and codesign fails with `errSecInternalComponent`. The workflow has an unlock step (added 2026-09-11) that reads the password from Doppler:
```
doppler secrets get GITHUB_PASSWORD --project seed --config prd --plain
```
If signing still fails: the unlock step exists on master, the runner's Doppler is authenticated, and `build.sh` adds the login keychain to the search list itself. Do NOT conclude "can't sign" — the identity is on the machine and the password is in Doppler.

**4. TWO artifacts publish per release — TWO install paths exist on the mini:**
```
https://secondsee.com/downloads/gauge/plugins/GaugeAISessions.app.zip?v=<N>          # the standalone companion app
https://secondsee.com/downloads/gauge/plugins/GaugeAISessionsPlugin.gaugeplugin.zip?v=<N>  # the plugin bundle
```
- The companion app installs at `/Applications/GaugeAISessions.app` (a login item, self-registers).
- The plugin bundle installs at `~/Library/Application Support/Gauge/plugins/<Name>.gaugeplugin` — THIS is what the Gauge.app menu bar actually loads.
- **Updating one and not the other leaves the other burning the old code.** Install BOTH every time:
```bash
# Per-run staging (#351): a fixed /tmp/app or /tmp/plug is shared with every
# same-box sibling running this recipe — a concurrent unzip -oq overwrite
# strews a half-written or wrong-version bundle that the cp -R below then
# installs. mktemp mints a dir only this run can name; nothing else touches it.
stage="$(mktemp -d "${TMPDIR:-/tmp}/gauge-install-XXXXXX")"
curl -sL "<app.zip URL>" -o "$stage/app.zip" && unzip -oq "$stage/app.zip" -d "$stage/app"
killall <App> 2>/dev/null; sleep 2
rm -rf /Applications/<App>.app && cp -R "$stage/app/<App>.app" /Applications/
xattr -dr com.apple.quarantine /Applications/<App>.app
curl -sL "<plugin.zip URL>" -o "$stage/plug.zip" && unzip -oq "$stage/plug.zip" -d "$stage/plug"
rm -rf ~/Library/Application\ Support/Gauge/plugins/<Name>.gaugeplugin
cp -R "$stage/plug/<Name>.gaugeplugin" ~/Library/Application\ Support/Gauge/plugins/
open -a <App>; open -a Gauge
rm -rf "$stage"   # staging is throwaway — the installed copies are the artifacts
```

**5. Verify the versions AND the cost, sustained:**
```bash
plutil -extract CFBundleShortVersionString raw /Applications/<App>.app/Contents/Info.plist
plutil -extract CFBundleShortVersionString raw ~/Library/Application\ Support/Gauge/plugins/<Name>.gaugeplugin/Contents/Info.plist
ps aux | grep -iE "gauge" | grep -v grep      # read 2+ minutes apart; idle ≈ 0-2% cpu
```

## Known failure signatures

| Symptom | Cause | Fix |
|---|---|---|
| `catalog entry not found: ` (empty id) | dispatched without `-f plugin=` | re-dispatch with inputs |
| Swift build error in the release | the runner compiles what CI didn't (older SDK) | check the exact line: `UInt64` arithmetic needs explicit casts; `readData(toEndOfFile()` not `readData(toEndOfFile:)` on this target |
| `errSecInternalComponent` at codesign | login keychain locked (post-reboot) | the workflow's unlock step handles it; verify it ran |
| The menu bar still burns CPU after "the release" | the plugin registry copy is stale | install path 2 above |
| `-10810` at launch | installed the `.gaugeplugin` bundle as the app | the `.app.zip` artifact is the app; the `.gaugeplugin.zip` is the registry payload |

## The history that wrote this

0.2.3 took five dispatches: a bare dispatch (empty id), two Swift compile errors the local build couldn't catch, the reboot-locked keychain, and a wrong-artifact install. 0.2.4 then shipped first-try EXCEPT the plugin registry was missed — and the menu bar burned a full core for an hour on the stale copy. Every trap above is one of those. The infra was already built; this skill is the map through it.
