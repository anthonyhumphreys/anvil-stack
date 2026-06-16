---
title: CLI reference
navTitle: CLI reference
description: Commands, JSON output, exit codes, local inspection, and AWS preview deployment for the Anvil Cloud CLI.
product: Anvil Cloud
section: Reference
order: 140
---

# CLI reference

The Anvil Cloud CLI binary is `anvil`.

In alpha, the package exists as `@anvil-cloud/cli` inside the `anvil-cloud` workspace. The command contract is the important part: human output can be friendly, but automation output must be stable.

## Commands

| Command | Purpose |
| --- | --- |
| `anvil new <name>` | Create a new Cell project. |
| `anvil dev` | Build and start the local runtime and client server. |
| `anvil check` | Validate config, import policy, capabilities, and TypeScript without writing build output. |
| `anvil build` | Build server and client artifacts, manifest, generated client, generated types, and metadata. |
| `anvil inspect --local` | Inspect local manifest, auth, database counts, and recent errors. |
| `anvil lens` | Verify the local runtime is reachable and print the Anvil Lens URL. |
| `anvil logs --local` | Read local NDJSON logs. |
| `anvil db list --local` | List local database tables. |
| `anvil db dump <table> --local` | Dump local table rows. |
| `anvil deploy --preview` | Build and synthesize AWS preview deployment output, with provisioning when configured. |
| `anvil auth users` | List local identity provider users. |
| `anvil auth add-user <id>` | Create a local user (`--email`, `--roles a,b`). |
| `anvil auth remove-user <id>` | Delete a local user. |
| `anvil auth login <id>` | Set the ambient dev identity and print a JWT. |
| `anvil auth token <id>` | Mint a JWT for a user (`--ttl` seconds); ideal for agents and curl. |
| `anvil auth whoami` | Show the ambient dev identity. |
| `anvil workflows list` | List local workflow runs. |
| `anvil workflows show <runId>` | Show a local workflow run with per-step state. |
| `anvil workflows run <name>` | Build the Cell and execute a workflow locally (`--input '<json>'`). |
| `anvil services list` | Show the last recorded local service states from `.anvil/local/services.json`. |

Remote inspection:

```bash
anvil inspect --app notes --env preview --json
anvil logs --app notes --env preview --json
```

Remote AWS readers require `ANVIL_AWS_DEPLOYMENT_METADATA_TABLE`.

## `anvil new <name>`

Creates a starter Cell:

