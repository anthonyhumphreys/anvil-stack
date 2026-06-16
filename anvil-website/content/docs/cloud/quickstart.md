---
title: Quickstart
navTitle: Quickstart
description: Create a Cell, run local checks, inspect output, and produce deployable artifacts.
product: Anvil Cloud
section: Getting started
order: 110
---

# Quickstart

Use this flow to create an Anvil Cell and inspect its output before deployment.

Anvil Cloud is alpha and the packages are currently private inside the
`anvil-cloud` workspace. There is no supported `npm install -g`, `pnpm dlx`, or
`npx` path yet. The stable command contract is `anvil ...`; from a local
checkout you run that contract through `pnpm anvil` or the built CLI entrypoint
while packaging settles.

## 1) Prepare the checkout

From `anvil-cloud`:

```bash
pnpm install --ignore-scripts
pnpm build
pnpm anvil --help
```

If dependencies are already installed, `pnpm build` is enough to refresh the
package output used by the CLI. `pnpm anvil` runs the built CLI entrypoint from
the workspace root.

## 2) Create a Cell

From the workspace root during alpha development:

```bash
pnpm anvil new notes
cd notes
```

Inside a checked-in example such as `examples/notes`, use the relative built
entrypoint:

```bash
node ../../packages/cli/dist/index.js check --json
```

The scaffold creates:

```txt
notes/
  AGENTS.md
  anvil.json
  package.json
  tsconfig.json
  src/
    cell.server.ts
    cell.client.tsx
```

The generated server defines a todos table, a `listTodos` query, an `addTodo` mutation, and `capabilities.database`.

## 3) Check before build

```bash
anvil check --json
```

In local workspace development, when the Cell lives directly under the repo root:

```bash
node ../packages/cli/dist/index.js check --json
```

`check` validates:

- Cell config
- import policy
- direct `process.env` access
- undeclared global `fetch`
- scheduled jobs without `capabilities.scheduledJobs`
- handler capability use
- TypeScript typecheck
- manifest extraction readiness

Fix check failures before trying to run or deploy.

## 4) Build artifacts

```bash
anvil build --json
```

The builder writes:

```txt
.anvil/
  dist/
    client/
      index.html
      assets/
    server/
      index.mjs
    manifest.json
    build-meta.json
  generated/
    api.d.ts
    client.ts
```

The manifest is the key handoff to local runtime and deployment adapters.

## 5) Run locally

```bash
anvil dev
```

Default local URLs:

| Surface | URL |
| --- | --- |
| Runtime | `http://localhost:8787` |
| Client | `http://localhost:5173` |

Useful local routes:

```txt
GET  /_anvil/health
GET  /_anvil/manifest
GET  /_anvil/inspect
POST /_anvil/query/:name
POST /_anvil/mutation/:name
ANY  /api/*
```

For automation:

```bash
anvil dev --json
anvil dev --agent --json
```

Agent mode emits JSONL events and avoids spinners, terminal control codes, and unstable prose.

## 6) Inspect local state

```bash
anvil inspect --local --json
anvil logs --local --json
anvil db list --local --json
anvil db dump todos --local --json
```

Local state is stored under `.anvil/local`:

```txt
.anvil/local/
  auth.json
  dev.db
  events.json
  files/
  jobs.json
  logs.ndjson
```

## 7) Preview deployment

```bash
anvil deploy --preview --json
```

Without AWS provisioning configuration, the preview adapter returns a stable deployment plan, CloudFormation template, and deploy artifact summary rather than mutating an AWS account.

To provision preview infrastructure, configure the AWS adapter environment described in [AWS preview](/docs/cloud/aws-preview).

## Read next

- [Cell contract](/docs/cloud/cell-contract)
- [Local runtime](/docs/cloud/local-runtime)
- [Builder and Guard](/docs/cloud/builder-and-guard)
- [CLI reference](/docs/cloud/cli-reference)
