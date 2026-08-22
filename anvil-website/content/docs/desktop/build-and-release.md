---
title: Build and release
navTitle: Build and release
description: Development, testing, packaging, signing, and distribution notes for Anvil Desktop.
product: Anvil Desktop
section: Engineering
journey: build
order: 132
---

# Build and release

Anvil Desktop is an Electron app with native dependencies. Build and release work should respect that reality instead of treating it like a static website with delusions of grandeur.

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

The unsigned internal path and the signed/notarized path are different release modes. Do not treat a local DMG that opens on one machine as release validation.

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

Release notes should tell maintainers what changed and how it was verified. They do not need to pretend every build was a spiritual event.
