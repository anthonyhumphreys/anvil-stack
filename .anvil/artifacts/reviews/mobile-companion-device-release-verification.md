# Mobile Companion Release Verification

Date: 13 July 2026

## Installed release

- Version: 1.2.0 (3)
- Configuration: signed Release
- iPhone 17 Pro Max installation and launch: passed
- Apple Watch Ultra 2 installation and launch: passed
- Widget embedding and signing: passed

## Regression verification

- Thread rows render as full-width cards with intact text, icons, chevrons, and hit areas.
- Thread-detail navigation opens live history and the composer.
- Explicit workspace selection displays as “Selected on this iPhone.”
- Stale polling, event-stream, and Watch requests cannot overwrite an explicit mobile selection.
- The redundant top settings action is removed.
- Settings remains available through the native bottom tab.

## Desktop boundary

Mobile-pinned workspace selection works with the currently installed desktop build.

Instant “Follow Mac” changes require the updated desktop build because it emits a companion event whenever the desktop workspace setting changes. The source change passes lint, tests, and production build, but the active desktop application was not replaced while it was hosting this conversation.

## Validation

- Mobile TypeScript: passed
- Expo lint: passed
- Expo iOS export: passed
- Desktop lint: passed
- Desktop production build: passed
- Vitest: 58 files and 337 tests passed
- Signed Xcode Release build: passed
- iPhone installed-app inventory: passed
- Watch installed-app inventory and physical launch: passed