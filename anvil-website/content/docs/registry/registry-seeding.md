---
title: Registry seeding
navTitle: Seeding
description: Warm Anvil Registry from representative org lockfiles before developers and CI switch their package traffic.
product: Anvil Registry
section: Operations
order: 11
---

# Registry seeding

Registry seeding lets operators warm Anvil with the dependency versions an organisation already uses. Before changing developer machines or CI to point at Anvil Registry, collect lockfiles from popular and business-critical repositories, then run `anvil warm` against them.

This reduces first-install latency, fills metadata and tarball caches earlier, and gives the worker time to produce policy decisions before a normal `npm install` is waiting on them. It is still the same analysis pipeline; seeding does not create a bypass or a second trust path.

## What to seed

Start with lockfiles from repositories that represent real install traffic:

- The main frontend and backend applications.
- Shared SDKs, design systems, CLIs, and internal packages.
- CI-heavy repos that run often.
- Repos with large dependency trees or slow cold installs.
- Production build lockfiles before lower-risk sandboxes.

Prefer exact lockfiles over `package.json` dependency ranges. `package-lock.json`, `pnpm-lock.yaml`, and `yarn.lock` identify resolved package versions, which makes the warm-up useful for policy decisions tied to immutable package identity.

Do not seed random public repos just because they are famous. The goal is to warm the packages your organisation actually installs, not to mirror the entire npm registry.

## First-run workflow

Start the gateway and worker, then wait for readiness:

```bash
curl http://localhost:4873/-/ready
```

Warm each representative lockfile:

```bash
ANVIL_REGISTRY_URL=http://localhost:4873 \
ANVIL_ADMIN_TOKEN=local-dev-token \
  anvil warm ./seed-lockfiles/package-lock.api.json

ANVIL_REGISTRY_URL=http://localhost:4873 \
ANVIL_ADMIN_TOKEN=local-dev-token \
  anvil warm ./seed-lockfiles/package-lock.web.json

ANVIL_REGISTRY_URL=http://localhost:4873 \
ANVIL_ADMIN_TOKEN=local-dev-token \
  anvil warm ./seed-lockfiles/pnpm-lock.design-system.yaml
```

`anvil warm` parses the lockfile, fetches package metadata through the gateway, and queues analysis for the resolved package versions. Queued jobs use `reason: "lockfile_scan"` so operators can tell pre-install review apart from install-path enforcement.

Watch the analysis queue until it drains enough for your rollout:

```bash
ANVIL_REGISTRY_URL=http://localhost:4873 \
ANVIL_ADMIN_TOKEN=local-dev-token \
  anvil queue status
```

Then route a small pilot repository through Anvil Registry and run its normal install with lifecycle scripts disabled:

```bash
npm config set registry http://localhost:4873
npm ci --ignore-scripts
```

## Ongoing use

Run seeding again when dependency baselines change:

- After large lockfile updates.
- Before switching a new team or repository to Anvil.
- As a scheduled job for high-traffic repos.
- Before strict CI modes require reviewed package identities.

For pull requests, use `anvil scan <lockfile> --queue-analysis` to review changed dependencies. For broader cache and analysis warm-up, use `anvil warm <lockfile>`.

## Security notes

Seeding should not approve packages by itself. It should only fetch metadata, warm cache entries, queue deterministic analysis, and produce policy decisions through the same worker path used by install traffic.

Treat seed lockfiles as operational input:

- Keep private registry tokens in environment variables, not in lockfile bundles.
- Seed from repositories the organisation owns or trusts.
- Keep audit logs for who ran warm-up jobs and when.
- Review blocked or quarantined packages before enforcing strict install gates.

If a package is risky during seeding, that is good news. It failed while nobody was blocked mid-install, which is the boring outcome security tools should aspire to.
