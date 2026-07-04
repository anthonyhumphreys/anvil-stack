---
title: CLI reference
navTitle: CLI reference
description: Commands, JSON output, exit codes, local inspection, and AWS preview deployment through the Anvil Cloud CLI.
product: Anvil Cloud
section: Reference
order: 140
---

# CLI reference

The normal user-facing command is `anvil cloud ...` through the umbrella
`@anvilstack/cli` package:

```bash
npm install --global @anvilstack/cli
npm install --global @anvilstack/cloud-cli

anvil cloud check --json
anvil cloud dev
```

The product package is `@anvilstack/cloud-cli` and the direct binary is
`anvil-cloud`. The wrapper dispatches to that binary, so these are equivalent
when both packages are installed:

```bash
anvil cloud check --json
anvil-cloud check --json
```

Use `anvil cloud ...` in docs, tutorials, and normal shell usage. Use
`anvil-cloud ...` when you are testing the product package directly, debugging
wrapper dispatch, or writing a package-specific CI path. From a checkout, run
the command contract through `pnpm anvil-cloud ...` at the workspace root, or
through `node ../../packages/cli/dist/index.js ...` inside checked-in examples.
Human output can be friendly, but automation output must be stable.

## Commands

| Command | Purpose |
| --- | --- |
| `anvil cloud new <name>` | Create a new Cell project. |
| `anvil cloud dev` | Build and start the local runtime and client server. |
| `anvil cloud check` | Validate config, import policy, capabilities, and TypeScript without writing build output. |
| `anvil cloud review` | Aggregate Guard diagnostics and AWS preview approval gates into one trust report. |
| `anvil cloud build` | Build server and client artifacts, manifest, generated client, generated types, and metadata. |
| `anvil cloud agents validate` | Validate mounted agents and compile their contracts without calling a model provider. |
| `anvil cloud agents manifest` | Emit provider-neutral agent manifests from the current Cell build. |
| `anvil cloud agents discover` | Discover project agent instruction files and mounted Cell agents. |
| `anvil cloud agents guardian` | Run the deterministic Guardian review over the Cell trust report. |
| `anvil cloud agents sandboxes` | Report AWS Lambda MicroVM sandbox readiness for sandbox-required agents. |
| `anvil cloud agents invoke <name>` | Invoke a mounted agent locally through the registered provider (`--input <text>`). |
| `anvil cloud inspect --local` | Inspect local manifest, auth, database counts, and recent errors. |
| `anvil cloud lens` | Verify the local runtime is reachable and print the Anvil Lens URL. |
| `anvil cloud logs --local` | Read local NDJSON logs. |
| `anvil cloud db list --local` | List local database tables. |
| `anvil cloud db dump <table> --local` | Dump local table rows. |
| `anvil cloud deploy --preview` | Build and synthesize AWS preview deployment output, with provisioning when configured. |
| `anvil cloud usage --preview` | Report declared preview resource counts, cost-driver hints, and cleanup commands. |
| `anvil cloud rollback --preview --dry-run` | Emit dry-run rollback intent for a previous preview deployment. |
| `anvil cloud auth users` | List local identity provider users. |
| `anvil cloud auth add-user <id>` | Create a local user (`--email`, `--roles a,b`). |
| `anvil cloud auth remove-user <id>` | Delete a local user. |
| `anvil cloud auth login <id>` | Set the ambient dev identity and print a JWT. |
| `anvil cloud auth token <id>` | Mint a JWT for a user (`--ttl` seconds); ideal for agents and curl. |
| `anvil cloud auth whoami` | Show the ambient dev identity. |
| `anvil cloud workflows list` | List local workflow runs. |
| `anvil cloud workflows show <runId>` | Show a local workflow run with per-step state. |
| `anvil cloud workflows run <name>` | Build the Cell and execute a workflow locally (`--input '<json>'`). |
| `anvil cloud services list` | Show the last recorded local service states from `.anvil/local/services.json`. |

Remote inspection:

```bash
anvil cloud inspect --app notes --env preview --json
anvil cloud logs --app notes --env preview --json
```

Remote AWS readers require `ANVIL_AWS_DEPLOYMENT_METADATA_TABLE`.

