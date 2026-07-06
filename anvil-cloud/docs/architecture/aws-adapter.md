# AWS Adapter Architecture

## Purpose

The AWS adapter implements the provider-neutral deployment adapter contract using managed AWS services. It must not expose AWS directly to Cell authors or add AWS assumptions to the core runtime, builder, manifest, or client SDK.

The adapter is intentionally not the first implementation target. Build the local runtime, builder, and deployment adapter contract first, then add AWS preview deployment.

## Goals

- Deploy one Cell to AWS preview environment.
- Serve static client assets.
- Execute query, mutation, endpoint, and job handlers through the shared runtime.
- Store Cell data in DynamoDB.
- Store files in S3 when declared.
- Store environment values in SSM Parameter Store or Secrets Manager.
- Stream structured logs to CloudWatch.
- Support CLI inspection of remote manifest and logs.
- Generate least-privilege IAM based on declared capabilities.

## Non-goals

- Multi-region deployments.
- Enterprise VPC/private networking.
- Arbitrary AWS resources.
- Long-running containers.
- Additional production provider adapters.
- Hosted SaaS control plane.

## Recommended alpha deployment model

Use one Lambda per Cell/environment.

Rationale:

- simpler isolation;
- simpler logs;
- simpler IAM;
- simpler debugging;
- clearer cost attribution;
- easier to reason about while the platform is young.

Shared runtime optimisation can be explored later.

## AWS resource mapping

This mapping is adapter-specific. Core Anvil specs should use provider-neutral concept names and link here for AWS details.

| Anvil concept      | AWS backing                                        |
| ------------------ | -------------------------------------------------- |
| Cell runtime       | Lambda Node.js 20/22                               |
| Query/mutation API | Lambda Function URL or API Gateway                 |
| Custom endpoints   | API Gateway routes or Lambda Function URL routing  |
| Client bundle      | S3 + CloudFront                                    |
| Database           | DynamoDB                                           |
| Files              | S3                                                 |
| Environment        | SSM Parameter Store or Secrets Manager             |
| Logs               | CloudWatch Logs                                    |
| Scheduled jobs     | EventBridge Scheduler                              |
| Queued jobs        | SQS + Lambda                                       |
| Workflows          | Step Functions + Lambda task states                |
| Services           | ECS/Fargate preview service resources              |
| Agent inference    | Bedrock through `@anvil-cloud/aws` provider        |
| Agent sandboxes    | Lambda MicroVM sessions through `@anvil-cloud/aws` |
| Outbound fetch     | Lambda runtime allow-list guard                    |
| Deploy metadata    | DynamoDB or manifest in S3                         |
| Audit events       | DynamoDB                                           |

## Runtime Lambda flow

```txt
API Gateway/Lambda Function URL event
  ↓
AWS adapter resolves Cell deployment
  ↓
AWS adapter translates event to RuntimeRequest
  ↓
Anvil Runtime executes handler
  ↓
AWS adapter translates RuntimeResponse
  ↓
Response returned to caller
```

The alpha adapter exposes a tested HTTP bridge for Lambda Function URL/API Gateway
v2 style events and packages the generated Lambda entrypoint around the shared
Anvil Runtime. It maps:

- `POST /_anvil/query/:name` to query runtime requests;
- `POST /_anvil/mutation/:name` to mutation runtime requests;
- `/api/*` to declared endpoint runtime requests.
- `GET /_anvil/health` to a lightweight runtime health response used by
  `anvil-cloud deploy --preview --wait`.

The bridge responds to `OPTIONS` preflight requests and adds CORS headers to
runtime responses so generated browser clients can call the preview runtime. It
preserves base64-encoded request bodies for endpoints and returns non-textual
endpoint `Response` bodies as base64 Lambda responses so binary/file payloads
survive the Function URL bridge. Runtime responses include
`x-anvil-request-id`, matching the request id written to structured runtime logs
for CloudWatch correlation. Malformed JSON query or mutation request bodies
return a stable `400 INVALID_JSON` response instead of escaping as a Lambda
handler failure.

