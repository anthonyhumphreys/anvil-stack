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
- Lambda environment values through `ctx.env`
- request-provided auth identity passthrough
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
| Events | A dedicated EventBridge bus when `capabilities.events` is declared; `ctx.events.publish` maps to `PutEvents` |
| Environment | Lambda environment values for alpha |
| Logs | CloudWatch Logs |
| Deployment metadata | DynamoDB |

## Deploy flow

`anvil deploy --preview --json`:

1. builds the Cell with preview target
2. reads the generated manifest
3. creates a provider-neutral deployment plan with AWS detail fields
4. synthesizes CloudFormation
5. packages deploy artifacts
6. provisions resources only if the AWS provisioner is configured
7. returns the deployment URL and next inspection commands when provisioning succeeds

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
ANVIL_AWS_STACK_NAME_PREFIX=anvil
```

Remote inspection and logs require:

```bash
ANVIL_AWS_DEPLOYMENT_METADATA_TABLE=<metadata-table-name>
```

Then:

```bash
anvil deploy --preview --json
anvil inspect --app notes --env preview --json
anvil logs --app notes --env preview --json
```

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

## Current limits

- AWS-backed event publishing is still unsupported in preview and returns an explicit runtime adapter error.
- Live AWS execution needs real account verification before the preview adapter is used for production workloads.
- Auth provider lookup is alpha-scoped. Current preview supports request-provided auth identity.
- Multi-region, custom domains, hosted control plane, marketplace, production policy packs, rollback, signed artifacts, and cost reporting are future work.

## Safety posture

The Cell author should not author CloudFormation, CDK, SST, IAM policy, or AWS SDK calls directly. The adapter owns that translation.

If app code imports provider SDKs, Guard should reject it. Provider glue belongs in the adapter because app code is supposed to stay inspectable.
