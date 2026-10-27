---
title: Registry CLI
navTitle: CLI
description: Install and use Mezair Registry commands for package decisions, lockfile scans, reports, overrides, and operations.
product: Mezair Registry
section: Guides
journey: build
order: 30
---

# Registry CLI

The normal user-facing command is `mezair registry ...` through the umbrella
`@mezairstack/cli` package. Use it to inspect package decisions before install,
scan lockfiles, warm the registry cache, request analysis, review reports,
manage overrides, and check gateway health.

The product package is `@mezairstack/registry-cli` and the direct binary is
`mezair-registry`. The wrapper dispatches to that binary, so these are
equivalent when both packages are installed:

```bash
mezair registry doctor
mezair-registry doctor
```

Use `mezair registry ...` in normal docs, tutorials, and shell usage. Use
`mezair-registry ...` when you are testing the package directly, debugging the
wrapper, or writing package-specific CI.

The CLI connects to a running Registry gateway. Start with the [quickstart](/docs/registry/quickstart) if you haven't set one up. Protected operator commands also need the Admin service and an admin token.

## Prerequisites

- Node.js 22.
- A Mezair Registry gateway, local or remote.
- An admin token for commands that read or mutate protected operator state.

## Install from npm

Install the umbrella CLI and the Registry product CLI globally:

```bash
npm install --global @mezairstack/cli
npm install --global @mezairstack/registry-cli
```

Or run it without a global install:

```bash
npx @mezairstack/registry-cli doctor
```

Then point it at a gateway:

```bash
export MEZAIR_REGISTRY_URL=http://localhost:4873
mezair registry doctor
```

If you do not have a gateway yet, start one with Docker Compose from the repository:

```bash
git clone https://github.com/anthonyhumphreys/mezair-stack.git
cd mezair-stack/mezair-registry
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
MEZAIR_REGISTRY_URL=http://localhost:4873 pnpm --filter @mezairstack/registry-cli dev -- doctor
MEZAIR_REGISTRY_URL=http://localhost:4873 pnpm --filter @mezairstack/registry-cli dev -- explain react@latest
```

Build the CLI when you want the compiled entrypoint:

```bash
pnpm --filter @mezairstack/registry-cli build
node apps/cli/dist/index.js doctor
```

## Link the `mezair-registry` command locally

For a local shell command, build the package and link it:

```bash
pnpm --filter @mezairstack/registry-cli build
pnpm --dir apps/cli link --global
```

Then run:

```bash
MEZAIR_REGISTRY_URL=http://localhost:4873 mezair registry doctor
```

To remove the local development link later:

```bash
pnpm --global remove @mezairstack/registry-cli
```

## Configure endpoints

Most commands talk to the gateway:

```bash
export MEZAIR_REGISTRY_URL=http://localhost:4873
```

If `MEZAIR_REGISTRY_URL` is not set, the CLI falls back to `PUBLIC_BASE_URL`, then `http://localhost:4873`.

Admin-facing commands use the Next.js Admin service URL:

```bash
export MEZAIR_ADMIN_URL=http://localhost:3000
```

If `MEZAIR_ADMIN_URL` is not set, the CLI uses `http://localhost:3000`.

Admin-gated commands read `MEZAIR_ADMIN_TOKEN`, falling back to `ADMIN_TOKEN`:

```bash
export MEZAIR_ADMIN_TOKEN=local-dev-token
```

Keep this token out of committed shell scripts and CI logs. It is small, sharp, and entirely uninterested in your excuses.

## Check the gateway

Use `doctor` before routing installs through the gateway:

```bash
mezair registry doctor
```

It checks:

- `GET /-/health`
- `GET /-/ready`
- `GET /-/mezair/policy`

The command exits with `0` only when health and readiness pass.

## Explain one package

```bash
mezair registry explain react@latest
mezair registry explain @tanstack/react-query@latest
```

