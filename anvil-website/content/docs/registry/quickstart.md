---
title: Quickstart
description: Run Anvil Registry locally and point npm-compatible clients at the gateway.
product: Anvil Registry
section: Getting started
order: 2
---

# Quickstart

This guide gets Anvil Registry running locally, points an npm-compatible client at the gateway, and shows where Anvil Node Base fits when you want a safer install container.

## Start Anvil Registry

```bash
docker compose -f infra/docker/docker-compose.yml up --build
```

The local stack includes:

- Gateway on port `4873`.
- Next.js Admin service on port `3000`.
- Worker process for queued analysis.
- Postgres, Redis, and MinIO for local persistence, queueing, and object storage.

Check that the gateway is alive and ready:

```bash
curl http://localhost:4873/-/health
curl http://localhost:4873/-/ready
curl http://localhost:3000/-/health
```

`/-/health` proves a service can answer HTTP. Gateway `/-/ready` checks runtime dependencies such as persistence, object storage, and the analysis queue.

## Route npm through the gateway

```bash
npm config set registry http://localhost:4873
```

Project-level config works too:

```ini
registry=http://localhost:4873
```

For pnpm and yarn, set the registry in the project config or pass it directly during a trial install:

```bash
pnpm add is-number@7.0.0 --config.registry=http://localhost:4873
yarn add is-number@7.0.0 --registry http://localhost:4873 --ignore-scripts
```

The gateway rewrites tarball URLs so package bytes continue through Anvil Registry instead of leaking back to the upstream registry.

## Explain a package

Install the CLI from npm:

```bash
npm install --global @anvilstack/cli
ANVIL_REGISTRY_URL=http://localhost:4873 anvil explain react@latest
```

Or run it without a global install:

```bash
npx @anvilstack/cli explain react@latest
```

The CLI requires the gateway you started above. See [CLI](/docs/registry/cli) for endpoint configuration, admin tokens, command reference, and CI examples.

The explain route resolves dist-tags, evaluates policy, and returns the current decision plus analysis and review context when available.

## Queue analysis

```bash
anvil scan pnpm-lock.yaml --queue-analysis
```

Lockfile warming uses `reason: "lockfile_scan"` so worker output can be traced back to preinstall review rather than request-path enforcement.

## Seed common org dependencies

Before routing a team through Anvil Registry, warm it with lockfiles from representative repositories:

```bash
ANVIL_REGISTRY_URL=http://localhost:4873 \
ANVIL_ADMIN_TOKEN=local-dev-token \
  anvil warm ./seed-lockfiles/package-lock.web.json
```

Use real `package-lock.json`, `pnpm-lock.yaml`, or `yarn.lock` files from high-traffic repos. Seeding uses the same warm and analysis queue path as normal lockfile review; it just does the work before someone is waiting on `npm install`. See [Registry seeding](/docs/registry/registry-seeding) for the full rollout flow.

## Try Anvil Node Base

Use Node Base when you want the install itself to happen inside a safer container:

```bash
docker run --rm -it -v "$PWD:/workspace" -w /workspace ghcr.io/<owner>/<repo>/anvil-node-base:22 anvil-npm-ci-safe
```

Safe mode runs `npm ci --ignore-scripts`, scans installed package manifests, and writes reports under `.anvil/reports` or `ANVIL_REPORT_DIR`.

Observed mode is explicit:

```bash
docker run --rm -it -v "$PWD:/workspace" -w /workspace ghcr.io/<owner>/<repo>/anvil-node-base:22 anvil-npm-ci-observed
```

Use observed mode only when dependency lifecycle scripts must run and you want process, network, filesystem, lifecycle, and environment evidence.
