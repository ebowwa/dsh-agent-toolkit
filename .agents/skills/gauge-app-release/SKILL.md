# gauge-app-release

Ship a Gauge.app release (the main menu-bar app, not a plugin) — the tagged build, notarization, the Sparkle feed, the DMG upload, and the update path. Use when bumping `targets/Version.xcconfig`, pushing a `v*` tag, or when the mini's `/Applications/Gauge.app` is stale.

## The release (the infra is BUILT — it all exists already)

**1. The version lives in `targets/Version.xcconfig`** (`MARKETING_VERSION` + `CURRENT_PROJECT_VERSION`). The workflow rewrites both from the tag/input — do NOT hand-bump unless releasing without a tag. `GAUGE_FEED_URL` also lives in that file; the sed touches only version lines so the feed URL survives.

**2. Trigger — either works:**
```bash
git tag v2.1.50 && git push origin v2.1.50          # the tag path (preferred)
# or, versionless dispatch (uses the committed Version.xcconfig):
gh workflow run release -R ebowwa/gauge
# or with an explicit version:
gh workflow run release -R ebowwa/gauge -f version=2.1.50
```
The gauge repo's default branch is **`master`**.

**3. The pipeline does the rest, all on the self-hosted runner (mac-mini-eul):**
- Xcode 26.6.0 selected, version stamped (`CURRENT_PROJECT_VERSION` = the commit count)
- **Notarize**: `doppler run -p seed -c prd -- scripts/notarize.sh` — the ASC key + Apple ID ride `seed/prd` in Doppler; notarytool + staple
- **Sparkle**: `scripts/sparkle-package.sh` builds the update zip + a fresh `appcast.xml` (enclosure + appcast URLs derive from the app's own `SUFeedURL` — single source of truth)
- **Upload**: the DMG + zip + appcast go to R2 via `doppler run -p caringmind-relay -c prd` (the relay's bucket)
- The artifact lands at `https://secondsee.com/downloads/gauge/` (DMG + `appcast.xml`)

**4. The update path is AUTOMATIC for installed copies** — Sparkle reads `SUFeedURL` (`https://secondsee.com/downloads/gauge/appcast.xml`) and offers/installs the update. No manual install needed for end users of an already-installed Gauge.app. For a fresh or manual install:
```bash
stage="$(mktemp -d "${TMPDIR:-/tmp}/dsh-gauge-app-release-XXXXXX")"   # per-run staging (issue #346) — a fixed /tmp/g.dmg is clobbered by a same-box sibling running this same fence
curl -sL "https://secondsee.com/downloads/gauge/Gauge-<VER>.dmg" -o "$stage/g.dmg"
hdiutil attach "$stage/g.dmg" -nobrowse -mountpoint "$stage/G" && cp -R "$stage/G/Gauge.app" /Applications/ && hdiutil detach "$stage/G"   # the mountpoint rides the stage — /Volumes/G is exactly as shared as /tmp
rm -rf "$stage"   # cleanup rule: only the path this session minted (after detach)
```

**5. Verify:** the run green (`gh run list -R ebowwa/gauge --workflow release`), the appcast's enclosure URL live (curl it), and on the mini after the Sparkle update lands: `plutil -extract CFBundleShortVersionString raw /Applications/Gauge.app/Contents/Info.plist` + a sustained `ps aux | grep Gauge` CPU read.

## Signing/notarization credentials (ALL in Doppler — nothing is missing)

| Need | Where |
|---|---|
| Developer ID Application identity | the mini's **login keychain** (unlocks via `seed/prd` `GITHUB_PASSWORD`; re-locks after reboots) |
| notarytool ASC key + profile | `doppler run -p seed -c prd` (scripts/notarize.sh consumes them inline) |
| R2 upload creds | `caringmind-relay/prd` |
| `errSecInternalComponent` at codesign | login keychain locked — see the plugin-release skill; the same unlock applies |

## Failure signatures

| Symptom | Cause | Fix |
|---|---|---|
| Notary step fails | ASC key expired/rotated in Doppler | check `seed/prd` ASC_* secrets, re-run |
| App ships with broken updates | Version.xcconfig rewritten wholesale (GAUGE_FEED_URL wiped) | keep the sed version-lines-only (the workflow does this correctly now) |
| The mini stays stale after release | Sparkle checks on its own schedule | the user's update prompt, or the manual DMG path above |
| Tag push didn't trigger | tag not `v*`-prefixed or not pushed | `git push origin v<VER>` |

## Distinction from the plugin skill

- `gauge-plugin-release`: the PLUGINS (`plugins/*`, e.g. aisessions) — `plugins-release` workflow, `-f plugin= -f bump=`, TWO manual install paths (app + registry).
- THIS skill: the MAIN Gauge.app — the `release` workflow, tag-driven, notarized + Sparkle, updates itself via the appcast. The plugin registry inside Application Support is untouched by this path (Gauge.app's bundled widgets ride along; the aisessions PLUGIN is separate).
