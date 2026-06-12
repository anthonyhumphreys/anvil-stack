# CLI Specification

## Purpose

The `anvil` CLI is the main human and agent interface for Anvil Cloud.

Every command intended for automation must support `--json`. Agent-facing commands should return stable shapes, stable error codes, and actionable hints.

## Commands

### `anvil new <name>`

Creates a new Anvil Cell project.

```sh
anvil new notes
```

Expected output:

```txt
Created Anvil Cell notes

Next steps:
  cd notes
  anvil dev
```

JSON output:

```json
{
  "ok": true,
  "cell": "notes",
  "path": "./notes",
  "next": ["cd notes", "anvil dev"]
}
```

### `anvil dev`

Starts local runtime and client dev server.

Options:

```txt
--json     machine-readable startup result
--agent    JSONL event stream, no rich UI
--port     runtime port, default 8787
--client-port client port, default 5173
```

### `anvil check`

Runs validation without building deploy artefacts.

Checks:

- project config;
- TypeScript typecheck;
- forbidden imports;
- capability-scoped `ctx.db`, `ctx.files`, `fetch`, and scheduled job usage;
- manifest extraction safety;
- declared capabilities.

### `anvil build`

Builds local artefacts into `.anvil/dist` and `.anvil/generated`.

### `anvil inspect`

Inspects local or remote runtime state.

```sh
anvil inspect --local --json
anvil inspect --app notes --env preview --json
```

### `anvil logs`

Reads local or remote structured logs.

```sh
anvil logs --local --json
anvil logs --app notes --env preview --since 10m --json
```

### `anvil db list`

Lists known database tables.

```sh
anvil db list --local --json
```

### `anvil db dump <table>`

Dumps table rows for local or remote inspection.

```sh
anvil db dump todos --local --json
```

Remote database dump should require explicit environment and future confirmation/policy rules.

### `anvil deploy --preview`

Deploys a Cell to a preview environment through the configured deployment adapter. AWS is the first planned alpha adapter.

In alpha, deploy may be implemented after local runtime, builder, manifest, and the deployment adapter contract are stable.

## Exit codes

Recommended exit codes:

| Code | Meaning                   |
| ---- | ------------------------- |
| 0    | Success                   |
| 1    | General failure           |
| 2    | Invalid CLI usage         |
| 3    | Project validation failed |
| 4    | Build failed              |
| 5    | Runtime unavailable       |
| 6    | Deploy failed             |
| 7    | Policy denied             |

## JSON response conventions

Successful command:

```json
{
  "ok": true,
  "result": {}
}
```

Failed command:

```json
{
  "ok": false,
  "errors": [
    {
      "code": "FORBIDDEN_IMPORT",
      "message": "Import '@aws-sdk/client-s3' is not allowed.",
      "hint": "Use ctx.files instead."
    }
  ]
}
```

## Agent mode

`anvil dev --agent --json` emits JSONL events:

```jsonl
{"type":"ready","runtimeUrl":"http://localhost:8787","clientUrl":"http://localhost:5173"}
{"type":"build.ok","queries":["listTodos"],"mutations":["addTodo"]}
{"type":"request","kind":"query","name":"listTodos","durationMs":6}
```

Agent mode must avoid spinners, colour codes, terminal control sequences, prompts, and unstable prose.

## Human output

Human output can be friendly and concise, but must not be the only available interface for automation.
