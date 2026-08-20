---
title: Troubleshooting
navTitle: Troubleshooting
description: Diagnose native module failures, LLM connection problems, indexing issues, and terminal rendering glitches in Anvil Desktop.
product: Anvil Desktop
section: Assurance
journey: reference
order: 121
---

# Troubleshooting

Most Anvil Desktop problems fall into one of four buckets: native modules, LLM connectivity, repository indexing, or the terminal. Work through the matching section before filing an issue.

## Native modules (`better-sqlite3`, `node-pty`)

These two dependencies compile against either the system Node or the Electron runtime, and a mismatch is the most common source of startup failures after dependency or Node version changes.

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| App crashes at startup with a `NODE_MODULE_VERSION` mismatch error | Native modules built for the wrong runtime | `pnpm install` (postinstall rebuilds for Node), then `pnpm dev` (prebuild step rebuilds for Electron) |
| `pnpm test` fails to load `better-sqlite3` | Modules were last rebuilt for Electron, not Node | `pnpm run rebuild:native:node`, or just rerun `pnpm test` (the pretest hook does this) |
| Install fails compiling native code | Missing C/C++ toolchain | Install Xcode Command Line Tools / VS Build Tools / `build-essential` per [Installation](/docs/desktop/installation) |

The rule of thumb: if native behavior looks strange after touching dependencies or Node, rerun `pnpm install` before blaming the app.

## LLM connection problems

- **OpenAI chat returns auth errors**: re-enter the API key in Settings. Keys saved there are stored encrypted in the local SQLite database, so an OS keychain reset or a copied database will invalidate them.
- **Azure AI Foundry requests fail**: check `~/.codex/config.toml`, the configured `base_url`, the selected model/deployment name, and the environment variable named by `env_key`.
- **Features are greyed out**: most AI surfaces require a configured LLM provider. The connector setup flow can be re-run from Settings.
- **Apple Foundation Models test fails**: confirm the Mac is running macOS 26 or later, supports Apple Intelligence, has Apple Intelligence enabled, and has an installed Swift toolchain that can import `FoundationModels`.
- **Simple prompts still use the configured backend**: that is expected when the on-device classifier says the prompt needs tools, repo context, files, web access, or deeper reasoning. The local route is intentionally conservative.
- **Apple Foundation Models works but chat still requires Codex**: current chat sessions are still created through the Codex-backed Anvil chat path before local routing is attempted. Install and authenticate the Codex CLI for agentic chat.

## Repository indexing

- **Indexing never completes on a large repo**: indexing walks the working tree; very large repos or repos with huge generated directories take longer. Make sure generated output is in `.gitignore`, which indexing respects.
- **Git operations fail**: Anvil shells out through `simple-git` against your local Git. Confirm `git` works in a terminal for the same repo (credentials, SSH agent, proxy) before assuming an app bug.
- **Cloning from GitHub or Azure DevOps fails**: the connector token needs repo read scope; for Azure DevOps the PAT must include Code (Read).

## Terminal and editor

- **Broken glyphs or misaligned prompt**: install a [Nerd Font](https://www.nerdfonts.com/) and select it for your shell; the embedded xterm.js terminal renders powerline glyphs only when the font supports them.
- **Terminal does not start**: this is `node-pty` territory; see the native modules table above.

## Database

The app stores everything in a local SQLite database (WAL mode). Schema migrations run automatically at startup.

- **App refuses to start after an upgrade**: check the console output for a migration error. Migrations are incremental and never rewritten, so a failure usually means the database file was modified outside the app.
- **Starting fresh**: quitting the app and removing its data directory resets all state, including encrypted credentials and chat history. There is no cloud copy; export anything you need first.

## Still stuck?

Open an issue at [anvil-stack](https://github.com/anthonyhumphreys/anvil-stack/issues) with the app version, OS, and the exact error text. Console output from `pnpm dev` is the most useful artifact for startup problems.
