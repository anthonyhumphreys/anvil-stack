---
title: Contributing to Anvil Registry
navTitle: Contributing
description: Development setup, workspace commands, and review expectations for Anvil Registry and Anvil Node Base.
product: Anvil Registry
section: Project
order: 20
---

# Contributing to Anvil Registry

Anvil Registry and Anvil Node Base are open source and accept contributions. The project is alpha, so sharp edges are expected. Honest documentation of limitations is preferred over optimistic silence.

## Development setup

Requirements:

- Node.js 22 LTS
- pnpm 9+
- Docker and Docker Compose (for local stack)
- Git

Clone and install:

```bash
git clone https://github.com/anthonyhumphreys/anvil-registry.git
cd anvil-registry
pnpm install --ignore-scripts
```

The `--ignore-scripts` flag avoids running lifecycle scripts during development. This is intentional: Anvil is a security project, and we should eat our own cooking.

## Workspace structure

```txt
apps/gateway      # Fastify npm proxy
apps/worker       # Background analysis
apps/admin        # Next.js admin UI
apps/cli          # Command-line client
packages/         # Shared packages
infra/docker      # Docker Compose local stack
infra/sst         # AWS SST deployment
devcontainer-base # Anvil Node Base image
```

## Common commands

```bash
pnpm install --ignore-scripts    # Install dependencies
pnpm lint                        # ESLint across packages
pnpm typecheck                   # TypeScript checks
pnpm test                        # Vitest suite
pnpm build                       # Build all packages
pnpm smoke:local                 # Full local stack smoke test
pnpm smoke:clients               # npm client routing smoke test
pnpm smoke:analysis              # Analysis pipeline smoke test
```

## Before changing code

1. Read `docs/anvil-registry-spec.md` for the relevant surface.
2. Read `docs/anvil-node-base-spec.md` for Node Base changes.
3. Keep changes scoped to one concern.
4. Add or update tests for policy, analysis, routing, or CLI behaviour.
5. Update docs in the same change.

## Before opening a PR

Run the relevant checks:

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
docker compose -f infra/docker/docker-compose.yml config
```

If a command is not yet available, add a sensible script or explain why it is not applicable.

## Review priorities

When reviewing code, check in this order:

1. Correctness.
2. Security.
3. Auth and access control, when auth exists.
4. Data integrity.
5. Accessibility for UI work.
6. Production risk.

Then:

7. Maintainability.
8. Readability.
9. Performance.
10. Developer experience.

Prefer concrete fixes over decorative commentary.

## Security research

If you are researching security vulnerabilities in Anvil Registry:

- Do not test against public registries without permission.
- Do not exploit the gateway, worker, or admin surfaces against real users.
- Report vulnerabilities through the process described in `SECURITY.md`.
- Safe local research in your own Docker Compose stack is encouraged.

## Documentation rules

- Update `README.md` for top-level orientation changes.
- Update `apps/cli/README.md` for CLI command changes.
- Update `devcontainer-base/README.md` for Node Base helper changes.
- Update `../anvil-website/content/docs/registry/*.md` for public operator docs.
- Update `../anvil-website/content/docs/node-base/*.md` for Node Base public docs.

## Commit style

Use Conventional Commits:

```txt
feat(gateway): add scoped upstream registry support
fix(worker): handle tarballs with unicode filenames
docs: explain policy reason codes in CLI output
test(policy-engine): add test for dependency addition in patch version
```

Keep scopes tied to the component: `gateway`, `worker`, `admin`, `cli`, `policy-engine`, `package-analysis`, `node-base`, etc.

## Read next

- [Security](/docs/registry/security)
- [Open source posture](/docs/project/open-source)
