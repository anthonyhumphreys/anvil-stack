---
title: Quickstart
navTitle: Quickstart
description: Create a Cell, run local checks, inspect output, and produce deployable artifacts.
product: Anvil Cloud
section: Getting started
order: 110
---

# Quickstart

Use this flow to run the checked-in Notes Cell, inspect the generated output,
and understand what is safe to trust before a preview deploy.

Anvil Cloud is alpha. The intended published command is `anvil cloud ...`
through the umbrella `@anvilstack/cli` wrapper. The Cloud product package is
`@anvilstack/cloud-cli`, and from a local checkout you run the same command
contract through `pnpm anvil-cloud` or the built CLI entrypoint.

## 1) Prepare the checkout

From `anvil-cloud`:

```bash
pnpm install --ignore-scripts
pnpm build
pnpm anvil-cloud --help
```

If dependencies are already installed, `pnpm build` is enough to refresh the
package output used by the CLI. `pnpm anvil-cloud` runs the built CLI entrypoint
from the workspace root.

## 2) Run the canonical Notes Cell first

The fastest useful path is the checked-in `examples/notes` Cell. It exercises a
React/Vite client, local auth, database queries and mutations, a public
endpoint, jobs, workflows, generated client metadata, CLI JSON, and Lens.

```bash
cd examples/notes
node ../../packages/cli/dist/index.js check --json
node ../../packages/cli/dist/index.js build --json
```

For a repeatable smoke test, run this from the `anvil-cloud` workspace:

```bash
pnpm verify:notes-local
```

The verifier starts `anvil cloud dev` on ephemeral ports, creates a local user, mints
a JWT, calls authenticated note mutation/query routes, checks local inspect and
logs, and then shuts the dev server down.

## 3) Install the published CLI shape

For normal command-line usage, install the umbrella wrapper and the Cloud
product CLI:

```bash
npm install --global @anvilstack/cli
npm install --global @anvilstack/cloud-cli

anvil cloud check --json
```

`@anvilstack/cli` dispatches to the installed product CLI. The direct
`anvil-cloud` binary remains available, but the docs use `anvil cloud ...` as
the front door so the Cloud and Registry commands share one Anvil shape.

## 4) Create a new Cell

From the workspace root during alpha development:

```bash
pnpm anvil cloud new notes
cd notes
```

With the published CLI installed:

```bash
anvil cloud new notes
cd notes
```

Inside a checked-in example such as `examples/notes`, use the relative built
entrypoint:

```bash
node ../../packages/cli/dist/index.js check --json
```

The scaffold creates a React/Vite Cell client and a server entrypoint:

```txt
notes/
  AGENTS.md
  anvil.json
  package.json
  tsconfig.json
  index.html
  vite.config.ts
  src/
    cell.server.ts
    client/
      App.tsx
      main.tsx
      styles.css
```

The generated server defines a small database-backed example. The client imports
generated metadata from `@anvil/generated/client` and calls it through
`@anvil-cloud/client`.

## 5) Check before build

```bash
anvil cloud check --json
```

In local workspace development, when the Cell lives directly under the repo root:

```bash
node ../packages/cli/dist/index.js check --json
```

`check` validates:

- Cell config
- import policy
- direct `process.env` access
- provider infrastructure imports such as AWS SDK, CDK, SST, CDKTF, and Pulumi
- undeclared global `fetch`
- outbound fetch hosts against `capabilities.outboundFetch.allow`
- scheduled jobs without `capabilities.scheduledJobs`
- handler capability use
- TypeScript typecheck
- manifest extraction readiness

Fix check failures before trying to run or deploy. Guard diagnostics are the
first trust boundary; do not treat them as decorative lint.

## 6) Build artifacts

```bash
anvil cloud build --json
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

The manifest is the key handoff to local runtime and deployment adapters. The
generated client output is the handoff to the browser UI.

## 7) Run locally

```bash
anvil cloud dev
```

Default local URLs:

| Surface | URL                     |
| ------- | ----------------------- |
| Runtime | `http://localhost:8787` |
| Client  | `http://localhost:5173` |

Useful local routes:

```txt
GET  /_anvil/health
GET  /_anvil/manifest
GET  /_anvil/inspect
GET  /_anvil/lens
POST /_anvil/query/:name
POST /_anvil/mutation/:name
POST /_anvil/workflows/run/:name
GET  /_anvil/workflows
GET  /_anvil/services
ANY  /api/*
```

For automation:

```bash
anvil cloud dev --json
anvil cloud dev --agent --json
```

Agent mode emits JSONL events and avoids spinners, terminal control codes, and
unstable prose.

## 8) Inspect local state

```bash
anvil cloud inspect --local --json
anvil cloud logs --local --json
anvil cloud db list --local --json
anvil cloud db dump notes --local --json
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
  schedules.json
  services.json
  workflows.json
```

Open Lens while the dev server is running:

```bash
anvil cloud lens --json
```

Lens is local inspection UI over the same JSON truth used by CLI commands:
manifest, capabilities, auth users, database state, logs, workflows, services,
and recent diagnostics.

## 9) Preview deployment

```bash
anvil cloud deploy --preview --json
```

Without AWS provisioning configuration, the preview adapter returns a stable
deployment plan, CloudFormation template, and deploy artifact summary rather
than mutating an AWS account.

Use `examples/aws-preview` for the current AWS smoke path. The canonical Notes
Cell intentionally includes workflows. They run locally and map to AWS preview
Step Functions resources, but remote workflow run inspection is still maturing.

To provision preview infrastructure, configure the AWS adapter environment described in [AWS preview](/docs/cloud/aws-preview).

## Read next

- [Cell contract](/docs/cloud/cell-contract)
- [Local runtime](/docs/cloud/local-runtime)
- [Builder and Guard](/docs/cloud/builder-and-guard)
- [CLI reference](/docs/cloud/cli-reference)
