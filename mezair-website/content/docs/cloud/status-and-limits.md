---
title: Status and limits
navTitle: Status and limits
description: What works in Mezair Cloud today, known limits, deployment restrictions and hosted availability.
product: Mezair Cloud
section: Reference
journey: reference
order: 200
---

# Status and limits

Mezair Cloud is beta software. You can run Cells locally, build React/Vite
clients, inspect them with the CLI and Lens, and try AWS preview deployments.

Mezair Cloud Agents will run agents on machines we host. It hasn't launched
and has no price or release date yet. The existing integrations use your own
provider accounts, which bill you directly.

Use it for local development, demos, tests and contribution work. Before a
preview deployment, check which features your adapter supports and inspect
the generated plan. Production hosting is not ready.

## AWS and Cloudflare app backends

Both adapters now have conditional database commits, bounded record pages,
private file storage, queue dispatch and bearer-token verification. Cloudflare
also has a queue consumer and Cron Trigger bridge. Its experimental artifact
builder accepts existing resources and generates a database migration. Normal
Cell deployment and automatic resource provisioning are not available yet. AWS remains a preview adapter.

Read [data and background work](/docs/cloud/app-backends) for failure behavior
and supported deployment targets.

## Supported features

| Surface           | Current state                                                                                                                                                                                                                                                                                                                                                                                                          |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Runtime DSL       | `app`, `query`, `mutation`, `endpoint`, `job`, `workflow`, `service`, `channel`, `table`, and field builders exist.                                                                                                                                                                                                                                                                                                    |
| Runtime execution | `handleRuntimeRequest` supports query, mutation, endpoint, job, and workflow handlers. Services run through the runtime `ServiceSupervisor`, not per-request invocation.                                                                                                                                                                                                                                               |
| Agents            | `defineAgent`, agent capabilities, explicit shallow subagents, approval contracts, provider-neutral manifests, provider registry, deterministic local stub inference, mounted Cell Agents, local invocation/session/channel simulation routes, CLI contract commands, AWS Bedrock inference provider support, and the Agent Sandbox target architecture exist.                                                           |
| Runtime host      | Host adapter interfaces exist for db, files, env, auth, logs, events, and jobs.                                                                                                                                                                                                                                                                                                                                        |
| Builder           | Config, import policy, typecheck, server/client bundle, manifest extraction, generated client, and build metadata exist.                                                                                                                                                                                                                                                                                               |
| Local runtime     | Local HTTP server, JSON database with snapshot branches and TTL cleanup, files, auth, logs, usage events, events, jobs, workflows, supervised services, manifest, and inspection state exist.                                                                                                                                                                                                                          |
| CLI               | `new`, `dev`, `check`, `review`, `build`, `agents`, `executions conformance`, `channels simulate`, `inspect`, `logs`, `usage --local`, `usage --preview`, `db` table and branch lifecycle commands, `workflows`, `services list`, named `deploy --preview`, `rollback --preview --dry-run`, and `destroy --preview` exist.                                                                                                                    |
| Client            | React/Vite is the default UI setup. The browser client supports generated query/mutation metadata, mounted agent session helpers, token lookup, structured runtime errors, hook helpers and manual `refetch`. |
| Lens              | Local Lens is served at `/_mezair/lens` and reads the same local runtime truth as CLI JSON: manifest, capabilities, auth users, logs, traces, usage totals, active database branch, database state, workflows, services, and diagnostics.                                                                                                                                                                                |
| Examples          | `examples/notes` is the canonical local demo. `examples/aws-preview` is the AWS-compatible smoke Cell.                                                                                                                                                                                                                                                                                                                 |
| AWS preview       | Plan, review aggregation, CloudFormation synthesis, artifacts, optional provisioner, named preview metadata, Lambda bridge, DynamoDB, S3, SQS, EventBridge events and schedules, Step Functions workflows, outbound fetch guard, ECS/Fargate service resource synthesis, CloudWatch logs, remote inspect, remote logs, usage visibility, rollback intent, preview destroy, cost-driver hints, and cleanup hints exist. |

## Non-goals for beta

Mezair Cloud beta does not aim to provide:

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
| CLI packaging is beta                       | The Cloud CLI package is `@mezairstack/cloud-cli` and exposes `mezair-cloud`. From the `mezair-cloud` workspace, use `pnpm mezair-cloud ...` after `pnpm build`; inside examples, use `node ../../packages/cli/dist/index.js ...`.                                                                                                                                             |
| Generated client is early                    | React/Vite is the default UI path and hook helpers exist, but invalidation is manual, there is no cache policy layer, and the generated surface is query/mutation metadata rather than a full SDK.                                                                                                                                                                         |
| AWS preview is beta, not production hosting | Preview provisioning exists for the checked-in smoke Cell, including named deploys, public runtime checks, remote inspect/logs, and destroy. Plans include cleanup commands and cost drivers. Rollback is dry-run recovery intent only because deployment history and restorable client assets are not yet stored. |
| Workflows need deeper remote inspection      | Local workflows have durable run state, retries, timeouts, resume behavior, CLI commands, and Lens inspection. AWS preview maps workflows to Step Functions, but remote `workflows list/show --app` is not wired yet.                                                                                                                                                      |
| Services are local-only                      | The `service` primitive is supervised by the local runtime. AWS preview blocks service-bearing deploys before provisioning until the Fargate runner executes the exact Cell handler. See [Services](/docs/cloud/services). |
| Usage is visibility, not billing             | `mezair cloud usage --preview` reports declared resource counts and cost-driver hints. It does not query AWS billing or produce prices.                                                                                                                                                                                                                                     |
| Agent hosting | Cell Agents and subagents run locally. Hosted orchestration, approval UI and memory are not available. See [Mezair Agents](/docs/cloud/agents). |
| Agent evals are local-first                  | Mounted agent eval suites run locally through `mezair-cloud eval`, support baseline comparisons, and can write updated baselines for CI review. Hosted eval orchestration and remote eval execution are not wired yet.                                                                                                                                         |
| Agent sessions are local-first               | Mounted agents support local persisted sessions, ordered events, continuation tokens, and SSE replay streams. AWS preview session transport and hosted continuation are not wired yet. See [Mezair Agents](/docs/cloud/agents).                                                                                                                                           |
| Channels are contract-first                  | Channel bindings compile into the manifest and local simulation can route messages into mounted agent sessions. Real Slack/GitHub/Discord adapters, signature verification, and deployed webhook ingress are not wired yet. See [Mezair Agents](/docs/cloud/agents).                                                                                                       |
| Agent Sandboxes | Local execution and the CLI service are available. AWS supports read-only execution with a compatible worker image in your own account. Mezair-hosted compute is not available. See [Agent Sandboxes](/docs/cloud/agent-sandboxes). |

## Check your Cell

Run:

```bash
mezair cloud check --json
mezair cloud build --json
mezair cloud inspect --local --json
mezair cloud logs --local --json
```

Before deploying a preview, review the generated manifest, declared capabilities
and deployment plan. See [AWS preview](/docs/cloud/aws-preview) for account
configuration, deployment commands, costs and cleanup.

## Related

- [Quickstart](/docs/cloud/quickstart)
- [Agents](/docs/cloud/agents)
- [Agent Sandboxes](/docs/cloud/agent-sandboxes)
