# Anvil Agents

Anvil Agents are portable, inspectable, capability-bound runtime units.

They can operate an Anvil workspace, power a Cell workflow, or become the primary interface of an Agent Cell.

Every agent compiles to a provider-neutral manifest before it is run or deployed. This keeps the agent contract reviewable, cloud-agnostic, locally testable, and adapter-friendly.

## Contract Model

Anvil keeps the agent boundary explicit:

```txt
Agent Definition
  ↓
Provider-neutral Agent Manifest
  ↓
Anvil Runtime Interfaces
  ↓
Inference Provider
  ↓
Adapter-specific Runtime Implementation
```

The core runtime understands model provider ids, messages, tool calls, tool results, structured output, token usage, approval gates, capability checks, execution metadata, local runtime mode, provider registries, and manifest validation.

Provider SDKs, credentials, deployment resources, infrastructure templates, and provider response shapes stay outside the core agent contract.

## Definition API

Agents are TypeScript definitions:

```ts
import { defineAgent } from "@anvil-cloud/runtime";

export default defineAgent({
  name: "support-assistant",
  description: "A support assistant for triaging and responding to tickets.",
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

Omitted capabilities are unavailable. `filesystem` defaults to `none`, `secrets` defaults to `none`, and `network` defaults to `restricted`.

## Local Runtime Model

Local development uses the Anvil runtime contract. It does not emulate cloud infrastructure.

Local runtime work still discovers Cells, validates mounted agents, resolves instructions files, compiles manifests, checks mounted references, enforces capabilities, enforces approval gates, and resolves inference providers through a registry.

## Contract Mode

Contract mode validates and compiles definitions without calling a model provider or executing tools.

```sh
anvil-cloud agents validate
anvil-cloud agents manifest --json
```

This mode reports project and Cell agent manifests, capability declarations, model configuration, approval-gated actions, and adapter compatibility warnings where available.

## Stub Mode

Stub mode runs agents with the deterministic local provider:

```ts
model: {
  provider: "local",
  model: "stub",
}
```

The local stub provider implements the generic inference interface, returns deterministic responses, and never calls an external API.

## Provider Mode

Provider mode runs Anvil Local while calling a registered real provider:

```ts
model: {
  provider: "aws-bedrock",
  model: "anthropic.claude-3-5-sonnet-20241022-v2:0",
  region: "eu-west-2",
}
```

Contracts, approvals, and capability checks are still enforced locally. The provider-neutral request is passed to the registered provider, and the provider maps the response back to the Anvil response shape.

## Project Agents

Project Agents help inspect, review, govern, deploy, or operate an Anvil workspace. They are not user-facing by default.

Typical uses include Cell manifest review, capability change inspection, release note drafting, preview deployment preparation, blast-radius explanation, policy checks, test planning, and migration proposals.

## Cell Agents

Cell Agents are mounted inside Cells and can power endpoints, jobs, workflows, mutations, or internal runtime behaviour.

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

Validation fails when an endpoint or workflow references a missing mounted agent.

## Agent Cells

An Agent Cell is a Cell whose primary product surface is an agent-powered experience. The Cell remains the application boundary. The mounted agent is governed by the same capabilities, approvals, validation, local runtime, and manifest model as any other Cell Agent.

## Capabilities And Approvals

Capabilities are explicit and least-privilege by default:

```ts
capabilities: {
  cells: ["read"],
  database: ["supportTickets.read"],
  network: "restricted",
  filesystem: "none",
  secrets: "none",
}
```

Approval gates are declared by action id:

```ts
approvals: {
  requiredFor: ["email.sendExternal", "deploy.production"],
}
```

Before tool execution, Anvil checks required capabilities and approval status. If approval is required and not granted, runtime execution returns an approval-required result instead of running the tool.

## Inference Providers

Providers implement a generic interface:

```ts
type AgentInferenceProvider = {
  id: string;
  invoke(request: AgentInferenceRequest): Promise<AgentInferenceResponse>;
};
```

Runtime code resolves providers by id through `AgentProviderRegistry`. Agent contracts do not change when providers are registered.

## AWS Bedrock Provider

`@anvil-cloud/aws` includes the first AWS inference provider. It maps Anvil messages to Bedrock Runtime requests and maps responses back to Anvil messages and token usage. AWS SDK imports remain in the AWS package.

## Runtime Invocation MVP

The first runtime invocation path resolves instructions, builds a system message, appends user input, resolves the configured provider, invokes it, and returns a provider-neutral response.

```ts
const result = await runtime.invoke(agent, {
  input: "Review the support-desk Cell manifest.",
  context: { cell: "support-desk" },
});
```

Full multi-step orchestration, production approval UI, durable agent workflows, hosted memory, and production sandboxing are future adapter work.
