---
title: Agent Sandboxes
navTitle: Agent Sandboxes
description: The Agent Sandbox contract and AWS Lambda MicroVM provider for isolated, sessionful Anvil Agent workspaces.
product: Anvil Cloud
section: Runtime
order: 126
---

# Agent Sandboxes

Agent Sandboxes are the runtime shape for serious Anvil Agent execution: isolated,
inspectable, sessionful workspaces where an agent can run tools, operate a repo,
wait for approval, resume with state, and leave evidence behind.

The execution foundation now exists: Anvil has provider-neutral sandbox and
execution contracts, resumable cursor events, durable local lease storage, a
deterministic conformance provider, an authenticated HTTP boundary,
content-addressed source snapshots, a provider-neutral worker boundary, a
runnable CLI service, an opt-in Desktop workbench, and an AWS Lambda MicroVM
read-only transport. The full hosted experience still needs a compatible
deployed worker image, subscription-login workers, production persistence,
Lens topology, and real-account verification. Technically functional, not yet
wearing a cape.

## Why sandboxes exist

Simple agent calls are request-shaped:

```txt
input -> model -> output
```

Useful agent work is often session-shaped:

```txt
inspect repo
install dependencies
run tests
edit files
open browser
wait for approval
resume
deploy preview
inspect logs
summarize evidence
```

An Agent Sandbox gives that session a bounded world:

- an agent manifest
- declared capabilities
- approval-gated actions
- workspace filesystem state
- brokered secrets
- network and filesystem policy
- streamed command output
- diffs and artifacts
- lifecycle state
- audit events

Cell authors still define agents through `defineAgent`. They do not write
Dockerfiles, CloudFormation, IAM policies, or provider SDK calls.

## Contract shape

The author-facing contract stays provider-neutral:

```ts
defineAgent({
  name: "release-engineer",
  model: {
    provider: "aws-bedrock",
    model: "anthropic.claude-3-5-sonnet-20241022-v2:0",
    region: "eu-west-2",
  },
  capabilities: {
    git: ["read", "branch", "commit"],
    deployments: ["preview"],
    network: { allow: ["github.com", "api.github.com"] },
    filesystem: "read-write",
    secrets: "brokered",
  },
  credentialBroker: {
    credentials: [
      {
        credential: "GITHUB_TOKEN",
        domains: ["github.com"],
        inject: {
          kind: "header",
          name: "authorization",
          scheme: "bearer",
        },
      },
    ],
  },
  approvals: {
    requiredFor: ["git.push", "deploy.preview"],
  },
  runtime: {
    sandbox: "required",
    durability: "optional",
    humanApproval: "required",
  },
});
```

The adapter decides how to satisfy `runtime.sandbox`. On AWS, the target is a
Lambda MicroVM-backed sandbox session.

`credentialBroker` is a manifest policy, not a secret container. The generated
manifest records credential names, allowed domains, and header/query injection
targets. It does not include credential values. Builder validation requires the
Cell to declare each credential in `capabilities.secrets`, the agent to declare
`secrets: "brokered"`, the agent to require a sandbox, and the broker domains to
be present in `capabilities.network.allow`.

## Local backends

Anvil Local now reports sandbox-required agents against the same provider
contract used by AWS. It can choose between:

- `local-docker`: a Docker-backed session with a per-session workspace mount.
- `local-process`: a development fallback that records lifecycle and policy
  state without Docker. It is not an OS isolation boundary for untrusted code.

The default backend is `auto`: use Docker when the Docker CLI can reach a
daemon, otherwise fall back to `local-process`. Override it with:

```sh
ANVIL_LOCAL_SANDBOX_BACKEND=process anvil-cloud agents sandboxes --json
anvil-cloud agents sandboxes --sandbox-backend docker --json
```

Local sessions are persisted under `.anvil/local/sandboxes`. `anvil-cloud
inspect --local --json` includes the backend id, lifecycle status, workspace
root, capability policy, network policy, and brokered credential policy names.
It does not include credential values.

## AWS implementation

For AWS deployments, Anvil keeps normal Cell traffic on Lambda and can use
Lambda MicroVMs for agent sandboxes:

```txt
Cell Lambda
  - auth
  - query/mutation/endpoint/job routing
  - capability broker
  - approval gate
  - session registry

Agent Sandbox on Lambda MicroVM
  - repository workspace
  - shell and tool execution
  - browser or MCP processes
  - generated-code execution
  - streamed logs
  - filesystem diffs and artifacts
```