The generated Lambda entrypoint creates an AWS-backed `RuntimeHost` from
environment variables supplied by the CloudFormation template. When
`capabilities.outboundFetch.allow` is declared, the template writes the
allow-list into `ANVIL_OUTBOUND_FETCH_ALLOW` and the generated Lambda entrypoint
installs a runtime fetch guard. Calls to hosts outside that list fail with
`OUTBOUND_FETCH_NOT_ALLOWED`.

Workflow-bearing Cells synthesize one Step Functions state machine per workflow.
Each state invokes the shared runtime Lambda with an `anvil.workflows` event for
the current step, run id, input, and accumulated step state. Deployment plans add
`workflow-preview-review` so this mutation is visible before provisioning.

Service-bearing Cells synthesize adapter-owned ECS/Fargate preview resources:
one cluster for the Cell, one task definition and ECS service per declared
service, and a CloudWatch log group. The template requires `ServiceSubnetIds`.
This is preview support for adapter resource shape and review; full execution of
the exact Cell service handler inside Fargate remains a hardening step.

## Static asset flow

```txt
CloudFront
  ├─ /assets/*      → S3 client asset bucket/prefix
  ├─ /_anvil/*      → Lambda/API runtime
  └─ /api/*         → Lambda/API runtime
```

## IAM generation

IAM must be generated from declared capabilities.

Example capability:

```ts
capabilities: {
  database: true,
  files: {
    publicRead: false
  }
}
```

Generated role should allow only required operations against the Cell-scoped resources.
The runtime role always gets CloudWatch log stream write access, but the AWS
preview template scopes those actions to the generated runtime log group instead
of granting log writes across the account.

For alpha, prefer dedicated resources per Cell/environment where feasible. If shared physical resources are used, scope IAM to app-specific partition keys/prefixes where possible.

## DynamoDB design

Initial option: one table per Cell/environment.

Pros:

- simple mental model;
- simple IAM;
- simple data deletion;
- easy cost attribution.

Generated DynamoDB tables use pay-per-request billing and point-in-time
recovery for both Cell-owned data and deployment metadata.

Cons:

- more AWS resources;
- less efficient at scale.

A later shared-table mode can use `cellId` in partition keys.

## S3 design

Static assets and user files may be separate buckets or prefixes.

Recommended alpha:

```txt
anvil-cell-assets-{cellId}-{env}
anvil-cell-files-{cellId}-{env}
```

If account limits become noisy, move to shared buckets with per-Cell prefixes later.

## Runtime sizing

AWS preview uses conservative explicit Lambda settings rather than provider
defaults:

- memory: 256 MB;
- timeout: 30 seconds.

When queued jobs are declared, the generated SQS queue uses a 60 second
visibility timeout so a Lambda invocation has time to finish or report batch
item failure before the message becomes visible again. The generated main queue
also redrives messages to a Cell-owned dead-letter queue after three failed
receives; the DLQ retains messages for 14 days so alpha operators have evidence
to inspect instead of an endlessly retrying poison job.

## Agent sandbox target

The AWS adapter keeps the normal Cell runtime on Lambda and uses Lambda
MicroVMs as the backing for Agent Sandboxes when a sandbox image is configured.

Lambda remains the right boundary for query, mutation, endpoint, and job
traffic:

- request-shaped lifecycle;
- simple IAM and logs;
- stable Function URL/API Gateway bridge;
- predictable preview deployment and cleanup.

MicroVMs fit a different shape: sessionful agent workspaces that need stronger
isolation and state between turns.

```txt
Browser or CLI
  ↓
Cell Lambda runtime
  ↓
Anvil approval and capability broker
  ↓
Agent session manager
  ↓
Lambda MicroVM Agent Sandbox
```

`AwsLambdaMicroVmSandboxProvider` creates, inspects, resumes, suspends,
terminates, and creates auth tokens for MicroVM sessions from provider-neutral
agent manifests. The Cell author does not write Dockerfiles, CloudFormation,
IAM policy, Lambda MicroVM calls, or provider SDK code.

### Sandbox responsibilities

An AWS-backed Agent Sandbox provider now provides:

