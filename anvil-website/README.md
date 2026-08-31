# Anvil Website

This is the standalone Next.js website for the Anvil open source projects:

- **Anvil Desktop**, a local workspace for repo-aware agent delivery work.
- **Anvil Registry**, an npm registry gateway for dependency policy and analysis.
- **Anvil Node Base**, a hardened Node devcontainer image for safer installs.
- **Anvil Cloud**, a local-first runtime and adapter toolchain for typed Cells, Agents, generated manifests, and inspectable deployment plans.

The site is markdown-first. Product documentation lives in `content/docs`, is grouped by product folder, and is rendered through the generated docs route. Write for OSS users who want to clone the repo, run the tools, inspect the boundaries, and decide whether the current alpha surface is useful.

## Local Development

Install dependencies with lifecycle scripts disabled:

```bash
pnpm install --ignore-scripts
```

Run the site:

```bash
pnpm dev
```

Validate before publishing:

```bash
pnpm build
pnpm typecheck
```

## Documentation

Docs are discovered from Markdown frontmatter:

```yaml
title: Anvil Desktop
navTitle: Overview
description: The local desktop workspace for repo-aware agent delivery work.
product: Anvil Desktop
section: Basics
order: 100
```

Use concrete commands, architecture, setup paths, and honest alpha notes. If a claim needs a receipt, put the receipt in the docs.

## Public Links

Repository links can be configured with:

```bash
NEXT_PUBLIC_ANVIL_APP_REPO_URL=https://github.com/your-org/anvil-app
NEXT_PUBLIC_ANVIL_REGISTRY_REPO_URL=https://github.com/your-org/anvil-registry
NEXT_PUBLIC_ANVIL_CLOUD_REPO_URL=https://github.com/your-org/anvil-cloud
ANVIL_UPDATE_ORIGIN=https://anvil-desktop-updates.example.workers.dev
```

## Status

The website is the public home for Anvil's OSS work. Keep it sharp, readable, and allergic to vendor theatre.