`@anvil-cloud/aws` exports `AwsLambdaMicroVmSandboxProvider`. It uses the
generated AWS SDK client for Lambda MicroVMs to run, inspect, suspend, resume,
terminate, and create auth tokens for MicroVM sessions. Set
`ANVIL_AWS_AGENT_SANDBOX_IMAGE` or pass `imageIdentifier` in provider options.
It does not replace the Cell runtime.

## Session lifecycle

The provider-neutral sandbox contract is:

```ts
type AgentSandboxSession = {
  id: string;
  agent: string;
  status:
    | "starting"
    | "active"
    | "waiting-for-approval"
    | "suspended"
    | "terminated"
    | "expired";
  endpointUrl?: string;
  startedAt: string;
  expiresAt?: string;
};

type AgentSandboxProvider = {
  start(input: AgentSandboxStartInput): Promise<AgentSandboxSession>;
  inspect(sessionId: string): Promise<AgentSandboxSession>;
  suspend(sessionId: string): Promise<void>;
  resume(sessionId: string): Promise<AgentSandboxSession>;
  terminate(sessionId: string): Promise<void>;
};
```

The important part is the boundary: Anvil owns the contract, policy, approval
checks, and inspection; the adapter owns provider resources.

## Execution control plane

`@anvil-cloud/runtime` also defines the `AgentExecutionProvider` contract and
stable source, policy, event, result, artifact, usage, and cleanup shapes.
`@anvil-cloud/control-plane` turns those provider operations into idempotent
execution leases with:

- client-token idempotency
- cursor-based replay without duplicate provider events
- approval decisions, structured input, and steering
- suspend, resume, collect, terminate, and TTL reaping
- event-count and estimated-cost ceilings
- JSON-file or in-memory state stores
- content-addressed snapshot storage with bounded archive/patch sizes
- short-lived, execution-bound, single-use worker grants
- cleanup receipts that distinguish requested teardown from verified teardown
- an authenticated, workspace-authorised `/v1/executions` HTTP router and
  matching execution/source clients
- a provider-neutral worker HTTP router that verifies snapshot size and
  SHA-256 before workspace preparation
- a loopback-safe Node service adapter

The deterministic exit gate needs no cloud account:

```bash
anvil cloud executions conformance --json
```

It starts a fake writable execution, pauses for approval, resumes from the same
cursor, returns a patch, and verifies that the sandbox was terminated. This is a
real contract test, not a simulated claim that AWS credentials or a hosted
service exist.

AWS implements the same interface in read-only mode. A compatible Lambda
MicroVM image receives source preparation, run, cursor event, approval, input,
steering, and result requests under `/_anvil/execution/*`. Every request uses a
short-lived MicroVM auth token. The token is not stored in the execution lease
or event log.

Run the durable alpha service and lifecycle clients with:

```bash
export ANVIL_EXECUTION_CONTROL_TOKEN="$(openssl rand -base64 32)"
anvil cloud executions serve --provider fake --json
anvil cloud executions list --json
anvil cloud executions show <execution-id> --json
anvil cloud executions events <execution-id> --json
```

Remote user requests fail closed without authentication and are authorised per
workspace. Snapshot downloads use a separate one-time bearer bound to the exact
execution. The Node service rejects invalid control-plane bearer headers before
buffering snapshot bodies. The raw grant token and the Desktop control-plane
bearer are never written to leases, events, results, or renderer state.

## Use a Codex or Cursor subscription

The execution contract supports two model-auth modes:

- a cloud-managed credential name, where the control plane owns secret
  brokering;
- an execution-scoped `codex` or `cursor` provider subscription login, where
  no model API key or local OAuth cache crosses the boundary.

