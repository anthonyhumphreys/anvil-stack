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

The first implementation slice exists: Anvil has a provider-neutral sandbox
contract, an AWS Lambda MicroVM sandbox provider, AWS compatibility checks,
preview-plan entries, and CLI readiness output. The full hosted experience still
needs live network-bound credential injection, streamed tools, workspace
snapshots, Lens views, and remote inspect. Technically functional, not yet
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

The CLI exposes sandbox readiness today:

```bash
anvil cloud agents sandboxes --json
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
- brokered credential declarations in agent manifests and sandbox startup
  payloads
- local Docker and process sandbox providers in `@anvil-cloud/local`
- local sandbox backend selection and inspect JSON session reporting
- `AwsLambdaMicroVmSandboxProvider` in `@anvil-cloud/aws`
- `ANVIL_AWS_AGENT_SANDBOX_IMAGE`-gated AWS support for sandbox-required agents
- AWS preview plan changes, review gates, and cost drivers for `agent-sandboxes`
- `anvil cloud agents sandboxes --json`

Not implemented yet:

- live network-bound credential injection around sandbox tools
- session streaming transport
- workspace snapshot storage
- production approval UI
- sandbox-aware Lens views
- remote sandbox inspect/logs
- persistent hosted memory
- durable multi-step orchestration

Treat this as a real first slice, not the finished hosted experience.
