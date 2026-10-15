---
title: Build and release
navTitle: Build and release
description: Develop, test, package and release Anvil Desktop on macOS, Windows and Linux.
product: Anvil Desktop
section: Guides
journey: build
order: 230
---

# Build and release

Anvil Desktop is an Electron app with native dependencies, so building and releasing it takes a little more care than a website.

## Local development

Install dependencies from the root of `anvil-app`:

```bash
pnpm install
```

Start the Electron app:

```bash
pnpm dev
```

Run common checks:

```bash
pnpm test
pnpm lint
pnpm build
```

Native modules such as `better-sqlite3` and `node-pty` may require rebuilds after Node, Electron, or platform changes.

## Workspace packages

| Path | Purpose |
| --- | --- |
| `src` | Main Electron runtime, preload bridge, shared contracts, and renderer app. |
| `mobile` | Expo companion app. |
| `raycast/anvil` | Raycast extension for local control. |
| `video` | Remotion video project. |
| `prompts` | Prompt templates used by LLM workflows. |
| `resources` | App icons and helper resources. |
| `scripts` | Build, packaging, signing, notarization, and external-control scripts. |

## Distribution

Production packaging uses `electron-builder`. The repo includes scripts for internal unsigned builds and signed/notarized macOS builds.

Typical release concerns:

- native module rebuilds
- app identity and branding
- app icons and packaged resources
- macOS signing and notarization secrets
- Windows and Linux packaging targets
- update and distribution strategy
- release notes and verification evidence

Unsigned internal builds and signed, notarised builds are different release paths. A DMG that opens on your machine isn't proof a release works.

## Tag-triggered packages

Bump the desktop version in `anvil-app/package.json`, commit it, and push a matching `app-v<version>` tag to run the platform release workflows:

| Target | Build command | Published artifacts |
| --- | --- | --- |
| macOS Apple Silicon | `pnpm run dist:mac:arm64` | Versioned DMG, stable `Anvil-latest-arm64.dmg`, and ZIP |
| Windows x64 | `pnpm run dist:win:x64` | NSIS installer and portable executable, with checksums |
| Linux x64 | `pnpm run dist:linux:x64` | AppImage, deb, and pacman packages, with checksums |

The macOS tag workflow explicitly disables signing discovery and builds without notarization. Auto-update publication stays disabled. The signed/notarized local script is a separate path and requires the appropriate credentials.

Platform workflows upload to the same GitHub release and can finish at different times. Check all three jobs and the uploaded assets before declaring the release complete. Packaging success does not establish runtime feature parity across operating systems; the current browser change-review runner, for example, depends on POSIX process checks.

## Mobile companion checks

Companion app work is scoped under `mobile`.

Common commands:

```bash
pnpm --dir mobile start
pnpm --dir mobile ios
pnpm --dir mobile android
pnpm --dir mobile typecheck
pnpm --dir mobile lint
```

Companion features should be tested against the desktop pairing and approval surfaces they control.

## Release evidence

For a release candidate, keep:

- commit or tag
- build command
- platform target
- signing/notarization status
- smoke test result
- critical workflow checks
- known limitations
- rollback or rebuild notes

Release notes should say what changed and how it was checked. Keep them plain.