[Codex supports ChatGPT subscription login and device-code login on headless
machines](https://learn.chatgpt.com/docs/auth#login-on-headless-devices). A
compatible worker can therefore ask the user to approve a one-time device flow,
keep the refreshed login only inside the sandbox session, and destroy it during
cleanup. [Cursor CLI supports browser login backed by the user's Cursor
account](https://docs.cursor.com/en/cli/reference/authentication), but its
public Background Agents API still uses API keys. Anvil therefore requires each
worker image to advertise `codex` and/or `cursor` subscription support instead
of claiming they are interchangeable.

The AWS adapter advertises no subscription providers by default. Operators set
`ANVIL_AWS_AGENT_SUBSCRIPTION_PROVIDERS=codex,cursor` only for login flows the
deployed image actually implements.

## Desktop remote executions

The optional Cloud Workbench in Anvil Desktop can save and test a control-plane
connection, upload a committed read-only repository snapshot, start an
execution, follow evidence, resolve approvals, steer, and terminate. The bearer
is encrypted by Electron `safeStorage` in main-process SQLite; the renderer sees
only endpoint/configured state. Working-tree changes and known secret-file
paths are excluded and Desktop reports when local changes were left behind.

Codex subscription is the default runtime selector. Cursor subscription and
cloud-managed credentials remain explicit alternatives, and a worker must
support the selected login flow before the provider accepts the request.

## What sandboxes should run

Good sandbox workloads:

- test runs and typechecks
- package installs
- generated-code execution
- browser automation
- repository inspection and diff generation
- static analysis and dependency review
- preview deployment preparation
- incident triage that needs logs plus repo state
- long-running tool servers such as MCP processes

Poor sandbox workloads:

- ordinary queries and mutations
- simple endpoints
- short jobs that fit the existing runtime
- durable business workflows that need persisted orchestration

Lambda is still the right request runtime. The sandbox is the workshop. Use the
right room, or enjoy debugging furniture.

## Policy model

Sandboxes make sandboxing real, but sandboxing is not the whole policy model.

Before a tool executes, Anvil should check:

1. the agent declared the required capability
2. the action is not approval-gated, or approval was granted
3. the sandbox network policy allows the destination
4. secret access is brokered and scoped
5. filesystem writes stay inside the workspace boundary
6. deployment and git actions go through Anvil-controlled brokers

The MicroVM contains the work. Anvil decides what work is allowed.

## Inspection model

The CLI exposes sandbox readiness and execution conformance today:

```bash
anvil cloud agents sandboxes --json
anvil cloud executions conformance --json
```

Anvil Lens and remote inspect should eventually expose:

- sandbox status
- region and adapter backing
- current session TTL
- last tool call
- command output
- filesystem diff
- artifacts
- pending approvals
- cost and usage hints
- audit events

Example future inspect shape:

```json
{
  "agents": {
    "release-engineer": {
      "sandbox": "aws-lambda-microvm",
      "session": "active",
      "region": "eu-west-1",
      "lastAction": "pnpm test",
      "approvals": ["deploy.preview"],
      "artifacts": ["diff.patch", "test-output.ndjson"]
    }
  }
}
```

## Current status

Implemented today:

- `defineAgent`
- provider-neutral agent manifests
- mounted Cell Agents
- local stub inference
- provider registry
- tool capability checks
- approval-required results
- AWS Bedrock inference provider
- AWS compatibility reporting
- provider-neutral Agent Sandbox types in `@anvil-cloud/runtime`
- provider-neutral execution request, source, policy, event, result, artifact,
  and provider I/O types in `@anvil-cloud/runtime`
- idempotent execution leases, durable cursors, approval/input/steering
  controls, budgets, results, and cleanup receipts in
  `@anvil-cloud/control-plane`
- in-memory and atomic JSON-file execution stores
- authenticated and workspace-authorised execution HTTP router/clients
- content-addressed file/in-memory snapshot stores and one-time worker grants
- authenticated worker HTTP boundary with source-integrity verification
- runnable execution service plus CLI snapshot and lifecycle commands
- optional Desktop remote execution connection, event/approval controls, and
  encrypted main-process token storage
- execution-scoped Codex/Cursor subscription-auth descriptors without model
  API keys or copied local OAuth caches
- deterministic fake-provider conformance with approval, patch, cursor, and
  teardown proof
- brokered credential declarations in agent manifests and sandbox startup
  payloads
- local Docker and process sandbox providers in `@anvil-cloud/local`
- local sandbox backend selection and inspect JSON session reporting
- `AwsLambdaMicroVmSandboxProvider` in `@anvil-cloud/aws`
- token-scoped AWS read-only execution transport for compatible MicroVM worker
  images
- `ANVIL_AWS_AGENT_SANDBOX_IMAGE`-gated AWS support for sandbox-required agents
- AWS preview plan changes, review gates, and cost drivers for `agent-sandboxes`
- `anvil cloud agents sandboxes --json`
- `anvil cloud executions conformance --json`

Not implemented yet:

- live network-bound credential injection around sandbox tools
- compatible deployed AWS execution worker image and real-account smoke
- concrete Codex device-login and Cursor interactive-login worker drivers
- concurrency-safe hosted persistence beyond the alpha JSON stores
- production approval UI
- sandbox-aware Lens views
- remote sandbox inspect/logs
- persistent hosted memory
- durable multi-step orchestration

Treat this as a runnable alpha boundary, not the finished hosted experience.
