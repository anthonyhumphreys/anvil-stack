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
anvil-cloud agents discover --json
anvil-cloud agents guardian --json
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

`anvil-cloud agents discover --json` reports project-level agent instruction
files under `agents/**/instructions.md` and mounted Cell agents from the built
manifest. `anvil-cloud agents guardian --json` is a deterministic project
reviewer: it runs the same review aggregation used by `anvil-cloud review` and
returns findings for Guard failures, approval gates, rollback posture, and
cleanup evidence. It does not pretend to be a hosted model; it is a stable
inspection surface for humans and other agents.

## Cell Agents

Cell Agents are mounted inside Cells and can power endpoints, jobs, workflows,
mutations, channel bindings, or internal runtime behaviour.

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

Validation fails when an endpoint, workflow, or channel references a missing
mounted agent. Subagents are shallow and explicit during alpha: a parent can
declare subagents, but subagents cannot declare their own nested subagents.
Guard validation fails if a subagent declares capabilities outside the parent
capability set. Channel adapters are platform-side; Cell agent code receives
normalized channel context and remains channel-agnostic. Local development can
simulate inbound channel messages through `anvil-cloud channels simulate`.

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

## Agent Sandboxes

Some agent work does not fit a request-shaped runtime. Reviewing a manifest is
small. Operating a repository, running tests, installing dependencies, using a
browser, waiting for approval, and resuming with the same workspace state is
session-shaped.

Anvil models that as an Agent Sandbox: an isolated, inspectable,
capability-bound execution workspace owned by an agent session. The runtime
package exposes the provider-neutral sandbox contract; provider packages
implement it.

```txt
Agent Manifest
  ↓
Agent Session
  ↓
Agent Sandbox
  ↓
tool execution, filesystem state, shell commands, browser work, logs, diffs
  ↓
Anvil approval, audit, and inspection surfaces
```

The sandbox is not a Cell authoring primitive. Cell code still declares agents,
capabilities, approvals, and runtime requirements. Deployment adapters decide
how to satisfy those requirements.

An Agent Sandbox carries:

- the agent manifest and mounted Cell context;
- declared capabilities and approval-gated action ids;
- a workspace snapshot or checked-out project state;
- a brokered secret boundary rather than raw secret reads;
- network policy derived from agent capabilities;
- filesystem policy derived from agent capabilities;
- structured tool logs, command output, diffs, and audit events;
- lifecycle metadata for start, suspend, resume, and terminate.

This gives agents a small world that can still do real work. The alternative is
pretending every useful agent action is a stateless function call, which is a
polite way to manufacture sadness.

## AWS Lambda MicroVM Target

For AWS deployments, `@anvil-cloud/aws` includes a Lambda MicroVM-backed sandbox
provider. It uses the AWS Lambda MicroVM SDK to run, inspect, suspend, resume,
terminate, and create auth tokens for MicroVM sessions. The provider requires a
MicroVM image identifier, supplied either through `ANVIL_AWS_AGENT_SANDBOX_IMAGE`
or directly in provider options.

The Anvil mapping should stay provider-neutral:

```txt
runtime.sandbox: "required"
  → AWS compatibility requires an Agent Sandbox image
  → AwsLambdaMicroVmSandboxProvider starts a Lambda MicroVM session

runtime.durability: "required"
  → still unsupported until Anvil has durable orchestration and persisted run state

approvals.requiredFor
  → enforced by Anvil before sharp tools execute inside the sandbox
```

The Lambda-based Cell runtime remains the request/control boundary. The
MicroVM-backed sandbox is the agent workspace. AWS preview deployment plans now
report `agent-sandboxes` changes for mounted agents with `runtime.sandbox:
"required"`, add review/cost entries, and block preview deploys unless the
sandbox image is configured.

```txt
Cell Lambda
  - auth
  - query/mutation/endpoint/job routing
  - capability broker
  - approval gate
  - session registry

Agent Sandbox MicroVM
  - repository workspace
  - shell and tool execution
  - browser/MCP processes
  - generated-code execution
  - streamed output and filesystem diff
```

This split matters. Lambda is a good Cell runtime. A MicroVM is a good
workshop. Asking either one to be both is how abstractions acquire a basement.

## Target Agent Delivery Loop

The current implemented slice gives AWS-backed agents:

- provider-neutral sandbox session types in `@anvil-cloud/runtime`;
- `AwsLambdaMicroVmSandboxProvider` in `@anvil-cloud/aws`;
- AWS compatibility reporting that treats sandbox-required agents as supported
  when a sandbox image is configured;
- AWS preview plan changes, review gates, and cost drivers for sandbox-required
  mounted agents;
- `anvil-cloud agents sandboxes --json` for CLI/agent inspection.

The fuller delivery loop still needs to:

1. start from a provider-neutral agent manifest;
2. launch or resume a sandbox with a workspace snapshot;
3. inspect the Cell manifest and declared capabilities;
4. run tests, typechecks, browser checks, package analysis, or build commands;
5. stream evidence into Anvil Lens and CLI JSON output;
6. request approval before protected actions such as external email, branch
   pushes, preview deploys, or production changes;
7. call brokered Anvil control-plane actions after approval;
8. suspend when waiting on a human;
9. resume with the same workspace state;
10. terminate with logs, diffs, artifacts, cost metadata, and audit history.

That is the product-shaped version of "agent sandboxing": not merely safer code
execution, but inspectable agent workspaces with policy in front and receipts
behind.

## Runtime Invocation MVP

The first runtime invocation path resolves instructions, builds a system message, appends user input, resolves the configured provider, invokes it, and returns a provider-neutral response.

```ts
const result = await runtime.invoke(agent, {
  input: "Review the support-desk Cell manifest.",
  context: { cell: "support-desk" },
});
```

Full multi-step orchestration, production approval UI, durable agent workflows, hosted memory, and production sandboxing are future adapter work.
