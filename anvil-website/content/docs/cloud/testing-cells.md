---
title: Testing Cells
navTitle: Testing
description: Test Anvil Cells with in-memory adapters, mock auth, and captured logs before deploying.
product: Anvil Cloud
section: Runtime
journey: build
order: 128
---

# Testing Cells

Anvil Cloud is designed to be testable without a cloud provider. The runtime package includes in-memory adapters so you can write fast, deterministic tests against the same contract used in production.

## In-memory runtime host

`@anvil-cloud/runtime` exports `createInMemoryRuntimeHost()`:

```ts
import { createInMemoryRuntimeHost } from "@anvil-cloud/runtime";

const host = createInMemoryRuntimeHost({
  auth: { userId: "test-user", roles: ["admin"] }
});
```

The in-memory host provides:

- In-memory database with full `where` clause support.
- In-memory file storage.
- Captured log entries.
- Tracked events and enqueued jobs.
- Configurable auth identity.

## Testing a query

```ts
import { handleRuntimeRequest } from "@anvil-cloud/runtime";

const request = {
  kind: "query" as const,
  name: "listTodos",
  input: {},
  auth: { userId: "test-user" },
  requestId: "req-1"
};

const response = await handleRuntimeRequest({
  app: myApp,
  request,
  host
});

assert(response.ok === true);
assert(Array.isArray(response.body));
```

## Testing a mutation

```ts
const request = {
  kind: "mutation" as const,
  name: "addTodo",
  input: { text: "Test todo" },
  auth: { userId: "test-user" },
  requestId: "req-2"
};

const response = await handleRuntimeRequest({ app: myApp, request, host });
assert(response.ok === true);
assert(response.body.text === "Test todo");
```

## Inspecting side effects

After a request, inspect the host directly:

```ts
// Check database state
const todos = await host.db.todos.all();
assert(todos.length === 1);

// Check logs
assert(host.logs.some(l => l.message.includes("Test todo")));

// Check events
assert(host.events.some(e => e.name === "todo.created"));

// Check jobs
assert(host.jobs.some(j => j.name === "notifyUser"));
```

## Testing auth

```ts
// Unauthenticated request
const guestHost = createInMemoryRuntimeHost({ auth: null });
const response = await handleRuntimeRequest({
  app: myApp,
  request: { kind: "query", name: "listTodos", input: {}, auth: null, requestId: "req-3" },
  host: guestHost
});

assert(response.ok === false);
assert(response.error?.code === "AUTH_REQUIRED");
```

## Testing capabilities

If a handler uses `ctx.files.put` but the Cell does not declare `capabilities.files`, the runtime returns `CAPABILITY_NOT_DECLARED`:

```ts
const response = await handleRuntimeRequest({ ... });
assert(response.error?.code === "CAPABILITY_NOT_DECLARED");
```

## Test recommendations

- Test happy paths and auth failures.
- Test capability mismatches.
- Assert on side effects through the host adapters, not by mocking implementation details.
- Keep tests fast: in-memory adapters are synchronous where possible.
- Run `anvil cloud check --json` in CI before running tests to catch import policy and type errors early.

## Read next

- [Cell contract](/docs/cloud/cell-contract)
- [Local runtime](/docs/cloud/local-runtime)
- [Builder and Guard](/docs/cloud/builder-and-guard)
