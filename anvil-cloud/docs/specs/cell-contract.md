# Anvil Cell Contract

## Purpose

An Anvil Cell is the deployable unit of Anvil Cloud. It contains the application code and declarations needed for local execution and provider-adapter deployment.

The contract must be small enough for agents to work inside safely and explicit enough for Anvil Builder, Anvil Guard, and Anvil Lens to inspect.

## Required files

```txt
src/cell.server.ts
anvil.json
package.json
tsconfig.json
AGENTS.md
```

The default `vite-react` client target also includes:

```txt
src/client/main.tsx
src/client/App.tsx
index.html
vite.config.ts
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
  "client": {
    "kind": "vite-react"
  },
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

`client.kind` declares the client target. It is part of the authoring/build
contract, not a deployment adapter. Valid alpha values are:

| Kind          | Meaning                                              |
| ------------- | ---------------------------------------------------- |
| `vite-react`  | Browser client bundled by Anvil Builder through Vite |
| `expo-router` | Expo Router app that calls the Anvil runtime         |
| `headless`    | Generated client metadata only, no bundled UI        |

The default Cell UI stack is `vite-react`. Its client entrypoint should render
a React app from `src/client/main.tsx`, with `index.html` providing the browser
mount point. `expo-router` Cells use an `app/index.tsx` entrypoint and run the
native client through Expo; Anvil Builder still emits the server bundle,
manifest, generated client metadata, and build metadata, but does not bundle an
Expo app.

Expo Router clients should read the runtime URL from
`EXPO_PUBLIC_ANVIL_RUNTIME_URL`. Generated scaffolds use local fallbacks for the
common simulator paths: `http://localhost:8787` outside Android and
`http://10.0.2.2:8787` on Android emulators. The scaffold types that public
runtime variable in `src/expo-env.d.ts`; Expo remains a client target, not a
deployment adapter.

The client should use `@anvil-cloud/client` instead of manually constructing runtime URLs.
Generated API metadata should be imported through the stable alias:

```ts
import { api, createAnvilApiClient } from "@anvil/generated/client";

const client = createAnvilApiClient();
```

Cells can type generated routes by adding a local declaration file, commonly
`src/anvil-api.d.ts`, that augments the generated route maps:

```ts
declare module "@anvil/generated/client" {
  interface QueryTypes {
    listNotes: {
      input: unknown;
      result: Note[];
    };
  }
}
```

The metadata object remains the runtime contract; the route maps are TypeScript
only and are consumed by `createAnvilApiClient`, `createApiClient`, and
`createAnvilHooks`. Generated clients also include `api.meta` with schema
version `0.1` plus stable query and mutation name arrays so tooling can compare
generated metadata with the built manifest without scraping route definitions.

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
    overlap: "skip",
    timeoutMs: 30_000,
    handler: async (ctx) => {
      ctx.log.info("Refreshing data");
    },
  });
}
```

Scheduled jobs support `rate(1 hour)`, `@every 5m`, and five-field cron syntax
locally. The local runtime persists schedule state and run history in
`.anvil/local/schedules.json`; missed runs while the runtime is stopped are
skipped rather than replayed.

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
  jobs: true,
  scheduledJobs: true
}
```

## Forbidden Cell behaviours

- Direct AWS SDK imports.
- Direct cloud infrastructure authoring.
- Direct `process.env` access, including `globalThis.process`, aliased
  `process`, or destructured `env` access.
- Direct file-system imports for persistent app data, including `fs/promises`,
  `node:fs/promises`, and CommonJS `require()` forms.
- Background work outside declared jobs.
- Direct network client imports such as `http`, `https`, `node:net`, `undici`,
  or `axios`; use `fetch()` with `capabilities.outboundFetch.allow` instead.
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
