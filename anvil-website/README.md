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
```

## Staging and Production

`ANVIL_DEPLOYMENT_ENV` selects the WorkOS and hosted backend used by the site. It accepts only
`staging` or `production`; when unset it defaults to `staging` for existing local and staging
deployments. It is independent of `NODE_ENV` and `VERCEL_ENV`, so a Vercel production slot can
continue serving the staging WorkOS and Cloudflare backend until the production services are ready.

Configure the selected environment's `ANVIL_STAGING_*` or `ANVIL_PRODUCTION_*` variables from
`.env.example`. Production builds require all production WorkOS and backend values, reject WorkOS
staging API keys, and never fall back to the legacy unscoped or staging variables. The production
WorkOS redirect URI and backend origin must use HTTPS. Keep separate build-time values per
environment: Next.js embeds the public WorkOS redirect URI when the site is built.

The existing unscoped variables (`WORKOS_API_KEY`, `WORKOS_CLIENT_ID`,
`WORKOS_COOKIE_PASSWORD`, `NEXT_PUBLIC_WORKOS_REDIRECT_URI`, `ANVIL_BACKEND_ORIGIN`,
`ANVIL_HOSTED_KEY_ID`, and `ANVIL_HOSTED_SERVICE_SECRET`) remain staging-only fallbacks for older
local and staging deployments. Migrate the current WorkOS and Cloudflare credentials into the
staging-scoped names when convenient.

## Status

The website is the public home for Anvil's OSS work. Keep it sharp, readable, and allergic to vendor theatre.
