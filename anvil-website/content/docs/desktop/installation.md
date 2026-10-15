---
title: Install Anvil Desktop
navTitle: Installation
description: Download a release build or build from source, then get through the first launch.
product: Anvil Desktop
section: Start here
journey: build
order: 20
---

# Install Anvil Desktop

You can download a ready-made build or build the app from source. Either way you end up at the same first-launch setup.

## Download a release

Builds are attached to the `app-v*` releases in the [anvil-stack repository](https://github.com/anthonyhumphreys/anvil-stack/releases).

### macOS

1. Download the latest [DMG for Apple silicon](https://github.com/anthonyhumphreys/anvil-stack/releases/latest/download/Anvil-latest-arm64.dmg), or pick the `.dmg` or `.zip` from the latest `app-v*` release.
2. Open the disk image and drag Anvil into Applications.
3. Before the first launch, open Terminal and run:

   ```bash
   xattr -dr com.apple.quarantine /Applications/Anvil.app
   ```

4. Open Anvil from Applications.

> **Note: Why the Terminal step?**
>
> Anvil isn't signed or notarised by Apple yet, because the project doesn't have an Apple Developer account. That command removes the quarantine flag macOS adds to downloads so the app can open. Only run it on a copy you downloaded from the official GitHub releases.
>
> [Sponsoring Anvil on GitHub](https://github.com/sponsors/anthonyhumphreys) helps pay for the Apple Developer membership.

Automatic updates are switched off for the standard macOS build for now, so check the releases page for new versions.

### Windows and Linux

Each release also includes Windows x64 installers and portable executables, and Linux x64 AppImage, deb and pacman packages. Download the one you need from the [releases page](https://github.com/anthonyhumphreys/anvil-stack/releases) and check it against the checksum file next to it. If a brand-new release is missing your platform, its build is probably still running; check back shortly.

> **Note: Using LLMGateway**
>
> LLMGateway agents run through Codex, so you need Codex installed. In Anvil's LLMGateway setup, choose **Install coding engine** and Anvil installs and manages it for you. Codex edits files and runs commands on your machine; LLMGateway provides the models and bills you for them.
>
> You don't need a ChatGPT login or subscription. Connect your LLMGateway account or API key instead.

## Build from source

You'll need:

- Node.js 22.12.0 or later
- pnpm 10 (run `corepack enable` to get it)
- A C/C++ toolchain for the native modules (`better-sqlite3` and `node-pty`):
  - macOS: Xcode Command Line Tools (`xcode-select --install`)
  - Windows: Visual Studio Build Tools with the "Desktop development with C++" workload
  - Linux: `build-essential`, `python3` and `libsecret-1-dev`
- Git 2.30 or later

```bash
git clone https://github.com/anthonyhumphreys/anvil-stack.git
cd anvil-stack/anvil-app
pnpm install
pnpm dev
```

`pnpm install` builds the native modules, and `pnpm dev` rebuilds them for Electron before starting the app. If a native module misbehaves after you change Node or a dependency, run `pnpm install` again before digging further.

To package a build yourself on an Apple silicon Mac:

```bash
pnpm run dist:mac:arm64
```

The result lands in `dist/`.

## First launch

The first time you open Anvil, it walks you through setup:

1. **Connect an agent.** Choose one or more:
   - LLMGateway, with its Codex coding engine (see the note above).
   - Codex, signed in with your ChatGPT account.
   - An OpenAI API key, added in Settings. Keys you enter there are encrypted before they're saved.
   - Azure AI Foundry, configured in `~/.codex/config.toml` with the API key in the environment variable it names.
2. **Apple's on-device model (optional).** On macOS 26 or later with Apple Intelligence turned on, set Apple Foundation Models to **Prefer simple** and run **Test Apple Models** in Settings. On macOS 27, run `sudo fm license` once to enable the faster `fm` backend and image prompts. Only short, self-contained helper prompts go to the on-device model; real coding work still uses the agent you connected.
3. **Add repositories.** Point Anvil at local checkouts or clone from GitHub or Azure DevOps, and let indexing finish.
4. **Other connections (optional).** Add an Azure DevOps token, a Linear API key or a Jira token for work items, and a Confluence token, Notion, or your Linear connection for docs.

Everything is stored on your machine and there's no required server. Deleting the app's data folder resets it completely. If you turn on the optional Cloud Workbench, Anvil connects to the Anvil Cloud endpoint you set up; its token is encrypted locally, and the remote run state lives on that service.

## Nice to have

- A [Nerd Font](https://www.nerdfonts.com/), such as MesloLGS NF or Hack Nerd Font, so the built-in terminal draws prompt icons properly.
- The mobile companion app in `anvil-app/mobile` and the Raycast extension in `anvil-app/raycast/anvil`. Both pair with a running copy of the desktop app. See [Companion surfaces](/docs/desktop/companion-surfaces).

## Read next

- [Operating guide](/docs/desktop/operating-guide) for the day-to-day loop.
- [Chat, personas and models](/docs/desktop/chat-personas-and-llm) to set up models.
- [Troubleshooting](/docs/desktop/troubleshooting) if something won't start.