`explain` posts to `/-/mezair/explain`, prints the policy decision, reasons, analysis summary, LLM review summary when present, and any active override.

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
mezair registry scan package-lock.json
mezair registry scan pnpm-lock.yaml
mezair registry scan yarn.lock
```

Supported inputs:

| File | Behaviour |
| --- | --- |
| `package-lock.json` | Reads resolved package versions from npm lockfile data. |
| `pnpm-lock.yaml` | Reads package keys from the pnpm lockfile package section. |
| `yarn.lock` | Reads package entries and resolved versions where available. |

Queue static analysis for risky or not-yet-reviewed versions:

```bash
mezair registry scan pnpm-lock.yaml --queue-analysis
```

`scan` exits with `1` when any scanned package is blocked or quarantined. Warnings are printed but do not fail the command.

## Warm cache and analysis

Use `warm` before a team or CI fleet switches registry traffic:

```bash
MEZAIR_REGISTRY_URL=http://localhost:4873 \
MEZAIR_ADMIN_TOKEN=local-dev-token \
  mezair registry warm ./seed-lockfiles/package-lock.web.json
```

`warm` fetches package metadata through the gateway and queues analysis for every resolved package version in the lockfile. It does not approve packages or create a bypass.

Watch the queue:

```bash
mezair registry queue status
mezair registry queue failed --limit 20
```

For BullMQ deployments, retry only the failed job IDs you have inspected. Remove obsolete failures only when they are no longer useful for diagnosis; removal is irreversible and therefore requires `--confirm`. Both mutations are recorded in the Registry audit log.

```bash
mezair registry queue retry 41 42 --requested-by operator
mezair registry queue remove 17 --confirm --requested-by operator
```

## Smoke test the gateway

Run a basic gateway smoke check:

```bash
mezair registry smoke
mezair registry smoke is-number
```

The smoke command checks gateway health/readiness, fetches metadata, verifies tarball URL rewriting through Mezair, fetches the tarball, and optionally checks Admin health when `MEZAIR_ADMIN_URL` is set.

## Manage overrides

Create explicit audited overrides:

```bash
mezair registry approve suspicious-pkg@1.2.3 \
  --reason "reviewed package source and install script" \
  --approved-by security-review \
  --expires-at 2027-06-20T00:00:00Z
```

By default, `approve` creates an `allow` override. To create a different action:

```bash
mezair registry approve suspicious-pkg@1.2.3 \
  --action quarantine \
  --reason "allow local review but keep CI blocked" \
  --approved-by security-review
```

Revoke an override:

```bash
mezair registry revoke suspicious-pkg@1.2.3 --revoked-by security-review
```

List overrides:

```bash
mezair registry overrides --limit 20
mezair registry overrides --target suspicious-pkg@1.2.3
mezair registry overrides --package suspicious-pkg --version 1.2.3
```

Review audit events:

```bash
mezair registry audit-events --limit 20
mezair registry audit-events --target suspicious-pkg@1.2.3
```

Override commands require `MEZAIR_ADMIN_TOKEN` or `ADMIN_TOKEN`.

## Request LLM review

When LLM review is enabled, request reviewer context for a package:

```bash
mezair registry llm-review package@1.2.3 --requested-by security-review --priority high
```

This queues review work. It does not allow a package, and deterministic policy remains the enforcement authority.

For provider setup, local smoke testing, and private-package controls, see [LLM integration](/docs/registry/llm-integration).

## Inspect analysis reports

Fetch the latest matching analysis report:

```bash
mezair registry reports package@1.2.3
```

Narrow by immutable identity:

```bash
mezair registry reports package@1.2.3 \
  --integrity sha512-example \
  --shasum abc123 \
  --analyser static-v1
```

Compare two reports for the same package version:

```bash
mezair registry reports compare package@1.2.3 \
  --left-integrity sha512-old \
  --right-integrity sha512-new
