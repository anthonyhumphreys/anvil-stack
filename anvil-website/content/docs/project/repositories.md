---
title: Monorepo map
navTitle: Monorepo map
description: How the anvil-stack monorepo is laid out and where each product surface lives.
product: Project
section: Notes
order: 890
---

# Monorepo map

Anvil lives in one repository: [`anvil-stack`](https://github.com/anthonyhumphreys/anvil-stack). Each product is an independent workspace inside it, with its own lockfile, tooling, and CI path filters. One clone gives you everything; each project still builds and tests on its own.

| Directory | Product | Owns |
| --- | --- | --- |
| `anvil-app/` | Anvil Desktop | Local developer workflow orchestration, repository context, agent sessions, work items, reviews, security checks, terminals, docs, diagrams, companion controls, and handover evidence. |
| `anvil-registry/` | Anvil Registry | npm metadata and tarball gateway, package policy, static analysis, provenance signals, cache identity, Admin, CLI, deployment infrastructure, and explicit overrides. |
| `anvil-registry/devcontainer-base/` | Anvil Node Base | Safer Node install execution inside a hardened Node 22 devcontainer image, with safe mode, observed mode, and install reports. |
| `anvil-cloud/` | Anvil Cloud | Anvil Cell contract, shared runtime, builder, import policy, local runtime server, generated client, CLI, and AWS preview adapter boundary. |
| `anvil-website/` | This site | Public docs, landing page, monorepo map, OSS posture, and markdown documentation entry points. |

## How the pieces fit

Anvil Desktop helps a developer or delivery team do repo-aware work locally. It is the place where code, work item context, Git state, chat sessions, review findings, security checks, terminals, docs, diagrams, and handover notes stay close enough to be useful.

Anvil Registry and Node Base sit earlier in the dependency path. Registry controls what package metadata and tarballs reach installs; Node Base controls how lifecycle scripts are allowed to run when a project is unfamiliar or risky.

Anvil Cloud is a separate app-platform experiment. It tries to make small apps authorable by developers and coding agents without giving app code direct cloud-provider primitives. The key boundary is the Anvil Cell contract, not AWS, SST, CDK, or any provider SDK.

## Working in the monorepo

Each project directory manages its own dependencies. Run `pnpm install` inside the project you are working on, not at the repo root:

```bash
git clone https://github.com/anthonyhumphreys/anvil-stack.git
cd anvil-stack/anvil-registry
pnpm install --ignore-scripts
```

CI is path-filtered: changes under `anvil-app/` run the desktop workflows, changes under `anvil-registry/` run the registry and image workflows, and so on. A change in one project does not trigger the others.

## Where to start in each project

### `anvil-app/`

Start with:

- `src/main`: privileged Electron services, SQLite, Git, PTY, filesystem, connector, LLM, automation, and app lifecycle work.
- `src/preload`: typed `window.anvil` bridge.
- `src/shared`: shared IPC contracts, app identity, branding, and shared types.
- `src/renderer`: React and Tailwind renderer surfaces.
- `mobile`: Expo companion app.
- `raycast/anvil`: Raycast command surface.
- `prompts`: reusable LLM prompt templates.

The important rule is simple: privileged side effects belong in the main process, not in renderer code.

### `anvil-registry/`

Start with:

- `apps/gateway`: Fastify npm-compatible registry proxy.
- `apps/worker`: queued static analysis, name-squatting checks, provenance context, and optional LLM review.
- `apps/admin`: Next.js Admin UI and JSON route handlers.
- `apps/cli`: `anvil-registry` command-line client.
- `packages`: shared config, policy, npm registry, persistence, object storage, queueing, analysis, and LLM review packages.
- `devcontainer-base`: Anvil Node Base image and helper scripts.
- `infra/docker` and `infra/sst`: local stack and AWS deployment infrastructure.

The important rule is that deterministic policy is the enforcement authority. LLM review can add context or quarantine-level risk, but it does not allow a package by itself.

### `anvil-cloud/`

Start with:

- `packages/runtime`: `app`, `query`, `mutation`, `endpoint`, `job`, `table`, `RuntimeRequest`, `RuntimeHost`, and `handleRuntimeRequest`.
- `packages/builder`: config loading, import policy, typecheck, server/client bundle, manifest extraction, and generated client output.
- `packages/local`: local runtime server, JSON database adapter, file adapter, auth adapter, logs, jobs, and inspection state.
- `packages/client`: browser client and framework hook helpers.
- `packages/cli`: `anvil-cloud new`, `dev`, `check`, `build`, `inspect`, `logs`, `db`, and `deploy --preview`.
- `packages/aws`: AWS preview adapter, CloudFormation synthesis, Lambda runtime bridge, DynamoDB/S3/SQS/EventBridge host adapters, artifact packaging, and remote readers.

The important rule is that Cell code uses the runtime contract. Provider-specific behavior belongs in deployment adapters.

## Contribution posture

When you update behavior, update docs in the same change — they live in the same repo now, so there is no excuse. This is especially important for Registry policy, Desktop IPC/service boundaries, and Cloud command output. Public docs that drift from implementation are not documentation, they are a scavenger hunt with better typography.
