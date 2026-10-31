---
title: Quickstart
navTitle: Quickstart
description: Run the Notes example locally, add and read data, and inspect the app before trying a deployment.
product: Mezair Cloud
section: Start here
journey: build
order: 20
---

# Quickstart

Run the Notes example to see a working app before setting up cloud hosting. You will start a local server, test sign-in, add and read notes, and inspect the app in your browser.

These instructions use the checked-out source, so the commands work without a published package or a cloud account. Build the command-line tool once, then run it from the example folder.

Coding agents can read the short contract at `/llms.txt` or the full authoring
guide at `/llms-full.txt`. The same files are bundled under `docs/` in the
published Cloud CLI package so an installed project can be inspected offline.

## Set it up with your agent

Copy this prompt into your coding agent to run the Notes example locally.

```prompt
Help me run the Mezair Cloud Notes example locally.

Follow https://mezair.dev/docs/cloud/quickstart. Use an existing Mezair checkout if available; otherwise clone https://github.com/anthonyhumphreys/mezair into a new directory. Install and build inside mezair-cloud, then check, build and start examples/notes using the current CLI.

Keep this local: do not create cloud resources. Check the runtime health endpoint, add and read a note, and show me the client and Lens URLs. Explain which process to stop when I am done and where the example stores its local data.
```

## 1) Prepare the checkout

From `mezair-cloud`:

```bash
pnpm install --ignore-scripts
pnpm build
pnpm mezair-cloud --help
```

If dependencies are already installed, `pnpm build` is enough to refresh the
package output used by the CLI. `pnpm mezair-cloud` runs the built CLI entrypoint
from the workspace root.

## 2) Run the Notes Cell

The fastest useful path is the checked-in `examples/notes` Cell. It exercises a
React/Vite client, local auth, database queries and mutations, a public
endpoint, jobs, workflows, generated client metadata, CLI JSON, and Lens.

```bash
cd examples/notes
node ../../packages/cli/dist/index.js check --json
node ../../packages/cli/dist/index.js build --json
```

## 3) Install the CLI

For normal command-line usage, install the umbrella wrapper and the Cloud
product CLI:

```bash
npm install --global @mezairstack/cli
npm install --global @mezairstack/cloud-cli

mezair cloud check --json
```

`@mezairstack/cli` dispatches to the installed product CLI. The direct
`mezair-cloud` binary remains available, but the docs use `mezair cloud ...` as
the front door so the Cloud and Registry commands share one Mezair shape.

## 4) Create a new Cell

From the workspace root during beta development:

```bash
pnpm mezair-cloud new notes
cd notes
```

Without a local workspace checkout, run the published CLI via `pnpm dlx`:

```bash
pnpm dlx @mezairstack/cloud-cli new notes
cd notes
```

The package name is `@mezairstack/cloud-cli`; it exposes the `mezair-cloud`
binary. In human mode, `new` installs dependencies, runs `git init`, prints the
Lens URL, and starts the local dev server. Use `--json` when you want a finite
machine-readable scaffold result for an agent run.

Inside a checked-in example such as `examples/notes`, use the relative built
entrypoint:

```bash
node ../../packages/cli/dist/index.js check --json
```

The scaffold creates a React/Vite Cell client and a server entrypoint:

```txt
notes/
  AGENTS.md
  mezair.json
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
generated metadata from `@mezair/generated/client` and calls it through
`@mezair-cloud/client`.

## 5) Check before build

```bash
mezair cloud check --json
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
mezair cloud build --json
```

The builder writes:

```txt
.mezair/
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
mezair cloud dev
```

Default local URLs:

| Surface | URL                     |
| ------- | ----------------------- |
| Runtime | `http://localhost:8787` |
| Client  | `http://localhost:5173` |

Useful local routes:

```txt
GET  /_mezair/health
GET  /_mezair/manifest
GET  /_mezair/inspect
GET  /_mezair/lens
POST /_mezair/query/:name
POST /_mezair/mutation/:name
POST /_mezair/workflows/run/:name
GET  /_mezair/workflows
GET  /_mezair/services
ANY  /api/*
```

For automation:

```bash
mezair cloud dev --json
mezair cloud dev --agent --json
```

Agent mode emits JSONL events and avoids spinners, terminal control codes, and
unstable prose.

## 8) Inspect local state

```bash
mezair cloud inspect --local --json
mezair cloud logs --local --json
mezair cloud db list --local --json
mezair cloud db dump notes --local --json
```

Local state is stored under `.mezair/local`:

```txt
.mezair/local/
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
mezair cloud lens --json
```

Lens is local inspection UI over the same JSON truth used by CLI commands:
manifest, capabilities, auth users, database state, logs, workflows, services,
and recent diagnostics.

## 9) Preview deployment

```bash
mezair cloud deploy --preview --json
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
