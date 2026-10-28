---
title: CLI reference
navTitle: CLI reference
description: Commands, JSON output, exit codes, local inspection, and AWS preview deployment through the Mezair Cloud CLI.
product: Mezair Cloud
section: Reference
journey: reference
order: 180
---

# CLI reference

The normal user-facing command is `mezair cloud ...` through the umbrella
`@mezairstack/cli` package:

```bash
npm install --global @mezairstack/cli
npm install --global @mezairstack/cloud-cli

mezair cloud check --json
mezair cloud dev
```

The product package is `@mezairstack/cloud-cli` and the direct binary is
`mezair-cloud`. The wrapper dispatches to that binary, so these are equivalent
when both packages are installed:

```bash
mezair cloud check --json
mezair-cloud check --json
```

Use `mezair cloud ...` in docs, tutorials, and normal shell usage. Use
`mezair-cloud ...` when you are testing the product package directly, debugging
wrapper dispatch, or writing a package-specific CI path. From a checkout, run
the command contract through `pnpm mezair-cloud ...` at the workspace root, or
through `node ../../packages/cli/dist/index.js ...` inside checked-in examples.
Human output can be friendly, but automation output must be stable.

## Commands

| Command                                    | Purpose                                                                                       |
| ------------------------------------------ | --------------------------------------------------------------------------------------------- |
| `mezair cloud new <name>`                   | Create a new Cell project.                                                                    |
| `mezair cloud dev`                          | Build and start the local runtime and client server.                                          |
| `mezair cloud doctor`                       | Check local toolchain, project artifacts, runtime ports, AWS preview env, and auth smoke setup. |
| `mezair cloud check`                        | Validate config, import policy, capabilities, and TypeScript without writing build output.    |
| `mezair cloud review`                       | Aggregate Guard diagnostics and AWS preview approval gates into one trust report.             |
| `mezair cloud build`                        | Build server and client artifacts, manifest, generated client, generated types, and metadata. |
| `mezair cloud manifest diff`                | Compare manifest baselines against current source or an explicit candidate manifest.          |
| `mezair cloud agents validate`              | Validate mounted agents and compile their contracts without calling a model provider.         |
| `mezair cloud agents manifest`              | Emit provider-neutral agent manifests from the current Cell build.                            |
| `mezair cloud agents discover`              | Discover project agent instruction files and mounted Cell agents.                             |
| `mezair cloud agents guardian`              | Run the deterministic Guardian review over the Cell trust report.                             |
| `mezair cloud agents sandboxes`             | Report AWS Lambda MicroVM sandbox readiness for sandbox-required agents.                      |
| `mezair cloud agents invoke <name>`         | Invoke a mounted agent locally through the registered provider (`--input <text>`).            |
| `mezair cloud executions conformance`       | Prove idempotency, cursor replay, approval resume, patch return, and sandbox teardown without a cloud account. |
| `mezair cloud channels simulate`            | Send a simulated channel message to a mounted agent through the local runtime (`--channel`, `--input`). |
| `mezair cloud inspect --local`              | Inspect local manifest, auth, database counts, and recent errors.                             |
| `mezair cloud lens`                         | Verify the local runtime is reachable and print the Mezair Lens URL.                           |
| `mezair cloud logs --local`                 | Read local NDJSON logs.                                                                       |
| `mezair cloud usage --local`                | Read local usage events: invocations, tokens, estimated cost, budget warnings, and top consumers. |
| `mezair cloud db list --local`              | List local database tables on the active branch, or `--branch <name>`.                        |
| `mezair cloud db dump <table> --local`      | Dump local table rows on the active branch, or `--branch <name>`.                             |
| `mezair cloud db branch <name>`             | Snapshot a local database branch (`--from main`, optional `--ttl` and `--use`).               |
| `mezair cloud db branches`                  | List local database branches; add `--expired` to filter TTL-expired branches.                 |
| `mezair cloud db use <name>`                | Store the active local database branch for CLI inspection and dev runs.                       |
| `mezair cloud db diff <name>`               | Compare row counts and schema fields against `main` or `--against <branch>`.                  |
| `mezair cloud db promote <name>`            | Copy a branch snapshot back to `main`.                                                        |
| `mezair cloud db delete <name> --yes`       | Delete a named local database branch.                                                         |
| `mezair cloud db cleanup --expired`         | Delete TTL-expired local database branches.                                                   |
| `mezair cloud deploy --preview`             | Build and synthesize AWS preview deployment output, with provisioning when configured.        |
| `mezair cloud usage --preview`              | Report declared preview resource counts, cost-driver hints, and cleanup commands.             |
| `mezair cloud rollback --preview --dry-run` | Emit rollback intent for a previous preview deployment.                                       |
| `mezair cloud auth users`                   | List local identity provider users.                                                           |
| `mezair cloud auth add-user <id>`           | Create a local user (`--email`, `--roles a,b`).                                               |
| `mezair cloud auth remove-user <id>`        | Delete a local user.                                                                          |
| `mezair cloud auth login <id>`              | Set the ambient dev identity and print a JWT.                                                 |
| `mezair cloud auth token <id>`              | Mint a JWT for a user (`--ttl` seconds); ideal for agents and curl.                           |
| `mezair cloud auth whoami`                  | Show the ambient dev identity.                                                                |
| `mezair cloud workflows list`               | List local workflow runs.                                                                     |
| `mezair cloud workflows show <runId>`       | Show a local workflow run with per-step state.                                                |
| `mezair cloud workflows run <name>`         | Build the Cell and execute a workflow locally (`--input '<json>'`).                           |
| `mezair cloud services list`                | Show the last recorded local service states from `.mezair/local/services.json`.                |

