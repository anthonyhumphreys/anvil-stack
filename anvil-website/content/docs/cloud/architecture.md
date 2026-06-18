---
title: Runtime model
navTitle: Runtime model
description: How shared execution contracts and adapter boundaries work in Anvil Cloud.
product: Anvil Cloud
section: Architecture
order: 120
---

# Runtime model

The Anvil Runtime is the part Cell code should depend on.

Local development, tests, and deployment adapters should all translate their trigger into a shared `RuntimeRequest`, provide a `RuntimeHost`, and call `handleRuntimeRequest`.

```txt
HTTP/Event/Test trigger
  -> adapter translates to RuntimeRequest
  -> runtime creates RuntimeContext from RuntimeHost
  -> runtime finds query, mutation, endpoint, or job handler
  -> handler uses ctx capabilities
  -> runtime returns RuntimeResponse
  -> adapter translates response back to its environment
```

## RuntimeRequest

All supported triggers normalize to one union:

```ts
export type RuntimeRequest =
  | {
      kind: "query";
      name: string;
      input: unknown;
      auth: AuthIdentity | null;
      requestId: string;
    }
  | {
      kind: "mutation";
      name: string;
      input: unknown;
      auth: AuthIdentity | null;
      requestId: string;
    }
  | {
      kind: "endpoint";
      method: string;
      path: string;
      headers: Record<string, string>;
      body: Uint8Array | null;
      auth: AuthIdentity | null;
      requestId: string;
    }
  | {
      kind: "job";
      name: string;
      payload: unknown;
      requestId: string;
    };
```

The runtime does not depend directly on API Gateway, Fastify, Express, Hono, EventBridge, test harness events, or local HTTP request objects.

## RuntimeResponse

Handlers return structured runtime output:

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

Runtime errors are normalized into stable payloads where possible. The current error family includes codes such as `VALIDATION_ERROR`, `AUTH_REQUIRED`, `FORBIDDEN`, `NOT_FOUND`, `HANDLER_NOT_FOUND`, `CAPABILITY_NOT_DECLARED`, `ADAPTER_ERROR`, and `INTERNAL_ERROR`.

## RuntimeHost

`RuntimeHost` is the environment boundary:

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

Local runtime, test hosts, and AWS preview hosts all provide this shape. That keeps app code out of provider SDKs.

## Agent runtime contract

Anvil Agents use a parallel provider-neutral runtime boundary:

```txt
Agent Definition
  -> Provider-neutral Agent Manifest
  -> Anvil Runtime Interfaces
  -> Inference Provider
  -> Adapter-specific Runtime Implementation
```

Core runtime code knows about agent definitions, model provider ids, messages,
tool calls, tool results, token usage, approval gates, capability checks,
provider registries, and manifest validation. Provider SDK imports and provider
resource shapes stay in provider or adapter packages.

Mounted Cell Agents are declared on the Cell definition and compiled into the
Cell manifest. Endpoint and workflow references are validated during build so a
Cell cannot quietly point at a missing agent and hope nobody notices. That hope
is not a deployment strategy.

Read [Anvil Agents](/docs/cloud/agents) for the current contract, local stub
mode, provider mode, and AWS Bedrock provider support.

## RuntimeContext

Cell handlers receive `ctx`:

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

Cell authors should use `ctx.db`, `ctx.files`, `ctx.env`, `ctx.auth`, `ctx.jobs`, `ctx.events`, and `ctx.log` rather than direct platform APIs.

## Handler execution

The runtime handles:

- `query` by name
- `mutation` by name
- `endpoint` by method and path
- `job` by name

If a handler is missing, the runtime returns a normalized `HANDLER_NOT_FOUND` error instead of leaking adapter-specific behavior.

## Logging

Runtime errors are written through `host.logs` with:

- timestamp
- request id
- handler kind and name
- message
- error code metadata

Local logs are NDJSON. AWS preview writes structured logs through Lambda and CloudWatch.

## Why the split matters

This split gives alpha three useful properties:

- local behavior and deployed behavior are comparable
- adapters can change provider details without changing Cell code
- Guard checks can reason about imports, capability use, manifest output, and deploy plans

If a feature needs to live both in Cell code and in a provider adapter, stop and move the behavior up or down the stack. The runtime contract should stay boring. Boring contracts are where sleep comes from.
