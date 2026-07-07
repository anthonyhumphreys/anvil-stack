---
title: Anvil Agents
navTitle: Agents
description: Define contract-first agents, mount them in Cells, compile provider-neutral manifests, and run them locally through Anvil Runtime.
product: Anvil Cloud
section: Runtime
order: 124
---

# Anvil Agents

Anvil Agents are portable, inspectable, capability-bound runtime units.

They can operate an Anvil workspace, power a Cell workflow, or become the primary interface of an Agent Cell. Every agent compiles to a provider-neutral manifest before it is run or deployed, so the contract can be reviewed, tested locally, and handed to runtime adapters without leaking provider infrastructure into Cell code.

This is an MVP foundation, not a hosted agent platform. Useful. Refreshingly unglamorous. Keep the contract small enough to inspect.

The bigger runtime direction is [Agent Sandboxes](/docs/cloud/agent-sandboxes):
isolated, sessionful, inspectable workspaces for agents that need to run tools,
operate a repo, wait for approval, and resume with state. The first AWS Lambda
MicroVM-backed provider is implemented behind the adapter boundary; the manifest
contract starts here.

## Contract boundary

```txt
Agent Definition
  -> Provider-neutral Agent Manifest
  -> Anvil Runtime Interfaces
  -> Inference Provider
  -> Adapter-specific Runtime Implementation
```

Core Anvil Agent concepts are provider-neutral:

- model provider id and model id
- messages, content parts, tool calls, and tool results
- structured output shape
- token usage
- approval gates
- capability checks
- execution metadata
- provider registry
- manifest validation

Provider SDKs, credentials, deployment resources, infrastructure templates, and provider response shapes stay outside the core manifest.

## Define an agent

Agents are normal TypeScript definitions:

```ts
import { defineAgent } from "@anvil-cloud/runtime";

export default defineAgent({
  name: "support-assistant",
  description: "A support assistant for triaging tickets.",
  instructions: "./instructions.md",
  model: {
    provider: "local",
    model: "stub",
  },
  capabilities: {
    cells: ["read"],
    database: ["supportTickets.read", "supportTickets.update"],
    network: { allow: ["api.statuspage.io"] },
    filesystem: "none",
    secrets: "brokered",
  },
  approvals: {
    requiredFor: ["supportTickets.bulkUpdate", "email.sendExternal"],
  },
  runtime: {
    durability: "optional",
    sandbox: "required",
    humanApproval: "required",
  },
  metadata: {
    owner: "support",
    risk: "medium",
  },
});
```

Least privilege is the default:

- omitted capabilities are unavailable
- `filesystem` defaults to `none`
- `secrets` defaults to `none`
- `network` defaults to `restricted`

## Mount an agent in a Cell

Cell Agents are mounted inside the Cell definition:

```ts
import { app, channel, defineAgent, endpoint } from "@anvil-cloud/runtime";

const support = defineAgent({
  name: "support",
  instructions: "./agents/support/instructions.md",
  model: { provider: "local", model: "stub" },
  capabilities: {
    cells: ["read"],
    database: ["supportTickets.read"],
    filesystem: "none",
    secrets: "none",
  },
  subagents: {
    triage: defineAgent({
      name: "support-triage",
      purpose: "Classify incoming support requests.",
      model: { provider: "local", model: "stub" },
      capabilities: {
        cells: ["read"],
        database: ["supportTickets.read"],
        filesystem: "none",
        secrets: "none",
      },
    }),
  },
});

export default app({
  agents: {
    support,
  },
  endpoints: {
    chat: endpoint({
      method: "POST",
      path: "/api/chat",
      auth: "required",
      agent: "support",
      handler: async () => ({ ok: true }),
    }),
  },
  channels: {
    supportSlack: channel({
      provider: "slack",
      agent: "support",
      sessionKey: "sender-thread",
      events: ["app_mention", "message"],
    }),
  },
});
```

Builder validation catches endpoint, workflow, or channel references to missing
mounted agents. The generated Cell manifest includes mounted agent manifests
under `agents`, each agent manifest includes its explicit `subagents` tree, and
channel bindings under `channels`.

Subagents are shallow during alpha. A parent can declare subagents, but a
subagent cannot declare its own nested subagents. Guard validation fails if a
subagent declares capabilities outside the parent's capability set.

## Add evals

Evals are colocated with the agent definition:

