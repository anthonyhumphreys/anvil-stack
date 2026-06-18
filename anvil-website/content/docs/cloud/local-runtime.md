---
title: Local runtime
navTitle: Local runtime
description: How Anvil Local runs Cells, stores local state, exposes runtime routes, and supports inspection.
product: Anvil Cloud
section: Runtime
order: 125
---

# Local runtime

Anvil Local runs a built Cell without a cloud provider.

It uses the same `handleRuntimeRequest` boundary as deployment adapters, then
provides local implementations for database, files, env, auth, logs, events,
jobs, workflows, and supervised services.

## What starts with `anvil dev`

`anvil dev` runs a build first. If the build passes, it imports the server bundle, loads the manifest, and starts:

- local runtime HTTP server
- local client asset server
- local agent runtime with the deterministic stub provider registered by default
- JSON database adapter
- local file adapter
- local environment adapter
- local auth adapter
- local log adapter
- local event adapter
- local job adapter
- local workflow adapter
- local service supervisor

Default ports:

| Surface | Default |
| --- | --- |
| Runtime | `8787` |
| Client | `5173` |

Options:

```bash
anvil dev --port 8787 --client-port 5173
anvil dev --json
anvil dev --agent --json
```

## Local routes

The local runtime exposes:

```txt
POST /_anvil/query/:name
POST /_anvil/mutation/:name
ANY  /api/*
GET  /_anvil/health
GET  /_anvil/manifest
GET  /_anvil/inspect
GET  /_anvil/lens
GET  /_anvil/agents
POST /_anvil/agents/:name
POST /_anvil/workflows/run/:name
GET  /_anvil/workflows
GET  /_anvil/workflows/:runId
GET  /_anvil/services
POST /_anvil/services/:name/start
POST /_anvil/services/:name/stop
```

Endpoint requests under `/api/*` are translated into endpoint runtime requests and matched against declared Cell endpoints.

Agent requests under `/_anvil/agents/:name` invoke mounted Cell Agents through
the same provider-neutral `AgentRuntime` used by tests and provider mode. The
local stub inference provider is registered automatically for `provider: "local"`.

## Local state

Local state lives in `.anvil/local` by default:

```txt
.anvil/local/
  auth.json
  dev.db
  events.json
  files/
  jobs.json
  logs.ndjson
  services.json
  workflows.json
```

The current database adapter stores JSON records in `dev.db`. It is intentionally simple, inspectable, and suited to alpha local development.

## Database behavior

`ctx.db.<table>` supports table operations through the local JSON adapter:

- `all`
- `get`
- `insert`
- `update`
- `delete`
- `where(...).all`
- `where(...).first`
- `where(...).count`

Inspection commands:

```bash
anvil db list --local --json
anvil db dump notes --local --json
```

## Files

`ctx.files` stores local file data under `.anvil/local/files`.

Supported operations:

- `get`
- `put`
- `delete`

Deployment adapters map the same capability to their own backing store.

## Auth

Local auth state is stored in `.anvil/local/auth.json`.

Handlers can use `ctx.auth.requireUser()` to require a current local user. Local auth is a development emulator; production auth belongs behind configured OIDC providers.

## Logs

Local logs are NDJSON in `.anvil/local/logs.ndjson`.

Read them with:

```bash
anvil logs --local --json
```

Runtime errors include request id, handler kind, handler name, message, and error metadata.

## Workflows

Local workflows persist state to `.anvil/local/workflows.json`. The runtime
records each step transition so a `running` workflow can resume when the local
server starts again.

Useful commands:

```bash
anvil workflows list --json
anvil workflows show <runId> --json
anvil workflows run <name> --input '{"example":true}' --json
```

## Services

Local services run under the runtime service supervisor. Service state snapshots
are written to `.anvil/local/services.json`.

```bash
anvil services list --json
```

For live state while the dev server is running, use the local Lens UI or
`GET /_anvil/services`.

## Inspection

Use:

```bash
anvil inspect --local --json
```

The local inspection payload includes:

- build status
- manifest
- current auth user
- table row counts
- recent runtime errors
- declared workflows and recent run state
- service state when recorded

The value of local runtime is not that it perfectly mimics a provider. The value is that the app contract can be executed and inspected before adapter behavior enters the conversation.
