# AWS preview smoke Cell

Small Anvil Cell for exercising the AWS preview adapter without turning the
smoke path into a sprawling demo.

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
node ../../packages/cli/dist/index.js destroy --preview --app aws-preview --yes --dry-run --json
node ../../packages/cli/dist/index.js destroy --preview --app aws-preview --yes --json
```

Or run the repeatable smoke verifier from the `anvil-cloud` workspace:

```bash
ANVIL_AWS_ARTIFACT_BUCKET=<artifact-bucket> \
ANVIL_AWS_DEPLOYMENT_METADATA_TABLE=<metadata-table> \
AWS_REGION=eu-west-2 \
pnpm verify:aws-preview
```

Set `ANVIL_AWS_SMOKE_TOKEN` to exercise authenticated `createNote` and
`listNotes` calls against an OIDC-configured runtime. Set
`ANVIL_AWS_EXPIRED_SMOKE_TOKEN` when you have an expired provider token to prove
expiry rejection too. Set `ANVIL_AWS_WRONG_ISSUER_SMOKE_TOKEN` and
`ANVIL_AWS_WRONG_AUDIENCE_SMOKE_TOKEN` when you can mint provider tokens for
those negative cases. The verifier always checks that anonymous `listNotes`
requests are rejected with `AUTH_REQUIRED` and that a forged bearer token is
rejected. It also asserts that deploy output includes deployment metadata,
remote inspect returns the manifest, runtime URL, resources, and Lambda artifact
digest, remote logs return a stable AWS log payload, and destroy removes the
deployment metadata record when `ANVIL_AWS_DEPLOYMENT_METADATA_TABLE` is set.
Set `ANVIL_AWS_SMOKE_KEEP_STACK=1` to leave the preview stack running for manual
inspection.

See `../../docs/contributing/oidc-smoke-guide.md` for the complete OIDC smoke
setup, expected negative auth results, and cleanup checks.
