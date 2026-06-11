---
title: CLI
description: Install and use the Anvil command-line client for package decisions, lockfile scans, reports, overrides, and operations.
product: Anvil Registry
section: Getting started
order: 3
---

# CLI

The Anvil CLI is the `anvil` command-line client in `apps/cli`. Use it to inspect package decisions before install, scan lockfiles, warm the registry cache, request analysis, review reports, manage overrides, and check gateway health.

The CLI is a client. It does not run Anvil Registry by itself. Package decision commands require a running gateway, and protected operator commands require an Admin service plus an admin token. Tiny detail, large difference; otherwise you have installed a very confident phone with nobody on the other end.

## Prerequisites

- Node.js 22.
- An Anvil Registry gateway, local or remote.
- An admin token for commands that read or mutate protected operator state.

## Install from npm

Install the published CLI globally:

```bash
npm install --global @anvilstack/cli
```

Or run it without a global install:

```bash
npx @anvilstack/cli doctor
```

Then point it at a gateway:

```bash
export ANVIL_REGISTRY_URL=http://localhost:4873
anvil doctor
```

If you do not have a gateway yet, start one with Docker Compose from the repository:

```bash
git clone https://github.com/anthonyhumphreys/anvil-registry.git
cd anvil-registry
docker compose -f infra/docker/docker-compose.yml up -d --build gateway worker admin
```

The local gateway listens on `http://localhost:4873`; Admin listens on `http://localhost:3000`; the local admin token defaults to `local-dev-token`.

For the full local setup, see [Quickstart](/docs/registry/quickstart). For hosted infrastructure, see [Deployment](/docs/registry/deploy).

## Run from the repository

Use this when developing the CLI itself.

Install workspace dependencies with lifecycle scripts disabled:

```bash
pnpm install --ignore-scripts
```

Run the CLI through the workspace package:

```bash
ANVIL_REGISTRY_URL=http://localhost:4873 pnpm --filter @anvilstack/cli dev -- doctor
ANVIL_REGISTRY_URL=http://localhost:4873 pnpm --filter @anvilstack/cli dev -- explain react@latest
```

Build the CLI when you want the compiled entrypoint:

```bash
pnpm --filter @anvilstack/cli build
node apps/cli/dist/index.js doctor
```

## Link the `anvil` command locally

For a local shell command, build the package and link it:

```bash
pnpm --filter @anvilstack/cli build
pnpm --dir apps/cli link --global
```

Then run:

```bash
ANVIL_REGISTRY_URL=http://localhost:4873 anvil doctor
```

To remove the local development link later:

```bash
pnpm --global remove @anvilstack/cli
```

## Configure endpoints

Most commands talk to the gateway:

```bash
export ANVIL_REGISTRY_URL=http://localhost:4873
```

If `ANVIL_REGISTRY_URL` is not set, the CLI falls back to `PUBLIC_BASE_URL`, then `http://localhost:4873`.

Admin-facing commands use the Next.js Admin service URL:

```bash
export ANVIL_ADMIN_URL=http://localhost:3000
```

If `ANVIL_ADMIN_URL` is not set, the CLI uses `http://localhost:3000`.

Admin-gated commands read `ANVIL_ADMIN_TOKEN`, falling back to `ADMIN_TOKEN`:

```bash
export ANVIL_ADMIN_TOKEN=local-dev-token
```

Keep this token out of committed shell scripts and CI logs. It is small, sharp, and entirely uninterested in your excuses.

## Check the gateway

Use `doctor` before routing installs through the gateway:

```bash
anvil doctor
```

It checks:

- `GET /-/health`
- `GET /-/ready`
- `GET /-/anvil/policy`

The command exits with `0` only when health and readiness pass.

## Explain one package

```bash
anvil explain react@latest
anvil explain @tanstack/react-query@latest
```

`explain` posts to `/-/anvil/explain`, prints the policy decision, reasons, analysis summary, LLM review summary when present, and any active override.

Exit behaviour:

| Decision | Exit code |
| --- | --- |
| `allow` | `0` |
| `warn` | `0` |
| `quarantine` | `0` |
| `block` | `1` |

Use `scan` when quarantine should fail a lockfile gate.

## Scan lockfiles

Scan exact dependency versions from lockfiles:

```bash
anvil scan package-lock.json
anvil scan pnpm-lock.yaml
anvil scan yarn.lock
```

Supported inputs:

| File | Behaviour |
| --- | --- |
| `package-lock.json` | Reads resolved package versions from npm lockfile data. |
| `pnpm-lock.yaml` | Reads package keys from the pnpm lockfile package section. |
| `yarn.lock` | Reads package entries and resolved versions where available. |

Queue static analysis for risky or not-yet-reviewed versions:

```bash
anvil scan pnpm-lock.yaml --queue-analysis
```

`scan` exits with `1` when any scanned package is blocked or quarantined. Warnings are printed but do not fail the command.

## Warm cache and analysis

Use `warm` before a team or CI fleet switches registry traffic:

```bash
ANVIL_REGISTRY_URL=http://localhost:4873 \
ANVIL_ADMIN_TOKEN=local-dev-token \
  anvil warm ./seed-lockfiles/package-lock.web.json
```

`warm` fetches package metadata through the gateway and queues analysis for every resolved package version in the lockfile. It does not approve packages or create a bypass.

Watch the queue:

```bash
anvil queue status
```

## Smoke test the gateway

Run a basic gateway smoke check:

```bash
anvil smoke
anvil smoke is-number
```

