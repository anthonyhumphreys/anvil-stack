---
title: Deployment
navTitle: Deployment
description: Run Anvil Registry locally, on a NAS or Docker host, or on AWS.
product: Anvil Registry
section: Operations
journey: build
order: 11
---

# Deployment

## Local registry stack

```bash
docker compose -f infra/docker/docker-compose.yml up --build
```

The local stack includes the Fastify gateway, worker, Next.js Admin service, Postgres, Redis, and MinIO.

## Local readiness

Before routing installs through the gateway, check:

```bash
curl http://localhost:4873/-/health
curl http://localhost:4873/-/ready
curl http://localhost:3000/-/health
```

Use `/-/health` for service liveness checks and gateway `/-/ready` for traffic readiness. Readiness should fail if persistence, object storage, or queue dependencies are unavailable.

## Local smoke checks

The product stack includes smoke scripts for npm-compatible clients and worker flows:

```bash
pnpm smoke:clients
pnpm smoke:analysis
pnpm smoke:node-base-report
pnpm smoke:llm-review
pnpm smoke:scoped-upstream
```

Run these after bringing up the local stack when changing gateway routing, policy decisions, upstream registry handling, or report submission.

## NAS and operator deployment

Each `registry-v*` GitHub release includes a self-contained Compose bundle for Linux AMD64 and ARM64 hosts. It runs versioned gateway, worker, Admin, and migration images from GHCR and stores Postgres, Redis, and MinIO data beneath one configurable directory.

Download and unpack the release bundle, then configure it:

```bash
cp .env.example .env
```

Before starting the stack, set:

- `PUBLIC_BASE_URL` to the exact URL npm and pnpm clients use.
- `ANVIL_DATA_DIR` to a directory covered by the host backup policy.
- Unique values for `ANVIL_ADMIN_TOKEN`, `POSTGRES_PASSWORD`, and `MINIO_ROOT_PASSWORD`.
- `ANVIL_BIND_ADDRESS=127.0.0.1` when a host reverse proxy terminates HTTPS, or `0.0.0.0` for a trusted LAN pilot.

Start and verify the release:

```bash
docker compose pull
docker compose up -d
docker compose ps
curl "$PUBLIC_BASE_URL/-/ready"
```

Point a pilot repository on the Mac at the NAS with a project-level `.npmrc`:

```ini
registry=http://anvil-nas.local:4873/
```

npm and pnpm both read this setting. The server's `PUBLIC_BASE_URL` must match the reachable gateway URL because Anvil rewrites tarball URLs into package metadata.

The bundle starts in `development` mode so unanalysed dependencies warn rather than unexpectedly blocking a first install. Warm representative lockfiles and inspect decisions before switching `RUNTIME_MODE` to `ci` or `production`.

Only gateway and Admin publish host ports. Postgres, Redis, and MinIO remain on the private Compose network. Do not expose the alpha stack directly to the public internet.

For optional Codex-backed package review, the release also includes `docker-compose.codex.yml`. Set `CODEX_AUTH_FILE` to the NAS user's absolute `~/.codex/auth.json` path and apply both Compose files. Only the worker receives the read-only credential mount. See [LLM integration](/docs/registry/llm-integration) before enabling it.

### Upgrade and backup

Back up `ANVIL_DATA_DIR` before changing `ANVIL_REGISTRY_VERSION`. Then run:

```bash
docker compose pull
docker compose up -d
```

The one-shot migration image must complete successfully before gateway and worker start. For a filesystem-level backup, stop the stack first so Postgres and object-store state are consistent.

## AWS deployment

Run preflight before deploying:

```bash
PUBLIC_BASE_URL=https://npm.example.com pnpm sst:preflight
```

Then run migrations before routing production install traffic:

```bash
pnpm sst:migrate
```

The SST deployment creates Fargate services for the gateway, worker, Next.js Admin app, and migration task, plus Postgres, S3 package cache, SQS analysis queue, and linked secrets for admin and optional LLM review.

## Node Base image

Build and test the image locally:

```bash
pnpm smoke:node-base-image
pnpm smoke:node-base-image-observed
pnpm smoke:node-base-image-report
```

The public Anvil image path is:

```text
ghcr.io/anthonyhumphreys/anvil-stack/anvil-node-base:22
```

Use immutable tags for CI rollouts when you need repeatability, and keep a major Node tag such as `22` for routine upgrades. Forks can publish the same image under their own GHCR namespace.
