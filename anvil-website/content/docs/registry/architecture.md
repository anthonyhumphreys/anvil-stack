---
title: Architecture
description: How Anvil Registry, the worker, persistence, object storage, queueing, CLI, Admin, and Node Base fit together.
product: Anvil Registry
section: Concepts
order: 2.5
---

# Architecture

Anvil has two connected halves:

- **Anvil Registry**, a central npm-compatible gateway.
- **Anvil Node Base**, a local and CI container safety harness.

The registry controls dependency traffic before install. Node Base controls local install execution when scripts and unknown repositories need extra scrutiny.

## System map

```text
Developer / CI
  |
  | npm, pnpm, yarn registry requests
  v
Anvil Registry gateway
  |
  +--> upstream npm or scoped private registries
  +--> Postgres decision and audit data
  +--> S3 / MinIO tarball and report storage
  +--> BullMQ / SQS analysis queue
            |
            v
        Worker analysis
            |
            +--> static package analysis
            +--> name-squatting analysis
            +--> provenance context
            +--> optional LLM risk review context

The Next.js Admin service and CLI read the same decisions, reports, policies, queue state, and overrides.
```

## Gateway

The gateway is a Fastify service that behaves like an npm registry from the package manager's point of view.

It handles:

- `GET /-/health`
- `GET /-/ready`
- `GET /:packageName`
- `GET /@:scope/:packageName`
- `GET /:packageName/-/:tarballName`
- `GET /@:scope/:packageName/-/:tarballName`
- Anvil-specific explain, policy, report, and override routes.

Metadata responses are normalized, filtered, and rewritten so tarball URLs continue to point through Anvil. If tarballs escape back to upstream, the gateway is doing theatre with extra latency.

## Worker

The worker handles expensive analysis outside the install request path where possible.

Worker jobs can perform:

- Manifest and dependency diffing.
- Lifecycle-script detection.
- Install-path static analysis.
- Binary, hidden file, unusual path, encoded blob, and credential-looking file detection.
- Name-squatting checks using similarity and adoption signals.
- Provenance context checks.
- Optional LLM risk review context when enabled.

The worker writes analysis reports and feeds deterministic policy decisions. It should not be required for every hot-path metadata request to complete.

## Persistence and storage

Postgres stores structured state:

- Package decisions.
- Analysis reports metadata.
- Policy configuration.
- Overrides and audit events.
- Node Base report records.
- Popular package and name-squatting signals.

Object storage stores heavier artifacts:

- Tarballs.
- Node Base report payloads.
- Large analysis output where appropriate.

Local development uses Docker Compose with Postgres, Redis, and MinIO. AWS deployment uses Postgres, SQS, and S3 behind the same abstractions.

## Queueing

The queue separates install-path work from deeper review.

Local development uses BullMQ over Redis. AWS deployment uses SQS. The code keeps provider-specific behaviour behind queue adapters so gateway and worker logic do not need to care which transport is currently carrying the bucket of future work.

Queue jobs should include enough context to explain why analysis was requested, such as install-path enforcement, manual review, or `lockfile_scan` from seeding.

## Cache identity

Policy decisions and analysis reports are meaningful only when tied to immutable package identity.

Cache keys should include:

- Package name.
- Version.
- Tarball integrity or hash.
- Analysis engine version.
- Policy version.

This prevents a decision for one artifact from being accidentally reused for another artifact wearing the same name tag and a suspicious little moustache.

## Admin and CLI

The Admin app is a Next.js App Router service for human review. Its pages cover:

- Package decisions.
- Policy visibility.
- Overrides.
- Audit events.
- Node Base reports.
- Popular package and name-squatting context.

Its route-handler JSON API is the surface the CLI uses for reports, overrides, audit events, package review data, Node Base reports, policy, and popular package index operations.

The CLI is for operators and CI:

- Explain package decisions.
- Scan lockfiles.
- Warm registry caches.
- Queue analysis.
- Inspect reports.
- Manage overrides.
- Check health and readiness.

Protected operations require the admin endpoint and token documented in [CLI](/docs/registry/cli) and [API reference](/docs/registry/api-reference).

## Node Base

Anvil Node Base is deliberately separate from the central gateway. It helps when you need local install safety:

- Non-root Node 22 base.
- npm `ignore-scripts=true` by default.
- Safe mode through `anvil-npm-ci-safe`.
- Observed mode through `anvil-npm-ci-observed`.
- Report generation under `.anvil/reports`.
- Optional report submission back to Anvil Admin.

Use Node Base for unknown repos, PR dependency review, and CI jobs where install script behaviour should be visible.

## Failure posture

Development can warn or quarantine depending on configuration. CI and production should fail closed for high-confidence risk, stale policy decisions, tarball identity mismatches, and blocked packages.

The important split is simple:

- Fast deterministic checks belong on the request path.
- Deeper analysis belongs in the worker.
- Human overrides must be explicit, reasoned, audited, and preferably expiring.
- LLM review may add context, but deterministic policy decides enforcement.
