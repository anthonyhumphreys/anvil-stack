---
title: Alpha status
description: What the first Anvil alpha is meant for, what is working, and what still needs caution.
product: Anvil Registry
section: Getting started
order: 2
---

# Alpha status

This is the first public version of Anvil Registry and Anvil Node Base. It is an alpha release: useful for review, local trials, CI experiments, and early operator feedback, but not something to drop in front of every production install path without a careful rollout.

The project is intentionally open about its edges. Dependency security tools are not helped by pretending a young system has been forged in the fires of ten thousand incident reports. It has not. Use it with that context.

## Good alpha use cases

Use this version for:

- Running the local Docker Compose stack.
- Routing a pilot repository through the npm-compatible gateway.
- Exercising metadata and tarball proxying for scoped and unscoped packages.
- Inspecting package decisions and explain output.
- Warming caches and queueing analysis from representative lockfiles.
- Reviewing Node Base safe-mode and observed-mode reports.
- Testing CI dependency-review workflows on non-critical repositories.
- Contributing fixes, docs, and implementation feedback.

## Use caution for

Be more careful with:

- Production builds that must fail closed under every dependency edge case.
- Large organisation-wide registry cutovers.
- Private scoped registry setups with complex token and upstream routing requirements.
- Strict policy modes that have not been tested against your real dependency graph.
- Workflows where a false block would stop a critical release.
- Workflows where a false allow would create meaningful security exposure.

Pilot first. Seed common lockfiles. Watch decisions. Review report output. Then tighten policy.

## Current coverage

The alpha docs cover:

- Local quickstart and registry client configuration.
- Registry request flow, tarball rewriting, scoped upstreams, and cache behaviour.
- Policy actions, runtime modes, quarantine, blocks, and overrides.
- CLI commands for explain, scan, warm, queue, reports, overrides, and health checks.
- Registry seeding from lockfiles.
- Node Base safe mode, observed mode, reports, network monitoring, and strict gates.
- CI usage and deployment notes.
- API endpoints and operator reference.
- Troubleshooting for routing, readiness, blocks, reports, and lifecycle scripts.

## What is not a promise

This alpha does not promise:

- Full production hardening for every npm client edge case.
- A finished auth system beyond the documented admin token path.
- That optional LLM review is enabled or required.
- That every policy threshold is correct for your organisation.
- That observed mode makes lifecycle scripts safe. It makes them visible. Those are not the same thing, and the difference matters.

## Recommended rollout

1. Start locally with Docker Compose.
2. Run the smoke checks relevant to your workflow.
3. Seed the registry with representative lockfiles using `anvil warm`.
4. Route one low-risk repository through the gateway.
5. Run installs with lifecycle scripts disabled.
6. Review package decisions and Node Base reports.
7. Add CI checks in warning or review mode.
8. Move toward stricter policy only after the evidence looks sane.

See [Quickstart](/docs/registry/quickstart), [Registry seeding](/docs/registry/registry-seeding), and [CI usage](/docs/registry/ci) for the practical flow.
