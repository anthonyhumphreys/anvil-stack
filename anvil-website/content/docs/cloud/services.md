---
title: Services
navTitle: Services
description: Long-running supervised service handlers in Anvil Cells, with restart policies, abort-signal stop semantics, and local status routes.
product: Anvil Cloud
section: Architecture
journey: learn
order: 120
---

# Services

A service is a long-running handler that the platform starts, supervises, and stops with the app: pollers, queue consumers, socket listeners, or any loop that should run continuously rather than per request. Where a job is a single background invocation and a workflow is a durable multi-step run, a service is process-shaped and stays up until it is stopped.

## Definition

```ts
import { app, service } from "@anvil-cloud/runtime";

export default app({
  capabilities: { services: true },
  services: {
    heartbeat: service({
      restart: "on-failure", // "always" | "on-failure" | "never" (default "on-failure")
      maxRestarts: 5, // default 5
      handler: async (ctx, controls) => {
        while (!controls.stopping()) {
          await ctx.log.info("tick");
          await sleep(1000, controls.signal);
        }
      },
    }),
  },
});
```

The handler receives the shared runtime `ctx` and a `controls` object:

- `controls.signal` is an `AbortSignal` the platform aborts when the service must stop.
- `controls.stopping()` returns `true` once a stop has been requested.

Handlers should observe the signal and return promptly. A handler that ignores it is given a bounded grace period (5 seconds by default), then recorded as stopped with a warning.

Services run in the background with no request auth context: `ctx.auth.identity` is always `null` inside service handlers.

## Capability requirement

Declaring a service requires `capabilities.services`. Anvil Guard reports `CAPABILITY_NOT_DECLARED` during `anvil cloud check` and `anvil cloud build` if it is missing. The built Cell manifest lists each service as `{ name, restart, maxRestarts }`.

## Supervision semantics

The runtime supervisor records each service as `running`, `stopped`, `failed`, or `restarting`:

- On handler failure, `on-failure` and `always` policies restart the handler with capped exponential backoff, up to `maxRestarts`. Exhausting the cap marks the service `failed` with the last error.
- A clean return restarts only under `always` (the cap still applies); under other policies it marks the service `stopped`.
- `never` marks the service `failed` on the first error without restarting.
- Stopping aborts `controls.signal`, waits (bounded) for the handler to exit, and marks the service `stopped`.

Every transition is written through the host log adapter with `kind: "service"`, so service lifecycle events appear alongside normal handler logs.

## Local runtime

The local dev server starts every declared service on boot and stops them all when it shuts down. After each state transition it persists a status snapshot to `.anvil/local/services.json` — that file is informational; live state is in-process and served over HTTP:

```txt
GET  /_anvil/services                ->  { "ok": true, "services": [...] }
POST /_anvil/services/<name>/stop    ->  { "ok": true, "service": {...} }
POST /_anvil/services/<name>/start   ->  { "ok": true, "service": {...} }
```

A service status record looks like:

```json
{
  "name": "heartbeat",
  "state": "running",
  "restarts": 0,
  "startedAt": "2025-01-01T00:00:00.000Z"
}
```

Failed services additionally carry `lastError: { code, message }`.

## CLI

```bash
anvil cloud services list --json
```

This reads the `.anvil/local/services.json` snapshot — the last recorded states, not necessarily live. For live state, query `GET /_anvil/services` on a running dev server.

## Current limits

Services execute fully on the local runtime. The AWS adapter can synthesize the
intended ECS/Fargate resource shape, but preview deploy blocks service-bearing
manifests with `AWS_PREVIEW_UNSUPPORTED_FEATURE`.

The current task scaffold does not run the exact Cell service handler. Blocking
before provisioning avoids creating an idle, billable service while that runner
is incomplete.

Single instance per service: no horizontal scaling, leader election, or distributed coordination in alpha.
