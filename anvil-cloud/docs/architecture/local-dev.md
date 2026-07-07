# Local Development Architecture

## Purpose

Anvil Local provides a full local development environment for Anvil Cells. It should let a developer or coding agent build, run, inspect, and debug a Cell without requiring AWS credentials or cloud resources.

Local development is the first-class alpha experience.

## Goals

- Run server handlers locally through the same runtime contract used in cloud adapters.
- Run the default Vite client UI with proxying to the local runtime.
- Provide local database, auth, files, jobs, logs, and inspector support.
- Persist local state in `.anvil/local/`.
- Provide stable JSON output for agent workflows.

## Non-goals

- Perfect cloud parity.
- Requiring Docker by default.
- Requiring DynamoDB Local by default.
- Running AWS infrastructure locally.

## Local process model

For `vite-react` Cells, `anvil-cloud dev` starts two local processes:

```txt
Anvil local runtime server  http://localhost:8787
Anvil client server         http://localhost:5173
```

The alpha implementation runs a Vite-backed React client server for
`vite-react` Cells during `anvil-cloud dev` and proxies runtime requests to
Anvil Local. `expo-router` and `headless` Cells run the local runtime only;
native clients should start through Expo and use the runtime URL explicitly.
Production builds still emit static client assets under `.anvil/dist/client`
for `vite-react` so deployment adapters have a boring artifact shape. Boring is
a feature here.

```txt
/_anvil/* → http://localhost:8787
/api/*    → http://localhost:8787
```

## Local state

```txt
.anvil/local/
├── auth/
│   ├── keys.json
│   └── users.json
├── dev.db
├── files/
├── jobs.json
├── logs.ndjson
├── services.json
└── workflows.json
```

## Local runtime routes

```txt
POST /_anvil/query/:name
POST /_anvil/mutation/:name
ANY  /api/*
GET  /_anvil/health
GET  /_anvil/manifest
GET  /_anvil/inspect
GET  /_anvil/logs
GET  /_anvil/db/tables
GET  /_anvil/db/:table
POST /_anvil/auth/as/:userId
POST /_anvil/jobs/run/:name
```

## Local database

Default alpha adapter: SQLite.

Rationale:

- no Docker required;
- easy to inspect;
- fast for local dev;
- reliable for agent workflows;
- can be reset cheaply.

The database API should remain constrained so a future DynamoDB Local mode can be added.

Recommended CLI commands:

```sh
anvil-cloud db list --local --json
anvil-cloud db dump todos --local --json
anvil-cloud db reset --local
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
anvil-cloud auth add-user local_anth --email anth@example.local --roles admin
anvil-cloud auth login local_anth --json
anvil-cloud auth token local_anth --ttl 3600 --json
anvil-cloud auth users --json
anvil-cloud auth whoami --json
anvil-cloud auth test --json
```

`auth test --json` runs the reusable conformance kit for local JWT issue and
verification, runtime public/required/role policy, mock OIDC discovery and JWKS
verification, issuer/audience/expiry rejection, claim mapping, and common
provider fixture config examples.

## Local files

If a Cell declares file capability, local files are stored under:

```txt
.anvil/local/files/
```

`ctx.files.signedUrl()` can return local runtime URLs:

```txt
http://localhost:8787/_anvil/files/<key>?token=dev
```

## Local jobs

Local jobs should be persisted in `.anvil/local/jobs.json` and executable manually.

```sh
anvil jobs run refreshData --local --json
```

The alpha job runner may be simple:

- in-memory queue during dev;
- persisted job metadata for inspection;
- manual execution support;
- scheduled jobs can be simulated with timers.

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

Local usage events are NDJSON at `.anvil/local/usage.ndjson`. The runtime writes
an event for each Cell handler invocation and each mounted Agent invocation.
Agent events include provider/model metadata, token counts, session id when
provided, estimated USD cost, and sandbox runtime milliseconds. The local stub
provider reports zero tokens through the same shape as production providers.

`anvil-cloud usage --local --json` and `GET /_anvil/usage` aggregate the same
file into totals, per-Cell and per-Agent rollups, hourly buckets, top
consumers, and budget warnings. Budgets are warnings only in alpha:

```sh
ANVIL_USAGE_DAILY_BUDGET_USD=1 \
ANVIL_USAGE_SESSION_BUDGET_USD=0.25 \
anvil-cloud usage --local --json
```

## Inspector

`GET /_anvil/inspect` and `anvil-cloud inspect --local --json` should return:

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

`anvil-cloud dev --agent --json` should emit JSONL lifecycle events instead of rich terminal UI.

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
4. SQLite adapter.
5. Local auth adapter.
6. Local logs adapter.
7. Local inspector.
8. Vite client proxy.
9. Agent JSONL mode.
