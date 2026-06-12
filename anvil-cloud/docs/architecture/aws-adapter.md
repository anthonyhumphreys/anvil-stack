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

| Anvil concept      | AWS backing                                       |
| ------------------ | ------------------------------------------------- |
| Cell runtime       | Lambda Node.js 20/22                              |
| Query/mutation API | Lambda Function URL or API Gateway                |
| Custom endpoints   | API Gateway routes or Lambda Function URL routing |
| Client bundle      | S3 + CloudFront                                   |
| Database           | DynamoDB                                          |
| Files              | S3                                                |
| Environment        | SSM Parameter Store or Secrets Manager            |
| Logs               | CloudWatch Logs                                   |
| Scheduled jobs     | EventBridge Scheduler                             |
| Queued jobs        | SQS + Lambda                                      |
| Deploy metadata    | DynamoDB or manifest in S3                        |
| Audit events       | DynamoDB                                          |

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

The generated Lambda entrypoint creates an AWS-backed `RuntimeHost` from
environment variables supplied by the CloudFormation template.

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

For alpha, prefer dedicated resources per Cell/environment where feasible. If shared physical resources are used, scope IAM to app-specific partition keys/prefixes where possible.

## DynamoDB design

Initial option: one table per Cell/environment.

Pros:

- simple mental model;
- simple IAM;
- simple data deletion;
- easy cost attribution.

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

`anvil logs --app <name> --json` should query CloudWatch logs and return stable JSON.

`anvil inspect --app <name> --json` should return:

- active manifest;
- deployment id;
- runtime health;
- recent errors;
- resource ids;
- basic usage/cost hints where available.

## Deploy pipeline

`anvil deploy --preview --json` should:

```txt
1. Run anvil check
2. Run anvil build
3. Read manifest
4. Compare capabilities with previous deployment
5. Produce provider-neutral deployment plan with AWS-specific detail fields where needed
6. Require approval if risky capability changes are introduced
7. Upload server and client artefacts
8. Provision/update AWS resources
9. Publish deployment metadata
10. Return deployed URL and inspection commands
```

The current adapter implementation produces the provider-neutral deployment
plan, packages deploy artifacts, bundles the Lambda runtime entrypoint,
synthesizes a CloudFormation template, and can drive an AWS SDK provisioner when
`ANVIL_AWS_ARTIFACT_BUCKET` is configured. The provisioner uploads artifacts,
creates or updates the preview stack, uploads client assets, and publishes
deployment metadata.

The AWS runtime host currently supports:

- DynamoDB-backed Cell tables when `capabilities.database` is declared;
- S3-backed files when `capabilities.files` is declared;
- SQS-backed `ctx.jobs.enqueue`;
- scheduled jobs through EventBridge rules that invoke the shared Lambda
  runtime;
- Lambda environment values through `ctx.env`;
- request-provided auth identity with no provider-specific auth lookup yet;
- structured JSON logs written to CloudWatch through Lambda logging.

Remote inspection and logs use deployment metadata plus CloudWatch Logs. The CLI
remote reader requires `ANVIL_AWS_DEPLOYMENT_METADATA_TABLE` so it can find the
latest deployment record for `anvil inspect --app <name> --env preview --json`
and `anvil logs --app <name> --env preview --json`.

AWS-backed event publishing is still unsupported in preview and fails with an
explicit runtime adapter error. Live AWS execution still needs real account
verification before the preview adapter is used for production workloads.

## Deployment result shape

```json
{
  "ok": true,
  "deploymentId": "dep_abc123",
  "environment": "preview",
  "url": "https://example.cloudfront.net",
  "resources": {
    "lambda": "anvil-notes-preview",
    "database": "anvil-notes-preview",
    "assetsBucket": "anvil-cell-assets-notes-preview"
  },
  "next": [
    "anvil inspect --app notes --env preview --json",
    "anvil logs --app notes --env preview --json"
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
