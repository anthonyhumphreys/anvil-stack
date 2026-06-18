import { app, defineAgent, endpoint } from "@anvil-cloud/runtime";

const supportAssistant = defineAgent({
  name: "support-assistant",
  description: "Support assistant configured for provider mode.",
  instructions: "./agents/support-assistant/instructions.md",
  model: {
    provider: "aws-bedrock",
    model: "anthropic.claude-3-5-sonnet-20241022-v2:0",
    region: process.env.ANVIL_AGENT_REGION ?? "eu-west-2",
  },
  capabilities: {
    cells: ["read"],
    database: ["supportTickets.read", "supportTickets.update"],
    network: { allow: ["api.statuspage.io"] },
    filesystem: "none",
    secrets: "brokered",
  },
  approvals: {
    requiredFor: ["email.sendExternal"],
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

export default app({
  agents: {
    support: supportAssistant,
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