```

Report commands use `MEZAIR_ADMIN_URL` and require an admin token. They read the Admin service JSON route handlers; the browser console shows the same evidence with friendlier tables and package detail pages.

## Review Node Base reports

List submitted Mezair Node Base reports:

```bash
mezair registry node-base reports --limit 20
mezair registry node-base reports --type lifecycle
mezair registry node-base reports --type ioc --risk high
```

Fetch one report by id:

```bash
mezair registry node-base report <id>
```

The command exits with `1` when a listed or fetched Node Base report contains high-risk findings.

## Manage the popular package index

Inspect the active popular package index:

```bash
mezair registry popular-index show
```

Upload a generated index:

```bash
mezair registry popular-index upload popular-index.json \
  --generated-at 2026-05-20T00:00:00Z \
  --uploaded-by security-review
```

The popular package index helps name-squatting checks compare low-adoption package names against known popular packages.
You can inspect and upload the same index through the Admin console at `/popular-package-index`.

## Test policy against package.json

Use `policy test` for a quick dependency-name check:

```bash
mezair registry policy test package.json
```

This reads dependency names from `package.json` and asks the gateway about the latest resolvable versions. For exact installed versions, use `mezair registry scan <lockfile>` instead.

## CI examples

Scan an npm lockfile in CI:

```bash
export MEZAIR_REGISTRY_URL=https://npm.example.com
export MEZAIR_ADMIN_TOKEN="${MEZAIR_ADMIN_TOKEN}"

npm install --global @mezairstack/cli
npm install --global @mezairstack/registry-cli
mezair registry doctor
mezair registry scan package-lock.json --queue-analysis
```

If you prefer not to install globally:

```bash
npx @mezairstack/registry-cli doctor
npx @mezairstack/registry-cli scan package-lock.json --queue-analysis
```

Use `npm ci --ignore-scripts` or Mezair Node Base safe mode for the actual install. The CLI reviews and warms dependency decisions; it is not a replacement package manager.

## Stage the CLI for publishing

The npm package is `@mezairstack/registry-cli` and exposes the `mezair-registry` binary. Publishing requires access to the `@mezairstack` npm scope.

Release publishing is handled by `.github/workflows/publish-registry-cli.yml`
through trusted publishing and npm staged publishing. The workflow runs on
`registry-cli-v*` tags and also supports a manual dry run. It stages the package
with `npm stage publish`; a maintainer must review and approve the staged
package on npm before it becomes publicly available.

From the repository, verify the package before tagging:

```bash
npm whoami
pnpm --filter @mezairstack/registry-cli build
pnpm --filter @mezairstack/registry-cli test
cd apps/cli
npm pack --dry-run
```

Before publishing a release, verify that the npm README still points users at the gateway setup docs and that `mezair registry doctor` works against a local Compose gateway.

## Command reference

```text
mezair registry doctor
mezair registry explain package@version
mezair registry scan package-lock.json [--queue-analysis]
mezair registry scan pnpm-lock.yaml [--queue-analysis]
mezair registry scan yarn.lock [--queue-analysis]
mezair registry warm package-lock.json
mezair registry warm yarn.lock
mezair registry smoke [package]
mezair registry approve package@version --reason "intentional dependency" [--approved-by reviewer] [--expires-at 2027-06-20T00:00:00Z]
mezair registry revoke package@version [--revoked-by reviewer]
mezair registry llm-review package@version [--requested-by reviewer] [--priority high]
mezair registry queue status
mezair registry queue failed [--limit 20]
mezair registry queue retry <job-id> [job-id...] [--requested-by operator]
mezair registry queue remove <job-id> [job-id...] --confirm [--requested-by operator]
mezair registry overrides [--target package@version] [--package package] [--version version] [--limit 20]
mezair registry audit-events [--target package@version] [--limit 20]
mezair registry popular-index show
mezair registry popular-index upload popular-index.json [--generated-at 2026-05-20T00:00:00Z]
mezair registry reports package@version [--integrity sha512-...] [--shasum ...] [--analyser static-v1]
mezair registry reports compare package@version [--left-integrity sha512-old] [--right-integrity sha512-new]
mezair registry node-base reports [--type dependency|lifecycle|ioc|network] [--risk risky|high|medium] [--limit 20]
mezair registry node-base report <id>
mezair registry policy test package.json
```
