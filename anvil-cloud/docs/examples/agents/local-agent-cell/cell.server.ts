import { app, channel, defineAgent, endpoint } from "@anvil-cloud/runtime";

const supportAssistant = defineAgent({
  name: "support-assistant",
  description: "Triage assistant for local support workflows.",
  instructions: "./agents/support-assistant/instructions.md",
  model: {
    provider: "local",
    model: "stub",
  },
  capabilities: {
    cells: ["read"],
    database: ["supportTickets.read"],
    network: "restricted",
    filesystem: "none",
    secrets: "none",
  },
  approvals: {
    requiredFor: ["email.sendExternal"],
  },
  runtime: {
    sandbox: "required",
    humanApproval: "required",
  },
  subagents: {
    triage: defineAgent({
      name: "support-triage",
      purpose: "Classify incoming support requests before the parent responds.",
      model: {
        provider: "local",
        model: "stub",
      },
      capabilities: {
        cells: ["read"],
        database: ["supportTickets.read"],
        network: "restricted",
        filesystem: "none",
        secrets: "none",
      },
    }),
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
  channels: {
    supportSlack: channel({
      provider: "slack",
      agent: "support",
      sessionKey: "sender-thread",
      events: ["app_mention", "message"],
    }),
  },
});
