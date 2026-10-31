---
title: Beta status
navTitle: Beta status
description: Registry availability, deployment limits and a gradual rollout for your repositories.
product: Mezair Registry
section: Reference
journey: reference
order: 180
---

# Beta status

Mezair Registry and Node Base are beta software. You can run the local Docker
Compose stack, deploy Registry to your own host, route npm-compatible clients
through the gateway and use Node Base for dependency installs.

Start with one repository so you can inspect decisions and adjust policy before
changing a team-wide registry or a critical CI pipeline.

## Current limits

- Admin access uses the documented admin-token configuration.
- Policy thresholds need to match your organisation and dependency graph. A
  blocked package can stop an install; review decisions before enabling strict
  enforcement.
- Optional LLM review explains analysis. It does not decide whether a package
  is allowed.
- Node Base observed mode runs dependency install scripts and records their
  activity. Use safe mode when those scripts are not needed.
- Keep the beta stack on a private network or behind your own access controls.

## Roll out gradually

1. Start the [local stack](/docs/registry/quickstart) or [deploy to your own host](/docs/registry/deploy).
2. Seed common lockfiles with `mezair registry warm`.
3. Route one project through the gateway using a project-level `.npmrc`.
4. Install with lifecycle scripts disabled, then inspect package decisions and Node Base reports.
5. Add CI checks in warning mode before switching to stricter enforcement.

See [Registry seeding](/docs/registry/registry-seeding), [Policy](/docs/registry/policy)
and [CI usage](/docs/registry/ci) for configuration.
