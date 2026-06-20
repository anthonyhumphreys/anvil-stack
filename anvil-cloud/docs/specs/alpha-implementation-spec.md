# Anvil Cloud Alpha Implementation Spec

## Summary

Anvil Cloud alpha proves a small, agent-friendly, provider-neutral application model before adding broad deployment features.

The alpha product is a local-first TypeScript platform where a developer or coding agent can create an **Anvil Cell**, run it locally, inspect its state, and build deployable artefacts. Deployment adapters build on the local runtime and builder. AWS is the first planned adapter.

## Goals

- Define the Anvil Cell app contract.
- Implement a shared runtime request model.
- Implement local dev with auth, database, logs, files, jobs, and inspector support.
- Implement a builder that emits server bundle, client bundle, manifest, and generated client metadata.
- Implement a CLI with human-readable and JSON output modes.
- Implement capability declarations and basic policy checks.
- Define a deployment adapter contract.
- Implement a first AWS adapter against that contract.

## Non-goals

- No arbitrary cloud resource authoring in Cell code.
- No raw container or Kubernetes authoring in Cell code. Long-running work is expressed through the `service` primitive (supervised handlers, executed locally in alpha); container-backed execution (for example ECS/Fargate) arrives later as a deployment adapter concern, never as a Cell-level API.
- No second production cloud adapter during alpha.
- No provider-specific assumptions in the core runtime, builder, manifest, or client SDK.
- No raw Terraform/CDK/SST authoring surface for Cell authors.
- No enterprise networking/VPC support.
- No production marketplace or hosted control plane during alpha.
- No perfect JavaScript sandbox. Safety comes from capability scoping, adapter-generated provider policy, runtime adapters, import restrictions, and deployment isolation.

## Product concepts

### Anvil Cloud

The overall platform.

### Anvil Cell

A deployable app unit containing:

- server functions;
- client UI;
- schema;
- endpoints;
- jobs;
- files capability;
- auth assumptions;
- environment variables;
- declared capabilities.

### Anvil Runtime

The execution layer used by local dev, tests, and deployment adapters.

### Anvil Builder

The compiler and bundler that turns Cell source into:

- server bundle;
- client bundle;
- manifest;
- generated client definitions;
- build metadata.

### Anvil Local

The local development runtime and adapters.

### Anvil Guard

Capability, import, policy, and deploy safety checks.

### Anvil Lens

Inspection surface for logs, database state, manifest, runtime status, and diagnostic summaries.

## Alpha golden path

```sh
pnpm create anvil-cloud notes
cd notes
anvil-cloud dev
anvil-cloud check --json
anvil-cloud inspect --local --json
anvil-cloud build
anvil-cloud deploy --preview --json
```

The initial implementation may use `anvil-cloud new notes` before a package initializer exists.

## Cell project structure

```txt
notes/
├── AGENTS.md
├── anvil.json
├── package.json
├── src/
│   ├── cell.client.tsx
│   ├── cell.server.ts
│   └── shared.ts
└── tsconfig.json
```

## Example Cell server

```ts
import {
  app,
  mutation,
  query,
  table,
  text,
  boolean,
  userId,
} from "@anvil-cloud/runtime";

export default app({
  schema: {
    todos: table({
      text: text().min(1).max(500),
      done: boolean().default(false),
      ownerId: userId(),
    }),
  },
  capabilities: {
    database: true,
  },
  queries: {
    listTodos: query({
      input: {},
      handler: async (ctx) => {
        return ctx.db.todos.where("ownerId", "=", ctx.auth.requireUser()).all();
      },
    }),
  },
  mutations: {
    addTodo: mutation({
      input: {
        text: text().min(1).max(500),
      },
      handler: async (ctx, input) => {
        return ctx.db.todos.insert({
          text: input.text,
          done: false,
          ownerId: ctx.auth.requireUser(),
        });
      },
    }),
  },
});
```

## Runtime request model

All triggers are normalised to `RuntimeRequest` before user code runs.

