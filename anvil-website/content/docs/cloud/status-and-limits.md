---
title: Status and limits
navTitle: Status and limits
description: Current alpha maturity, working surfaces, non-goals, and known limits for Anvil Cloud.
product: Anvil Cloud
section: Reference
order: 160
---

# Status and limits

Anvil Cloud is alpha software with real implementation across the runtime,
builder, local server, React/Vite client path, CLI, Lens, and AWS preview
adapter.

Use it for inspection, local development, adapter design, demos, tests, and
contribution work. Do not treat it as production hosting. The useful question is
not "is it done?" It is "which parts are implemented, which parts are gated, and
what evidence should I inspect before trusting a Cell?"

## Implemented surfaces

| Surface | Current state |
| --- | --- |
| Runtime DSL | `app`, `query`, `mutation`, `endpoint`, `job`, `workflow`, `service`, `table`, and field builders exist. |
| Runtime execution | `handleRuntimeRequest` supports query, mutation, endpoint, job, and workflow handlers. Services run through the runtime `ServiceSupervisor`, not per-request invocation. |
| Agents | `defineAgent`, agent capabilities, approval contracts, provider-neutral manifests, provider registry, deterministic local stub inference, mounted Cell Agents, local invocation routes, CLI contract commands, AWS Bedrock inference provider support, and the Agent Sandbox target architecture exist. |
| Runtime host | Host adapter interfaces exist for db, files, env, auth, logs, events, and jobs. |
| Builder | Config, import policy, typecheck, server/client bundle, manifest extraction, generated client, and build metadata exist. |
| Local runtime | Local HTTP server, JSON database, files, auth, logs, events, jobs, workflows, supervised services, manifest, and inspection state exist. |
| CLI | `new`, `dev`, `check`, `review`, `build`, `agents`, `inspect`, `logs`, `usage`, `db`, `workflows`, `services list`, `deploy --preview`, `rollback --preview --dry-run`, and `destroy --preview` exist. |
| Client | React/Vite is the current paved road. The browser client supports generated query/mutation metadata, token lookup, structured runtime errors, hook helpers, and manual `refetch`. |
| Lens | Local Lens is served at `/_anvil/lens` and reads the same local runtime truth as CLI JSON: manifest, capabilities, auth users, logs, database state, workflows, services, and diagnostics. |
| Examples | `examples/notes` is the canonical local demo. `examples/aws-preview` is the AWS-compatible smoke Cell. |
| AWS preview | Plan, review aggregation, CloudFormation synthesis, artifacts, optional provisioner, Lambda bridge, DynamoDB, S3, SQS, EventBridge events and schedules, Step Functions workflows, outbound fetch guard, ECS/Fargate service resource synthesis, CloudWatch logs, remote inspect, remote logs, usage visibility, rollback dry-run intent, preview destroy, cost-driver hints, and cleanup hints exist. |

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
| CLI packaging is alpha | The Cloud CLI package is `@anvilstack/cloud-cli` and exposes `anvil-cloud`. From the `anvil-cloud` workspace, use `pnpm anvil-cloud ...` after `pnpm build`; inside examples, use `node ../../packages/cli/dist/index.js ...`. |
| Generated client is early | React/Vite is the default UI path and hook helpers exist, but invalidation is manual, there is no cache policy layer, and the generated surface is query/mutation metadata rather than a full SDK. |
| AWS preview is alpha, not production hosting | Preview provisioning exists for the checked-in smoke Cell, including deploy, public runtime checks, remote inspect/logs, and destroy. Plans include cleanup commands and cost drivers, but authenticated mutation/query checks require an OIDC-backed token setup, and production use still needs wider rollback, auth, and cost-hardening work. |
| No hosted control plane | A local Lens UI (`/_anvil/lens`) and the `ControlPlaneApi` contract exist, but inspect and logs still depend on local state or AWS deployment metadata. A hosted plane would be a future adapter behind the same contract. See [Anvil Lens](/docs/cloud/lens). |
| Workflows need deeper remote inspection | Local workflows have durable run state, retries, timeouts, resume behavior, CLI commands, and Lens inspection. AWS preview maps workflows to Step Functions, but remote `workflows list/show --app` is not wired yet. |
| Services are preview-resource support | The `service` primitive is supervised by the local runtime. AWS preview synthesizes ECS/Fargate service resources for review and cleanup evidence, but exact Cell service-handler execution inside Fargate is still a hardening step. See [Services](/docs/cloud/services). |
| Usage is visibility, not billing | `anvil cloud usage --preview` reports declared resource counts and cost-driver hints. It does not query AWS billing or produce prices. |
| Agents are foundation-level | Mounted Cell Agents run locally, compile to manifests, and can run colocated eval suites through `anvil-cloud eval`. Project-agent discovery and deterministic Guardian review exist; hosted orchestration, production approval UI, durable multi-step tool execution, and hosted memory are not implemented yet. See [Anvil Agents](/docs/cloud/agents). |
| Agent Sandboxes are first-slice implemented | Runtime sandbox types, the AWS Lambda MicroVM sandbox provider, deploy-plan entries, compatibility gates, cost/review reporting, and CLI readiness output exist. Hosted policy brokering, session streaming, workspace snapshots, sandbox-aware Lens views, and remote inspect/logs are not implemented. See [Agent Sandboxes](/docs/cloud/agent-sandboxes). |

## What to verify before trusting a Cell

Run:

```bash
anvil cloud check --json
anvil cloud build --json
anvil cloud inspect --local --json
anvil cloud logs --local --json
```

Before preview deploy, inspect:

- manifest
- declared capabilities
- generated client output
- import policy diagnostics
- typecheck diagnostics
- deployment plan
- CloudFormation template
- artifact summary, including the Lambda bundle hash and content-addressed key
- rollback, cleanup, and cost-driver hints in the deployment plan

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
- EventBridge event and scheduled-job behavior
- CloudWatch logs
- deployment metadata table
- remote `inspect` and `logs`
- preview cleanup through `anvil cloud destroy --preview --app <name> --yes`
- rollback dry-run intent plus the current manual fallback: redeploy a known-good checkout or destroy the preview stack

## Contribution priorities

Useful next work includes:

- documenting a complete OIDC setup flow for `ANVIL_AWS_SMOKE_TOKEN`
- adding negative auth tests and cleanup assertions to `pnpm verify:aws-preview`
- remote workflow run-state persistence and remote CLI/Lens inspection
- exact Cell service-handler execution inside the Fargate preview task path
- auth provider integration examples
- richer Guard capability checks
- generated client examples: loading/error examples, token handling, invalidation patterns, and typed examples around `examples/notes`
- standalone project-agent manifest generation beyond instruction discovery
- provider-mode examples for AWS Bedrock with local contract checks
- production approval, memory, sandbox, and durable orchestration adapter work for agents
- AWS Lambda MicroVM-backed Agent Sandboxes for sandbox-required agents
- automated artifact rollback beyond dry-run intent
- real cost reporting beyond declared usage visibility and preview plan cost drivers
- clearer package publishing path
- custom domain support

Keep the contract small. The first version should be understandable, not omniscient.
