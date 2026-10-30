---
title: Install Mezair Desktop
navTitle: Installation
description: Download a release build or build from source, then get through the first launch.
product: Mezair Desktop
section: Start here
journey: build
order: 20
---

# Install Mezair Desktop

You can download a ready-made build or build the app from source. Either way you end up at the same first-launch setup.

## Download a release

Builds are attached to the `app-v*` releases in the [mezair repository](https://github.com/anthonyhumphreys/mezair/releases).

### macOS

1. Download the latest [DMG for Apple silicon](https://github.com/anthonyhumphreys/mezair/releases/latest/download/Mezair-latest-arm64.dmg) and `Mezair-macos-arm64.sha256` from the same release.
2. In Terminal, move to the download folder and verify the DMG:

   ```bash
   grep '  Mezair-latest-arm64.dmg$' Mezair-macos-arm64.sha256 | shasum -a 256 -c -
   ```

   Continue only if the result says `OK`.
3. Open the disk image and drag Mezair into Applications.
4. Open Mezair from Applications.

> **About signed builds**
>
> Check the release notes. They state whether that build is signed and notarised. Unsigned internal builds may be blocked by Gatekeeper. For private testing only, follow the release note's quarantine-removal instruction after verifying the checksum. Removing quarantine does not sign or notarise the app. Never use that step to make an unverified download appear safe.
>
> [Sponsoring Mezair on GitHub](https://github.com/sponsors/anthonyhumphreys) helps pay for the Apple Developer membership.

Automatic updates are switched off for macOS builds for now, so check the releases page for new versions.

### Windows and Linux

Each release also includes Windows x64 installers and portable executables, and Linux x64 AppImage, deb and pacman packages. Download the one you need from the [releases page](https://github.com/anthonyhumphreys/mezair/releases) and check it against the checksum file next to it. If a brand-new release is missing your platform, its build is probably still running; check back shortly.

> **Note: Using LLMGateway**
>
> LLMGateway agents run through Codex, so you need Codex installed. In Mezair's LLMGateway setup, choose **Install coding engine** and Mezair installs and manages it for you. Codex edits files and runs commands on your machine; LLMGateway provides the models and bills you for them.
>
> You don't need a ChatGPT login or subscription. Connect your LLMGateway account or API key instead.

## Build from source

You'll need:

- Node.js 22.13.0 or later
- pnpm 10 (run `corepack enable` to get it)
- A C/C++ toolchain for the native modules (`better-sqlite3` and `node-pty`):
  - macOS: Xcode Command Line Tools (`xcode-select --install`)
  - Windows: Visual Studio Build Tools with the "Desktop development with C++" workload
  - Linux: `build-essential`, `python3` and `libsecret-1-dev`
- Git 2.30 or later

```bash
git clone https://github.com/anthonyhumphreys/mezair.git
cd mezair/mezair-app

# Build the local Cloud and Registry CLI packages first
node ../.github/scripts/prepare-desktop-clis.mjs
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

You can start locally without a Mezair account. Setup has three short steps:

1. **Choose your starting tools.** Pick the kind of work you do. This changes the initial navigation, not what you are allowed to use. Change your role or show all tools in Settings later.
2. **Connect a coding agent, or choose Set up later.** Use your Codex, Cursor or Devin subscription, or connect OpenAI, Azure AI Foundry or LLMGateway. A coding agent is needed for chat and coding tasks; you can browse repositories before connecting one. Any API keys you save are encrypted on your machine.
3. **Choose whether to use Sync.** Select **Continue without Sync** to work on this device. Sync is optional and has separate hosting and account setup.

Next, create a workspace and add a local repository or clone one. A workspace groups the repositories and conversations for a piece of work. Let indexing finish, then try a small task on a repository you know.

### Connect more tools when you need them

You do not need to configure everything before your first task. Settings lets you add more agent accounts, choose models, and connect Azure DevOps, Linear or Jira for work items. Connect Confluence, Notion or Linear for documents when your work needs them.

For LLMGateway, Mezair offers **Install coding engine** during setup. It uses Codex to edit files and run commands, while LLMGateway supplies and bills for the models. A ChatGPT subscription is not required.

### Optional on-device helpers

On macOS 26 or later with Apple Intelligence enabled, **Settings → AI connections & models → Local model** can route short helper prompts to Apple Foundation Models. Coding work still uses your chosen agent. Leave this off to start; the settings panel explains the platform requirements and test options.

Your repositories, settings and chat history are stored locally. Coding agents send the context they need to your chosen model provider, and optional integrations contact their services. Deleting the app's data folder resets it completely. If you turn on the optional Cloud Workbench, Mezair connects to the Mezair Cloud endpoint you set up; its token is encrypted locally, and the remote run state lives on that service.

## Nice to have

- A [Nerd Font](https://www.nerdfonts.com/), such as MesloLGS NF or Hack Nerd Font, so the built-in terminal draws prompt icons properly.
- The mobile companion app in `mezair-app/mobile` and the Raycast extension in `mezair-app/raycast/mezair`. Both pair with a running copy of the desktop app. See [Companion surfaces](/docs/desktop/companion-surfaces).

## Read next

- [Operating guide](/docs/desktop/operating-guide) for the day-to-day loop.
- [Chat, personas and models](/docs/desktop/chat-personas-and-llm) to set up models.
- [Troubleshooting](/docs/desktop/troubleshooting) if something won't start.
