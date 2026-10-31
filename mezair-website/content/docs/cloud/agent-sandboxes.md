---
title: Agent Sandboxes
navTitle: Agent Sandboxes
description: Run agents in isolated workspaces, follow their progress, pause for approval and resume from saved state.
product: Mezair Cloud
section: Concepts
journey: learn
order: 130
---

# Agent Sandboxes

An Agent Sandbox gives an agent an isolated workspace to run tools and work on
a repository. You can inspect its activity, pause for approval and resume from
saved state.

The beta includes local execution, persisted events, source snapshots, a CLI
service and an optional Desktop view. The AWS Lambda MicroVM adapter supports
read-only execution. The sections below describe the contracts and their limits.

Mezair Cloud Agents will let you run this work on machines we host. It hasn't
launched, and no price or release date has been set. Existing integrations use
your own machines or provider accounts; those providers bill you directly.

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

Mezair Local now reports sandbox-required agents against the same provider
contract used by AWS. It can choose between:

- `local-docker`: a Docker-backed session with a per-session workspace mount.
- `local-process`: a development fallback that records lifecycle and policy
  state without Docker. It is not an OS isolation boundary for untrusted code.

The default backend is `auto`: use Docker when the Docker CLI can reach a
daemon, otherwise fall back to `local-process`. Override it with:

```sh
MEZAIR_LOCAL_SANDBOX_BACKEND=process mezair-cloud agents sandboxes --json
mezair-cloud agents sandboxes --sandbox-backend docker --json
```

Local sessions are persisted under `.mezair/local/sandboxes`. `mezair-cloud
inspect --local --json` includes the backend id, lifecycle status, workspace
root, capability policy, network policy, and brokered credential policy names.
It does not include credential values.

## AWS implementation

For AWS deployments, Mezair keeps normal Cell traffic on Lambda and can use
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

`@mezair-cloud/aws` exports `AwsLambdaMicroVmSandboxProvider`. It uses the
generated AWS SDK client for Lambda MicroVMs to run, inspect, suspend, resume,
terminate, and create auth tokens for MicroVM sessions. Set
`MEZAIR_AWS_AGENT_SANDBOX_IMAGE` or pass `imageIdentifier` in provider options.
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

The important part is the boundary: Mezair owns the contract, policy, approval
checks, and inspection; the adapter owns provider resources.

## Execution control plane

`@mezair-cloud/runtime` also defines the `AgentExecutionProvider` contract and
stable source, policy, event, result, artifact, usage, and cleanup shapes.
`@mezair-cloud/control-plane` turns those provider operations into idempotent
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

Check the execution lifecycle locally without a cloud account:

```bash
mezair cloud executions conformance --json
```

It starts a fake writable execution, pauses for approval, resumes from the same
cursor, returns a patch, and verifies that the sandbox was terminated. It uses
a local test provider and does not create cloud resources.

AWS implements the same interface in read-only mode. A compatible Lambda
MicroVM image receives source preparation, run, cursor event, approval, input,
steering, and result requests under `/_mezair/execution/*`. Every request uses a
short-lived MicroVM auth token. The token is not stored in the execution lease
or event log.

Run the durable beta service and lifecycle clients with:

```bash
export MEZAIR_EXECUTION_CONTROL_TOKEN="$(openssl rand -base64 32)"
mezair cloud executions serve --provider fake --json
mezair cloud executions list --json
mezair cloud executions show <execution-id> --json
mezair cloud executions events <execution-id> --json
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
public Background Agents API still uses API keys. Mezair therefore requires each
worker image to advertise `codex` and/or `cursor` subscription support instead
of claiming they are interchangeable.

The AWS adapter advertises no subscription providers by default. Operators set
`MEZAIR_AWS_AGENT_SUBSCRIPTION_PROVIDERS=codex,cursor` only for login flows the
deployed image actually implements.

## Desktop remote executions

The optional Cloud Workbench in Mezair Desktop can save and test a control-plane
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

Lambda is still the right request runtime. The sandbox is the execution workspace. Use the
right room, or enjoy debugging furniture.

## Policy model

Sandboxes make sandboxing real, but sandboxing is not the whole policy model.

Before a tool executes, Mezair should check:

1. the agent declared the required capability
2. the action is not approval-gated, or approval was granted
3. the sandbox network policy allows the destination
4. secret access is brokered and scoped
5. filesystem writes stay inside the workspace boundary
6. deployment and git actions go through Mezair-controlled brokers

The MicroVM contains the work. Mezair decides what work is allowed.

## Inspection model

The CLI exposes sandbox readiness and execution conformance today:

```bash
mezair cloud agents sandboxes --json
mezair cloud executions conformance --json
```

Mezair Lens and remote inspect should eventually expose:

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

## Availability and limits

- Local execution supports isolated workspaces, file changes, events, approvals
  and saved execution state.
- The CLI service and optional Desktop view connect to an execution control plane
  you run. They require authentication and workspace authorization.
- AWS Lambda MicroVM execution is read-only and requires a compatible worker
  image in your own AWS account. It does not apply working-tree patches.
- Codex or Cursor subscription sign-in requires a worker that explicitly
  supports that provider's login flow.
- The beta service stores state locally. It does not provide shared hosted
  persistence, hosted memory or a hosted credential broker.
- Mezair Cloud Agents hosted compute is not available. No price or release date
  has been set.