```ts
export type RuntimeRequest =
  | {
      kind: "query";
      name: string;
      input: unknown;
      auth: AuthIdentity | null;
      requestId: string;
    }
  | {
      kind: "mutation";
      name: string;
      input: unknown;
      auth: AuthIdentity | null;
      requestId: string;
    }
  | {
      kind: "endpoint";
      method: string;
      path: string;
      headers: Record<string, string>;
      body: Uint8Array | null;
      auth: AuthIdentity | null;
      requestId: string;
    }
  | {
      kind: "job";
      name: string;
      payload: unknown;
      requestId: string;
    };
```

## Runtime context

Cell handlers receive a `ctx` object. This is the application-facing cloud abstraction.

```ts
export type RuntimeContext = {
  auth: AuthContext;
  db: DatabaseClient;
  files: FileClient;
  env: EnvClient;
  log: LogClient;
  events: EventClient;
  jobs: JobClient;
  request: RequestContext;
};
```

Cell authors should use `ctx` rather than direct platform APIs.

## Runtime host contract

Runtime host adapters provide implementations for local, test, and deployed execution.

```ts
export interface RuntimeHost {
  db: DatabaseAdapter;
  files: FileAdapter;
  env: EnvAdapter;
  auth: AuthAdapter;
  logs: LogAdapter;
  events: EventAdapter;
  jobs: JobAdapter;
}
```

## Runtime execution API

```ts
export async function handleRuntimeRequest(
  app: AppDefinition,
  host: RuntimeHost,
  request: RuntimeRequest,
): Promise<RuntimeResponse>;
```

This function is the core execution boundary and should be shared by local dev, tests, and deployment adapters.

## Builder output

`anvil-cloud build` writes:

```txt
.anvil/
├── dist/
│   ├── client/
│   │   ├── index.html
│   │   └── assets/
│   ├── server/
│   │   ├── index.mjs
│   │   └── index.mjs.map
│   ├── manifest.json
│   └── build-meta.json
└── generated/
    ├── api.d.ts
    └── client.ts
```

## Manifest shape

```json
{
  "schemaVersion": "0.1",
  "cell": {
    "name": "notes",
    "runtime": "nodejs20",
    "target": "local"
  },
  "entrypoints": {
    "server": "dist/server/index.mjs",
    "client": "dist/client/index.html"
  },
  "schema": {
    "tables": {}
  },
  "queries": [],
  "mutations": [],
  "endpoints": [],
  "jobs": [],
  "capabilities": {}
}
```

## Local dev requirements

`anvil-cloud dev` starts:

- local runtime server;
- client dev server;
- local database adapter;
- local auth emulator;
- local file adapter;
- local job runner;
- local inspector API;
- structured log stream.

Default ports:

- client: `5173`;
- runtime: `8787`.

Local state lives in `.anvil/local/`.

```txt
.anvil/local/
├── dev.db
├── files/
├── logs.ndjson
├── jobs.json
└── auth.json
```

## Local runtime routes

```txt
POST /_anvil/query/:name
POST /_anvil/mutation/:name
ANY  /api/*
GET  /_anvil/health
GET  /_anvil/manifest
GET  /_anvil/inspect
GET  /_anvil/logs
GET  /_anvil/db/tables
GET  /_anvil/db/:table
POST /_anvil/auth/as/:userId
```

Production inspection routes must not be exposed publicly. Remote inspection should go through CLI/control-plane APIs.

## Alpha CLI commands

```txt
anvil-cloud new <name>
anvil-cloud dev [--json] [--agent]
anvil-cloud check [--json]
anvil-cloud build [--json]
anvil-cloud inspect [--local] [--json]
anvil-cloud logs [--local] [--json]
anvil-cloud db list [--local] [--json]
anvil-cloud db dump <table> [--local] [--json]
anvil-cloud deploy --preview [--json]
```

Every automation-oriented command must support `--json`.

## JSON diagnostic shape

```json
{
  "ok": false,
  "errors": [
    {
      "code": "FORBIDDEN_IMPORT",
      "message": "Import '@aws-sdk/client-s3' is not allowed. Use ctx.files instead.",
      "file": "src/cell.server.ts",
      "line": 3,
      "column": 1
    }
  ]
}
```

## Import restrictions

Forbidden in Cell server code by default:

- direct cloud provider SDK imports;
- `fs`;
- `child_process`;
- arbitrary network clients where capability is not declared;
- direct `process.env` access;
- dynamic import for runtime-sensitive code;
- native addons.

