# Mobile Release Verification

## Result

Anvil Companion `1.1.0` builds in Release and launches on the iPhone 17 Pro Max simulator.

## Verified Commands

- `pnpm --dir mobile typecheck`
- `pnpm --dir mobile lint`
- `git diff --check`
- `xcodebuild -workspace ios/AnvilCompanion.xcworkspace -scheme AnvilCompanion -configuration Release -destination 'platform=iOS Simulator,id=E9989057-B602-4A7B-AC2E-326786621690' -derivedDataPath ios/build/DerivedData-companion-release-jsc build`
- `xcrun simctl install E9989057-B602-4A7B-AC2E-326786621690 ios/build/DerivedData-companion-release-jsc/Build/Products/Release-iphonesimulator/AnvilCompanion.app`
- `xcrun simctl launch E9989057-B602-4A7B-AC2E-326786621690 dev.anthonyhumphreys.anvil.app.companion`

## Evidence

- Release screenshot: `/tmp/anvil-mobile-shots/release-1.1.0-home.png`
- Launch PID: `97362`
- No new `AnvilCompanion-*.ips` crash report after final launch on July 6, 2026 after 09:20.

## Remaining Gaps

- XcodeBuildMCP semantic UI automation is blocked in this local Xcode beta install because `SimulatorKit.framework` is missing from `/Applications/Xcode-beta.app/Contents/Developer/Library/PrivateFrameworks/`.
- The simulator is carrying an iOS deep-link confirmation prompt, so the final screenshot verifies launch/dark-mode home rendering but not a clean tap-through of the chat composer.
