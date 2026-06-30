---
title: AWS preview adapter
navTitle: AWS preview
description: How the Anvil Cloud AWS preview adapter maps Cell manifests to Lambda, CloudFormation, DynamoDB, S3, SQS, EventBridge, and CloudWatch.
product: Anvil Cloud
section: Deployment
order: 150
---

# AWS preview adapter

AWS is the first Anvil Cloud deployment adapter. It is not the core application contract.

Cell code should stay provider-neutral. The AWS adapter consumes a manifest, creates a deployment plan, synthesizes CloudFormation, packages artifacts, and can provision preview resources when configured.

## Current implementation

The `@anvil-cloud/aws` package currently includes:

- AWS HTTP event to `RuntimeRequest` translation
- Lambda runtime handler creation around the shared Anvil Runtime
- CloudFormation template synthesis from Cell manifests
- AWS resource name generation
- deploy artifact packaging for server bundle, client assets, manifest, and template
- optional AWS SDK preview provisioner
- DynamoDB-backed Cell table adapter
- S3-backed file adapter
- SQS-backed `ctx.jobs.enqueue`
- EventBridge scheduled job rules invoking the shared Lambda runtime
- Lambda-side workflow step execution for the planned Step Functions adapter
- Step Functions state machine template synthesis for declared workflow topology
- Lambda environment values through `ctx.env`
- OIDC bearer token verification when auth environment is configured
- structured JSON logs through Lambda and CloudWatch
- remote inspect and logs through deployment metadata and CloudWatch Logs

## Preview resource mapping

| Anvil concept | AWS backing |
| --- | --- |
| Cell runtime | Lambda |
| Query and mutation API | Lambda Function URL or API Gateway style HTTP event bridge |
| Custom endpoints | Runtime endpoint routing through the Lambda handler |
| Client bundle | S3 client asset bucket |
| Database | DynamoDB when `capabilities.database` is declared |
| Files | S3 when `capabilities.files` is declared |
| Queued jobs | SQS |
| Scheduled jobs | EventBridge rules |
| Events | A dedicated EventBridge bus when `capabilities.events` is declared; `ctx.events.publish` maps to `PutEvents` and reports structured EventBridge failure details |
| Agent inference | AWS Bedrock through the `@anvil-cloud/aws` inference provider |
| Agent sandboxes | Lambda MicroVM sessions for sandbox-required agent work when a sandbox image is configured |
| Environment | Lambda environment values for alpha |
| Logs | CloudWatch Logs |
| Deployment metadata | DynamoDB |

Deployment plans include an `events` change when `capabilities.events` is
declared, so `anvil-cloud deploy --preview --json` reports the EventBridge resource
before provisioning.

Deployment plans also include an `operations` block with preview rollback
guidance, cleanup commands, and cost drivers. This is intentionally not a cost
calculator. It tells you which AWS surfaces can produce usage-based charges and
how to back out of a preview deploy while rollback commands are still future
work.

For workflow-bearing manifests, the plan reports a `workflows` change with
Step Functions topology and includes Step Functions state transitions in cost
drivers. Preview deploy still rejects those Cells until provisioning and remote
run-state support land.

Generated S3 buckets for client assets and Cell files use CloudFormation
generated names to avoid global bucket-name collisions, and the adapter reads
the physical names from stack outputs. They block public access and use
S3-managed server-side encryption. Declaring `capabilities.files` gives Cell
code object storage through `ctx.files`; it does not make uploaded files public.
Preview artifact uploads and runtime `ctx.files.put` writes request S3-managed
encryption explicitly, and browser client assets use `Cache-Control: no-cache`
so alpha redeploys do not depend on stale cached files.

Generated DynamoDB tables use pay-per-request billing and point-in-time
recovery for both Cell data and deployment metadata.

Preview Lambdas use explicit alpha defaults: 256 MB memory and a 30 second
timeout. Queued job Cells get an SQS queue with a 60 second visibility timeout
so job messages are not immediately retried while the Lambda is still running.
The generated queue redrives messages to a Cell-owned dead-letter queue after
three failed receives, with 14 day retention for alpha debugging.

## Agent sandbox target

The AWS preview adapter keeps normal Cell traffic on Lambda and can use Lambda
MicroVMs as the backing for [Agent Sandboxes](/docs/cloud/agent-sandboxes).

The split is deliberate:

- Lambda handles query, mutation, endpoint, job, auth, approval, and capability
  broker traffic.
- MicroVM-backed sandboxes handle sessionful agent work such as repository
  operations, shell commands, package installs, browser automation, generated
  code execution, scanners, and long-running tool processes.

