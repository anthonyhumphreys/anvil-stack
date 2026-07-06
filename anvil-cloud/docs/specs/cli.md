# CLI Specification

## Purpose

The `anvil` CLI is the main human and agent interface for Anvil Cloud.

Every command intended for automation must support `--json`. Agent-facing commands should return stable shapes, stable error codes, and actionable hints.

## Commands

### `anvil-cloud new <name>`

Creates a new Anvil Cell project.

```sh
anvil-cloud new notes
anvil-cloud new native-notes --client expo-router
```

Options:

```txt
--client vite-react|expo-router|headless
```

`vite-react` is the default. `expo-router` scaffolds an Expo Router client
target with `app/index.tsx` and `app/_layout.tsx`; it still uses the Anvil
runtime through `@anvil-cloud/client`. `headless` writes generated client
metadata without a browser UI.

Expo Router scaffolds read `EXPO_PUBLIC_ANVIL_RUNTIME_URL` when it is set. For
local development they fall back to `http://localhost:8787`, except Android
emulators use `http://10.0.2.2:8787` so the native app can reach the host
runtime. The scaffold includes `src/expo-env.d.ts` so the public runtime URL is
typed without adding Node globals to Cell authoring.

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
  "client": {
    "kind": "vite-react"
  },
  "path": "./notes",
  "next": ["cd notes", "anvil-cloud dev"]
}
```

### `anvil-cloud dev`

Starts the local runtime. For `vite-react` Cells it also starts the Vite client
dev server. For `expo-router` and `headless` Cells, the CLI runs the runtime
only; start the native client separately and point it at the runtime URL.

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
- public file-read escalation against the previous local manifest when building;
- destructive schema removals or field type changes against the previous local
  manifest when building;
- manifest extraction safety;
- declared capabilities.

### `anvil-cloud build`

Builds local artefacts into `.anvil/dist` and `.anvil/generated`.

### `anvil-cloud review`

Aggregates Guard diagnostics and AWS preview deployment review into one trust
report.

```sh
anvil-cloud review --json
anvil-cloud review --adapter aws --env preview --json
```

JSON output includes:

- `summary.guardErrors` and `summary.guardWarnings`;
- the built manifest capabilities and handler lists;
- `review.changeSet`, `review.capabilityDiffs`, cost drivers, cleanup notes,
  rollback notes, and approval gates from the AWS preview plan;
- `status: "pass" | "review" | "block"`;
- stable next-step commands.

Guard failures block the report before deploy planning. Blocking adapter gates
return `ok: false`; review-only gates return `ok: true` with
`status: "review"` so humans and agents can decide before provisioning.

### `anvil-cloud doctor`

Checks the local Anvil Cloud toolchain and common runtime/deploy prerequisites.

```sh
anvil-cloud doctor --json
anvil-cloud doctor --port 8787 --client-port 5173 --json
```

Doctor is read-only. It reports stable check ids with `ok`, `warning`, or
`error` status. Warnings explain optional or situational setup, such as AWS
preview environment variables, without failing local development. Errors are
reserved for local blockers such as an unsupported Node version.

Initial checks include:

- Node and pnpm availability/version requirements;
- built CLI entrypoint;
- package publishing boundary: `@anvilstack/cloud-cli` public, internal
  workspace packages private, runtime/client tracked as candidate public APIs,
  and no public `workspace:` dependencies;
- Cell config and build manifest;
- generated client metadata presence and consistency with the built manifest;
- local `.anvil/local` state, including auth, database, logs, agent sessions,
  jobs, workflows, and service snapshots;
- local runtime health and runtime/client port availability;
- Notes golden-path verification runs doctor against the live local runtime and
  expects `project.build`, `project.generatedClient`, `local.state`, and
  `local.runtime` to report `ok`;
- AWS region, artifact bucket, and deployment metadata table env;
- OIDC token verification env for authenticated AWS preview smoke tests;
  `auth.oidc.details.claims` reports the effective user id, email, and roles
  claim names plus whether each was explicitly configured;
- `ANVIL_AWS_SMOKE_TOKEN` presence for authenticated preview query/mutation
  smoke coverage;
- optional `ANVIL_AWS_EXPIRED_SMOKE_TOKEN` presence for expired-token rejection
  smoke coverage;
- optional `ANVIL_AWS_WRONG_ISSUER_SMOKE_TOKEN` and
  `ANVIL_AWS_WRONG_AUDIENCE_SMOKE_TOKEN` presence for issuer/audience rejection
  smoke coverage.

`local.runtime` includes `details.reason` on warnings so automation can
distinguish `invalid-json`, `not-anvil-health`, `http-status`, and connection
errors when a port is occupied by the wrong process or the local runtime is not
ready.

JSON output:

```json
{
  "ok": true,
  "checks": [
    {
      "id": "node.version",
      "status": "ok",
      "message": "Node 20.11.0 satisfies >=20.11.0."
    }
  ],
  "summary": {
    "ok": 1,
    "info": 0,
    "warnings": 0,
    "errors": 0
  }
}
```

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

### `anvil-cloud usage --preview`

Builds the Cell and emits lightweight usage visibility from the AWS preview
plan.

```sh
anvil-cloud usage --preview --json
```

The report includes declared resource counts for tables, files, events, jobs,
workflows, services, and agents, plus cost-driver hints and cleanup commands.
It is not a bill and does not query AWS.

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

### `anvil-cloud plan --stage <stage> --adapter aws`

Builds the Cell, compiles the provider-neutral Cell graph, and asks the adapter
for an Anvil-first deployment plan.

```sh
anvil-cloud plan --stage dev --adapter aws --json
```

JSON output includes:

- `graph`: provider-neutral Cell graph, with no Pulumi or AWS authoring surface;
- `plan.changes`: stable Anvil concepts such as cells, routes, functions,
  tables, secrets, and permissions;
- `plan.review.changeSet`: diffable change ids for review tooling;
- `plan.review.capabilityDiffs`: added, removed, or unchanged Cell graph
  capabilities compared with a previous graph when available;
- `plan.review.cost.drivers`: cost-driver hints, not price estimates;
- `plan.review.rollback`: current rollback support and manual recovery notes;
- `plan.review.cleanup`: cleanup commands and notes reviewers should confirm
  before applying preview changes;
- `plan.review.approvalSummary`: compact counts over review gates, including
  whether any gate blocks provisioning;
- `plan.review.approvalGates`: required review gates for destructive changes,
  new data resources, permissions/secrets, and public ingress.

Human output shows Anvil concepts first, followed by review gates, cost drivers,
and rollback notes. `--verbose` or `--debug` may include underlying Pulumi
resource mappings for adapter debugging only.

### `anvil-cloud deploy --preview`

Deploys a Cell to a preview environment through the configured deployment adapter. AWS is the first planned alpha adapter.

In alpha, deploy may be implemented after local runtime, builder, manifest, and the deployment adapter contract are stable.

`anvil-cloud deploy --preview --wait --json` polls the deployed runtime
`/_anvil/health` endpoint after successful provisioning. Use
`--wait-timeout <seconds>` to adjust the default 60 second timeout; the value
must be positive. If the runtime does not become healthy, the JSON result uses
`AWS_RUNTIME_UNHEALTHY` and includes the deployment result plus verification
details.

Preview deploy JSON includes review-oriented plan metadata: stable
`plan.review.changeSet` ids, `plan.review.changeSummary` concept counts,
structured `plan.review.cost.drivers`, rollback/cleanup notes, and
`plan.review.approvalSummary` / `plan.review.approvalGates`. Successful AWS
preview deploys include
`resources.deploymentMetadataTable` and `resources.deploymentMetadataKey` so
automation can connect deploy output to remote inspect, logs, and destroy
cleanup state. During alpha, Cells with services, workflows, or outbound fetch
are reviewable before provisioning: workflows add `workflow-preview-review`,
services add `service-preview-review`, and outbound fetch allow-lists are
written into the generated AWS runtime guard.

If CloudFormation does not reach a terminal stack status within the provisioner
polling limit, deploy returns `AWS_STACK_TIMEOUT` with the last observed stack
status and polling details.
If a completed stack omits a required adapter output, deploy returns
`AWS_STACK_OUTPUT_MISSING` with the missing output key.
If an AWS SDK operation fails while uploading artifacts, applying the stack, or
publishing deployment metadata, deploy returns
`AWS_PROVISIONING_OPERATION_FAILED` with the failed operation and provider
error cause.

### `anvil-cloud rollback --preview`

Returns dry-run rollback intent for a previous preview deployment.

```sh
anvil-cloud rollback --preview --app notes --to-deployment dep_123 --dry-run --json
```

The command is intentionally dry-run only in alpha. It returns the target
deployment id, inspection/log commands, and redeploy guidance. Artifact
promotion is not automated yet.

### `anvil-cloud destroy --preview --app <name> --yes [--dry-run]`

Deletes the AWS preview stack for a Cell. The command is intentionally explicit:
alpha cleanup requires `--preview`, `--app`, and `--yes` so a typo does not
become infrastructure archaeology with billing.
Only `--env preview` is accepted during alpha; other environments return
`INVALID_USAGE`.

`--dry-run` validates the same command shape and returns the computed stack name,
bucket cleanup intent, deployment metadata key, and real destroy command without
calling AWS. It exists so local contract tests can cover the full lifecycle
without pretending every laptop is a cloud control plane.

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