- VM-isolated execution for generated code, shell commands, package installs,
  test runs, browser automation, scanners, and MCP/tool processes;
- a workspace filesystem with session state for the configured lifetime;
- a dedicated session endpoint for streamed interaction;
- AWS SDK lifecycle calls for run, inspect, suspend, resume, terminate, and
  auth-token creation;
- lifecycle metadata: started, active, waiting for approval, suspended,
  resumed, terminated, expired.

The policy broker, streamed command transport, workspace snapshot store,
sandbox-aware Lens view, and artifact/diff capture are still follow-on work.

### Compatibility mapping

`runtime.sandbox: "required"` should become an AWS-supported requirement only
when the MicroVM sandbox adapter is enabled in a supported region.

In the current implementation, "enabled" means `ANVIL_AWS_AGENT_SANDBOX_IMAGE`
or provider `imageIdentifier` is configured. Without that, AWS preview support
returns an `AWS_PREVIEW_UNSUPPORTED_FEATURE` diagnostic for `agentSandboxes`.

`runtime.durability: "required"` should remain unsupported until Anvil has
durable orchestration, persisted run state, replay/retry semantics, and
inspection for resumed runs. MicroVM suspend/resume helps session continuity; it
is not durable workflow execution by itself.

`memory.retention: "session"` can map to sandbox-local state plus explicit
Anvil-managed summaries or artifacts. `memory.retention: "persistent"` still
needs an Anvil memory store and retention policy.

`approvals.requiredFor` must be enforced by Anvil before the sandbox executes
protected tools. VM isolation is useful, but it is not an approval system. Very
clever boxes still need locks on the doors.

### Prebuilt sandbox images

The high-leverage AWS path is a set of Anvil-owned sandbox images or snapshots:

- `anvil/node-agent-base` for TypeScript repo work;
- `anvil/web-reviewer` for browser and Playwright checks;
- `anvil/cloud-deployer` for preview deployment preparation;
- `anvil/registry-auditor` for dependency and package analysis;
- `anvil/docs-maintainer` for docs and release-note work.

These images should be adapter implementation details. The manifest should name
the agent contract and capabilities, not the underlying image.

### Inspection surface

The local AWS plan and `anvil-cloud agents sandboxes --json` report sandbox
readiness today. Remote inspect should eventually report live sandbox state
alongside the Cell runtime:

```json
{
  "agents": {
    "release-engineer": {
      "sandbox": "aws-lambda-microvm",
      "session": "active",
      "region": "eu-west-1",
      "startedAt": "2026-06-30T10:00:00.000Z",
      "expiresAt": "2026-06-30T18:00:00.000Z",
      "lastAction": "pnpm test",
      "approvals": ["deploy.preview"],
      "artifacts": ["diff.patch", "test-output.ndjson"]
    }
  }
}
```

Until remote sandbox inspect exists, AWS compatibility reporting and deploy
plans are the source of truth for sandbox readiness.

## Environment and secrets

Cell code must use `ctx.env`, never direct `process.env`.

AWS adapter may hydrate env from:

- Lambda environment variables for non-secret config;
- SSM Parameter Store for config;
- Secrets Manager for secrets.

Open decision: one source of truth for alpha.

## Logs and inspection

Cloud logs should be structured JSON and include:

- timestamp;
- request id;
- Cell id;
- environment;
- handler kind/name;
- level;
- message;
- metadata.

`anvil-cloud logs --app <name> --json` should query CloudWatch logs and return stable JSON.

`anvil-cloud inspect --app <name> --json` should return:

- active manifest;
- deployment id;
- deployment update timestamp when metadata includes it;
- resource ids;
- stable metadata errors (`AWS_DEPLOYMENT_METADATA_NOT_FOUND` and
  `AWS_DEPLOYMENT_METADATA_INVALID`) when the remote metadata record is missing
  or malformed;
- stable AWS read errors (`AWS_REMOTE_READ_FAILED`) when DynamoDB or CloudWatch
  rejects remote inspection or log reads.

## Deploy pipeline

`anvil-cloud deploy --preview --json` should:

