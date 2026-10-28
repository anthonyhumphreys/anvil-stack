---
title: Generated client
navTitle: Generated client
description: How Mezair Cloud emits client metadata and browser helpers for calling Cell queries and mutations.
product: Mezair Cloud
section: Concepts
journey: build
order: 160
---

# Generated client

The builder emits generated client files under `.mezair/generated`.

The generated client lets browser code call queries and mutations by name,
using metadata from the manifest. You don't need to hard-code runtime paths.
React/Vite is the current default for Cell interfaces.

## Output

```txt
.mezair/generated/
  api.d.ts
  client.ts
```

`client.ts` exposes metadata for declared queries and mutations. `api.d.ts` gives TypeScript a stable shape for generated API names.

## Browser client

The browser package is `@mezair-cloud/client`.

Current responsibilities:

- provide a `createClient` function
- route query and mutation calls to the local or deployed runtime
- avoid hard-coded runtime paths in Cell client code
- attach bearer tokens through `setToken` or `getToken`
- throw structured `MezairClientError` failures
- provide React hook helpers for loading/error state and manual refetch

## Direct client use

```ts
import { createClient } from "@mezair-cloud/client";
import { api, createMezairApiClient } from "@mezair/generated/client";

const generated = createMezairApiClient({
  getToken: () => localStorage.getItem("mezair_token")
});

await generated.queries.listNotes({});
await generated.mutations.createNote({
  title: "Write docs"
});
```

Use the generated helper for most calls. Use the lower-level client when you need
to pass generated definitions around explicitly:

```ts
import { createApiClient, createClient } from "@mezair-cloud/client";
import { api } from "@mezair/generated/client";

const client = createClient({
  getToken: () => localStorage.getItem("mezair_token")
});
const generated = createApiClient(client, api);

await generated.queries.listNotes({});
```

By default the runtime URL is the same origin. Pass `runtimeUrl` when a client
is served from a different origin:

```ts
const client = createClient({
  runtimeUrl: "https://preview.example.test",
  getToken: () => sessionStorage.getItem("token")
});
```

## React hooks

The hook runtime is injected, but React/Vite is the default and documented path.

```ts
import * as React from "react";
import { createMezairHooks, createClient } from "@mezair-cloud/client";
import { api } from "@mezair/generated/client";

const client = createClient({
  getToken: () => localStorage.getItem("mezair_notes_token")
});
const { useQuery, useMutation } = createMezairHooks(client, React);

const notes = useQuery(api.queries.listNotes, {});
const createNote = useMutation(api.mutations.createNote);

await createNote.mutate({ title: "Ship the demo" });
await notes.refetch();
```

`useQuery` returns:

- `status`: `loading`, `success`, or `error`
- `data`
- `error`
- `refetch()`

`useMutation` returns:

- `status`: `idle`, `loading`, `success`, or `error`
- `data`
- `error`
- `mutate(input)`

There is no cache policy layer yet. Invalidation is explicit: call `refetch`
after a mutation when the visible query data should change.

## Runtime target

Client code should not assume the runtime URL by hand. Local and deployed runtime targets should be supplied through the client package and generated metadata.

Hard-coded URLs are easy. They are also how preview, local, and deployed environments slowly become three different products.

In local dev, Vite serves the client and proxies runtime calls back to Mezair
Local. In preview, the deployed client can call the preview runtime through the
same generated metadata and browser client API.

## Auth tokens

For local demos, use the CLI to create a user and mint a token:

```bash
mezair cloud auth add-user local_demo --email demo@example.test --roles admin --json
mezair cloud auth token local_demo --json
```

In a real app, token acquisition belongs to the auth provider. The generated
client only needs a token source:

```ts
const client = createClient({
  getToken: async () => authSession.currentAccessToken()
});
```

When no token is available, authenticated runtime handlers return
`AUTH_REQUIRED`.

## Errors

Runtime failures throw `MezairClientError`. It carries the HTTP `status`, runtime
`code`, message, and optional diagnostic `details` from the runtime payload.

```ts
import { isMezairClientError } from "@mezair-cloud/client";

try {
  await client.query(api.queries.listNotes, {});
} catch (error) {
  if (isMezairClientError(error) && error.code === "AUTH_REQUIRED") {
    // Ask the auth provider for a fresh session or token.
  }
}
```

## Status

Generated client output is part of the alpha builder path. The current surface is
metadata plus small runtime helpers, not a full application data layer. The next
useful work is better typed examples, clearer token handling, and cache
invalidation patterns around `examples/notes`.
