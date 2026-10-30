import { defineAgent } from "@mezair-cloud/runtime";

export default defineAgent({
  name: "cell-reviewer",
  description: "Reviews Mezair Cell manifests and capability changes.",
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