Remote inspection:

```bash
mezair cloud inspect --app notes --env preview --json
mezair cloud logs --app notes --env preview --json
```

Remote AWS readers require `MEZAIR_AWS_DEPLOYMENT_METADATA_TABLE`.

## `mezair cloud new <name>`

Creates a starter Cell:

```bash
mezair cloud new notes
pnpm dlx @mezairstack/cloud-cli new notes
```

The package name is `@mezairstack/cloud-cli`; the binary name is `mezair-cloud`.

JSON output:

```json
{
  "ok": true,
  "cell": "notes",
  "template": "crud",
  "path": "./notes",
  "lensUrl": "http://localhost:8787/_mezair/lens",
  "next": ["cd notes", "mezair-cloud dev"]
}
```

Human mode scaffolds, installs dependencies with `pnpm install --ignore-scripts`,
runs `git init`, prints the Lens URL, and starts the local dev server. Pass
`--no-install`, `--no-git`, or `--no-start` to split the flow. `--json` stays
finite by default so coding agents get the project path, Lens URL, bootstrap
plan, and next commands without being trapped inside a long-running server.

Useful starter options:

```txt
--client vite-react|expo-router|headless
--template crud|auth|workflow|service|agent|sandbox
--package-manager pnpm|npm|bun
```

## `mezair cloud dev`

Starts local runtime and client servers after a successful build.

Options:

```txt
--json
--agent
--host <address>
--port <port>
--client-port <port>
```

The runtime binds to `127.0.0.1` by default. Only use `--host` on a trusted
network; it also exposes local Lens management actions.

Human output:

```txt
Mezair Local runtime  http://localhost:8787
Mezair client         http://localhost:5173
Mezair Lens           http://localhost:8787/_mezair/lens
```

`--agent --json` emits JSONL events and avoids rich terminal output.

## `mezair cloud lens`

Checks that a local runtime is reachable (`GET /_mezair/health` at `--port`, default `8787`) and prints the Lens URL:

```bash
mezair cloud lens
mezair cloud lens --json
```

Success:

```json
{ "ok": true, "url": "http://localhost:8787/_mezair/lens" }
```

If nothing is running, the command exits with code `5` and returns `LENS_SERVER_NOT_RUNNING` telling you to run `mezair cloud dev` first. See [Mezair Lens](/docs/cloud/lens).

