# AWS preview smoke Cell

Small Anvil Cell for exercising the AWS preview adapter without local-only
features.

It uses:

- DynamoDB through `ctx.db`;
- S3 through `ctx.files`;
- EventBridge through `ctx.events`;
- SQS through `ctx.jobs`;
- Lambda HTTP through queries, mutations, and endpoints.

```bash
cd anvil-cloud/examples/aws-preview
node ../../packages/cli/dist/index.js check --json
node ../../packages/cli/dist/index.js deploy --preview --json
```

With AWS preview environment variables configured, add `--wait` to verify the
deployed runtime health endpoint:

```bash
node ../../packages/cli/dist/index.js deploy --preview --wait --json
node ../../packages/cli/dist/index.js inspect --app aws-preview --env preview --json
node ../../packages/cli/dist/index.js logs --app aws-preview --env preview --since 10m --json
node ../../packages/cli/dist/index.js destroy --preview --app aws-preview --yes --json
```

Or run the repeatable smoke verifier from the `anvil-cloud` workspace:

```bash
ANVIL_AWS_ARTIFACT_BUCKET=<artifact-bucket> \
AWS_REGION=eu-west-2 \
pnpm verify:aws-preview
```

Set `ANVIL_AWS_SMOKE_TOKEN` to exercise authenticated `createNote` and
`listNotes` calls against an OIDC-configured runtime. Set
`ANVIL_AWS_SMOKE_KEEP_STACK=1` to leave the preview stack running for manual
inspection.
