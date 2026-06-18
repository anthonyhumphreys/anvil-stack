# @anvil-cloud/aws

AWS deployment adapter package for Anvil Cloud.

This package is the first planned provider adapter. It must implement the provider-neutral deployment adapter contract rather than adding AWS assumptions to Cell code, the runtime, or the manifest.

Current implementation:

- translate AWS events into Anvil runtime requests;
- synthesize preview CloudFormation templates from Cell manifests;
- map Cell capabilities to AWS resources;
- provide AWS-backed runtime host adapters for DynamoDB tables, S3 files, env,
  EventBridge events, queued jobs, auth passthrough, and structured Lambda logs;
- package deploy artifacts for preview deployments, including a bundled Lambda
  runtime entrypoint with a content-addressed S3 key;
- provision preview stacks when `ANVIL_AWS_ARTIFACT_BUCKET` is configured;
- empty stack-owned S3 buckets, delete preview stacks, and remove matching
  deployment metadata for alpha cleanup;
- include recent CloudFormation resource failure events when preview stack
  creation or update fails;
- return stable AWS SDK operation failure codes for deploy and destroy
  operations;
- read remote deployment metadata and CloudWatch logs when `ANVIL_AWS_DEPLOYMENT_METADATA_TABLE` is configured.

Remaining responsibilities:

- harden live AWS account verification and rollback paths;
- add cloud execution paths for workflows and services after the local alpha contract settles;
- harden preview deployment for production use.

See `docs/architecture/aws-adapter.md` for the implementation design.

## AWS Pulumi deployment adapter

The AWS cloud adapter consumes Anvil's provider-neutral Cell graph and realises it on AWS. Pulumi is used internally by this adapter layer only; Cell authors continue to declare Anvil capabilities rather than Pulumi or AWS resources.

Supported vertical slice:

- HTTP routes are mapped to an AWS HTTP entrypoint.
- Runtime handlers are mapped to Lambda functions.
- Tables are mapped to DynamoDB.
- Secrets are mapped to SSM Parameter Store references.
- Function access to tables and secrets is mapped to generated IAM policies.
- Resource names use deterministic app/stage prefixes.

Use `anvil plan --stage dev --adapter aws` for Anvil-first preview output. Add `--verbose` only when you need to inspect underlying Pulumi resource mappings.
