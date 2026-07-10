# Anvil mobile companion review

## Outcome

The mobile companion has been moved from a telemetry-style demo toward a platform-native Anvil control surface.

## Product changes

- Native Expo Router tabs with system materials and iOS glass.
- Follow Mac context by default, with deliberate workspace pinning.
- Searchable open work items with provider-backed active-sprint filtering.
- Virtualized chat timeline with optimistic sending and retry.
- Compact composer with attachments, file mentions, skills, run mode, reasoning, send, and stop.
- Structured headings, lists, inline code, fenced code, attachments, approvals, and error rendering.
- Attachment bearer tokens moved from URLs to Authorization headers.
- Widget priority: approval, active work, serious finding, then current work.
- Live Activities limited to approvals and active runs.
- Demo widget commands and misleading approval labels removed.

## Platform alignment

- Expo SDK 57.0.4.
- React Native 0.86.0.
- Expo Router 57.0.4.
- Hermes and New Architecture enabled.
- Reanimated 4.5 and Worklets 0.10.
- Native Material Icons package replaces deprecated Expo vector icons.
- iOS deployment target aligned to 16.4.
- Config plugins support the Expo 57 Podfile and AppDelegate shapes.
- Watch, Widget, Live Activity, and app targets regenerate from durable plugin source.

## Watch diagnosis

The original integrity failure was caused by expired seven-day personal-development provisioning profiles.

Current native metadata is correct:

- Watch device family `4`.
- `WKApplication` enabled.
- Correct companion bundle identifier.
- Matching App Group entitlements.
- Watch app and widget embedded in the phone bundle.
- Native dependency graph builds successfully.

A paid Apple Developer profile or TestFlight distribution is required for a dependable installation. Free signing would simply recreate the failure seven days later.

## Verification

- Mobile TypeScript: pass.
- Mobile ESLint: pass.
- Expo dependency alignment: pass.
- Expo Doctor: 19/20; only the intentional monorepo React patch-version split remains.
- Web export: pass, 17 routes.
- Root TypeScript: pass.
- Vitest: 58 files, 335 tests passed.
- CocoaPods: 109 pods installed.
- Unsigned iPhone Release build with embedded Watch and Widget products: pass.
- Signed build/install: awaiting Xcode account and provisioning profiles.

## Remaining delivery step

1. Sign into the intended paid Apple Developer team in Xcode 27.
2. Generate profiles for the app, Watch app, and widget extension.
3. Rebuild the signed Release bundle.
4. Install it on the paired iPhone.
5. Verify Watch propagation and physical-device interaction states.