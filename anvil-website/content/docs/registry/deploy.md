---
title: Deployment
description: Run Anvil Registry locally and prepare the registry stack for AWS.
product: Anvil Registry
section: Operations
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

Publish the image under your chosen container registry namespace, for example:

```text
ghcr.io/<owner>/anvil-node-base:22
```

Use immutable tags for CI rollouts when you need repeatability, and keep a major Node tag such as `22` for routine upgrades.