Cell authors should not see a MicroVM API. They declare:

```ts
runtime: {
  sandbox: "required",
  durability: "optional",
  humanApproval: "required",
}
```

The AWS adapter maps that to `agent-sandboxes` plan entries when a mounted agent
requires a sandbox. Set `ANVIL_AWS_AGENT_SANDBOX_IMAGE` to enable AWS support
for those agents. `durability: "required"` remains a separate problem; MicroVM
suspend/resume helps session continuity, but it is not durable workflow
execution.

## Deploy flow

`anvil-cloud deploy --preview --json`:

1. builds the Cell with preview target
2. reads the generated manifest
3. creates a provider-neutral deployment plan with AWS detail fields
4. synthesizes CloudFormation
5. packages deploy artifacts
6. provisions resources only if the AWS provisioner is configured
7. returns the deployment URL and next inspection commands when provisioning succeeds

Lambda bundle artifacts use content-addressed S3 keys, and deploy JSON includes
artifact SHA-256 digests. That gives CloudFormation a changed
`ServerBundleKey` parameter when server code changes instead of depending on a
same-key S3 overwrite to behave like a fresh deployment. Technically legal,
operationally rude.

## Plan without provisioning

If no provisioner is configured, the adapter returns:

```json
{
  "ok": false,
  "code": "AWS_PROVISIONER_NOT_CONFIGURED",
  "message": "AWS preview provisioning needs a provisioner implementation or AWS client configuration.",
  "hint": "The adapter produced a stable deployment plan, CloudFormation template, and deploy artifacts for this Cell."
}
```

That is expected in local review. It means a developer can inspect the deploy plan before mutating AWS.

## Provisioning configuration

The AWS SDK preview provisioner requires:

```bash
ANVIL_AWS_ARTIFACT_BUCKET=<bucket-for-uploaded-artifacts>
```

Optional environment:

```bash
AWS_REGION=eu-west-2
ANVIL_AWS_STACK_PREFIX=anvil
```

Remote inspection and logs require:

```bash
ANVIL_AWS_DEPLOYMENT_METADATA_TABLE=<metadata-table-name>
```

Then:

```bash
anvil-cloud deploy --preview --json
anvil-cloud inspect --app notes --env preview --json
anvil-cloud logs --app notes --env preview --json
anvil-cloud destroy --preview --app notes --yes --json
```

For the checked-in AWS-compatible smoke Cell, run the repeatable verifier from
the `anvil-cloud` workspace:

```bash
ANVIL_AWS_ARTIFACT_BUCKET=<artifact-bucket> \
AWS_REGION=eu-west-2 \
pnpm verify:aws-preview
```

The verifier builds the workspace, deploys `examples/aws-preview` with
`--wait`, checks `/_anvil/health`, calls the public `status` query, runs remote
`inspect` and `logs`, and destroys the stack in `finally`. Set
`ANVIL_AWS_SMOKE_TOKEN` to also exercise authenticated `createNote` and
`listNotes` calls against an OIDC-configured runtime. Set
`ANVIL_AWS_SMOKE_KEEP_STACK=1` to leave the stack running for manual inspection.
The verifier normalizes Lambda Function URLs before calling runtime routes, so
provider-returned trailing slashes do not turn health checks into accidental
`404`s. If deploy returns a deployment URL but the health wait fails, the
verifier still attempts preview cleanup before exiting.

Remote inspect reads the latest deployment record from the metadata table and
returns the manifest, deployment id, update timestamp when present, runtime URL,
and resource ids including runtime, assets, logs, database, files, EventBridge,
SQS, workflow state machines, and deployment metadata when present. New
deployment records also include the artifact summary, including the Lambda
bundle key and SHA-256 digest.
Missing or malformed records return stable `AWS_DEPLOYMENT_METADATA_NOT_FOUND`
or `AWS_DEPLOYMENT_METADATA_INVALID` errors. DynamoDB or CloudWatch read
failures return `AWS_REMOTE_READ_FAILED` with the failed operation and provider
error cause.
Remote logs page through CloudWatch events until the requested limit is reached
or CloudWatch has no more pages.
Destroy empties stack-owned S3 buckets before deleting the stack and deletes the
matching metadata record when the table is configured, so inspect and logs stop
advertising a runtime after preview cleanup. Delete failures return
`AWS_DESTROY_FAILED`; cleanup polling timeouts return `AWS_DESTROY_TIMEOUT`.
AWS SDK cleanup failures return `AWS_DESTROY_OPERATION_FAILED` with the failed
operation and provider error cause.

