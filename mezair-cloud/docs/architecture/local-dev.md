# Local Development Architecture

## Purpose

Mezair Local provides a full local development environment for Mezair Cells. It should let a developer or coding agent build, run, inspect, and debug a Cell without requiring AWS credentials or cloud resources.

Local development is the first-class alpha experience.

## Goals

- Run server handlers locally through the same runtime contract used in cloud adapters.
- Run the default Vite client UI with proxying to the local runtime.
- Provide local database, auth, files, jobs, logs, and inspector support.
- Persist local state in `.mezair/local/`.
- Provide stable JSON output for agent workflows.

## Non-goals

- Perfect cloud parity.
- Requiring Docker by default.
- Requiring DynamoDB Local by default.
- Running AWS infrastructure locally.

## Local process model

For `vite-react` Cells, `mezair-cloud dev` starts two local processes:

```txt
Mezair local runtime server  http://localhost:8787
Mezair client server         http://localhost:5173
```

The runtime binds to `127.0.0.1` by default. Pass `--host <address>` only when a
native device or another machine must connect; the `/_mezair/*` management routes
are local development controls and must not be exposed to an untrusted network.

The alpha implementation runs a Vite-backed React client server for
`vite-react` Cells during `mezair-cloud dev` and proxies runtime requests to
Mezair Local. `expo-router` and `headless` Cells run the local runtime only;
native clients should start through Expo and use the runtime URL explicitly.
Production builds still emit static client assets under `.mezair/dist/client`
for `vite-react` so deployment adapters have a boring artifact shape. Boring is
a feature here.

```txt
/_mezair/* → http://localhost:8787
/api/*    → http://localhost:8787
```

## Local state

```txt
.mezair/local/
├── auth/
│   ├── keys.json
│   └── users.json
├── agent-sessions.json
├── dev.db
├── files/
├── approvals.json
├── events.json
├── jobs.json
├── logs.ndjson
├── services.json
├── traces.json
└── workflows.json
```

## Local runtime routes

```txt
POST /_mezair/query/:name
POST /_mezair/mutation/:name
ANY  /api/*
GET  /_mezair/health
GET  /_mezair/manifest
GET  /_mezair/inspect
GET  /_mezair/logs
GET  /_mezair/approvals
GET  /_mezair/approvals/audit
POST /_mezair/approvals/:id/approve
POST /_mezair/approvals/:id/reject
GET  /_mezair/traces
GET  /_mezair/traces/:traceId
GET  /_mezair/agents
POST /_mezair/agents/:name
POST /_mezair/agents/:name/sessions
POST /_mezair/agents/sessions/:sessionId/messages
GET  /_mezair/agents/sessions/:sessionId/stream?after=:token
POST /_mezair/channels/simulate
GET  /_mezair/db/tables
GET  /_mezair/db/:table
POST /_mezair/auth/as/:userId
GET  /_mezair/auth/users
POST /_mezair/auth/users
DELETE /_mezair/auth/users/:userId
POST /_mezair/auth/token
GET  /_mezair/auth/jwks
GET  /_mezair/auth/whoami
GET  /_mezair/agents
POST /_mezair/agents/:name
POST /_mezair/workflows/run/:name
GET  /_mezair/workflows
GET  /_mezair/workflows/:runId
GET  /_mezair/services
POST /_mezair/services/:name/start
POST /_mezair/services/:name/stop
POST /_mezair/jobs/run/:name
```

Approval-gated agent tool execution writes pending requests to
`.mezair/local/approvals.json`. The CLI can inspect and decide them with
`mezair-cloud approvals list|approve|reject|audit --json`; Lens shows the same
pending requests and audit trail while the local runtime is running.

## Local database

Default alpha adapter: local JSON files.

Rationale:

- no Docker required;
- easy to inspect;
- fast for local dev;
- reliable enough for alpha agent workflows;
- can be reset cheaply.

The database API should remain constrained so a future DynamoDB Local mode can be added.

The primary branch is `.mezair/local/dev.db`. Named branches are snapshot files
under `.mezair/local/db-branches`, tracked by `.mezair/local/db-branches.json`.
Branching is local-first: it copies the source JSON store, can record a TTL for
agent-created throwaway branches, and keeps `ctx.db` unchanged for Cell code.

Recommended CLI commands:

```sh
mezair-cloud db list --local --json
mezair-cloud db dump todos --local --json
mezair-cloud db branch preview --from main --ttl 3600 --json
mezair-cloud db use preview --json
mezair-cloud dev --db-branch preview --json
mezair-cloud db diff preview --against main --json
mezair-cloud db promote preview --json
mezair-cloud db delete preview --yes --json
mezair-cloud db cleanup --expired --json
```

