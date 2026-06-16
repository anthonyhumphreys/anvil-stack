---
title: Anvil Lens
navTitle: Anvil Lens
description: The local-first management plane for Anvil Cells - a browser UI over the local runtime plus the ControlPlaneApi contract a hosted plane would implement.
product: Anvil Cloud
section: Runtime
order: 127
---

# Anvil Lens

Anvil Lens is the inspection and debugging surface for a running Cell. In alpha it is local-first: a single self-contained HTML page served by the local runtime, backed by the same `/_anvil/*` JSON routes the CLI uses. A hosted control plane can sit behind the same contract later.

## Opening Lens

Start the dev server, then open the Lens URL it prints:

```bash
anvil dev
# Anvil Local runtime  http://localhost:8787
# Anvil client         http://localhost:5173
# Anvil Lens           http://localhost:8787/_anvil/lens
```

Or ask the CLI for the URL of an already running server:

```bash
anvil lens
anvil lens --json
```

If no local runtime is reachable, `anvil lens --json` returns:

```json
{
  "ok": false,
  "errors": [
    {
      "code": "LENS_SERVER_NOT_RUNNING",
      "message": "No local runtime is reachable at http://localhost:8787. Start one with `anvil dev` first."
    }
  ]
}
```

The client dev server proxies `/_anvil/*` to the runtime, so the page is also reachable at `http://localhost:5173/_anvil/lens`.

## What Lens shows

| Tab | Contents |
| --- | --- |
| Overview | Manifest summary: query, mutation, endpoint, job, workflow, and service counts, plus declared capabilities. |
| Logs | Latest 100 NDJSON log entries with a level filter and a pausable 5-second auto-refresh. |
| Database | Local JSON database tables with row counts; click a table to view its rows. |
| Auth | Local identity provider users, a create-user form, and per-user JWT minting with a copyable token box. |
| Workflows | Run list with status badges, per-step detail including attempts and errors, and a run form for each declared workflow. |
| Services | Supervised service states with start and stop actions. |
| Diagnostics | Trust-gateway commands, runtime state, current auth user, table summary, recent errors, and raw manifest JSON. |

Everything Lens renders comes from routes you can also hit with `curl`: `GET /_anvil/inspect`, `GET /_anvil/logs`, `GET /_anvil/db/tables`, `GET /_anvil/auth/users`, `GET /_anvil/workflows`, `GET /_anvil/services`, and the corresponding action routes. Lens is a viewer, not a separate source of truth.

## The ControlPlaneApi contract

The `@anvil-cloud/control-plane` package defines the management-plane contract Lens-style tooling depends on:

```ts
interface ControlPlaneApi {
  describe(): Promise<{ cell: string; target: "local" | string; runtimeUrl?: string }>;
  manifest(): Promise<unknown>;
  inspect(): Promise<unknown>;
  logs(options?: { limit?: number; level?: string }): Promise<ControlPlaneLogEntry[]>;
  dbTables(): Promise<Record<string, { rows: number }>>;
  dbDump(table: string): Promise<unknown[]>;
  authUsers(): Promise<unknown[]>;
  workflows(): Promise<unknown[]>;
  workflowRun(runId: string): Promise<unknown | null>;
  services(): Promise<unknown[]>;
  serviceAction(name: string, action: "start" | "stop"): Promise<unknown>;
}
```

`createHttpControlPlane(baseUrl)` implements this interface against a local runtime's `/_anvil/*` routes. The point of the abstraction is the adapter swap: a future hosted control plane implements the same interface against hosted APIs, and tooling written against `ControlPlaneApi` does not change. That hosted plane does not exist yet; do not plan around it.

## Honest limits

- Lens is local only. It reads the state of the dev server on your machine, nothing else.
- The page itself has no authentication. It is only as protected as the local runtime, which binds to localhost. Do not expose the runtime port to a network you do not trust.
- Mutating actions (create user, mint token, run workflow, start/stop service) hit the same unauthenticated local routes the CLI uses. They are development conveniences, not an admin panel.
- Logs auto-refresh by re-reading the local NDJSON file; there is no streaming.
