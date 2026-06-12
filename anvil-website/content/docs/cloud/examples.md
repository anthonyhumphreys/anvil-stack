---
title: Examples
navTitle: Examples
description: Walk through the notes example and common Anvil Cell patterns.
product: Anvil Cloud
section: Getting started
order: 112
---

# Examples

The `anvil-cloud` repository includes an example Cell under `examples/notes`. It demonstrates a CRUD app with schema, queries, mutations, and local runtime.

## Notes example

The notes Cell defines:

- A `notes` table with `title`, `body`, and `ownerId`.
- A `listNotes` query that returns notes owned by the current user.
- An `addNote` mutation that creates a note.

```ts
import { app, mutation, query, table, text, userId } from "@anvil-cloud/runtime";

export default app({
  schema: {
    notes: table({
      title: text().min(1).max(200),
      body: text().min(1).max(5000),
      ownerId: userId()
    })
  },
  capabilities: {
    database: true
  },
  queries: {
    listNotes: query({
      handler: async (ctx) => {
        return ctx.db.notes
          .where("ownerId", "=", ctx.auth.requireUser())
          .all();
      }
    })
  },
  mutations: {
    addNote: mutation<{ title: string; body: string }>({
      handler: async (ctx, input) => {
        return ctx.db.notes.insert({
          title: input.title,
          body: input.body,
          ownerId: ctx.auth.requireUser()
        });
      }
    })
  }
});
```

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
  files: true
}

// in a mutation or endpoint
await ctx.files.put("uploads/avatar.png", buffer);
const file = await ctx.files.get("uploads/avatar.png");
```

### Outbound fetch

```ts
capabilities: {
  outboundFetch: {
    allowedHosts: ["api.stripe.com"]
  }
}

// Guard checks that fetch calls match declared hosts
const res = await fetch("https://api.stripe.com/v1/customers");
```

## Running the example

```bash
cd anvil-cloud/examples/notes
node ../../packages/cli/dist/index.js check --json
node ../../packages/cli/dist/index.js dev
```

Then:

```bash
curl -X POST http://localhost:8787/_anvil/mutation/addNote \
  -H "Content-Type: application/json" \
  -d '{"title":"Hello","body":"World"}'

curl -X POST http://localhost:8787/_anvil/query/listNotes \
  -H "Content-Type: application/json" \
  -d '{}'
```

## Read next

- [Quickstart](/docs/cloud/quickstart)
- [Cell contract](/docs/cloud/cell-contract)
- [Testing Cells](/docs/cloud/testing-cells)
