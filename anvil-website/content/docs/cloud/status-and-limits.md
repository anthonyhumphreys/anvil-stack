---
title: Status and limits
navTitle: Status and limits
description: Current alpha maturity, working surfaces, non-goals, and known limits for Anvil Cloud.
product: Anvil Cloud
section: Reference
journey: reference
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

| Surface           | Current state                                                                                                                                                                                                                                                                                                                                                                                                          |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Runtime DSL       | `app`, `query`, `mutation`, `endpoint`, `job`, `workflow`, `service`, `channel`, `table`, and field builders exist.                                                                                                                                                                                                                                                                                                    |
| Runtime execution | `handleRuntimeRequest` supports query, mutation, endpoint, job, and workflow handlers. Services run through the runtime `ServiceSupervisor`, not per-request invocation.                                                                                                                                                                                                                                               |
| Agents            | `defineAgent`, agent capabilities, explicit shallow subagents, approval contracts, provider-neutral manifests, provider registry, deterministic local stub inference, mounted Cell Agents, local invocation/session/channel simulation routes, CLI contract commands, AWS Bedrock inference provider support, and the Agent Sandbox target architecture exist.                                                           |
| Runtime host      | Host adapter interfaces exist for db, files, env, auth, logs, events, and jobs.                                                                                                                                                                                                                                                                                                                                        |
| Builder           | Config, import policy, typecheck, server/client bundle, manifest extraction, generated client, and build metadata exist.                                                                                                                                                                                                                                                                                               |
| Local runtime     | Local HTTP server, JSON database with snapshot branches and TTL cleanup, files, auth, logs, usage events, events, jobs, workflows, supervised services, manifest, and inspection state exist.                                                                                                                                                                                                                          |
| CLI               | `new`, `dev`, `check`, `review`, `build`, `agents`, `executions conformance`, `channels simulate`, `inspect`, `logs`, `usage --local`, `usage --preview`, `db` table and branch lifecycle commands, `workflows`, `services list`, named `deploy --preview`, `rollback --preview --dry-run`, and `destroy --preview` exist.                                                                                                                    |
| Client            | React/Vite is the current paved road. The browser client supports generated query/mutation metadata, mounted agent session helpers, token lookup, structured runtime errors, hook helpers, and manual `refetch`.                                                                                                                                                                                                      |
| Lens              | Local Lens is served at `/_anvil/lens` and reads the same local runtime truth as CLI JSON: manifest, capabilities, auth users, logs, traces, usage totals, active database branch, database state, workflows, services, and diagnostics.                                                                                                                                                                                |
| Examples          | `examples/notes` is the canonical local demo. `examples/aws-preview` is the AWS-compatible smoke Cell.                                                                                                                                                                                                                                                                                                                 |
| AWS preview       | Plan, review aggregation, CloudFormation synthesis, artifacts, optional provisioner, named preview metadata, Lambda bridge, DynamoDB, S3, SQS, EventBridge events and schedules, Step Functions workflows, outbound fetch guard, ECS/Fargate service resource synthesis, CloudWatch logs, remote inspect, remote logs, usage visibility, rollback intent, preview destroy, cost-driver hints, and cleanup hints exist. |

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

| Limit                                        | Impact                                                                                                                                                                                                                                                                                                                                                                     |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Auth lifecycle is provider-owned             | Token verification is real locally and on AWS (local IdP + OIDC config), but session/refresh management and login UI belong to your provider. See [Auth](/docs/cloud/auth).                                                                                                                                                                                                |
| CLI packaging is alpha                       | The Cloud CLI package is `@anvilstack/cloud-cli` and exposes `anvil-cloud`. From the `anvil-cloud` workspace, use `pnpm anvil-cloud ...` after `pnpm build`; inside examples, use `node ../../packages/cli/dist/index.js ...`.                                                                                                                                             |
| Generated client is early                    | React/Vite is the default UI path and hook helpers exist, but invalidation is manual, there is no cache policy layer, and the generated surface is query/mutation metadata rather than a full SDK.                                                                                                                                                                         |
| AWS preview is alpha, not production hosting | Preview provisioning exists for the checked-in smoke Cell, including named deploys, public runtime checks, remote inspect/logs, and destroy. Plans include cleanup commands and cost drivers. Rollback is dry-run recovery intent only because deployment history and restorable client assets are not yet stored. |
| No deployed hosted control-plane service | The execution plane now has mandatory auth/workspace policy hooks, content-addressed snapshot storage, one-time worker grants, a Node HTTP adapter, durable CLI clients, and an opt-in Desktop workbench. It is runnable locally, but production persistence, a deployed AWS worker image, and real-account verification remain. See [Agent Sandboxes](/docs/cloud/agent-sandboxes). |
| Workflows need deeper remote inspection      | Local workflows have durable run state, retries, timeouts, resume behavior, CLI commands, and Lens inspection. AWS preview maps workflows to Step Functions, but remote `workflows list/show --app` is not wired yet.                                                                                                                                                      |
| Services are local-only                      | The `service` primitive is supervised by the local runtime. AWS preview blocks service-bearing deploys before provisioning until the Fargate runner executes the exact Cell handler. See [Services](/docs/cloud/services). |
| Usage is visibility, not billing             | `anvil cloud usage --preview` reports declared resource counts and cost-driver hints. It does not query AWS billing or produce prices.                                                                                                                                                                                                                                     |
| Agents are foundation-level | Mounted Cell Agents and shallow subagent trees run locally and compile to manifests. Project-agent discovery, Guardian review, and provider-neutral execution leases/events/controls now exist; authenticated hosted orchestration, production approval UI, trace-linked parent/child sessions, and hosted memory are not deployed. See [Anvil Agents](/docs/cloud/agents). |
| Agent evals are local-first                  | Mounted agent eval suites run locally through `anvil-cloud eval`, support baseline comparisons, and can write updated baselines for CI review. Hosted eval orchestration and remote eval execution are not wired yet.                                                                                                                                         |
| Agent sessions are local-first               | Mounted agents support local persisted sessions, ordered events, continuation tokens, and SSE replay streams. AWS preview session transport and hosted continuation are not wired yet. See [Anvil Agents](/docs/cloud/agents).                                                                                                                                           |
| Channels are contract-first                  | Channel bindings compile into the manifest and local simulation can route messages into mounted agent sessions. Real Slack/GitHub/Discord adapters, signature verification, and deployed webhook ingress are not wired yet. See [Anvil Agents](/docs/cloud/agents).                                                                                                       |
| Agent Sandboxes have a runnable control plane | Runtime contracts, local providers, idempotent leases, durable cursor events, controls, budgets, cleanup receipts, authenticated HTTP/service boundaries, immutable snapshots, one-time grants, Desktop controls, subscription-auth intent, and AWS read-only transport exist. A deployed compatible worker, concrete subscription-login runners, sandbox-aware Lens, hosted persistence, and real-account verification remain. See [Agent Sandboxes](/docs/cloud/agent-sandboxes). |

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
- rollback intent for versioned preview metadata plus the current artifact-promotion limit: redeploy a known-good checkout or destroy the preview stack when direct pointer promotion is not enough

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
- hosted approval, memory, credential broker, and concurrency-safe execution
  persistence for agents
- deployed subscription-capable execution workers and real-account cleanup
  evidence
- a compatible AWS Lambda MicroVM execution worker image plus real-account
  read-only smoke and cleanup evidence
- automated artifact rollback beyond dry-run intent
- real cost reporting beyond declared usage visibility and preview plan cost drivers
- clearer package publishing path
- custom domain support

Keep the contract small. The first version should be understandable, not omniscient.