## Local auth

The local auth emulator should provide a current identity to `ctx.auth`.

Example `auth.json`:

```json
{
  "currentUser": {
    "userId": "local_anth",
    "email": "anth@example.local",
    "roles": ["admin"],
    "claims": {}
  }
}
```

Useful commands:

```sh
mezair-cloud auth add-user local_anth --email anth@example.local --roles admin
mezair-cloud auth login local_anth --json
mezair-cloud auth token local_anth --ttl 3600 --json
mezair-cloud auth users --json
mezair-cloud auth whoami --json
mezair-cloud auth test --json
```

`auth test --json` runs the reusable conformance kit for local JWT issue and
verification, runtime public/required/role policy, mock OIDC discovery and JWKS
verification, issuer/audience/expiry rejection, claim mapping, and common
provider fixture config examples.

## Local files

If a Cell declares file capability, local files are stored under:

```txt
.mezair/local/files/
```

`ctx.files.signedUrl()` can return local runtime URLs:

```txt
http://localhost:8787/_mezair/files/<key>?token=dev
```

## Local jobs

Local queued jobs are persisted in `.mezair/local/jobs.json`; scheduled job state
and run history live in `.mezair/local/schedules.json`.

```sh
mezair-cloud schedules list --json
mezair-cloud schedules run refreshData --payload '{}' --json
```

The alpha scheduler is intentionally simple:

- in-memory queue during dev;
- persisted job metadata for inspection;
- manual execution support through the CLI and `/_mezair/schedules/:name/run`;
- scheduled execution with local timers while `mezair-cloud dev` is running;
- missed runs while the local runtime is stopped are skipped, not caught up;
- overlapping scheduled executions default to `skip`; `overlap: "queue"` allows concurrent manual/scheduled runs.

## Logs

Local logs are NDJSON.

Each event should include:

```json
{
  "timestamp": "2026-06-07T10:30:00.000Z",
  "level": "info",
  "requestId": "req_123",
  "cell": "notes",
  "kind": "mutation",
  "handler": "addTodo",
  "message": "Todo created",
  "meta": { "id": "todo_123" }
}
```

## Usage metering

Local usage events are NDJSON at `.mezair/local/usage.ndjson`. The runtime writes
an event for each Cell handler invocation and each mounted Agent invocation.
Agent events include provider/model metadata, token counts, session id when
provided, estimated USD cost, and sandbox runtime milliseconds. The local stub
provider reports zero tokens through the same shape as production providers.

`mezair-cloud usage --local --json` and `GET /_mezair/usage` aggregate the same
file into totals, per-Cell and per-Agent rollups, hourly buckets, top
consumers, and budget warnings. Budgets are warnings only in alpha:

```sh
MEZAIR_USAGE_DAILY_BUDGET_USD=1 \
MEZAIR_USAGE_SESSION_BUDGET_USD=0.25 \
mezair-cloud usage --local --json
```

## Inspector

`GET /_mezair/inspect` and `mezair-cloud inspect --local --json` should return:

```json
{
  "ok": true,
  "status": "running",
  "cell": "notes",
  "runtimeUrl": "http://localhost:8787",
  "clientUrl": "http://localhost:5173",
  "manifest": {
    "queries": ["listTodos"],
    "mutations": ["addTodo"],
    "endpoints": []
  },
  "auth": {
    "currentUser": "local_anth"
  },
  "database": {
    "tables": {
      "todos": { "rows": 3 }
    }
  },
  "recentErrors": []
}
```

## Agent mode

`mezair-cloud dev --agent --json` should emit JSONL lifecycle events instead of rich terminal UI.

Example:

```jsonl
{"type":"ready","clientUrl":"http://localhost:5173","runtimeUrl":"http://localhost:8787"}
{"type":"build.ok","queries":["listTodos"],"mutations":["addTodo"]}
{"type":"request","kind":"mutation","name":"addTodo","durationMs":14}
{"type":"db.change","table":"todos","operation":"insert","id":"todo_123"}
```

This mode is intended for coding agents and automated harnesses.

## Hot reload

Client reload will be handled by Vite once the Vite-backed client server is
added.

Server reload should:

1. watch server source files;
2. rebuild the server bundle;
3. reload the app definition;
4. regenerate manifest;
5. keep the runtime process alive;
6. emit structured reload events.

## Recommended alpha implementation order

1. Runtime test host.
2. Local Hono/Fastify server.
3. In-memory database adapter.
4. JSON database adapter with snapshot branches.
5. Local auth adapter.
6. Local logs adapter.
7. Local inspector.
8. Vite client proxy.
9. Agent JSONL mode.