## `mezair cloud doctor`

Checks the local toolchain, Cell config, built artifacts, generated client
freshness, local runtime state, runtime/client ports, AWS preview environment,
and OIDC smoke-test variables:

```bash
mezair cloud doctor --json
mezair cloud doctor --port 8787 --client-port 5173 --json
```

Each check includes a stable `id`, `status`, display `message`, optional
remediation `hint`, optional `details`, and a `docs` link. See
[Doctor diagnostics](/docs/cloud/doctor) for the full ID list.

## `mezair cloud check`

Runs validation without writing artifacts:

```bash
mezair cloud check --json
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
      "hint": "Use declared Mezair capabilities such as ctx.db or ctx.files."
    }
  ],
  "errors": [
    {
      "code": "FORBIDDEN_IMPORT",
      "severity": "error",
      "message": "Import '@aws-sdk/client-s3' is not allowed in Cell server code.",
      "hint": "Use declared Mezair capabilities such as ctx.db or ctx.files."
    }
  ]
}
```

`errors` is kept as a compatibility alias for older automation; new agent flows
should read `diagnostics`.

## `mezair cloud agents`

Agent commands build the current Cell and use the same manifest extraction path
as `mezair cloud build`.

Contract validation:

```bash
mezair cloud agents validate --json
```

Manifest output:

```bash
mezair cloud agents manifest --json
```

Project discovery:

```bash
mezair cloud agents discover --json
```

Guardian review:

```bash
mezair cloud agents guardian --json
```

Local invocation:

```bash
mezair cloud agents invoke support --input "Review this Cell" --json
```

`validate`, `manifest`, `discover`, and `guardian` do not call a model provider.
`discover` reports `agents/**/instructions.md` files plus mounted Cell agents
from the manifest. `guardian` runs the same trust aggregation as
`mezair-cloud review` and emits deterministic findings for Guard errors, approval
gates, rollback posture, and cleanup evidence. `invoke` resolves the agent model
provider through the runtime provider registry. The local stub provider is
deterministic and does not make external calls. Provider mode can use a
registered provider such as `aws-bedrock` while still enforcing the Mezair agent
contract locally.

See [Mezair Agents](/docs/cloud/agents).

## `mezair cloud channels`

Simulate provider-neutral channel ingress against a running local runtime:

```bash
mezair cloud channels simulate \
  --channel supportSlack \
  --sender U123 \
  --thread T456 \
  --input "Can you review this issue?" \
  --json
```

The command posts to `/_mezair/channels/simulate`. The JSON response includes
the matched channel, session summary, ordered events, continuation token, and
reply chunks. Real Slack, GitHub, and Discord credentials stay platform-side;
Cell agent code receives normalized context and remains channel-agnostic.

## `mezair cloud build`

Writes `.mezair/dist` and `.mezair/generated`:

```bash
mezair cloud build --json
```

Successful output includes build paths, manifest, and diagnostics.

## `mezair cloud manifest diff`

Compares Cell manifests without deploying anything:

```bash
mezair cloud manifest diff --json
mezair cloud manifest diff --from .mezair/dist/manifest.json --to candidate.json --json
```

Without `--to`, the command compares the previous local
`.mezair/dist/manifest.json` with a scratch build of the current Cell source.
With `--to`, it reads both manifest files directly and skips the build.

JSON output includes:

- `status: "no-baseline" | "unchanged" | "changed" | "block"`
- summary counts for additions, removals, changes, warnings, and errors
- stable `changes[].id` values
- `category`, `action`, `severity`, `path`, `message`, optional `before`,
  `after`, and `hint` for each change

Error-severity changes currently include public file access escalation, schema
table removal, schema field removal, and schema field type changes. The command
exits with code `5` when any error-severity diff is present.

## Local inspection commands

```bash
mezair cloud inspect --local --json
mezair cloud logs --local --json
mezair cloud logs --trace run_123 --json
mezair cloud db list --local --json
mezair cloud db dump notes --local --json
mezair cloud services list --json
```

