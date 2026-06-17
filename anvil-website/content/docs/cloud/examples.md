---
title: Examples
navTitle: Examples
description: Walk through the notes example and common Anvil Cell patterns.
product: Anvil Cloud
section: Getting started
order: 112
---

# Examples

The `anvil-cloud` repository includes two examples that serve different jobs:

| Example | Use it for |
| --- | --- |
| `examples/notes` | Canonical local-first demo: React/Vite UI, auth, database, query, mutation, endpoint, job, workflow, generated client, local Lens, and CLI JSON. |
| `examples/aws-preview` | AWS-compatible smoke Cell for preview deploy, inspect, logs, auth rejection, and destroy. It avoids local-only workflow/service/outbound-fetch declarations. |

Start with `examples/notes` when learning the Cell model. Use
`examples/aws-preview` when validating AWS preview behavior.

## Notes example

The notes Cell defines:

- a `notes` table with `title`, `body`, `archived`, and `ownerId`
- a public `status` query
- an authenticated `listNotes` query
- authenticated `createNote` and `archiveNote` mutations
- a public `/api/health` endpoint
- a `summarizeNote` job
- an `onboardUser` workflow
- a React/Vite client that uses generated query/mutation metadata

```ts
import {
  app,
  boolean,
  endpoint,
  job,
  mutation,
  query,
  table,
  text,
  userId,
  workflow,
} from "@anvil-cloud/runtime";

export default app({
  schema: {
    notes: table({
      title: text().min(1).max(120),
      body: text().max(2000).optional(),
      archived: boolean().default(false),
      ownerId: userId(),
    })
  },
  capabilities: {
    database: true,
    jobs: true,
    workflows: true,
  },
  queries: {
    status: query({
      auth: "public",
      handler: async () => ({ ok: true, cell: "notes" }),
    }),
    listNotes: query({
      auth: "required",
      handler: async (ctx) => {
        return ctx.db.notes
          .where("ownerId", "=", ctx.auth.requireUser())
          .all();
      },
    }),
  },
  mutations: {
    createNote: mutation<{ title: string; body?: string }>({
      auth: "required",
      handler: async (ctx, input) => {
        const note = await ctx.db.notes.insert({
          title: input.title,
          body: input.body ?? "",
          archived: false,
          ownerId: ctx.auth.requireUser(),
        });

        await ctx.jobs.enqueue("summarizeNote", { noteId: note.id });
        return note;
      },
    }),
  },
  endpoints: {
    health: endpoint({
      method: "GET",
      path: "/api/health",
      auth: "none",
      handler: async () => ({ ok: true, cell: "notes" }),
    }),
  },
  jobs: {
    summarizeNote: job({
      handler: async (ctx, payload) => {
        await ctx.log.info("Summarize note job received", payload);
        return { summarized: true };
      },
    }),
  },
  workflows: {
    onboardUser: workflow({
      steps: [
        {
          name: "seedWelcomeNote",
          handler: async (ctx) => {
            return ctx.db.notes.insert({
              title: "Welcome to Anvil Notes",
              body: "This note was created by a local workflow.",
              archived: false,
              ownerId: ctx.auth.requireUser(),
            });
          },
        },
      ],
    }),
  },
});
```

The full source lives in `examples/notes/src/cell.server.ts`. The client source
is in `examples/notes/src/client`.

## Common patterns

### Filtering with where clauses

```ts
const recent = await ctx.db.notes
  .where("createdAt", ">", Date.now() - 86400000)
  .all();
```

Supported operators: `=`, `!=`, `>`, `>=`, `<`, `<=`.

### Requiring auth

```ts
const userId = ctx.auth.requireUser();
```

Throws `AUTH_REQUIRED` if no user is authenticated.

### Checking roles

```ts
if (!ctx.auth.hasRole("admin")) {
  throw new Error("FORBIDDEN");
}
```

### Using environment variables

```ts
const apiKey = ctx.env.require("OPENAI_API_KEY");
```

Never use `process.env` directly. Guard rejects it.

### Logging

```ts
ctx.log.info("Note created", { noteId: note.id });
```

Logs are written to `.anvil/local/logs.ndjson` locally and CloudWatch in AWS preview.

### File uploads

```ts
capabilities: {
  files: { publicRead: false }
}

// in a mutation or endpoint
await ctx.files.put("uploads/avatar.png", buffer);
const file = await ctx.files.get("uploads/avatar.png");
```

### Outbound fetch

```ts
capabilities: {
  outboundFetch: {
    allow: ["api.stripe.com"]
  }
}

// Guard checks that fetch calls match declared hosts
const res = await fetch("https://api.stripe.com/v1/customers");
```

## Running the example

```bash
cd anvil-cloud/examples/notes
node ../../packages/cli/dist/index.js check --json
node ../../packages/cli/dist/index.js dev --port 8787 --client-port 5173
```

Create a local user and token:

```bash
node ../../packages/cli/dist/index.js auth add-user local_demo \
  --email demo@example.test \
  --roles admin \
  --json

TOKEN=$(node ../../packages/cli/dist/index.js auth token local_demo --json | jq -r .token)
```

Call the runtime directly:

```bash
curl -X POST http://localhost:8787/_anvil/mutation/createNote \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"input":{"title":"Hello","body":"World"}}'

curl -X POST http://localhost:8787/_anvil/query/listNotes \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"input":{}}'
```

Or run the repeatable smoke verifier:

```bash
cd anvil-cloud
pnpm verify:notes-local
```

## Inspecting the example

While `anvil dev` is running:

```bash
node ../../packages/cli/dist/index.js lens --json
node ../../packages/cli/dist/index.js inspect --local --json
node ../../packages/cli/dist/index.js logs --local --json
node ../../packages/cli/dist/index.js db dump notes --local --json
```

## Read next

- [Quickstart](/docs/cloud/quickstart)
- [Cell contract](/docs/cloud/cell-contract)
- [Testing Cells](/docs/cloud/testing-cells)
