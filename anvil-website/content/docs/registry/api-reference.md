---
title: API reference
navTitle: API reference
description: Gateway, Admin, health, readiness, explain, policy, override, report, and package endpoint reference for alpha operators.
product: Anvil Registry
section: Operations
order: 10.5
---

# API reference

This page summarizes the alpha HTTP surface that operators, CI jobs, and the CLI use. The CLI wraps most of these routes; call the API directly when you are debugging or integrating a custom workflow.

Local defaults:

| Service | URL |
| --- | --- |
| Gateway | `http://localhost:4873` |
| Admin | `http://localhost:3000` |
| Local admin token | `local-dev-token` |

Protected routes require the admin token. Services prefer `ANVIL_ADMIN_TOKEN` and still accept the legacy `ADMIN_TOKEN` alias; the local Compose stack sets `ADMIN_TOKEN` to `local-dev-token` by default.

## Health

```http
GET /-/health
```

Use this for process liveness. A healthy response means the HTTP service can answer.

Example:

```bash
curl http://localhost:4873/-/health
curl http://localhost:3000/-/health
```

The gateway health route is served by Fastify. The Admin health route is served by the Next.js Admin service.

## Readiness

```http
GET /-/ready
```

Use this before routing install traffic. Readiness should check runtime dependencies such as persistence, object storage, queueing, and upstream registry configuration.

Example:

```bash
curl http://localhost:4873/-/ready
```

Health can pass while readiness fails. That is useful, not a contradiction.

## Metadata

```http
GET /:packageName
GET /@:scope/:packageName
```

Metadata routes return npm-compatible package metadata after Anvil has applied cheap policy checks, filtered versions where configured, rewritten dist-tags, and rewritten tarball URLs through the gateway.

Examples:

```bash
curl http://localhost:4873/react
curl http://localhost:4873/@types/node
```

Package managers encode scoped names differently across requests, so test scoped metadata with real npm-compatible clients as well as `curl`.

## Tarballs

```http
GET /:packageName/-/:tarballName
GET /@:scope/:packageName/-/:tarballName
```

Tarball routes check policy decisions for the resolved package identity, serve cached allowed tarballs when possible, and fetch from upstream when needed.

Blocked or quarantined tarball requests should return useful JSON rather than a mystery failure dressed as package-manager misery.

## Explain

```http
POST /-/anvil/explain
```

Explain returns the current decision and evidence for a package version.

Example payload:

```json
{
  "name": "react",
  "version": "latest"
}
```

Use the CLI for the normal path:

```bash
ANVIL_REGISTRY_URL=http://localhost:4873 anvil registry explain react@latest
```

Explain output should include the decision action, policy version, triggering signals, analysis state, override state, and any review context that is enabled.

## Policy

```http
GET /-/anvil/policy
```

Returns the active policy view for operators and CI tools. Use this to confirm the runtime mode and policy version a decision is using.

CLI example:

```bash
ANVIL_REGISTRY_URL=http://localhost:4873 anvil registry policy
```

## LLM review

```http
POST /-/anvil/llm-review
Authorization: Bearer <admin-token>
Content-Type: application/json
```

Queues optional model review context for one package version or a deduplicated set of targets. The route is available only when LLM review is enabled, and it does not approve packages or bypass deterministic policy.

Example payload:

```json
{
  "name": "react",
  "version": "18.3.1",
  "requestedBy": "security-review",
  "priority": "high"
}
```

CLI example:

```bash
ANVIL_REGISTRY_URL=http://localhost:4873 \
ANVIL_ADMIN_TOKEN=local-dev-token \
  anvil registry llm-review react@18.3.1 --requested-by security-review --priority high
```

See [LLM integration](/docs/registry/llm-integration) for provider setup, schema expectations, and privacy controls.

## Overrides

```http
POST /-/anvil/override
```

Creates an explicit override for a package decision. Overrides should be version-specific, reasoned, audited, and preferably expiring.

Required concepts:

- Package name.
- Version.
- Desired action.
- Human reason.
- Reviewer identity when available.
- Expiry when the override is temporary.

CLI example:

```bash
ANVIL_REGISTRY_URL=http://localhost:4873 \
ANVIL_ADMIN_TOKEN=local-dev-token \
  anvil override approve react@18.3.1 --reason "Reviewed package identity and reports"
```

Do not use overrides as a junk drawer for making CI green. That drawer fills up fast, then catches fire.

## Reports

Analysis reports are available through the Next.js Admin route-handler API:

```http
GET /api/reports?limit=100
GET /api/reports?packageName=react&version=18.3.1
GET /api/reports/:packageName/:version
```

The list route is useful for smokes and operator checks after worker queue processing. The package route returns the latest matching immutable report identity, with optional `integrity`, `shasum`, and `analyser` query filters.

CLI example:

```bash
ANVIL_ADMIN_URL=http://localhost:3000 \
ANVIL_ADMIN_TOKEN=local-dev-token \
  anvil registry reports react@18.3.1
```

Node Base reports can be submitted to Admin so reviewers can inspect local install evidence with registry decisions.

CLI example:

```bash
ANVIL_REGISTRY_URL=http://localhost:4873 \
ANVIL_ADMIN_TOKEN=local-dev-token \
ANVIL_PROJECT_NAME=my-project \
ANVIL_REPORT_SOURCE=ci \
  anvil-submit-report .anvil/reports/ioc-report.json ioc
```

Report types include:

| Type | Meaning |
| --- | --- |
| `lifecycle` | Safe-mode lifecycle script report. |
| `dependency` | Dependency tree report. |
| `ioc` | Observed install indicators of compromise report. |
| `network` | Network monitor report. |

## Queue operations

Queue operations are normally driven through the CLI.

Examples:

```bash
ANVIL_REGISTRY_URL=http://localhost:4873 \
ANVIL_ADMIN_TOKEN=local-dev-token \
  anvil registry queue status

ANVIL_REGISTRY_URL=http://localhost:4873 \
ANVIL_ADMIN_TOKEN=local-dev-token \
  anvil registry warm ./pnpm-lock.yaml
```

`anvil registry warm` queues exact package versions from lockfiles and records the reason as `lockfile_scan`.

## Authentication model

The alpha admin surface uses an environment admin token where protected operations need it. Full auth is intentionally not described as finished.

Use:

```bash
export ANVIL_ADMIN_TOKEN=local-dev-token
```

For hosted deployments, set a real secret. Do not expose admin tokens through `NEXT_PUBLIC_*`, client-side code, logs, readiness output, or screenshots in issues. Future you deserves at least this much kindness.
