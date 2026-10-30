---
title: Quickstart
navTitle: Quickstart
description: Run Mezair Registry locally and point npm-compatible clients at the gateway.
product: Mezair Registry
section: Start here
journey: build
order: 20
---

# Quickstart

This guide gets Mezair Registry running locally, points an npm-compatible client at the gateway, and shows where Mezair Node Base fits when you want a safer install container.

## Start Mezair Registry

From a checkout:

```bash
git clone https://github.com/anthonyhumphreys/mezair.git
cd mezair/mezair-registry
pnpm install --ignore-scripts
```

Start the local stack:

```bash
docker compose -f infra/docker/docker-compose.yml up --build
```

The local stack includes:

- Gateway on port `4873`.
- Next.js Admin service on port `3000`.
- Worker process for queued analysis.
- Postgres, Redis, and MinIO for local persistence, queueing, and object storage.

For a NAS or an always-on Docker host, use the Compose bundle attached to a `registry-v*` GitHub release instead of cloning the build workspace. The release bundle uses published AMD64 and ARM64 images, requires explicit secrets, and keeps internal data services off host ports. See [Deployment](/docs/registry/deploy).

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

The gateway rewrites tarball URLs so package bytes continue through Mezair Registry instead of leaking back to the upstream registry.

When the gateway runs on another machine, both the client registry URL and the gateway's `PUBLIC_BASE_URL` must use the reachable hostname, for example `http://mezair-nas.local:4873`. A server-side value of `localhost` produces tarball URLs that point back at the Mac rather than the NAS.

## Explain a package

Install the CLI from npm:

```bash
npm install --global @mezairstack/cli
npm install --global @mezairstack/registry-cli
MEZAIR_REGISTRY_URL=http://localhost:4873 mezair registry explain react@latest
```

Or run it without a global install:

```bash
npx @mezairstack/registry-cli explain react@latest
```

The CLI requires the gateway you started above. See [CLI](/docs/registry/cli) for endpoint configuration, admin tokens, command reference, and CI examples.

The explain route resolves dist-tags, evaluates policy, and returns the current decision plus analysis and review context when available.

## Queue analysis

```bash
mezair registry scan pnpm-lock.yaml --queue-analysis
```

Lockfile warming uses `reason: "lockfile_scan"` so worker output can be traced back to preinstall review rather than request-path enforcement.

## Seed common org dependencies

Before routing a team through Mezair Registry, warm it with lockfiles from representative repositories:

```bash
MEZAIR_REGISTRY_URL=http://localhost:4873 \
MEZAIR_ADMIN_TOKEN=local-dev-token \
  mezair registry warm ./seed-lockfiles/package-lock.web.json
```

Use real `package-lock.json`, `pnpm-lock.yaml`, or `yarn.lock` files from high-traffic repos. Seeding uses the same warm and analysis queue path as normal lockfile review; it just does the work before someone is waiting on `npm install`. See [Registry seeding](/docs/registry/registry-seeding) for the full rollout flow.

## Try Mezair Node Base

Use Node Base when you want the install itself to happen inside a safer container:

```bash
docker run --rm -it -v "$PWD:/workspace" -w /workspace ghcr.io/anthonyhumphreys/mezair-stack/mezair-node-base:22 mezair-npm-ci-safe
```

Safe mode runs `npm ci --ignore-scripts`, scans installed package manifests, and writes reports under `.mezair/reports` or `MEZAIR_REPORT_DIR`.

Observed mode is explicit:

```bash
docker run --rm -it -v "$PWD:/workspace" -w /workspace ghcr.io/anthonyhumphreys/mezair-stack/mezair-node-base:22 mezair-npm-ci-observed
```

Use observed mode only when dependency lifecycle scripts must run and you want process, network, filesystem, lifecycle, and environment evidence.
