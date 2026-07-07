---
title: Cell contract
navTitle: Cell contract
description: The Anvil Cell app DSL, schema, handlers, capabilities, and generated manifest shape.
product: Anvil Cloud
section: Architecture
order: 115
---

# Cell contract

An Anvil Cell is a small TypeScript app unit. It default-exports an `app()` definition from the server entrypoint.

The contract is intentionally smaller than a cloud provider. Cell code declares application behavior and capabilities; deployment adapters translate those concepts into provider resources.

## Project shape

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

`anvil.json` points at the server and client entrypoints:

```json
{
  "name": "notes",
  "entrypoints": {
    "server": "src/cell.server.ts",
    "client": "src/client/main.tsx"
  },
  "runtime": "nodejs20",
  "region": "eu-west-2"
}
```

## Server definition

```ts
import {
  app,
  boolean,
  mutation,
  query,
  table,
  text,
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
      handler: async (ctx) => {
        return ctx.db.todos.where("ownerId", "=", ctx.auth.requireUser()).all();
      },
    }),
  },
  mutations: {
    addTodo: mutation<{ text: string }>({
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

## Supported definition types

| Definition                  | Purpose                                                                                                   |
| --------------------------- | --------------------------------------------------------------------------------------------------------- |
| `app`                       | Root Cell definition containing schema, capabilities, handlers, endpoints, jobs, workflows, and services. |
| `table`                     | Declares a table in the Cell schema.                                                                      |
| `text`, `boolean`, `userId` | Current field builders.                                                                                   |
| `query`                     | Read-oriented named server function.                                                                      |
| `mutation`                  | Write-oriented named server function.                                                                     |
| `endpoint`                  | Declared HTTP route with method, path, optional auth mode, and handler.                                   |
| `job`                       | Named background handler, optionally scheduled.                                                           |
| `workflow`                  | Durable ordered steps with retries, timeouts, and persisted run state.                                    |
| `service`                   | Supervised long-running local handler with restart policy.                                                |

## Capabilities

Capabilities declare what the Cell expects from the runtime host and deployment adapter.

Current examples include:

```ts
capabilities: {
  database: true,
  files: { publicRead: false },
  outboundFetch: {
    allow: ["api.example.com"]
  },
  scheduledJobs: true,
  jobs: true,
  events: true,
  workflows: true,
  services: true
}
```

Guard checks use these declarations to reject direct provider access and
undeclared effects where alpha can detect them.

## Manifest output

The builder imports the server bundle and extracts a manifest.

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
    "tables": []
  },
  "queries": ["listTodos"],
  "mutations": ["addTodo"],
  "endpoints": [],
  "jobs": [],
  "workflows": [],
  "services": [],
  "capabilities": {
    "database": true
  }
}
```

Adapters should consume the manifest rather than crawling arbitrary source.

## Contract rules

- App code should use `ctx`, not provider SDKs.
- Server code should stay statically inspectable.
- Dynamic import is forbidden in Cell server code.
- Direct `process.env` access is forbidden. Use `ctx.env`.
- `fs` and `node:fs` are forbidden. Use `ctx.files`.
- `child_process` is forbidden. Move background work into declared jobs.
- `@aws-sdk/*`, `aws-cdk-lib`, `sst`, `cdktf`, and `pulumi` are forbidden in Cell server code.
- Global `fetch` requires `capabilities.outboundFetch`, and static absolute
  URL hosts must be listed in `capabilities.outboundFetch.allow`. Local runtime
  request handlers and workflow steps, plus AWS preview, reject undeclared hosts
  with `OUTBOUND_FETCH_NOT_ALLOWED`.
- Handler use of `ctx.db`, `ctx.files`, `ctx.events`, `ctx.jobs`, and
  `ctx.workflows` must match declared capabilities where Guard can inspect it.

The restrictions are not there to be fancy. They keep the app contract small enough for people and agents to reason about.