```txt
1. Run anvil-cloud check
2. Run anvil-cloud build
3. Read manifest
4. Compare capabilities with previous deployment
5. Produce provider-neutral deployment plan with AWS-specific detail fields where needed
6. Require approval if risky capability changes are introduced
7. Upload server and client artefacts
8. Provision/update AWS resources
9. Publish deployment metadata
10. Return deployed URL and inspection commands
```

`anvil-cloud deploy --preview --name <preview>` creates an additional named
preview for the same Cell. The default preview keeps the existing stack and
metadata key; named previews add a normalized name to the adapter-owned stack
and deployment metadata key.

`anvil-cloud rollback --preview --app <name> --to-deployment <id> --dry-run`
returns stable rollback intent JSON for a previous deployment id. Preview
deployments are versioned in adapter metadata; direct AWS artifact pointer
promotion remains adapter-owned in alpha.

`anvil-cloud usage --preview --json` returns declared preview resource counts,
cost-driver hints, and cleanup commands from the built manifest and AWS preview
plan. It is visibility, not billing.

`anvil-cloud destroy --preview --app <name> --name <preview> --yes` deletes the
computed AWS preview CloudFormation stack for the Cell and preview name.
`--dry-run` returns the same computed stack name, bucket cleanup
intent, optional deployment metadata key, and real destroy command without
calling AWS, which lets local contract tests cover cleanup intent safely. Before
deleting the stack, destroy empties stack-owned S3 buckets from CloudFormation
outputs so uploaded client assets or Cell files do not block stack deletion.
When `ANVIL_AWS_DEPLOYMENT_METADATA_TABLE` is configured, destroy also removes
the Cell/environment deployment metadata record so remote inspect and logs do
not keep pointing at a deleted runtime. If CloudFormation reports a failed
delete status, destroy returns `AWS_DESTROY_FAILED`; if deletion remains in
progress past the polling limit, it returns `AWS_DESTROY_TIMEOUT` with the last
observed status. AWS SDK operation failures during cleanup return
`AWS_DESTROY_OPERATION_FAILED` with the failed operation and provider error
cause.

The current adapter implementation produces the provider-neutral deployment
plan, packages deploy artifacts, bundles the Lambda runtime entrypoint,
synthesizes a CloudFormation template, and can drive an AWS SDK provisioner when
`ANVIL_AWS_ARTIFACT_BUCKET` is configured. The provisioner uploads artifacts,
creates or updates the preview stack, uploads client assets, and publishes
deployment metadata. Lambda bundle artifact keys include the bundle content hash
so stack updates change the `ServerBundleKey` parameter when the server code
changes instead of relying on S3 object overwrites to mean "new deployment".
Deploy JSON includes each artifact SHA-256 digest for inspection. If the
CloudFormation stack reaches a failed terminal state, the provisioner includes
recent failing stack events in an
`AWS_STACK_FAILED` deploy result so JSON diagnostics point at the resource that
actually failed instead of escaping through a generic CLI error. If the stack
remains in progress past the polling limit, deploy returns
`AWS_STACK_TIMEOUT` with the last observed stack status, attempt count, and poll
delay. If the stack finishes but omits a required adapter output, deploy returns
`AWS_STACK_OUTPUT_MISSING` with the stack name and missing output key. AWS SDK
operation failures while uploading artifacts, applying the stack, or publishing
metadata return `AWS_PROVISIONING_OPERATION_FAILED` with the failed operation
and provider error cause.

Generated S3 buckets for client assets and Cell files use CloudFormation
generated names so preview deploys do not collide with globally unique bucket
names from other AWS accounts. The adapter reads the physical bucket names from
stack outputs. Those buckets block public access and use S3-managed server-side
encryption by default. Preview artifact uploads also request S3-managed
encryption explicitly. Runtime `ctx.files.put` uploads make the same explicit
encryption request, and uploaded browser client assets use
`Cache-Control: no-cache` so redeploys are visible during alpha testing. Public
file serving is not an alpha promise; any future public-read path should be a
deliberate adapter feature, not a bucket policy accident in a trench coat.

The AWS runtime host currently supports:

