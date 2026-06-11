---
title: Status and limits
navTitle: Status and limits
description: Current v0 maturity, working surfaces, non-goals, and known limits for Anvil Cloud.
product: Anvil Cloud
section: Overview
order: 160
---

# Status and limits

Anvil Cloud is v0 software. It has real implementation across the runtime, builder, local server, client, CLI, and AWS preview adapter, but it should still be treated as early infrastructure.

Use it for inspection, local development, adapter design, demos, tests, and contribution work. Do not present it as production-ready hosted platform infrastructure.

## Implemented surfaces

| Surface | Current state |
| --- | --- |
| Runtime DSL | `app`, `query`, `mutation`, `endpoint`, `job`, `table`, and field builders exist. |
| Runtime execution | `handleRuntimeRequest` supports query, mutation, endpoint, and job handlers. |
| Runtime host | Host adapter interfaces exist for db, files, env, auth, logs, events, and jobs. |
| Builder | Config, import policy, typecheck, server/client bundle, manifest extraction, generated client, and build metadata exist. |
| Local runtime | Local HTTP server, JSON database, files, auth, logs, events, jobs, manifest, and inspection state exist. |
| CLI | `new`, `dev`, `check`, `build`, `inspect`, `logs`, `db`, and `deploy --preview` exist. |
| Client | Browser client and hook helper shape exist, with generated metadata support. |
| AWS preview | Plan, CloudFormation synthesis, artifacts, optional provisioner, Lambda bridge, DynamoDB, S3, SQS, EventBridge schedules, CloudWatch logs, remote inspect, and remote logs exist. |

## Non-goals for v0

Anvil Cloud v0 does not aim to provide:

- arbitrary cloud resource authoring in Cell code
- direct provider SDK access from Cell handlers
- Kubernetes, ECS, or container runtime support
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
| AWS event publishing is unsupported | `ctx.events` is not yet backed by AWS preview execution. |
| Auth is early | Local auth exists; AWS preview currently uses request-provided auth identity rather than full provider lookup. |
| Packaging is private | Packages are currently private workspace packages, so local usage may need the built CLI entrypoint or linked binaries. |
| Generated client is early | The browser client and hook helpers exist, but framework integration is still being shaped. |
| Live AWS needs more verification | Preview provisioning exists, but real account execution must be hardened before production claims. |
| No hosted control plane | Inspect and logs depend on local state or AWS deployment metadata, not a central hosted service. |

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
- artifact summary

## What to verify before trusting AWS preview

Before treating AWS preview as more than a local deploy experiment, verify:

- artifact bucket configuration
- stack creation or update behavior
- Lambda runtime URL
- generated IAM permissions
- DynamoDB table shape
- S3 asset and file behavior
- SQS and scheduled job behavior
- CloudWatch logs
- deployment metadata table
- remote `inspect` and `logs`
- cleanup and rollback path

## Contribution priorities

Useful next work includes:

- hardening AWS preview against real account runs
- event publishing adapter support
- auth provider integration
- richer Guard capability checks
- generated client ergonomics
- rollback and cleanup commands
- custom domain support
- cost and usage hints
- clearer package publishing path

Keep the contract small. The first version should be understandable, not omniscient.