## Authenticated smoke path

The AWS verifier always checks that anonymous `listNotes` calls are rejected
with `401 AUTH_REQUIRED`. To also exercise authenticated mutation/query calls,
configure the deployed runtime with OIDC verification and pass a token from that
issuer:

```bash
ANVIL_AUTH_ISSUER=https://issuer.example.test \
ANVIL_AUTH_AUDIENCE=anvil-preview \
ANVIL_AUTH_JWKS_URI=https://issuer.example.test/.well-known/jwks.json \
ANVIL_AWS_SMOKE_TOKEN=<bearer-token-from-that-issuer> \
ANVIL_AWS_ARTIFACT_BUCKET=<artifact-bucket> \
AWS_REGION=eu-west-2 \
pnpm verify:aws-preview
```

`ANVIL_AUTH_JWKS_URI` is optional when the issuer supports OIDC discovery at
`/.well-known/openid-configuration`. Use the claim mapping variables from
[Authentication](/docs/cloud/auth) when your provider uses non-default claim
names for user id, email, or roles.

The smoke token should be short-lived and scoped to the preview app. The
verifier does not create provider users or run a hosted login flow; it only
proves that the deployed runtime can verify a bearer token and enforce handler
auth policy.

## Runtime Lambda flow

```txt
API Gateway or Lambda Function URL event
  -> AWS adapter translates to RuntimeRequest
  -> Anvil Runtime executes handler through AWS RuntimeHost
  -> AWS adapter translates RuntimeResponse
  -> HTTP response returns to caller
```

The adapter maps:

- `POST /_anvil/query/:name` to query runtime requests
- `POST /_anvil/mutation/:name` to mutation runtime requests
- `/api/*` to declared endpoint runtime requests
- `GET /_anvil/health` to a runtime health response used by
  `anvil-cloud deploy --preview --wait`

The AWS bridge handles `OPTIONS` preflight requests and adds CORS headers to
runtime responses so generated browser clients can call the preview runtime.
Endpoint request bodies preserve Lambda base64 decoding, and non-textual
endpoint responses are returned as base64 so binary/file payloads survive the
Function URL bridge. Runtime responses include `x-anvil-request-id`, which
matches the request id written to structured runtime logs for CloudWatch
correlation. Malformed JSON query or mutation bodies return a stable
`400 INVALID_JSON` response.

## Current limits

- Services, workflows, and outbound fetch are local-only in alpha. AWS preview rejects Cells that declare them before provisioning with an `AWS_PREVIEW_UNSUPPORTED_FEATURE` diagnostic. The AWS package can synthesize Step Functions state machine templates, configure Lambda with workflow state machine ARNs, start configured executions through `ctx.workflows.start`, and execute individual workflow step events through Lambda; preview provisioning and remote run inspection are still gated.
- AWS Bedrock inference and Lambda MicroVM sandbox lifecycle calls are available
  through provider interfaces. Preview deploys with sandbox-required agents are
  gated until `ANVIL_AWS_AGENT_SANDBOX_IMAGE` is configured. Streamed tool
  transport, policy brokering, workspace snapshots, sandbox-aware Lens views,
  and remote sandbox inspect are still future work.
- Production use needs wider operational validation beyond the preview verifier.
- CloudFormation stack failures return `AWS_STACK_FAILED` with recent failing stack events. Stack polling timeouts return `AWS_STACK_TIMEOUT` with the last observed status. Missing required stack outputs return `AWS_STACK_OUTPUT_MISSING`. AWS SDK provisioning failures return `AWS_PROVISIONING_OPERATION_FAILED` with the failed operation and provider error cause.
- If a deployed runtime is missing adapter environment values for a declared capability, it returns `CAPABILITY_NOT_DECLARED` diagnostics naming the missing variable, such as `ANVIL_EVENT_BUS_NAME` for events.
- Auth provider lookup is alpha-scoped. Current preview verifies bearer tokens through OIDC when `ANVIL_AUTH_ISSUER` is configured; otherwise authenticated handlers require a future auth integration or a smoke token setup.
- Multi-region, custom domains, hosted control plane, marketplace, production policy packs, rollback commands, signed artifacts, and real cost reporting are future work.

## Safety posture

The Cell author should not author CloudFormation, CDK, SST, IAM policy, or AWS SDK calls directly. The adapter owns that translation.

If app code imports provider SDKs, Guard should reject it. Provider glue belongs in the adapter because app code is supposed to stay inspectable.
