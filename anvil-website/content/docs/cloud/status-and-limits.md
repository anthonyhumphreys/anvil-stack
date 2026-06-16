---
title: Status and limits
navTitle: Status and limits
description: Current alpha maturity, working surfaces, non-goals, and known limits for Anvil Cloud.
product: Anvil Cloud
section: Reference
order: 160
---

# Status and limits

Anvil Cloud is alpha software with real implementation across the runtime, builder, local server, client, CLI, and AWS preview adapter.

Use it for inspection, local development, adapter design, demos, tests, and contribution work. Treat hosted production claims as out of scope until the adapter, operations, and account-verification paths have been hardened.

## Implemented surfaces

| Surface | Current state |
| --- | --- |
| Runtime DSL | `app`, `query`, `mutation`, `endpoint`, `job`, `workflow`, `service`, `table`, and field builders exist. |
| Runtime execution | `handleRuntimeRequest` supports query, mutation, endpoint, job, and workflow handlers. Services run through the runtime `ServiceSupervisor`, not per-request invocation. |
| Runtime host | Host adapter interfaces exist for db, files, env, auth, logs, events, and jobs. |
| Builder | Config, import policy, typecheck, server/client bundle, manifest extraction, generated client, and build metadata exist. |
| Local runtime | Local HTTP server, JSON database, files, auth, logs, events, jobs, workflows, supervised services, manifest, and inspection state exist. |
| CLI | `new`, `dev`, `check`, `build`, `inspect`, `logs`, `db`, `workflows`, `services list`, and `deploy --preview` exist. |
| Client | Browser client and hook helper shape exist, with generated metadata support. |
| AWS preview | Plan, CloudFormation synthesis, artifacts, optional provisioner, Lambda bridge, DynamoDB, S3, SQS, EventBridge schedules, CloudWatch logs, remote inspect, and remote logs exist. |

## Non-goals for alpha

Anvil Cloud alpha does not aim to provide:

- arbitrary cloud resource authoring in Cell code
- direct provider SDK access from Cell handlers
- raw container or Kubernetes authoring in Cell code (long-running work goes through the `service` primitive; container-backed execution such as ECS/Fargate is a future deployment adapter concern)
- second production cloud adapter
- raw Terraform, CDK, or SST authoring surface for Cell authors
- enterprise networking or VPC support
- hosted SaaS control plane
- marketplace
- perfect JavaScript sandbox

Safety comes from a smaller contract: declared capabilities, import restrictions, runtime adapters, adapter-generated provider policy, and deployment isolation.

## Known limits

| Limit | Impact |
| --- | --- |
| Auth lifecycle is provider-owned | Token verification is real locally and on AWS (local IdP + OIDC config), but session/refresh management and login UI belong to your provider. See [Auth](/docs/cloud/auth). |
| Packaging is private | Packages are currently private workspace packages. There is no supported `npm install -g`, `pnpm dlx`, or `npx` path yet. From the `anvil-cloud` workspace, use `pnpm anvil ...` after `pnpm build`; inside examples, use `node ../../packages/cli/dist/index.js ...`. |
| Generated client is early | The browser client and hook helpers exist, but framework integration is still being shaped. |
| AWS preview is alpha, not production hosting | Preview provisioning exists for the checked-in smoke Cell, including deploy, public runtime checks, remote inspect/logs, and destroy. Plans include cleanup commands and cost drivers, but authenticated mutation/query checks require an OIDC-backed token setup, and production use still needs wider rollback, auth, and cost-hardening work. |
| No hosted control plane | A local Lens UI (`/_anvil/lens`) and the `ControlPlaneApi` contract exist, but inspect and logs still depend on local state or AWS deployment metadata. A hosted plane would be a future adapter behind the same contract. See [Anvil Lens](/docs/cloud/lens). |
| Services run locally only | The `service` primitive is supervised by the local runtime. There is no cloud execution path yet; an ECS/Fargate adapter is designed but not implemented. See [Services](/docs/cloud/services). |
| Outbound fetch runs locally only | The builder accepts `capabilities.outboundFetch`, but AWS preview rejects it until outbound network policy can be enforced. |

## What to verify before trusting a Cell

Run:

```bash
anvil check --json
anvil build --json
anvil inspect --local --json
anvil logs --local --json
```

Before preview deploy, inspect:

- manifest
- declared capabilities
- generated client output
- import policy diagnostics
- deployment plan
- CloudFormation template
- artifact summary, including the Lambda bundle hash and content-addressed key

## What to verify before trusting AWS preview

Before treating AWS preview as more than a local deploy experiment, verify:

- artifact bucket configuration
- stack creation or update behavior
- Lambda runtime URL
- `pnpm verify:aws-preview` against `examples/aws-preview`
- generated IAM permissions
- DynamoDB table shape
- S3 asset and file behavior
- SQS and scheduled job behavior
- CloudWatch logs
- deployment metadata table
- remote `inspect` and `logs`
- preview cleanup through `anvil destroy --preview --app <name> --yes`
- rollback path

## Contribution priorities

Useful next work includes:

- widening `pnpm verify:aws-preview` to cover authenticated OIDC smoke checks
- cloud execution paths for workflows and services
- auth provider integration
- richer Guard capability checks
- generated client ergonomics
- rollback commands beyond preview redeploy/destroy guidance
- custom domain support
- cost and usage reporting beyond preview plan cost drivers
- clearer package publishing path

Keep the contract small. The first version should be understandable, not omniscient.
