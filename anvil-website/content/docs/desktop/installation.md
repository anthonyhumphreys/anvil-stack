---
title: Installation and setup
navTitle: Installation
description: Get Anvil Desktop running from a release build or from source, and complete first-launch setup.
product: Anvil Desktop
section: Basics
order: 101
---

# Installation and setup

Anvil Desktop is an Electron app. You can run a packaged release build or build it from source. Both paths end at the same first-launch flow.

## Option A: release build (macOS Apple Silicon)

Release builds are attached to GitHub releases tagged `app-v*` in the [anvil-stack repository](https://github.com/anthonyhumphreys/anvil-stack/releases).

1. Download the latest [macOS Apple Silicon DMG](https://github.com/anthonyhumphreys/anvil-stack/releases/latest/download/Anvil-latest-arm64.dmg), or open the latest `app-v*` release and choose the `.dmg` or `.zip` asset manually.
2. Open the disk image and drag Anvil into Applications.
3. Launch it. If the build is not notarized, macOS Gatekeeper may require right-click → Open on first launch.

Other platforms do not have published builds yet; use the source path below. The packaging config supports Windows (NSIS, portable) and Linux (AppImage, deb) targets for local builds.

## Option B: build from source

Prerequisites:

- Node.js 20 LTS or later
- pnpm 10 (`corepack enable` is the simplest route)
- A C/C++ toolchain for the native modules (`better-sqlite3`, `node-pty`):
  - macOS: Xcode Command Line Tools (`xcode-select --install`)
  - Windows: Visual Studio Build Tools with the "Desktop development with C++" workload
  - Linux: `build-essential`, `python3`, `libsecret-1-dev`
- Git 2.30+

```bash
git clone https://github.com/anthonyhumphreys/anvil-stack.git
cd anvil-stack/anvil-app
pnpm install
pnpm dev
```

`pnpm install` rebuilds the native modules through a postinstall hook, and `pnpm dev` rebuilds them against the Electron runtime before starting. If either native module misbehaves after a Node or dependency change, rerun `pnpm install` before debugging anything else.

To produce a local packaged build on macOS arm64:

```bash
pnpm run dist:mac:arm64
```

Artifacts land in `dist/`.

## First launch

On first launch the app walks you through connector setup:

1. **LLM provider**: add an Azure AI Foundry or OpenAI key in Settings, or authenticate the Codex CLI for agentic chat sessions. Credentials are encrypted before being stored in the local SQLite database; no `.env` file is involved.
2. **Optional Apple Foundation Models route**: on macOS 26 or later, with Apple Intelligence available and enabled, set Apple Foundation Models to **Prefer simple** and run **Test Apple Models** from Settings. This only routes short, self-contained helper prompts to the on-device model; repo-aware work still uses the configured backend.
3. **Repositories**: connect local checkouts or clone from GitHub/Azure DevOps, then let indexing run.
4. **Optional connectors**: Azure DevOps PAT, Linear API key, or Jira token for work items; a Confluence PAT for documentation features.

Everything is stored locally. There is no hosted backend; deleting the app's data directory resets it completely.

## Optional extras

- A [Nerd Font](https://www.nerdfonts.com/) (for example MesloLGS NF or Hack Nerd Font) makes the built-in terminal render powerline glyphs correctly.
- The Expo companion app in `anvil-app/mobile` and the Raycast extension in `anvil-app/raycast/anvil` pair with a running desktop instance. See [Companion surfaces](/docs/desktop/companion-surfaces).

## Read next

- [Operating guide](/docs/desktop/operating-guide) for the day-to-day working loop.
- [Chat personas, reasoning, and LLM providers](/docs/desktop/chat-personas-and-llm) to configure models.
- [Troubleshooting](/docs/desktop/troubleshooting) if something refuses to start.
