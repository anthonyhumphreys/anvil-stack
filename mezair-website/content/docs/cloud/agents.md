---
title: Mezair Agents
navTitle: Agents
description: Define an agent's tools and permissions, add it to a Cell, inspect its manifest and run it locally.
product: Mezair Cloud
section: Concepts
journey: build
order: 120
---

# Mezair Agents

A Mezair Agent declares its tools and permissions before it runs.

Agents can work in a Mezair workspace, run a Cell workflow or provide a Cell's main interface. Each agent compiles to a manifest you can review and test locally. Adapters translate that manifest for a provider, so Cell code doesn't need provider-specific APIs.

You can use the open-source runtime and CLI today with your own provider accounts. Providers bill you directly. Mezair Cloud Agents, which will run agents on machines we host, hasn't launched and has no price or release date yet.

[Agent Sandboxes](/docs/cloud/agent-sandboxes) support longer tasks that need
an isolated repository, approval pauses and saved state. The first AWS Lambda
MicroVM adapter supports read-only execution. Start here to define the agent
that runs inside one.

## Contract boundary

```txt
Agent Definition
  -> Provider-neutral Agent Manifest
  -> Mezair Runtime Interfaces
  -> Inference Provider
  -> Adapter-specific Runtime Implementation
```

Core Mezair Agent concepts are provider-neutral:

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
import { defineAgent } from "@mezair-cloud/runtime";

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
    network: { allow: ["github.com", "api.statuspage.io"] },
    filesystem: "none",
    secrets: "brokered",
    git: ["clone"],
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

## Broker credentials to sandboxes

Brokered credentials let an agent reach a private external resource without
placing the raw secret in sandbox environment variables.

The Cell declares the secret name:

```ts
capabilities: {
  secrets: ["GITHUB_TOKEN"],
}
```

The mounted agent declares the broker policy:

```ts
capabilities: {
  network: { allow: ["github.com"] },
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
runtime: {
  sandbox: "required",
}
```

The generated manifest records credential names, allowed domains, and
header/query injection targets. It does not contain secret values. Validation
fails if the Cell does not declare the credential, if the agent does not use
`secrets: "brokered"`, if the agent is not sandbox-required, or if the target
domain is outside `capabilities.network.allow`.

## Mount an agent in a Cell

Cell Agents are mounted inside the Cell definition:

```ts
import { app, channel, defineAgent, endpoint } from "@mezair-cloud/runtime";

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
import { defineAgent, defineAgentEvalSuite } from "@mezair-cloud/runtime";

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
mezair-cloud eval --json
mezair-cloud eval --write-baseline --json
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
mezair cloud agents validate
mezair cloud agents manifest --json
mezair cloud agents discover --json
mezair cloud agents guardian --json
mezair cloud agents sandboxes --json
```

This checks mounted agents, model config, instructions files, capabilities,
approval rules, endpoint/workflow references, generated provider-neutral
manifests, project instruction files, and deterministic Guardian review
findings. Guardian uses the same trust report as `mezair-cloud review`; it does
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
mezair cloud agents invoke support --input "Review this Cell" --json
```

Mezair Local also exposes:

```txt
GET  /_mezair/agents
POST /_mezair/agents/:name
GET  /_mezair/approvals
GET  /_mezair/approvals/audit
POST /_mezair/approvals/:id/approve
POST /_mezair/approvals/:id/reject
POST /_mezair/agents/:name/sessions
POST /_mezair/agents/sessions/:sessionId/messages
GET  /_mezair/agents/sessions/:sessionId/stream?after=:token
POST /_mezair/channels/simulate
```

Approval-gated tool actions persist pending decisions to
`.mezair/local/approvals.json`. Inspect and decide them from the CLI:

```bash
mezair-cloud approvals list --status pending --json
mezair-cloud approvals approve <approvalId> --by reviewer --reason "Checked"
mezair-cloud approvals reject <approvalId> --by reviewer --reason "Not safe"
mezair-cloud approvals audit --json
```

Lens shows the same pending queue and audit history in its Approvals tab. Local
runtimes can also set `MEZAIR_APPROVAL_WEBHOOK_URL` to receive
`approval.requested` webhook events; webhook delivery failures are recorded in
the approval audit log and do not execute the gated action.

`POST /_mezair/agents/:name` accepts `{ "input": "..." }` and returns the
provider-neutral `AgentRuntime` result. Session routes persist local agent event
history in `.mezair/local/agent-sessions.json`. Message sends return ordered
events and a continuation token; the stream route replays events after that
token as `text/event-stream`.

Channel simulation lets local dev and tests exercise Slack/GitHub/Discord-style
inbound messages without real workspace credentials:

```bash
mezair cloud channels simulate \
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

Provider mode still runs through Mezair Local, but resolves a real inference provider from the registry:

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
} from "@mezair-cloud/runtime";
import { BedrockInferenceProvider } from "@mezair-cloud/aws";

const registry = new AgentProviderRegistry();

registry.register(new LocalStubInferenceProvider({ echoInput: true }));
registry.register(new BedrockInferenceProvider({ region: "eu-west-2" }));

const runtime = new AgentRuntime({ providers: registry });
```

## AWS Bedrock provider

`@mezair-cloud/aws` includes the first AWS inference provider. It implements the generic Mezair inference provider interface, uses the standard AWS credential chain, maps Mezair messages to Bedrock Runtime requests, maps responses back to Mezair messages and token usage, and keeps raw provider responses out of provider-neutral manifests.

AWS compatibility reporting can say that `aws-bedrock` inference is supported while still warning about unimplemented adapter requirements such as durable agent execution, hosted memory, production approval UI, or sandbox execution.

## Sandbox target

`runtime.sandbox: "required"` is a real manifest requirement, not decoration.
AWS compatibility treats it as supported when a Lambda MicroVM sandbox image is
configured through `MEZAIR_AWS_AGENT_SANDBOX_IMAGE`.

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

Before execution, Mezair checks:

1. the agent declares each required capability
2. the action is not approval-gated, or approval has been granted

If approval is required and not granted, the runtime returns an approval-required result instead of executing the tool. Decorative security is still decorative. This is the actual gate.

## Manifest shape

Agent manifests are provider-neutral:

```json
{
  "kind": "mezair.agent",
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

Read this as a contract foundation: enough to define, validate, inspect, mount, manifest, and run agents locally through the Mezair runtime model.
