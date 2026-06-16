---
title: Generated client
navTitle: Generated client
description: How Anvil Cloud emits client metadata and browser helpers for calling Cell queries and mutations.
product: Anvil Cloud
section: Runtime
order: 135
---

# Generated client

The builder emits generated client files under `.anvil/generated`.

The goal is to keep client code attached to manifest-derived query and mutation metadata instead of hard-coded endpoint strings.

## Output

```txt
.anvil/generated/
  api.d.ts
  client.ts
```

`client.ts` exposes metadata for declared queries and mutations. `api.d.ts` gives TypeScript a stable shape for generated API names.

## Browser client

The browser package is `@anvil-cloud/client`.

Current responsibilities:

- provide a `createClient` function
- route query and mutation calls to the local or deployed runtime
- avoid hard-coded runtime paths in Cell client code
- provide framework hook helpers while the alpha UI framework decision remains open

## Framework-neutral use

```ts
import { createClient } from "@anvil-cloud/client";
import { api } from "../.anvil/generated/client";

const client = createClient();

await client.query(api.queries.listTodos, {});
await client.mutation(api.mutations.addTodo, { text: "Write docs" });
```

## React-style hooks

The hook runtime is injected so the same client package can support React or Preact while alpha settles.

```ts
import * as React from "react";
import { createAnvilHooks, createClient } from "@anvil-cloud/client";
import { api } from "../.anvil/generated/client";

const client = createClient();
const { useQuery, useMutation } = createAnvilHooks(client, React);

const todos = useQuery(api.queries.listTodos, {});
const addTodo = useMutation(api.mutations.addTodo);

await addTodo.mutate({ text: "Write docs" });
await todos.refetch();
```

## Runtime target

Client code should not assume the runtime URL by hand. Local and deployed runtime targets should be supplied through the client package and generated metadata.

Hard-coded URLs are easy. They are also how preview, local, and deployed environments slowly become three different products.

## Status

Generated client output is part of the alpha builder path. The framework integration is intentionally early, and the package keeps the hook runtime injectable while React and Preact support are still being shaped.