Initial capability diagnostics should catch common static cases before bundling:

- `ctx.db` requires `capabilities.database`;
- `ctx.files` requires `capabilities.files`;
- `ctx.jobs` requires `capabilities.jobs`;
- global `fetch()` requires `capabilities.outboundFetch`;
- `fetch()` targets must be static absolute `http` or `https` URL literals;
- `job({ schedule })` requires `capabilities.scheduledJobs`.

Allowed:

- `@anvil-cloud/runtime`;
- local shared modules;
- approved runtime-safe dependencies;
- dependencies explicitly permitted by project config.

## Capabilities

Cells declare capabilities. Capabilities are used for local adapter configuration, deployment adapter planning, provider policy generation, and deploy review.

Example:

```ts
capabilities: {
  database: true,
  files: {
    publicRead: false,
    maxObjectSizeMb: 25
  },
  outboundFetch: {
    allow: ["api.openai.com", "stripe.com"]
  },
  scheduledJobs: true
}
```

## Deployment adapter contract

The core manifest and runtime contract must remain provider-neutral. Deployment adapters map Anvil concepts to provider resources after `anvil-cloud build` has produced artefacts.

The adapter contract should cover:

- runtime host implementation;
- trigger translation into `RuntimeRequest`;
- `RuntimeResponse` translation back to the provider;
- deployment plan generation;
- artefact upload;
- capability-to-resource mapping;
- logs and inspection readers;
- policy inputs for Anvil Guard.

| Anvil concept      | Adapter responsibility                         |
| ------------------ | ---------------------------------------------- |
| Client bundle      | Serve static client assets                     |
| Server runtime     | Execute server handlers                        |
| Query/mutation API | Expose runtime RPC routes                      |
| Custom endpoints   | Expose declared HTTP routes                    |
| Database           | Store Cell table data                          |
| Files              | Store Cell-owned objects                       |
| Env/secrets        | Provide config and secrets                     |
| Logs               | Store structured runtime logs                  |
| Jobs               | Invoke scheduled or queued jobs                |
| Audit/deploy state | Store deployment state and manifest references |

AWS is the first planned alpha adapter. Its concrete service mapping belongs in `docs/architecture/aws-adapter.md`, not in the core Cell contract.

## Alpha acceptance criteria

### Milestone 1: runtime DSL

- `app`, `query`, `mutation`, `endpoint`, and `table` primitives exist.
- App definitions are inspectable without executing handlers.
- Runtime request handling executes query and mutation handlers with a test host.

### Milestone 2: local runtime

- `anvil-cloud dev` runs a local server.
- Queries and mutations are callable over HTTP.
- Local auth can switch users.
- Local logs are written as NDJSON.
- Local inspect endpoint returns manifest, runtime status, auth status, and table counts.

### Milestone 3: builder

- `anvil-cloud build` emits server bundle, client bundle, manifest, generated client metadata, and build metadata.
- Forbidden import checks run before bundle output.
- Manifest includes schema, queries, mutations, endpoints, jobs, and capabilities.

### Milestone 4: client SDK

- Generated client definitions are consumable by the default React/Vite Cell
  client.
- `useQuery` and `useMutation` work against local runtime.
- Token lookup, structured runtime errors, and manual query refetch are
  documented around the canonical Notes demo.

### Milestone 5: deployment adapter contract

- A provider-neutral deployment adapter interface is specified.
- Deployment plans use stable JSON shapes before provisioning.
- Core manifest, builder, runtime, and client SDK stay provider-neutral.

### Milestone 6: AWS preview adapter

- `anvil-cloud deploy --preview --json` deploys one Cell through the AWS adapter.
- Deployed Cell can serve client assets and query/mutation endpoints.
- Remote logs and manifest can be inspected through CLI.

## Open decisions

- Additional starter templates beyond the default Vite + React Cell.
- Zod, Valibot, or custom schema DSL.
- Hono vs Fastify for local/runtime HTTP layer.
- SQLite-only local DB vs optional DynamoDB Local mode.
- AWS adapter internals: SST vs CDK.
- Whether the first non-AWS adapter should be a local static/runtime bundle, Fly.io, Cloudflare, or another target after alpha.