```ts
import { defineAgent, defineAgentEvalSuite } from "@anvil-cloud/runtime";

const support = defineAgent({
  name: "support",
  model: { provider: "local", model: "stub" },
  evals: defineAgentEvalSuite({
    scenarios: [
      {
        name: "answers support review",
        input: "Review this Cell.",
        expect: {
          responseIncludes: "Review this Cell.",
          toolCalls: { count: 0 },
          capabilities: {
            notUsed: ["network.api.statuspage.io"],
          },
        },
      },
    ],
  }),
});
```

Run them locally or in CI:

```sh
anvil-cloud eval --json
anvil-cloud eval --write-baseline --json
```

The JSON output includes scenario pass/fail, assertion results, tool calls,
approval requests, capability usage, and baseline diffs. Failed assertions or
baseline drift exit non-zero.

## Project Agents, Cell Agents, and Agent Cells

| Shape         | Use it for                                                                                                                                                                                |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Project Agent | Workspace operations: review a Cell manifest, inspect capability changes, draft release notes, prepare preview deployment, explain blast radius, or check policy.                         |
| Cell Agent    | Runtime behavior inside a Cell: endpoint, job, workflow, mutation, or internal app behavior.                                                                                              |
| Agent Cell    | A Cell whose primary product surface is an agent-powered experience. The Cell remains the boundary for auth, capabilities, approvals, validation, local runtime, and deployment adapters. |

Project-agent discovery currently reports instruction files under
`agents/**/instructions.md`. Mounted Cell Agents are wired through the current
Cell build and local runtime path.

## Contract mode

Contract mode validates and compiles without calling a model provider or executing tools:

```bash
anvil cloud agents validate
anvil cloud agents manifest --json
anvil cloud agents discover --json
anvil cloud agents guardian --json
anvil cloud agents sandboxes --json
```

This checks mounted agents, model config, instructions files, capabilities,
approval rules, endpoint/workflow references, generated provider-neutral
manifests, project instruction files, and deterministic Guardian review
findings. Guardian uses the same trust report as `anvil-cloud review`; it does
not call a model provider.

## Stub mode

Stub mode uses the deterministic local provider:

```ts
model: {
  provider: "local",
  model: "stub",
}
```

The local stub provider implements the generic inference provider interface, returns deterministic responses, and never calls an external API. Use it for tests and quick local development.

Invoke a mounted agent:

```bash
anvil cloud agents invoke support --input "Review this Cell" --json
```

Anvil Local also exposes:

```txt
GET  /_anvil/agents
POST /_anvil/agents/:name
GET  /_anvil/approvals
GET  /_anvil/approvals/audit
POST /_anvil/approvals/:id/approve
POST /_anvil/approvals/:id/reject
POST /_anvil/agents/:name/sessions
POST /_anvil/agents/sessions/:sessionId/messages
GET  /_anvil/agents/sessions/:sessionId/stream?after=:token
POST /_anvil/channels/simulate
```

Approval-gated tool actions persist pending decisions to
`.anvil/local/approvals.json`. Inspect and decide them from the CLI:

```bash
anvil-cloud approvals list --status pending --json
anvil-cloud approvals approve <approvalId> --by reviewer --reason "Checked"
anvil-cloud approvals reject <approvalId> --by reviewer --reason "Not safe"
anvil-cloud approvals audit --json
```

Lens shows the same pending queue and audit history in its Approvals tab. Local
runtimes can also set `ANVIL_APPROVAL_WEBHOOK_URL` to receive
`approval.requested` webhook events; webhook delivery failures are recorded in
the approval audit log and do not execute the gated action.

`POST /_anvil/agents/:name` accepts `{ "input": "..." }` and returns the
provider-neutral `AgentRuntime` result. Session routes persist local agent event
history in `.anvil/local/agent-sessions.json`. Message sends return ordered
events and a continuation token; the stream route replays events after that
token as `text/event-stream`.

Channel simulation lets local dev and tests exercise Slack/GitHub/Discord-style
inbound messages without real workspace credentials:

```bash
anvil cloud channels simulate \
  --channel supportSlack \
  --sender U123 \
  --thread T456 \
  --input "Can you review this issue?" \
  --json
```

The runtime maps the normalized channel message to the mounted agent session
using the channel's `sessionKey`. Agent code stays channel-agnostic; provider
credentials and webhook verification remain platform-side.

## Provider mode

Provider mode still runs through Anvil Local, but resolves a real inference provider from the registry:

