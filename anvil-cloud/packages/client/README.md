# @anvil-cloud/client

Browser client package for Anvil Cloud.

Responsibilities:

- provide client-side hooks or functions for generated query/mutation metadata;
- route calls to the local or deployed Anvil runtime;
- avoid hard-coded runtime paths in Cell client code;
- provide React/Preact integration once the UI framework decision is made.

Initial framework-neutral API:

```ts
import { createAnvilHooks, createClient } from "@anvil-cloud/client";
import { api } from "@anvil/generated/client";
import * as React from "react";

const client = createClient();
const { useQuery, useMutation } = createAnvilHooks(client, React);

const notes = useQuery(api.queries.listNotes, {});
const createNote = useMutation(api.mutations.createNote);

await createNote.mutate({ title: "Ship the demo" });
await notes.refetch();
```

The hook runtime is injected so the same client package can support React first
while keeping the runtime boundary small.
