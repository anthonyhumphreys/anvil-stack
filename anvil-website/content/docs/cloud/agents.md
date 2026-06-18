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
import { app, defineAgent, endpoint } from "@anvil-cloud/runtime";

const support = defineAgent({
  name: "support",
  instructions: "./agents/support/instructions.md",
  model: { provider: "local", model: "stub" },
  capabilities: {
    cells: ["read"],
    filesystem: "none",
    secrets: "none",
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
});
```

Builder validation catches endpoint or workflow references to missing mounted agents. The generated Cell manifest includes the mounted agent manifests under `agents`.

## Project Agents, Cell Agents, and Agent Cells

| Shape | Use it for |
| --- | --- |
| Project Agent | Workspace operations: review a Cell manifest, inspect capability changes, draft release notes, prepare preview deployment, explain blast radius, or check policy. |
| Cell Agent | Runtime behavior inside a Cell: endpoint, job, workflow, mutation, or internal app behavior. |
| Agent Cell | A Cell whose primary product surface is an agent-powered experience. The Cell remains the boundary for auth, capabilities, approvals, validation, local runtime, and deployment adapters. |

Project-agent discovery from `agents/*/agent.ts` is still early. Mounted Cell Agents are wired through the current Cell build and local runtime path.

## Contract mode

Contract mode validates and compiles without calling a model provider or executing tools:

```bash
anvil agents validate
anvil agents manifest --json
```

This checks mounted agents, model config, instructions files, capabilities, approval rules, endpoint/workflow references, and generated provider-neutral manifests.

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
anvil agents invoke support --input "Review this Cell" --json
```

Anvil Local also exposes:

```txt
GET  /_anvil/agents
POST /_anvil/agents/:name
```

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

- Project-agent discovery is not yet a full standalone build path.
- There is no hosted production agent orchestration.
- There is no chat UI.
- There is no production approval UI.
- There is no durable multi-step tool-calling loop.
- Memory and sandbox requirements are manifest-level contract fields, not complete hosted implementations.
- AWS support currently covers Bedrock inference and compatibility reporting, not full agent infrastructure generation.

Read this as a contract foundation: enough to define, validate, inspect, mount, manifest, and run agents locally through the Anvil runtime model.