```ts
model: {
  provider: "aws-bedrock",
  model: "anthropic.claude-3-5-sonnet-20241022-v2:0",
  region: "eu-west-2",
}
```

Contracts, approval gates, and capability checks remain local. The provider-neutral request is passed to the registered provider, which maps the request and response at the provider boundary.

## Inference providers

Providers implement:

```ts
type AgentInferenceProvider = {
  id: string;
  invoke(request: AgentInferenceRequest): Promise<AgentInferenceResponse>;
};
```

Runtime code resolves providers by id through `AgentProviderRegistry`.

```ts
import {
  AgentProviderRegistry,
  AgentRuntime,
  LocalStubInferenceProvider,
} from "@anvil-cloud/runtime";
import { BedrockInferenceProvider } from "@anvil-cloud/aws";

const registry = new AgentProviderRegistry();

registry.register(new LocalStubInferenceProvider({ echoInput: true }));
registry.register(new BedrockInferenceProvider({ region: "eu-west-2" }));

const runtime = new AgentRuntime({ providers: registry });
```

## AWS Bedrock provider

`@anvil-cloud/aws` includes the first AWS inference provider. It implements the generic Anvil inference provider interface, uses the standard AWS credential chain, maps Anvil messages to Bedrock Runtime requests, maps responses back to Anvil messages and token usage, and keeps raw provider responses out of provider-neutral manifests.

AWS compatibility reporting can say that `aws-bedrock` inference is supported while still warning about unimplemented adapter requirements such as durable agent execution, hosted memory, production approval UI, or sandbox execution.

## Sandbox target

`runtime.sandbox: "required"` is a real manifest requirement, not decoration.
AWS compatibility treats it as supported when a Lambda MicroVM sandbox image is
configured through `ANVIL_AWS_AGENT_SANDBOX_IMAGE`.

That means normal Cell traffic still runs through the Lambda runtime, while
agent-heavy work can move into an isolated session workspace:

```txt
Cell Lambda
  -> approval and capability broker
  -> Agent Sandbox
  -> shell, browser, repo, tool, and generated-code execution
```

See [Agent Sandboxes](/docs/cloud/agent-sandboxes) for the target architecture.

## Tool and approval boundary

Tool execution is intentionally small in the MVP. Tools declare required capabilities and an optional action id:

```ts
const tool = {
  definition: {
    name: "bulkUpdateTickets",
    action: "supportTickets.bulkUpdate",
    requiredCapabilities: ["database.supportTickets.update"],
  },
  execute: async () => ({ ok: true }),
};
```

Before execution, Anvil checks:

1. the agent declares each required capability
2. the action is not approval-gated, or approval has been granted

If approval is required and not granted, the runtime returns an approval-required result instead of executing the tool. Decorative security is still decorative. This is the actual gate.

## Manifest shape

Agent manifests are provider-neutral:

```json
{
  "kind": "anvil.agent",
  "name": "support-assistant",
  "exposure": "cell",
  "model": {
    "provider": "local",
    "model": "stub"
  },
  "requires": {
    "inference": true,
    "toolCalling": false,
    "memory": false,
    "durableExecution": false,
    "sandbox": true,
    "humanApproval": ["email.sendExternal"]
  },
  "capabilities": {
    "cells": ["read"],
    "database": ["supportTickets.read"],
    "network": "restricted",
    "filesystem": "none",
    "secrets": "none",
    "git": [],
    "deployments": []
  }
}
```

The manifest may name provider ids such as `local` or `aws-bedrock`. It must not contain provider credentials, IAM policy, Lambda definitions, Step Functions definitions, CloudWatch config, DynamoDB config, or deployment resources.

## Current limits

- Project-agent discovery is instruction-file based; standalone project-agent
  TypeScript manifests are future work.
- There is no hosted production agent orchestration.
- There is no chat UI.
- There is no hosted production approval UI. Local approval queues are
  persisted, visible in Lens, operable from the CLI, and auditable.
- There is no durable multi-step tool-calling loop.
- Memory and sandbox requirements are manifest-level contract fields, not complete hosted implementations.
- AWS support currently covers Bedrock inference, compatibility reporting,
  Lambda MicroVM sandbox lifecycle calls, deploy-plan entries, and CLI readiness
  output. Hosted policy brokering, streamed tools, workspace snapshots, and Lens
  views are still future work.

Read this as a contract foundation: enough to define, validate, inspect, mount, manifest, and run agents locally through the Anvil runtime model.
