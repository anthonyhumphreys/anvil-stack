# Mezair Website

This is the standalone Next.js website for the Mezair open source projects:

- **Mezair Desktop**, a local workspace for repo-aware agent delivery work.
- **Mezair Registry**, an npm registry gateway for dependency policy and analysis.
- **Mezair Node Base**, a hardened Node devcontainer image for safer installs.
- **Mezair Cloud**, a local-first runtime and adapter toolchain for typed Cells, Agents, generated manifests, and inspectable deployment plans.

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
title: Mezair Desktop
navTitle: Overview
description: The local desktop workspace for repo-aware agent delivery work.
product: Mezair Desktop
section: Basics
order: 100
```

Use concrete commands, architecture, setup paths, and honest alpha notes. If a claim needs a receipt, put the receipt in the docs.

## Public Links

Repository links can be configured with:

```bash
NEXT_PUBLIC_MEZAIR_APP_REPO_URL=https://github.com/your-org/mezair-app
NEXT_PUBLIC_MEZAIR_REGISTRY_REPO_URL=https://github.com/your-org/mezair-registry
NEXT_PUBLIC_MEZAIR_CLOUD_REPO_URL=https://github.com/your-org/mezair-cloud
```

## Staging and Production

`MEZAIR_DEPLOYMENT_ENV` selects the WorkOS and hosted backend used by the site. It accepts only
`staging` or `production`; when unset it defaults to `staging` for existing local and staging
deployments. It is independent of `NODE_ENV` and `VERCEL_ENV`, so a Vercel production slot can
continue serving the staging WorkOS and Cloudflare backend until the production services are ready.

Configure the selected environment's `MEZAIR_STAGING_*` or `MEZAIR_PRODUCTION_*` variables from
`.env.example`. Production builds require all production WorkOS and backend values, reject WorkOS
staging API keys, and never fall back to the legacy unscoped or staging variables. The production
WorkOS redirect URI and backend origin must use HTTPS. Keep separate build-time values per
environment: Next.js embeds the public WorkOS redirect URI when the site is built.

The existing unscoped variables (`WORKOS_API_KEY`, `WORKOS_CLIENT_ID`,
`WORKOS_COOKIE_PASSWORD`, `NEXT_PUBLIC_WORKOS_REDIRECT_URI`, `MEZAIR_BACKEND_ORIGIN`,
`MEZAIR_HOSTED_KEY_ID`, and `MEZAIR_HOSTED_SERVICE_SECRET`) remain staging-only fallbacks for older
local and staging deployments. Migrate the current WorkOS and Cloudflare credentials into the
staging-scoped names when convenient.

## Status

The website is the public home for Mezair's OSS work. Keep it sharp, readable, and allergic to vendor theatre.