- DynamoDB-backed Cell tables when `capabilities.database` is declared;
- S3-backed files when `capabilities.files` is declared;
- EventBridge-backed `ctx.events.publish` when `capabilities.events` is
  declared, with the generated deployment plan reporting an `events` resource
  and publish failures returning structured EventBridge error details;
- SQS-backed `ctx.jobs.enqueue`, with a generated dead-letter queue for
  repeatedly failing job messages;
- scheduled jobs through EventBridge rules that invoke the shared Lambda
  runtime;
- Lambda environment values through `ctx.env`;
- request-provided auth identity with no provider-specific auth lookup yet;
- structured JSON logs written to CloudWatch through Lambda logging;
- Step Functions templates for declared workflows, Lambda environment mapping
  for workflow state machine ARNs, and `ctx.workflows.start` against configured
  state machines.

Remote inspection and logs use deployment metadata plus CloudWatch Logs. The CLI
remote reader requires `ANVIL_AWS_DEPLOYMENT_METADATA_TABLE` so it can find the
latest deployment record for `anvil-cloud inspect --app <name> --env preview --json`
and `anvil-cloud logs --app <name> --env preview --json`. Inspect reports runtime,
assets, logs, database, files, EventBridge, SQS, SQS dead-letter queue, and
deployment metadata resource ids when the corresponding CloudFormation outputs
are present. New
deployment metadata also stores the deploy artifact summary, including the
Lambda bundle key and SHA-256 digest, so remote inspect can confirm which bundle
the latest preview deployment references. Remote logs page through CloudWatch
events until the requested limit is reached or CloudWatch has no more pages.
DynamoDB and CloudWatch SDK failures return `AWS_REMOTE_READ_FAILED` with the
failed operation and provider error cause.
Pass `--name <preview>` to inspect or read logs for a named preview record.

The `verify:aws-preview` smoke treats that metadata path as part of the preview
contract: deploy output must include the deployment metadata table/key, remote
inspect must echo the manifest, runtime URL, resources, and Lambda artifact
digest, remote logs must return the stable AWS log payload, and destroy must
delete deployment metadata when the metadata table is configured.

Workflows and outbound fetch now have AWS preview execution paths: workflows map
to Step Functions and outbound fetch is enforced by the generated Lambda runtime
guard. Services synthesize ECS/Fargate preview resources for review and cleanup
evidence, but running the exact Cell service handler inside the Fargate task is
still a hardening step. Production workloads can wait their turn like adults.
If an AWS runtime is invoked without the expected environment values for a
declared capability, the host returns `CAPABILITY_NOT_DECLARED` diagnostics that
name the missing adapter variable, such as `ANVIL_EVENT_BUS_NAME` for events.

## Deployment result shape

Preview deploy results include a stable deployment plan before provisioning
state. `plan.review` carries diffable `changeSet` ids, capability diffs,
structured cost-driver hints, rollback notes, cleanup commands/notes, and
approval gates. Workflow and service capability changes produce review gates
before any AWS resources are created.

```json
{
  "ok": true,
  "deploymentId": "dep_abc123",
  "environment": "preview",
  "previewName": "default",
  "url": "https://example.cloudfront.net",
  "resources": {
    "lambda": "anvil-notes-preview",
    "database": "anvil-notes-preview",
    "assetsBucket": "anvil-cell-assets-notes-preview"
  },
  "next": [
    "anvil-cloud inspect --app notes --env preview --json",
    "anvil-cloud logs --app notes --env preview --json"
  ]
}
```

## Provisioning tool

Open decision: SST or AWS CDK internally.

The Cell author must not author SST/CDK directly during alpha. The deployment adapter can use either tool internally.

## Safety checks

Before AWS deploy, Anvil Guard should check:

- forbidden imports;
- undeclared capabilities;
- new outbound domains;
- public file access changes;
- destructive schema changes;
- missing env declarations;
- estimated cost-risk changes where feasible.

## Future work

- Remote builds.
- Dedicated vs shared resource modes.
- Custom domains.
- Auth provider integrations.
- Cost reporting.
- Deployment rollback.
- Signed artefacts.
- Org-level policy packs.
