import { defineAgent } from "@anvil-cloud/runtime";

export default defineAgent({
  name: "cell-reviewer",
  description: "Reviews Anvil Cell manifests and capability changes.",
  instructions: "./instructions.md",
  model: {
    provider: "local",
    model: "stub",
  },
  capabilities: {
    cells: ["read"],
    filesystem: "read",
    secrets: "none",
  },
  metadata: {
    owner: "platform",
    risk: "low",
  },
});
