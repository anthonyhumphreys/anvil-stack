# CLI Specification

## Purpose

The `anvil` CLI is the main human and agent interface for Anvil Cloud.

Every command intended for automation must support `--json`. Agent-facing commands should return stable shapes, stable error codes, and actionable hints.

## Commands

### `anvil-cloud new <name>`

Creates a new Anvil Cell project.

```sh
anvil-cloud new notes
```

Expected output:

```txt
Created Anvil Cell notes

Next steps:
  cd notes
  anvil-cloud dev
```

JSON output:

```json
{
  "ok": true,
  "cell": "notes",
  "path": "./notes",
  "next": ["cd notes", "anvil-cloud dev"]
}
```

### `anvil-cloud dev`

Starts local runtime and client dev server.

Options:

```txt
--json     machine-readable startup result
--agent    JSONL event stream, no rich UI
--port     runtime port, default 8787
--client-port client port, default 5173
```

### `anvil-cloud check`

Runs validation without building deploy artefacts.

Checks:

- project config;
- TypeScript typecheck;
- forbidden imports;
- capability-scoped `ctx.db`, `ctx.files`, `ctx.jobs`, `fetch`, and scheduled job usage;
- manifest extraction safety;
- declared capabilities.

### `anvil-cloud build`

Builds local artefacts into `.anvil/dist` and `.anvil/generated`.

### `anvil-cloud inspect`

Inspects local or remote runtime state.

```sh
anvil-cloud inspect --local --json
anvil-cloud inspect --app notes --env preview --json
```

Remote AWS inspect returns stable JSON errors for missing or malformed
deployment metadata: `AWS_DEPLOYMENT_METADATA_NOT_FOUND` and
`AWS_DEPLOYMENT_METADATA_INVALID`. AWS SDK read failures, such as IAM denial or
throttling, return `AWS_REMOTE_READ_FAILED` with the failed operation and cause.

When the deployment record includes an artifact summary, remote AWS inspect
returns the Lambda bundle key and SHA-256 digest from the latest preview deploy.

Remote AWS commands only accept `--env preview` during alpha. Any other
environment returns `INVALID_USAGE`.

### `anvil-cloud logs`

Reads local or remote structured logs.

```sh
anvil-cloud logs --local --json
anvil-cloud logs --app notes --env preview --since 10m --json
```

Remote AWS logs use the same deployment metadata lookup as inspect, so metadata
lookup failures use the same stable error codes. DynamoDB or CloudWatch read
failures return `AWS_REMOTE_READ_FAILED` with the failed operation and provider
error cause.
`--since` accepts millisecond timestamps or relative durations with `ms`, `s`,
`m`, `h`, or `d` suffixes, such as `30s`, `10m`, or `1h`.
`--limit` must be a positive whole number.
The AWS log reader follows CloudWatch pagination until the requested limit is
reached or there are no more pages.

### `anvil-cloud db list`

Lists known database tables.

```sh
anvil-cloud db list --local --json
```

### `anvil-cloud db dump <table>`

Dumps table rows for local or remote inspection.

```sh
anvil-cloud db dump todos --local --json
```

Remote database dump should require explicit environment and future confirmation/policy rules.

### `anvil-cloud deploy --preview`

Deploys a Cell to a preview environment through the configured deployment adapter. AWS is the first planned alpha adapter.

In alpha, deploy may be implemented after local runtime, builder, manifest, and the deployment adapter contract are stable.

`anvil-cloud deploy --preview --wait --json` polls the deployed runtime
`/_anvil/health` endpoint after successful provisioning. Use
`--wait-timeout <seconds>` to adjust the default 60 second timeout; the value
must be positive. If the runtime does not become healthy, the JSON result uses
`AWS_RUNTIME_UNHEALTHY` and includes the deployment result plus verification
details.

If CloudFormation does not reach a terminal stack status within the provisioner
polling limit, deploy returns `AWS_STACK_TIMEOUT` with the last observed stack
status and polling details.
If a completed stack omits a required adapter output, deploy returns
`AWS_STACK_OUTPUT_MISSING` with the missing output key.
If an AWS SDK operation fails while uploading artifacts, applying the stack, or
publishing deployment metadata, deploy returns
`AWS_PROVISIONING_OPERATION_FAILED` with the failed operation and provider
error cause.

### `anvil-cloud destroy --preview --app <name> --yes`

Deletes the AWS preview stack for a Cell. The command is intentionally explicit:
alpha cleanup requires `--preview`, `--app`, and `--yes` so a typo does not
become infrastructure archaeology with billing.
Only `--env preview` is accepted during alpha; other environments return
`INVALID_USAGE`.

When `ANVIL_AWS_DEPLOYMENT_METADATA_TABLE` is configured, successful destroy
also deletes the matching deployment metadata record. The JSON result includes
`metadataDeleted` so automation can tell whether remote `inspect`/`logs` state
was cleaned up with the stack.

Before deleting the stack, destroy empties stack-owned S3 buckets exposed by
CloudFormation outputs, including the client assets bucket and Cell files bucket
when present. The JSON result includes `emptiedBuckets`.

If CloudFormation reports a failed delete status, destroy returns
`AWS_DESTROY_FAILED`. If deletion remains in progress past the polling limit,
destroy returns `AWS_DESTROY_TIMEOUT` with the last observed status and polling
details. If an AWS SDK operation fails while emptying buckets, deleting the
stack, or deleting deployment metadata, destroy returns
`AWS_DESTROY_OPERATION_FAILED` with the failed operation and provider error
cause.

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
| 6    | Deploy or destroy failed  |
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
  "phase": "import-policy",
  "diagnostics": [
    {
      "code": "FORBIDDEN_IMPORT",
      "message": "Import '@aws-sdk/client-s3' is not allowed.",
      "hint": "Use ctx.files instead."
    }
  ],
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

`anvil-cloud dev --agent --json` emits JSONL events:

```jsonl
{"type":"ready","runtimeUrl":"http://localhost:8787","clientUrl":"http://localhost:5173"}
{"type":"build.ok","queries":["listTodos"],"mutations":["addTodo"]}
{"type":"request","kind":"query","name":"listTodos","durationMs":6}
```

Agent mode must avoid spinners, colour codes, terminal control sequences, prompts, and unstable prose.

## Human output

Human output can be friendly and concise, but must not be the only available interface for automation.
