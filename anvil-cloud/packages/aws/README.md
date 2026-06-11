# @anvil-cloud/aws

AWS deployment adapter package for Anvil Cloud.

This package is the first planned provider adapter. It must implement the provider-neutral deployment adapter contract rather than adding AWS assumptions to Cell code, the runtime, or the manifest.

Current implementation:

- translate AWS events into Anvil runtime requests;
- synthesize preview CloudFormation templates from Cell manifests;
- map Cell capabilities to AWS resources;
- provide AWS-backed runtime host adapters for DynamoDB tables, S3 files, env,
  queued jobs, auth passthrough, and structured Lambda logs;
- package deploy artifacts for preview deployments, including a bundled Lambda
  runtime entrypoint;
- provision preview stacks when `ANVIL_AWS_ARTIFACT_BUCKET` is configured;
- read remote deployment metadata and CloudWatch logs when `ANVIL_AWS_DEPLOYMENT_METADATA_TABLE` is configured.

Remaining responsibilities:

- add AWS-backed event publishing adapters;
- harden preview deployment for production use.

See `docs/architecture/aws-adapter.md` for the implementation design.
