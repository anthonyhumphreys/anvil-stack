---
title: Registry rollout guide
navTitle: Rollout guide
description: A staged adoption path for Anvil Registry and Anvil Node Base across local trials, CI, policy tuning, and deployment.
product: Anvil Registry
section: Operations
order: 7.5
---

# Registry rollout guide

Anvil Registry is alpha software. Roll it out like infrastructure, not like a browser extension someone installed because the icon looked useful.

The safe path is staged:

1. local trial
2. read-only package decision review
3. lockfile warming and seeding
4. CI experiment
5. policy tuning
6. explicit override process
7. limited team adoption
8. deployed gateway and admin

## 1) Local trial

Start the local stack:

```bash
docker compose -f infra/docker/docker-compose.yml up -d --build gateway worker admin
```

Local defaults:

| Service | URL |
| --- | --- |
| Gateway | `http://localhost:4873` |
| Admin | `http://localhost:3000` |
| Admin token | `local-dev-token` |

Point npm at the gateway:

```bash
npm config set registry http://localhost:4873
```

Then install in a test project. Do not start with the repository that deploys payroll or production auth. Be brave later.

## 2) Inspect decisions before enforcement

Use the CLI to explain decisions:

```bash
ANVIL_REGISTRY_URL=http://localhost:4873 anvil registry explain is-number@7.0.0
```

Review:

- decision
- policy version
- package age
- provenance
- static analysis findings
- cache identity
- override status
- LLM review context if enabled

Read [Package decisions](/docs/registry/package-decisions) for the decision model.

## 3) Warm common lockfiles

Before routing a team through the gateway, warm it with representative lockfiles:

```bash
ANVIL_REGISTRY_URL=http://localhost:4873 \
ANVIL_ADMIN_TOKEN=local-dev-token \
  anvil registry warm ./seed-lockfiles/package-lock.web.json
```

Use real lockfiles from high-traffic repos:

- `package-lock.json`
- `pnpm-lock.yaml`
- `yarn.lock`

Warming lets the worker analyze packages before a developer is blocked on install.

## 4) Run CI in observe mode first

Start with CI that reports decisions without breaking delivery. Then move to stricter gates once false positives and missing policy settings are understood.

Useful commands:

```bash
ANVIL_REGISTRY_URL=http://localhost:4873 anvil registry scan pnpm-lock.yaml --queue-analysis
ANVIL_REGISTRY_URL=http://localhost:4873 anvil registry scan yarn.lock --queue-analysis
ANVIL_REGISTRY_URL=http://localhost:4873 ANVIL_ADMIN_TOKEN=local-dev-token anvil registry queue status
```

Read [Registry CI](/docs/registry/ci) for CI wiring.

## 5) Tune policy deliberately

Policy knobs use the `POLICY_` prefix.

Common settings:

- `POLICY_MINIMUM_PACKAGE_AGE_DAYS`
- `POLICY_LOW_DOWNLOAD_THRESHOLD`
- `POLICY_STRICT_LOW_DOWNLOAD_THRESHOLD`
- `POLICY_BLOCK_SIMILAR_LOW_DOWNLOAD_PACKAGES`
- `POLICY_HIDE_QUARANTINED_METADATA`
- `POLICY_OVERRIDE_DEFAULT_EXPIRY_DAYS`

Inspect effective policy:

```bash
curl http://localhost:4873/-/anvil/policy
```

Policy should be conservative enough to catch real risk and practical enough that teams do not route around it by lunch.

## 6) Define overrides before teams need them

Overrides should be:

- explicit
- reasoned
- audited
- scoped to package/version where possible
- expiring where practical
- visible in Admin and CLI output

An override process that only exists in someone's memory is not a process. It is folklore with merge rights.

## 7) Use Node Base for unknown repos

Use Anvil Node Base when install execution is itself the concern.

Safe mode:

```bash
anvil-npm-ci-safe
```

Observed mode:

```bash
anvil-npm-ci-observed
```

Safe mode disables lifecycle scripts and reports packages that wanted them. Observed mode runs lifecycle scripts deliberately while collecting process, network, filesystem, lifecycle, and environment evidence.

Read:

- [Node Base overview](/docs/node-base/overview)
- [Safe mode](/docs/node-base/safe-mode)
- [Observed mode](/docs/node-base/observed-mode)
- [Reports](/docs/node-base/reports)

## 8) Deploy carefully

For a NAS or small Docker host, use the image-based bundle attached to a `registry-v*` GitHub release. It provides versioned AMD64 and ARM64 images, a one-shot migration service, private data-service networking, explicit secrets, and durable storage beneath `ANVIL_DATA_DIR`.

The AWS deployment path uses SST under `infra/sst`. Run preflight before deployment:

```bash
PUBLIC_BASE_URL=https://npm.your-domain.com pnpm sst:preflight
```

Preflight catches missing gateway URLs, domain/certificate mismatches, malformed private upstream config, invalid policy overrides, and partially enabled LLM review.

Read [Deploy](/docs/registry/deploy) for deployment configuration.

## Production readiness checklist

Before a team depends on the registry:

- gateway health and readiness are monitored
- persistence is durable
- object storage is configured
- queue and worker are healthy
- Admin access is protected
- `ANVIL_ADMIN_TOKEN` is configured
- upstream scoped registries are tested
- tarball URL rewrites use the public HTTPS gateway URL
- policy is reviewed and documented
- override process exists
- smoke tests pass
- CI behavior is understood
- Node Base report handling is documented
- release images are pinned to an immutable `registry-v*` tag
- `ANVIL_DATA_DIR` is included in backups and restore has been rehearsed

## Smoke tests

Run relevant smokes:

```bash
pnpm smoke:local
pnpm smoke:clients
pnpm smoke:scoped-upstream
pnpm smoke:analysis
pnpm smoke:node-base-report
pnpm smoke:llm-review
```

Use smoke output as rollout evidence. If a smoke fails, fix the failing contract or mark the limitation before widening adoption.
