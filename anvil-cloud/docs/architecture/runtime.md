# Runtime Architecture

## Purpose

Anvil Runtime is the shared execution layer for Anvil Cells. It must run the same Cell contract in local dev, tests, and deployment adapters without requiring Cell code changes.

The runtime should hide execution environment details behind a `RuntimeHost` interface and expose a stable `ctx` object to Cell handlers.

## Design principles

- One runtime request model for every trigger.
- One handler path for local and cloud execution.
- Cell code receives platform capabilities through `ctx`.
- Host adapters provide environment-specific implementations.
- Runtime output must be structured and inspectable.
- Runtime errors must be normalised into stable diagnostic codes.

## Package split

```txt
packages/runtime
  src/
    app.ts          # app/query/mutation/endpoint DSL
    context.ts      # RuntimeContext creation
    errors.ts       # Runtime error types and codes
    host.ts         # RuntimeHost and adapter interfaces
    manifest.ts     # manifest extraction types
    request.ts      # RuntimeRequest/RuntimeResponse
    runner.ts       # handleRuntimeRequest
```

## Core flow

```txt
HTTP/Event trigger
  ↓
Adapter translates trigger into RuntimeRequest
  ↓
Runtime creates RuntimeContext from RuntimeHost
  ↓
Runtime validates input
  ↓
Runtime executes query/mutation/endpoint/job handler
  ↓
Runtime normalises result/error
  ↓
Adapter translates RuntimeResponse back to environment response
```

## RuntimeRequest

The runtime must not depend directly on API Gateway, Express, Fastify, Hono, EventBridge, or test harness events. Each adapter translates into a `RuntimeRequest`.

```ts
export type RuntimeRequest =
  | QueryRuntimeRequest
  | MutationRuntimeRequest
  | EndpointRuntimeRequest
  | JobRuntimeRequest;
```

## RuntimeResponse

```ts
export type RuntimeResponse = {
  ok: boolean;
  status: number;
  headers: Record<string, string>;
  body: unknown;
  error?: RuntimeErrorPayload;
  diagnostics?: RuntimeDiagnostic[];
};
```

## RuntimeHost

`RuntimeHost` is the environment boundary.

```ts
export interface RuntimeHost {
  db: DatabaseAdapter;
  files: FileAdapter;
  env: EnvAdapter;
  auth: AuthAdapter;
  logs: LogAdapter;
  events: EventAdapter;
  jobs: JobAdapter;
}
```

## RuntimeContext

`RuntimeContext` is the Cell author boundary.

```ts
export type RuntimeContext = {
  auth: AuthContext;
  db: DatabaseClient;
  files: FileClient;
  env: EnvClient;
  log: LogClient;
  events: EventClient;
  jobs: JobClient;
  request: RequestContext;
};
```

The context should wrap adapters with app-specific constraints, table-specific clients, capability checks, and request metadata.

## Query and mutation execution

Queries should be read-oriented and side-effect-free by convention. Mutations may write to `ctx.db`, `ctx.files`, `ctx.events`, and `ctx.jobs` when capabilities allow.

The runtime should not rely on convention alone for security, but alpha may begin with compiler/import restrictions and capability checks rather than full effect tracking.

## Endpoint execution

Endpoints are explicitly declared routes. They should include:

- method;
- path;
- auth mode;
- handler;
- optional input/body constraints.

Endpoints are the only way a Cell exposes arbitrary HTTP routes.

## Jobs

Jobs are named handlers invoked by local queues, manual CLI calls, or deployment adapter event sources.

Local jobs should be persisted to `.anvil/local/jobs.json` for debuggability.

Cloud jobs should be mapped by each deployment adapter depending on whether the job is scheduled or queued.

## Error model

Errors should become stable runtime payloads.

Example:

```json
{
  "ok": false,
  "status": 400,
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Input failed validation.",
    "details": [
      { "path": ["text"], "message": "Expected at least 1 character." }
    ]
  }
}
```

Recommended error codes:

- `VALIDATION_ERROR`
- `AUTH_REQUIRED`
- `FORBIDDEN`
- `NOT_FOUND`
- `HANDLER_NOT_FOUND`
- `CAPABILITY_NOT_DECLARED`
- `ADAPTER_ERROR`
- `INTERNAL_ERROR`

## Logging

Handlers write logs through `ctx.log`. Logs must include:

- timestamp;
- level;
- request id;
- Cell name/id;
- handler kind/name;
- message;
- metadata.

Local logs are NDJSON. Deployment adapters should write structured JSON logs to their provider log sink.

## Inspection data

The runtime should provide enough state for Anvil Lens:

- active manifest;
- runtime status;
- current local auth user;
- known queries/mutations/endpoints/jobs;
- table counts where supported;
- recent errors;
- recent requests;
- adapter health.

## Testing strategy

Start with a test host:

- in-memory database adapter;
- in-memory file adapter;
- static env adapter;
- configurable auth adapter;
- memory log adapter;
- fake jobs/events adapters.

The runtime package should be testable without local server or cloud provider dependencies.