```bash
anvil new notes
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

## `anvil dev`

Starts local runtime and client servers after a successful build.

Options:

```txt
--json
--agent
--port <port>
--client-port <port>
```

Human output:

```txt
Anvil Local runtime  http://localhost:8787
Anvil client         http://localhost:5173
Anvil Lens           http://localhost:8787/_anvil/lens
```

`--agent --json` emits JSONL events and avoids rich terminal output.

## `anvil lens`

Checks that a local runtime is reachable (`GET /_anvil/health` at `--port`, default `8787`) and prints the Lens URL:

```bash
anvil lens
anvil lens --json
```

Success:

```json
{ "ok": true, "url": "http://localhost:8787/_anvil/lens" }
```

If nothing is running, the command exits with code `5` and returns `LENS_SERVER_NOT_RUNNING` telling you to run `anvil dev` first. See [Anvil Lens](/docs/cloud/lens).

## `anvil check`

Runs validation without writing artifacts:

```bash
anvil check --json
```

Failure shape:

```json
{
  "ok": false,
  "phase": "import-policy",
  "errors": [
    {
      "code": "FORBIDDEN_IMPORT",
      "severity": "error",
      "message": "Import '@aws-sdk/client-s3' is not allowed in Cell server code.",
      "hint": "Use declared Anvil capabilities such as ctx.db or ctx.files."
    }
  ]
}
```

## `anvil build`

Writes `.anvil/dist` and `.anvil/generated`:

```bash
anvil build --json
```

Successful output includes build paths, manifest, and diagnostics.

## Local inspection commands

```bash
anvil inspect --local --json
anvil logs --local --json
anvil db list --local --json
anvil db dump todos --local --json
anvil services list --json
```

`anvil services list` reads the snapshot file written by the dev server, so it shows the last recorded states. For live service state, query `GET /_anvil/services` on a running dev server. See [Services](/docs/cloud/services).

Use these before deploying. They are cheap and they catch the kind of "it worked in my imagination" issues that make preview environments do performance art.

For remote AWS inspection:

```bash
anvil inspect --app notes --env preview --json
anvil logs --app notes --env preview --json
```

Both commands read the deployment metadata table configured with
`ANVIL_AWS_DEPLOYMENT_METADATA_TABLE`. Missing or malformed records return
stable JSON errors: `AWS_DEPLOYMENT_METADATA_NOT_FOUND` or
`AWS_DEPLOYMENT_METADATA_INVALID`.

Remote inspect includes deploy artifact metadata when present, including the
Lambda bundle key and SHA-256 digest from the latest preview deploy.
Remote logs accept `--since` as a millisecond timestamp or a relative duration
with `ms`, `s`, `m`, `h`, or `d`, such as `30s`, `10m`, or `1h`. They page
through CloudWatch events until the requested `--limit` is reached or CloudWatch
has no more pages. `--limit` must be a positive whole number.

## `anvil deploy --preview`

```bash
anvil deploy --preview --json
anvil deploy --preview --wait --wait-timeout 60 --json
```

The CLI:

1. builds the Cell with `target: "preview"`
2. creates an AWS preview deployment plan
3. synthesizes a CloudFormation template
4. packages deploy artifacts when build output is present
5. provisions AWS resources only when the AWS provisioner is configured

If provisioning is not configured, the adapter returns:

- `ok: false`
- `code: "AWS_PROVISIONER_NOT_CONFIGURED"`
- deployment plan
- CloudFormation template
- artifact summary when available

That is useful. It means deploy planning can be reviewed without mutating an AWS account.

The deployment plan includes an `operations` block with rollback notes, cleanup
commands, and cost drivers for the generated preview resources. Treat these as
operator hints, not billing estimates. Actual rollback commands and real cost
reporting are still future work.

If CloudFormation reaches a failed terminal state during provisioning, deploy
returns `ok: false` with `code: "AWS_STACK_FAILED"` and structured stack event
details so CI and agents can report the failing resource directly.
If the stack remains in progress past the provisioner polling limit, deploy
returns `ok: false` with `code: "AWS_STACK_TIMEOUT"` and the last observed stack
status.
If a completed stack omits a required adapter output, deploy returns `ok: false`
with `code: "AWS_STACK_OUTPUT_MISSING"` and the missing output key.
If an AWS SDK operation fails while uploading artifacts, applying the stack, or
publishing deployment metadata, deploy returns `ok: false` with
`code: "AWS_PROVISIONING_OPERATION_FAILED"` and the failed operation plus
provider error cause.

With `--wait`, deploy polls the deployed runtime `/_anvil/health` endpoint after
successful provisioning. If the runtime does not become healthy within the
timeout, deploy returns `ok: false` with `code: "AWS_RUNTIME_UNHEALTHY"` and
keeps the deployment result in the JSON payload for debugging.
`--wait-timeout` must be a positive number of seconds.

The workspace also includes a repeatable AWS preview smoke verifier for the
checked-in `examples/aws-preview` Cell:

```bash
ANVIL_AWS_ARTIFACT_BUCKET=<artifact-bucket> \
AWS_REGION=eu-west-2 \
pnpm verify:aws-preview
```

It deploys with `--wait`, checks the runtime health and public status query,
runs remote `inspect` and `logs`, and destroys the preview stack unless
`ANVIL_AWS_SMOKE_KEEP_STACK=1` is set. Set `ANVIL_AWS_SMOKE_TOKEN` to include
authenticated mutation/query checks.

## `anvil destroy --preview`

```bash
anvil destroy --preview --app notes --yes --json
```

Deletes the computed AWS preview CloudFormation stack for a Cell. The command
requires `--app` and `--yes` because accidental cleanup commands are how preview
environments become a small billing-themed mystery novel.

Before deleting the stack, destroy empties stack-owned S3 buckets exposed by
CloudFormation outputs, including client assets and Cell files when present. If
`ANVIL_AWS_DEPLOYMENT_METADATA_TABLE` is configured, destroy also removes the
matching deployment metadata record. The JSON result includes `emptiedBuckets`
and `metadataDeleted`, so automation can see which cleanup steps actually ran.
If CloudFormation reports a failed delete status, destroy returns
`AWS_DESTROY_FAILED`. If deletion remains in progress past the polling limit,
destroy returns `AWS_DESTROY_TIMEOUT`. If an AWS SDK operation fails while
emptying buckets, deleting the stack, or deleting deployment metadata, destroy
returns `AWS_DESTROY_OPERATION_FAILED`.

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | Success |
| `1` | General failure |
| `2` | Invalid CLI usage |
| `3` | Project validation failed |
| `4` | Build failed |
| `5` | Runtime unavailable or remote reader not configured |
| `6` | Deploy or destroy failed |

## Automation rule

Every automation-oriented command should support `--json`. Do not parse human output in CI or agent workflows unless you enjoy finding out that punctuation is an API now.
