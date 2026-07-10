# Anvil mobile companion review

## Product assessment

The companion already had substantial capability—multi-host pairing, chat attachments, file and skill mentions, approvals, widgets, Live Activities, and Watch surfaces—but its information architecture presented those capabilities like a demo dashboard.

The largest remaining weakness is chat. It currently behaves like an administrative transcript: repeated cards, polling-based refresh, no optimistic sending, limited structured rendering, and an oversized composer. Improving this is the next product-critical track.

## Implemented

- Replaced the fixed JavaScript tab bar with Expo Router Native Tabs.
- Adopted system-owned iOS tab materials and platform-specific icons.
- Added explicit Follow Mac and pinned-workspace modes.
- Added a searchable mobile work-item contract and interface.
- Defaulted work-item display to the detected current iteration, with All Open available.
- Made widget selection deterministic and action-oriented.
- Limited Live Activities to genuine active work and approvals.
- Removed widget demo commands and corrected approval terminology.

## Watch diagnosis

The generated Watch metadata is correct:

- Watch device family is `4`.
- `WKApplication` is enabled.
- `WKCompanionAppBundleIdentifier` is correct.
- The Watch app and widget are embedded in the phone bundle.
- App Group entitlements align.
- Nested signatures validate.

Installation fails because the personal-development provisioning profiles expired after seven days. Rebuilding refreshes them temporarily. A paid Apple Developer team with persistent profiles or TestFlight distribution is required for a dependable showcase build.

## Remaining priority work

1. Rebuild chat around a virtualized timeline, structured Markdown/code/tool rendering, optimistic sends, retry states, and event-driven updates.
2. Replace the current composer with a compact input plus attachment/context menu.
3. Add server-backed thread and work-item pagination/search.
4. Upgrade Expo incrementally from SDK 54 through 57.
5. Validate New Architecture, Hermes, filesystem migration, Metro configuration, and every generated Apple target after each SDK step.
6. Build and distribute the phone/watch bundle with durable signing.
7. Perform physical iPhone and Watch QA, including offline, approval, active-run, reduced-motion, and accessibility states.

## Delivery boundary

This pass establishes the native navigation, context model, useful work-item surface, and relevant widget behavior. It does not yet complete the gold-standard chat redesign or the Expo 57/native release migration.