---
title: Mezair Cloud
navTitle: Overview
description: Build small TypeScript apps called Cells, run them locally, inspect the generated output and try the AWS preview adapter.
product: Mezair Cloud
section: Start here
journey: learn
order: 10
---

# Mezair Cloud

Mezair Cloud is a TypeScript framework for app backends. Define the data your app stores, the API routes it exposes, its background jobs, and who can use them. Run it on your machine before creating any cloud resources. Mezair calls each app a **Cell**.

For example, a catalogue app can import records on a schedule, expose a search API, and store private import files. A team tool can add sign-in and restrict who may update records. Your application owns the business rules; the framework supplies the runtime and deployment tools.

## Start with a working app

Follow the [Notes quickstart](/docs/cloud/quickstart) to add and read records, test sign-in, and inspect logs in your browser. You do not need a cloud account for local development. The command-line tools also produce JSON output for scripts and coding agents.

Before deploying, review which resources your app needs and whether the chosen deployment target supports them. AWS is in preview. Cloudflare support is still experimental; a resource appearing in a plan does not mean the runtime can use it. Read [data and background work](/docs/cloud/app-backends) for the shared AWS and Cloudflare backend contract. See [status and limits](/docs/cloud/status-and-limits) before choosing a target for a live app.

The framework is open source and runs in your own provider accounts. Your hosting and model providers bill you directly. **Mezair Cloud Agents**, the planned service that would run agents on machines hosted by Mezair, has not launched. It is separate from this framework and from Desktop Sync.

## Terms used in the guides

- **Cell**: your app, including its data, handlers and permissions.
- **Runtime**: the code that receives requests and runs your handlers.
- **Deployment adapter**: the part that creates and connects resources in a hosting provider.
- **Manifest**: the generated list of your app's routes, data and required permissions.
- **Lens**: the local dashboard for inspecting data, logs and background work.

The API and architecture references below describe those parts in detail.

## Current package layout

| Package | Role |
| --- | --- |
| `@mezair-cloud/runtime` | Cell DSL, Agent definitions, provider-neutral agent runtime and execution contracts, `RuntimeRequest`, `RuntimeResponse`, `RuntimeHost`, `RuntimeContext`, and `handleRuntimeRequest`. |
| `@mezair-cloud/builder` | Config loading, import policy, typecheck, server/client bundle, manifest extraction, build metadata, and generated client files. |
| `@mezair-cloud/local` | Local runtime server, JSON database adapter, local files, auth, logs, events, jobs, and inspection state. |
| `@mezair-cloud/client` | Browser client and framework hook helpers for generated query and mutation metadata. |
| `@mezair-cloud/auth` | Provider-neutral token verification: OIDC discovery/JWKS verification plus a local identity provider that signs real JWTs. |
| `@mezairstack/cloud-cli` | `mezair cloud new`, `dev`, `check`, `review`, `build`, `agents`, `executions`, `inspect`, `logs`, `usage`, `db`, `auth`, `workflows`, `services`, `lens`, `deploy --preview`, and rollback/destroy preview commands. |
| `@mezair-cloud/control-plane` | The `ControlPlaneApi` contract behind Mezair Lens plus durable agent execution leases, cursor events, controls, and a framework-neutral HTTP boundary. |
| `@mezair-cloud/aws` | AWS preview adapter, CloudFormation synthesis, Lambda runtime bridge, AWS-backed host adapters, Bedrock inference provider, Lambda MicroVM read-only execution transport, artifact packaging, provisioning, remote inspect, remote logs, and preview cleanup. |

## Core terms

- **Mezair Cloud**: the toolchain and docs for building Mezair Cells.
- **Mezair Cell**: a deployable app unit with server functions, client UI, schema, endpoints, jobs, files, auth assumptions, environment needs, and declared capabilities.
- **Mezair Runtime**: shared execution layer for local, test, and adapter-backed execution.
- **Mezair Builder**: compiler and bundler that emits server bundle, client bundle, manifest, generated client output, and build metadata.
- **Mezair Local**: local runtime server and state adapters.
- **Mezair Guard**: import policy, capability checks, and safety validation.
- **Mezair Lens**: inspection surface for manifest, runtime status, local auth, logs, database state, workflows, services, and diagnostics.
- **Mezair Agent**: a portable, inspectable runtime unit with explicit capabilities, approval-gated actions, model configuration, and a provider-neutral manifest.
- **Agent Sandbox**: an isolated, sessionful, inspectable workspace for agents that need sandboxed tool execution. On AWS, `@mezair-cloud/aws` provides a Lambda MicroVM-backed sandbox provider.