## `anvil cloud new <name>`

Creates a starter Cell:

```bash
anvil cloud new notes
```

JSON output:

```json
{
  "ok": true,
  "cell": "notes",
  "path": "./notes",
  "next": ["cd notes", "anvil cloud dev"]
}
```

## `anvil cloud dev`

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

## `anvil cloud lens`

Checks that a local runtime is reachable (`GET /_anvil/health` at `--port`, default `8787`) and prints the Lens URL:

```bash
anvil cloud lens
anvil cloud lens --json
```

Success:

```json
{ "ok": true, "url": "http://localhost:8787/_anvil/lens" }
```

If nothing is running, the command exits with code `5` and returns `LENS_SERVER_NOT_RUNNING` telling you to run `anvil cloud dev` first. See [Anvil Lens](/docs/cloud/lens).

## `anvil cloud check`

Runs validation without writing artifacts:

```bash
anvil cloud check --json
```

Failure shape:

```json
{
  "ok": false,
  "phase": "import-policy",
  "diagnostics": [
    {
      "code": "FORBIDDEN_IMPORT",
      "severity": "error",
      "message": "Import '@aws-sdk/client-s3' is not allowed in Cell server code.",
      "hint": "Use declared Anvil capabilities such as ctx.db or ctx.files."
    }
  ],
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

`errors` is kept as a compatibility alias for older automation; new agent flows
should read `diagnostics`.

## `anvil cloud agents`

Agent commands build the current Cell and use the same manifest extraction path
as `anvil cloud build`.

Contract validation:

```bash
anvil cloud agents validate --json
```

Manifest output:

```bash
anvil cloud agents manifest --json
```

Project discovery:

```bash
anvil-cloud agents discover --json
```

Guardian review:

```bash
anvil-cloud agents guardian --json
```

Local invocation:

```bash
anvil cloud agents invoke support --input "Review this Cell" --json
```

`validate`, `manifest`, `discover`, and `guardian` do not call a model provider.
`discover` reports `agents/**/instructions.md` files plus mounted Cell agents
from the manifest. `guardian` runs the same trust aggregation as
`anvil-cloud review` and emits deterministic findings for Guard errors, approval
gates, rollback posture, and cleanup evidence. `invoke` resolves the agent model
provider through the runtime provider registry. The local stub provider is
deterministic and does not make external calls. Provider mode can use a
registered provider such as `aws-bedrock` while still enforcing the Anvil agent
contract locally.

See [Anvil Agents](/docs/cloud/agents).

## `anvil cloud build`

Writes `.anvil/dist` and `.anvil/generated`:

```bash
anvil cloud build --json
```

Successful output includes build paths, manifest, and diagnostics.

## Local inspection commands

```bash
anvil cloud inspect --local --json
anvil cloud logs --local --json
anvil cloud db list --local --json
anvil cloud db dump notes --local --json
anvil cloud services list --json
```

`anvil cloud services list` reads the snapshot file written by the dev server, so it shows the last recorded states. For live service state, query `GET /_anvil/services` on a running dev server. See [Services](/docs/cloud/services).

Use these before deploying. They are cheap and they catch the kind of "it worked in my imagination" issues that make preview environments do performance art.

For remote AWS inspection:

```bash
anvil cloud inspect --app notes --env preview --json
anvil cloud logs --app notes --env preview --json
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

## `anvil cloud deploy --preview`

```bash
anvil cloud deploy --preview --json
anvil cloud deploy --preview --wait --wait-timeout 60 --json
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
operator hints, not billing estimates.

## `anvil-cloud usage --preview`

```bash
anvil-cloud usage --preview --json
```

Builds the Cell and reports declared preview resource counts plus AWS preview
cost-driver hints and cleanup commands. It does not query AWS and is not a bill.

## `anvil-cloud rollback --preview`

```bash
anvil-cloud rollback --preview --app notes --to-deployment dep_previous --dry-run --json
```

Returns stable dry-run rollback intent: target deployment id, inspection/log
commands, and redeploy guidance. It does not mutate AWS. Automated artifact
promotion is still future work.

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

## `anvil cloud destroy --preview`

```bash
anvil cloud destroy --preview --app notes --yes --json
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
