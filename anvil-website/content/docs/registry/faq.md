---
title: Frequently asked questions
navTitle: FAQ
description: Quick answers about policy decisions, false positives, private packages, CI behavior, and performance.
product: Anvil Registry
section: Getting started
journey: build
order: 4
---

# Frequently asked questions

## Why was my package quarantined?

The most common reason is age: by default, versions younger than the policy window (7 days, `POLICY_MINIMUM_PACKAGE_AGE_DAYS`) are quarantined until they have been public long enough for problems to surface. Ask the gateway directly:

```bash
anvil registry explain <package>@<version>
```

The decision includes machine-readable reason codes and the evidence behind them. See [Package decisions](/docs/registry/package-decisions).

## How do I handle a false positive?

Use an explicit override. Overrides are audited, reasoned, and should expire:

```bash
anvil registry approve <package>@<version> \
  --reason "Reviewed by platform team" \
  --expires-at 2026-07-01T00:00:00Z
```

Overrides are deliberate paper trails, not silent allow-list edits. The audit log records who allowed what and why.

## Does the LLM review decide whether a package is allowed?

No. The deterministic policy engine is the only enforcement authority. LLM review (when enabled) adds explanatory context and risk evidence; it can never be the reason a package is allowed. See [Policy](/docs/registry/policy).

## Can I keep using private packages and scoped registries?

Yes. Scoped upstreams route configured scopes (for example `@yourco/*`) to your private registry while everything else flows through the public npm upstream. Private package source is never sent to an LLM unless you explicitly enable it. See [Configuration](/docs/registry/registry-configuration).

## What happens in CI when the registry is unsure?

CI mode fails closed. Unknown or quarantined packages block the install rather than slipping through, which is the entire point of running it in CI. Development mode can be configured to warn instead. See [CI usage](/docs/registry/ci).

## What is the performance impact on installs?

After the first fetch, metadata, tarballs, analysis reports, and policy decisions are all cached by immutable identity (name, version, tarball integrity, analyser version, policy version). Warm installs are served from cache; the analysis work happens in the worker outside the install request path. Seeding the cache ahead of a rollout removes most first-install latency; see [Seeding](/docs/registry/registry-seeding).

## Can I run it without Docker?

The supported local path is Docker Compose (gateway, worker, admin, Postgres, Redis, MinIO). The AWS deployment path uses SST. Running the processes bare is possible in principle but not a documented or tested path. See [Quickstart](/docs/registry/quickstart).

## How do I see why the gateway did something?

Three places, in increasing depth:

1. `anvil registry explain <package>@<version>` for a single decision.
2. The Admin UI (port 3000 locally) for decisions, overrides, and audit events.
3. The audit log itself, which records policy decisions, override changes, and analysis enqueues with their identities.

## Where should I use this today?

It is alpha infrastructure for local trials, security review, early CI experiments, and contribution work. Before putting it on an organization-wide install path, validate the gateway, cache, policy, overrides, analysis worker, and fallback behavior against your own packages. [Alpha status](/docs/registry/alpha-status) is the scope statement.

## How do I report a security issue?

See [Security](/docs/registry/security) for the reporting path. Do not open a public issue for vulnerabilities.
