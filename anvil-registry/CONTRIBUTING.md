# Contributing To Anvil Registry

Thanks for helping with Anvil Registry and Anvil Node Base.

This repository is an alpha security project. Contributions should be practical, well-scoped, and honest about what is implemented today. Please do not turn early behavior into brochure copy.

## Project Shape

The repo contains:

- `apps/gateway`: Fastify npm registry proxy and operator routes.
- `apps/worker`: background package analysis worker.
- `apps/admin`: Next.js Admin UI and route-handler JSON API.
- `apps/cli`: `anvil` command-line client.
- `packages/*`: shared TypeScript packages for policy, analysis, persistence, storage, queueing, config, logging, and registry access.
- `devcontainer-base`: hardened Node 22 base image and install/report helper scripts.
- `infra/docker`: local Docker Compose stack.
- `infra/sst`: AWS/SST deployment.
- `docs`: source specs and repo documentation map.

## Setup

Install dependencies with lifecycle scripts disabled:

```bash
pnpm install --ignore-scripts
```

Run focused checks for your change:

```bash
pnpm typecheck
pnpm test
pnpm build
```

For Docker Compose configuration:

```bash
docker compose -f infra/docker/docker-compose.yml config
```

For the docs site:

```bash
pnpm --dir ../anvil-website build
pnpm --dir ../anvil-website typecheck
```

Run the site build before standalone typecheck because Next.js generates route type files during build. Tiny framework paperwork tax. Paid in full.

## Development Rules

- Keep changes small and focused.
- Preserve the existing package boundaries unless the task genuinely requires reshaping them.
- Use TypeScript, Zod validation, Fastify for the gateway, Pino logging, Vitest tests, and pnpm workspace patterns.
- Keep provider-specific infrastructure behind adapters.
- Do not add dependencies unless they earn their keep.
- Do not run dependency install scripts unless explicitly approved.
- Do not implement full auth unless the task asks for it.

## Security Rules

- Deterministic policy is the enforcement authority.
- LLM review may explain or summarize risk, but must never be the sole reason a package is allowed.
- Do not send private package source to an LLM unless explicitly enabled.
- Cache analysis and policy decisions by immutable package identity: package name, version, tarball integrity or hash, analysis engine version, and policy version.
- Lifecycle scripts must not execute unless the user explicitly opts into observed mode or another approved path.
- CI and production modes should fail closed where policy enforcement matters.
- Overrides must be explicit, audited, reasoned, and preferably expiring.
- Admin tokens, private registry tokens, report payloads, and readiness output must not leak secrets.

## Documentation Rules

Update docs with behaviour changes. Use:

- `README.md` for top-level orientation.
- `docs/README.md` for the docs map.
- `docs/anvil-registry-spec.md` and `docs/anvil-node-base-spec.md` for product intent.
- `../anvil-website/content/docs/registry/*.md` and `../anvil-website/content/docs/node-base/*.md` for public operator/user docs.
- `devcontainer-base/README.md` for image helper behaviour.
- `apps/cli/README.md` for CLI package guidance.

Good docs here are concrete: commands, endpoints, environment variables, policy decisions, failure modes, and known alpha limits. Avoid unsupported maturity claims, vague security guarantees, and "enterprise-grade" confetti.

## Pull Requests

Pull requests should include:

- What changed.
- Why it changed.
- Files or areas touched.
- Commands run.
- Known gaps, stubs, or alpha limitations.

For code changes, include tests where practical. For docs-only changes, a relevant build or typecheck is usually enough.

## Reporting Security Issues

Follow `SECURITY.md`. If the issue has exploitable impact, report it privately before opening a public issue or pull request.