The smoke command checks gateway health/readiness, fetches metadata, verifies tarball URL rewriting through Anvil, fetches the tarball, and optionally checks Admin health when `ANVIL_ADMIN_URL` is set.

## Manage overrides

Create explicit audited overrides:

```bash
anvil approve suspicious-pkg@1.2.3 \
  --reason "reviewed package source and install script" \
  --approved-by security-review \
  --expires-at 2026-06-20T00:00:00Z
```

By default, `approve` creates an `allow` override. To create a different action:

```bash
anvil approve suspicious-pkg@1.2.3 \
  --action quarantine \
  --reason "allow local review but keep CI blocked" \
  --approved-by security-review
```

Revoke an override:

```bash
anvil revoke suspicious-pkg@1.2.3 --revoked-by security-review
```

List overrides:

```bash
anvil overrides --limit 20
anvil overrides --target suspicious-pkg@1.2.3
anvil overrides --package suspicious-pkg --version 1.2.3
```

Review audit events:

```bash
anvil audit-events --limit 20
anvil audit-events --target suspicious-pkg@1.2.3
```

Override commands require `ANVIL_ADMIN_TOKEN` or `ADMIN_TOKEN`.

## Request LLM review

When LLM review is enabled, request reviewer context for a package:

```bash
anvil llm-review package@1.2.3 --requested-by security-review --priority high
```

This queues review work. It does not allow a package, and deterministic policy remains the enforcement authority.

For provider setup, local smoke testing, and private-package controls, see [LLM integration](/docs/registry/llm-integration).

## Inspect analysis reports

Fetch the latest matching analysis report:

```bash
anvil reports package@1.2.3
```

Narrow by immutable identity:

```bash
anvil reports package@1.2.3 \
  --integrity sha512-example \
  --shasum abc123 \
  --analyser static-v1
```

Compare two reports for the same package version:

```bash
anvil reports compare package@1.2.3 \
  --left-integrity sha512-old \
  --right-integrity sha512-new
```

Report commands use `ANVIL_ADMIN_URL` and require an admin token. They read the Admin service JSON route handlers; the browser console shows the same evidence with friendlier tables and package detail pages.

## Review Node Base reports

List submitted Anvil Node Base reports:

```bash
anvil node-base reports --limit 20
anvil node-base reports --type lifecycle
anvil node-base reports --type ioc --risk high
```

Fetch one report by id:

```bash
anvil node-base report <id>
```

The command exits with `1` when a listed or fetched Node Base report contains high-risk findings.

## Manage the popular package index

Inspect the active popular package index:

```bash
anvil popular-index show
```

Upload a generated index:

```bash
anvil popular-index upload popular-index.json \
  --generated-at 2026-05-20T00:00:00Z \
  --uploaded-by security-review
```

The popular package index helps name-squatting checks compare low-adoption package names against known popular packages.
You can inspect and upload the same index through the Admin console at `/popular-package-index`.

## Test policy against package.json

Use `policy test` for a quick dependency-name check:

```bash
anvil policy test package.json
```

This reads dependency names from `package.json` and asks the gateway about the latest resolvable versions. For exact installed versions, use `anvil scan <lockfile>` instead.

## CI examples

Scan an npm lockfile in CI:

```bash
export ANVIL_REGISTRY_URL=https://npm.example.com
export ANVIL_ADMIN_TOKEN="${ANVIL_ADMIN_TOKEN}"

npm install --global @anvilstack/cli
anvil doctor
anvil scan package-lock.json --queue-analysis
```

If you prefer not to install globally:

```bash
npx @anvilstack/cli doctor
npx @anvilstack/cli scan package-lock.json --queue-analysis
```

Use `npm ci --ignore-scripts` or Anvil Node Base safe mode for the actual install. The CLI reviews and warms dependency decisions; it is not a replacement package manager.

## Publish the CLI

The npm package is `@anvilstack/cli` and exposes the `anvil` binary. Publishing requires access to the `@anvilstack` npm scope.

From the repository:

```bash
npm whoami
pnpm --filter @anvilstack/cli build
pnpm --filter @anvilstack/cli test
pnpm --filter @anvilstack/cli publish --access public
```

Before publishing a release, verify that the npm README still points users at the gateway setup docs and that `anvil doctor` works against a local Compose gateway.

## Command reference

```text
anvil doctor
anvil explain package@version
anvil scan package-lock.json [--queue-analysis]
anvil scan pnpm-lock.yaml [--queue-analysis]
anvil scan yarn.lock [--queue-analysis]
anvil warm package-lock.json
anvil warm yarn.lock
anvil smoke [package]
anvil approve package@version --reason "intentional dependency" [--approved-by reviewer] [--expires-at 2026-06-20T00:00:00Z]
anvil revoke package@version [--revoked-by reviewer]
anvil llm-review package@version [--requested-by reviewer] [--priority high]
anvil queue status
anvil overrides [--target package@version] [--package package] [--version version] [--limit 20]
anvil audit-events [--target package@version] [--limit 20]
anvil popular-index show
anvil popular-index upload popular-index.json [--generated-at 2026-05-20T00:00:00Z]
anvil reports package@version [--integrity sha512-...] [--shasum ...] [--analyser static-v1]
anvil reports compare package@version [--left-integrity sha512-old] [--right-integrity sha512-new]
anvil node-base reports [--type dependency|lifecycle|ioc|network] [--risk risky|high|medium] [--limit 20]
anvil node-base report <id>
anvil policy test package.json
```