## What works now

The alpha implementation includes:

- object-based Cell DSL for `app`, `query`, `mutation`, `endpoint`, `job`, `workflow`, `service`, `table`, and field builders
- contract-first [Mezair Agents](/docs/cloud/agents): `defineAgent`, provider-neutral agent manifests, mounted Cell Agents, local stub inference, provider registry, approval gates, tool capability checks, and AWS Bedrock provider support
- [Agent Sandbox](/docs/cloud/agent-sandboxes) contract and AWS Lambda MicroVM provider for sandbox-required agent workspaces
- shared runtime request handling for query, mutation, endpoint, job, and workflow triggers
- [real authentication](/docs/cloud/auth): declarative per-handler access control enforced by the runtime, a local identity provider signing real JWTs, and OIDC verification for any compliant provider via configuration
- [durable workflows](/docs/cloud/workflows): ordered typed steps with retries and timeouts, state persisted per transition, resumable after interruption
- [supervised services](/docs/cloud/services): long-running handlers with restart policies and clean shutdown
- [Mezair Lens](/docs/cloud/lens): a local management UI over manifest, logs, database, auth users, workflow runs, and services
- in-memory and local runtime host adapters
- local HTTP runtime routes for queries, mutations, endpoints, mounted agents, auth, workflows, services, health, manifest, and inspection
- local JSON database, files, events, jobs, and NDJSON logs
- builder checks for config, forbidden imports, direct `process.env`, undeclared fetch, scheduled jobs, and capability use (database, files, outboundFetch, events, workflows, services)
- typecheck, bundle, manifest extraction, generated client output, and build metadata
- CLI commands with JSON output for automation, including `mezair cloud agents validate`, `mezair cloud agents manifest`, `mezair cloud agents invoke`, and `mezair cloud auth token` for agent-friendly authenticated sessions
- AWS preview plan and CloudFormation synthesis
- AWS-backed runtime host adapters for DynamoDB, S3, SQS, EventBridge events and scheduled jobs, Lambda env, OIDC token verification, workflow Step Functions starts when configured, and structured logs
- optional AWS provisioning when required environment variables are configured
- remote inspect and logs through deployment metadata and CloudWatch Logs
- preview destroy that empties stack-owned buckets and removes deployment metadata when configured

## Alpha boundaries

Current alpha limits include:

- AWS is the first adapter, not the application contract.
- Workflows execute end-to-end locally and map to Step Functions in AWS preview, but remote workflow run inspection is still maturing.
- Services execute fully locally; AWS preview blocks service-bearing deploys
  until the Fargate runner executes the exact Cell service handler.
- Outbound fetch policy is checked by Guard and enforced by the AWS Lambda runtime allow-list guard.
- Production use needs wider operational validation beyond the preview verifier.
- Agents are a runnable alpha control-plane foundation, not a deployed hosted agent platform. Project-agent discovery, deterministic Guardian review, authenticated resumable execution leases/events/controls, immutable snapshots, one-time worker grants, a CLI service, an optional Desktop workbench, subscription-auth intent, provider conformance, and an AWS Lambda MicroVM read-only transport exist. A deployed compatible worker image, concrete Codex/Cursor login runners, production persistence/approval UI, hosted memory, real-account proof, and sandbox-aware Lens views are future work.
- Auth token verification is real locally and on AWS, but session/refresh lifecycle and login UI belong to your provider.
- Mezair Lens is local-first; there is no hosted control plane, marketplace, or multi-region deployment.
- No arbitrary provider-resource authoring or raw container/Kubernetes definitions in Cell code.
- Safety comes from capability scoping, import restrictions, runtime adapters, generated provider policy, and deployment isolation, not a perfect JavaScript sandbox.

## Read next

- [Quickstart](/docs/cloud/quickstart)
- [Cell contract](/docs/cloud/cell-contract)
- [Auth](/docs/cloud/auth)
- [Mezair Agents](/docs/cloud/agents)
- [Agent Sandboxes](/docs/cloud/agent-sandboxes)
- [Workflows](/docs/cloud/workflows)
- [Services](/docs/cloud/services)
- [Runtime model](/docs/cloud/architecture)
- [Local runtime](/docs/cloud/local-runtime)
- [Mezair Lens](/docs/cloud/lens)
- [Builder and Guard](/docs/cloud/builder-and-guard)
- [CLI reference](/docs/cloud/cli-reference)
- [AWS preview](/docs/cloud/aws-preview)
- [Status and limits](/docs/cloud/status-and-limits)
