# Anvil Website

This is the standalone Next.js website for the Anvil open source projects:

- **Anvil Desktop**, a local workspace for repo-aware agent delivery work.
- **Anvil Registry**, an npm registry gateway for dependency policy and analysis.
- **Anvil Node Base**, a hardened Node devcontainer image for safer installs.
- **Anvil Cloud**, an app platform for typed Cells, local runtime, and adapter-driven deployment.

The site is markdown-first. Product documentation lives in `content/docs`, is grouped by product folder, and is rendered through the generated docs route.

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
```

## Status

The website is the public home for Anvil's OSS work. Keep it sharp, readable, and allergic to vendor theatre.
