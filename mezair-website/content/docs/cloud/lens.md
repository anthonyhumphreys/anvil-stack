---
title: Mezair Lens
navTitle: Mezair Lens
description: Inspect a running Cell's manifest, logs, data, workflows and services in your browser.
product: Mezair Cloud
section: Concepts
journey: build
order: 170
---

# Mezair Lens

Mezair Lens lets you inspect and debug a running Cell in your browser. The local runtime serves the page and its data through the same `/_mezair/*` routes the CLI uses. A hosted version could use the same API later; the alpha runs locally.

## Opening Lens

Start the dev server, then open the Lens URL it prints:

```bash
mezair cloud dev
# Mezair Local runtime  http://localhost:8787
# Mezair client         http://localhost:5173
# Mezair Lens           http://localhost:8787/_mezair/lens
```

Or ask the CLI for the URL of an already running server:

```bash
mezair cloud lens
mezair cloud lens --json
```

If no local runtime is reachable, `mezair cloud lens --json` returns:

```json
{
  "ok": false,
  "errors": [
    {
      "code": "LENS_SERVER_NOT_RUNNING",
      "message": "No local runtime is reachable at http://localhost:8787. Start one with `mezair cloud dev` first."
    }
  ]
}
```

The client dev server proxies `/_mezair/*` to the runtime, so the page is also reachable at `http://localhost:5173/_mezair/lens`.

## What Lens shows

| Tab | Contents |
| --- | --- |
| Overview | Manifest summary: query, mutation, endpoint, job, workflow, and service counts, plus declared capabilities. |
| Logs | Latest 100 NDJSON log entries with a level filter and a pausable 5-second auto-refresh. |
| Traces | Local agent and workflow traces, including event type, duration, and redacted attributes. |
| Usage | Local invocation totals, token totals, estimated cost, budget warnings, and top Cell/Agent consumers. |
| Database | Local JSON database tables with row counts; click a table to view its rows. |
| Auth | Local identity provider users, a create-user form, and per-user JWT minting with a copyable token box. |
| Workflows | Run list with status badges, per-step detail including attempts and errors, and a run form for each declared workflow. |
| Services | Supervised service states with start and stop actions. |
| Diagnostics | Trust-gateway commands, runtime state, current auth user, table summary, recent errors, and raw manifest JSON. |

Everything Lens renders comes from routes you can also hit with `curl`: `GET /_mezair/inspect`, `GET /_mezair/logs`, `GET /_mezair/traces`, `GET /_mezair/usage`, `GET /_mezair/db/tables`, `GET /_mezair/auth/users`, `GET /_mezair/workflows`, `GET /_mezair/services`, and the corresponding action routes. Lens is a viewer, not a separate source of truth.

## The ControlPlaneApi contract

The `@mezair-cloud/control-plane` package defines the management-plane contract Lens-style tooling depends on:

```ts
interface ControlPlaneApi {
  describe(): Promise<{ cell: string; target: "local" | string; runtimeUrl?: string }>;
  manifest(): Promise<unknown>;
  inspect(): Promise<unknown>;
  logs(options?: { limit?: number; level?: string }): Promise<ControlPlaneLogEntry[]>;
  traces(): Promise<unknown[]>;
  trace(traceId: string): Promise<unknown | null>;
  dbTables(): Promise<Record<string, { rows: number }>>;
  dbDump(table: string): Promise<unknown[]>;
  authUsers(): Promise<unknown[]>;
  workflows(): Promise<unknown[]>;
  workflowRun(runId: string): Promise<unknown | null>;
  services(): Promise<unknown[]>;
  serviceAction(name: string, action: "start" | "stop"): Promise<unknown>;
}
```

`createHttpControlPlane(baseUrl)` implements this interface against a local runtime's `/_mezair/*` routes. The point of the abstraction is the adapter swap: a future hosted control plane implements the same interface against hosted APIs, and tooling written against `ControlPlaneApi` does not change. That hosted plane does not exist yet; do not plan around it.

## Access and limits

- Lens is local only. It reads the state of the dev server on your machine, nothing else.
- The page itself has no authentication. It is only as protected as the local runtime, which binds to localhost. Do not expose the runtime port to a network you do not trust.
- Mutating actions (create user, mint token, run workflow, start/stop service) hit the same unauthenticated local routes the CLI uses. They are development conveniences, not an admin panel.
- Logs auto-refresh by re-reading the local NDJSON file; there is no streaming.
