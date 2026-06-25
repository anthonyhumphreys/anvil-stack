# @anvil-cloud/client

Client SDK package for Anvil Cloud.

Responsibilities:

- provide client-side hooks or functions for generated query/mutation metadata;
- route calls to the local or deployed Anvil runtime;
- avoid hard-coded runtime paths in Cell client code;
- provide React hooks while keeping headless and native targets on the same
  generated metadata contract.

Initial framework-neutral API:

```ts
import {
  createAnvilHooks,
  createApiClient,
  createClient,
} from "@anvil-cloud/client";
import { api } from "@anvil/generated/client";
import * as React from "react";

const client = createClient();
const apiClient = createApiClient(client, api);
const { useQuery, useMutation } = createAnvilHooks(client, React);

await apiClient.queries.listNotes({});
console.log(apiClient.meta.queries);

const notes = useQuery(api.queries.listNotes, {});
const createNote = useMutation(api.mutations.createNote, {
  refetch: notes,
});

await createNote.mutate({ title: "Ship the demo" });
```

`createApiClient(client, api)` binds generated query and mutation metadata into
plain async functions. Use it for headless clients, tests, and non-React targets;
the hook layer remains an adapter over the same generated metadata. The bound
client exposes `apiClient.meta` so headless and native clients can inspect the
stable operation list without retaining the raw generated object.

Generated clients also include stable `api.meta` operation arrays. Runtime calls
still use `api.queries` and `api.mutations`; `api.meta` is for tools that need to
compare the generated client with a manifest without parsing route definitions.
`createApiClient` validates `api.meta` against the route records when it is
present, so stale generated metadata fails before any runtime call.

Generated metadata carries optional phantom input/result types. Add a local
declaration file to type routes without changing runtime metadata:

```ts
declare module "@anvil/generated/client" {
  interface QueryTypes {
    listNotes: {
      input: unknown;
      result: Note[];
    };
  }

  interface MutationTypes {
    createNote: {
      input: { title: string };
      result: Note;
    };
  }
}
```

With those route maps in scope, `createApiClient` and `createAnvilHooks` infer
function inputs and results without call-site generics.

`useQuery` returns a manual `refetch()` function. Pass that query result, a
`refetch` function, or an array of either to `useMutation(..., { refetch })` to
refresh dependent data after a successful mutation. `useMutation` also accepts
`onSuccess(data)` for local state updates or navigation after the runtime call
has completed.

Expo Router clients should use `createApiClient` with a runtime URL such as
`EXPO_PUBLIC_ANVIL_RUNTIME_URL`. Generated Expo scaffolds fall back to
`http://localhost:8787` for iOS Simulator/web and `http://10.0.2.2:8787` for
Android emulators. Expo is a client target only; Cell deployment continues to
flow through the provider-neutral Anvil runtime and deployment adapters.

Runtime failures throw `AnvilClientError`, which includes the HTTP `status`,
runtime `code`, message, and optional diagnostic `details` from the runtime
payload. Runtime-call failures also include `error.request` with the
provider-neutral operation kind, name, and runtime path, so clients can display
or log exactly which generated operation failed. Use
`isAnvilClientError(error)` to narrow unknown errors before checking those
fields. Transport failures use stable client-side codes:
`NETWORK_ERROR` when no runtime response was received and
`INVALID_RUNTIME_RESPONSE` when the response is not a valid Anvil runtime JSON
payload. Invalid generated API or route metadata fails before the runtime call
with `INVALID_API_DEFINITION`. Valid generated route names are URL-encoded
before calling the runtime so non-identifier names remain path-safe.

The hook runtime is injected so the same client package can support React first
while keeping the runtime boundary small.
