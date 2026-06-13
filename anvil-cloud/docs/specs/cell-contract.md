# Anvil Cell Contract

## Purpose

An Anvil Cell is the deployable unit of Anvil Cloud. It contains the application code and declarations needed for local execution and provider-adapter deployment.

The contract must be small enough for agents to work inside safely and explicit enough for Anvil Builder, Anvil Guard, and Anvil Lens to inspect.

## Required files

```txt
src/cell.server.ts
src/client/main.tsx
src/client/App.tsx
index.html
vite.config.ts
anvil.json
package.json
tsconfig.json
AGENTS.md
```

## Optional files

```txt
src/shared.ts
src/components/*
public/*
.env.local
```

## `anvil.json`

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

## Server entrypoint

The server entrypoint must default-export an app definition.

```ts
import { app } from "@anvil-cloud/runtime";

export default app({
  schema: {},
  capabilities: {},
  queries: {},
  mutations: {},
  endpoints: {},
  jobs: {},
});
```

## Client entrypoint

The default Cell UI stack is Vite + React. The client entrypoint should render
a React app from `src/client/main.tsx`, with `index.html` providing the browser
mount point.

The client should use `@anvil-cloud/client` instead of manually constructing runtime URLs.
Generated API metadata should be imported through the stable Vite alias:

```ts
import { api } from "@anvil/generated/client";
```

Other browser frameworks can still work if they produce static assets and call
the Anvil runtime through `@anvil-cloud/client`, but React is the paved-road
template.

## Schema

Schema describes Cell-owned data tables.

```ts
schema: {
  notes: table({
    title: text().min(1).max(100),
    body: text().max(5000),
    ownerId: userId(),
  });
}
```

## Queries

Queries read server-authoritative data.

```ts
queries: {
  listNotes: query({
    input: {},
    handler: async (ctx) => {
      return ctx.db.notes.where("ownerId", "=", ctx.auth.requireUser()).all();
    },
  });
}
```

## Mutations

Mutations write server-authoritative data.

```ts
mutations: {
  createNote: mutation({
    input: {
      title: text().min(1).max(100),
      body: text().max(5000),
    },
    handler: async (ctx, input) => {
      return ctx.db.notes.insert({
        ...input,
        ownerId: ctx.auth.requireUser(),
      });
    },
  });
}
```

## Endpoints

Endpoints expose HTTP routes.

```ts
endpoints: {
  webhook: endpoint({
    method: "POST",
    path: "/api/webhook",
    auth: "none",
    handler: async (ctx, request) => {
      ctx.log.info("Webhook received");
      return Response.json({ ok: true });
    },
  });
}
```

## Jobs

Jobs are named background handlers.

```ts
jobs: {
  refreshData: job({
    schedule: "rate(1 hour)",
    handler: async (ctx) => {
      ctx.log.info("Refreshing data");
    },
  });
}
```

## Capabilities

Cells must declare capabilities before using runtime features that map to cloud resources or privileged operations.

```ts
capabilities: {
  database: true,
  files: {
    publicRead: false,
    maxObjectSizeMb: 25
  },
  outboundFetch: {
    allow: ["api.openai.com"]
  },
  scheduledJobs: true
}
```

## Forbidden Cell behaviours

- Direct AWS SDK imports.
- Direct cloud infrastructure authoring.
- Direct `process.env` access.
- Raw filesystem writes for persistent app data.
- Background work outside declared jobs.
- Network access to undeclared outbound domains.
- Top-level runtime side effects in app definition modules.

## Manifest extraction requirements

The server entrypoint must be safe to import during build analysis.

The builder should be able to extract:

- schema;
- query names;
- mutation names;
- endpoint methods and paths;
- job names/schedules;
- capabilities;
- env declarations.

Handler bodies should not execute during manifest extraction.