`mezair cloud services list` reads the snapshot file written by the dev server, so it shows the last recorded states. For live service state, query `GET /_mezair/services` on a running dev server. See [Services](/docs/cloud/services).

Use these before deploying. They are cheap and they catch the kind of "it worked in my imagination" issues that make preview environments do performance art.

`logs --trace <traceId>` reads local trace records from
`.mezair/local/traces.json`. Workflow traces use the workflow run id; agent
invocations return a `traceId` in local runtime responses.

For remote AWS inspection:

```bash
mezair cloud inspect --app notes --env preview --json
mezair cloud logs --app notes --env preview --json
```

Both commands read the deployment metadata table configured with
`MEZAIR_AWS_DEPLOYMENT_METADATA_TABLE`. Missing or malformed records return
stable JSON errors: `AWS_DEPLOYMENT_METADATA_NOT_FOUND` or
`AWS_DEPLOYMENT_METADATA_INVALID`.

Remote inspect includes deploy artifact metadata when present, including the
Lambda bundle key and SHA-256 digest from the latest preview deploy.
Remote logs accept `--since` as a millisecond timestamp or a relative duration
with `ms`, `s`, `m`, `h`, or `d`, such as `30s`, `10m`, or `1h`. They page
through CloudWatch events until the requested `--limit` is reached or CloudWatch
has no more pages. `--limit` must be a positive whole number.

## `mezair cloud deploy --preview`

```bash
mezair cloud deploy --preview --json
mezair cloud deploy --preview --wait --wait-timeout 60 --json
mezair cloud deploy --preview --name branch --json
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

Named previews use `--name <preview>`. The default preview keeps the existing
metadata key. Named previews add the normalized name to the adapter-owned stack
and deployment metadata key so branch previews do not overwrite each other.

## `mezair-cloud usage --preview`

```bash
mezair-cloud usage --preview --json
```

Builds the Cell and reports declared preview resource counts plus AWS preview
cost-driver hints and cleanup commands. It does not query AWS and is not a bill.

## `mezair-cloud rollback --preview`

```bash
mezair-cloud rollback --preview --app notes --to-deployment dep_previous --dry-run --json
```

Returns stable rollback intent: target deployment id, inspection/log commands,
and redeploy guidance. Automated promotion is unsupported because current
metadata stores only the active deployment and client assets are not archived
as a restorable set.

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

With `--wait`, deploy polls the deployed runtime `/_mezair/health` endpoint after
successful provisioning. If the runtime does not become healthy within the
timeout, deploy returns `ok: false` with `code: "AWS_RUNTIME_UNHEALTHY"` and
keeps the deployment result in the JSON payload for debugging.
`--wait-timeout` must be a positive number of seconds.

The workspace also includes a repeatable AWS preview smoke verifier for the
checked-in `examples/aws-preview` Cell:

```bash
MEZAIR_AWS_ARTIFACT_BUCKET=<artifact-bucket> \
AWS_REGION=eu-west-2 \
pnpm verify:aws-preview
```

It deploys with `--wait`, checks the runtime health and public status query,
runs remote `inspect` and `logs`, and destroys the preview stack unless
`MEZAIR_AWS_SMOKE_KEEP_STACK=1` is set. Set `MEZAIR_AWS_SMOKE_TOKEN` to include
authenticated mutation/query checks.

## `mezair cloud destroy --preview`

```bash
mezair cloud destroy --preview --app notes --yes --json
mezair cloud destroy --preview --app notes --name branch --yes --json
```

Deletes the computed AWS preview CloudFormation stack for a Cell. The command
requires `--app` to identify the Cell and `--yes` to confirm deletion.

Before deleting the stack, destroy empties stack-owned S3 buckets exposed by
CloudFormation outputs, including client assets and Cell files when present. If
`MEZAIR_AWS_DEPLOYMENT_METADATA_TABLE` is configured, destroy also removes the
matching deployment metadata record. The JSON result includes `emptiedBuckets`
and `metadataDeleted`, so automation can see which cleanup steps actually ran.
Pass `--name <preview>` to clean up a named preview stack and metadata record.
If CloudFormation reports a failed delete status, destroy returns
`AWS_DESTROY_FAILED`. If deletion remains in progress past the polling limit,
destroy returns `AWS_DESTROY_TIMEOUT`. If an AWS SDK operation fails while
emptying buckets, deleting the stack, or deleting deployment metadata, destroy
returns `AWS_DESTROY_OPERATION_FAILED`.

## `mezair-cloud mesh`

The `mesh` commands deploy the existing Sync/Mesh backend Worker to a
Cloudflare account. Select `--mode self-hosted` for enrollment/OIDC without
hosted billing, or `--mode hosted` for D1 billing, the website service channel
and reconciliation. The generic Cell Cloudflare adapter remains plan-only.

```bash
mezair-cloud mesh plan --backend <path> --name <worker> \
  --mode hosted --stage staging --account-id <id> \
  --base-url <https-origin> --bucket <bucket> --database <billing-db> \
  --vars-file <json> --config-out <generated-config> --write --json

# Repeat the same target options on each command:
mezair-cloud mesh provision <target-options> --json
mezair-cloud mesh migrate <target-options> --json
mezair-cloud mesh apply <target-options> --dry-run --json
mezair-cloud mesh apply <target-options> --test-deployment --json
mezair-cloud mesh secrets <target-options> --from-file <secret-json> --json
mezair-cloud mesh remove <target-options> --test-deployment --json

mezair-cloud mesh provisioner plan --provisioner <path> --name <worker> \
  --mode managed --stage staging --account-id <id> --write --json
mezair-cloud mesh provisioner apply <provisioner-options> --dry-run --json
mezair-cloud mesh provisioner apply <provisioner-options> --test-deployment --json
mezair-cloud mesh provisioner secrets <provisioner-options> \
  --from-file <token-text-file> --test-deployment --json
```

`plan` writes config only with `--write`. It preserves the selected backend's
bindings and complete Durable Object migration history. Hosted mode reads
`wrangler.hosted.jsonc` and retains D1, cron, billing vars and service bindings.
`--first-deploy` records intent; migration tags are always emitted.

`provision` creates or reuses resources and records D1 ids. `migrate` applies
D1 migrations remotely. `apply` deploys the Worker; install secrets separately
after the first apply. Backend secrets input is JSON; provisioner secrets
input is one raw token. Both support `--from-stdin` instead of a file and keep
values off process arguments and command output.

`--test-deployment` allows initial deployment testing only on an explicit
non-production stage. The default production stage still requires
`--evidence <recorded-reference>` for apply/remove. Resource isolation comes
from the account, Worker, bucket and database names you select.

The provisioner commands build and deploy the Sandbox Worker/container for
managed or BYO environments. `--managed-provisioner <worker>` on the backend
adds the service binding; install matching backend/provisioner tokens.

`mesh connection --name <worker> --base-url <https-origin> --out <path> --json`
exports a discovery record for the desktop. Removal deletes the selected
Worker and is not a complete D1/R2 cleanup workflow.

The branch testing sequence is in
`mezair-app/docs/runbooks/hosted-sync/deploy.md`; architecture and API details
are in `mezair-cloud/docs/architecture/cloudflare-mesh-recipe.md`.

## Exit codes

| Code | Meaning                                             |
| ---- | --------------------------------------------------- |
| `0`  | Success                                             |
| `1`  | General failure                                     |
| `2`  | Invalid CLI usage                                   |
| `3`  | Project validation failed                           |
| `4`  | Build failed                                        |
| `5`  | Runtime unavailable, remote reader not configured, doctor blocking errors, or manifest diff blocking errors |
| `6`  | Deploy or destroy failed                            |

## Automation rule

Every automation-oriented command should support `--json`. Do not parse human output in CI or agent workflows unless you enjoy finding out that punctuation is an API now.
