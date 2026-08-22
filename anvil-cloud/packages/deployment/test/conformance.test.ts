import { describe, expect, it } from "vitest";

import type { CellManifest } from "@anvil-cloud/builder";
import {
  runPreviewAdapterConformance,
  type DeploymentPlan,
  type DeploymentPlanAdapter,
} from "../src/index.js";

const manifest = {
  schemaVersion: "0.1",
  cell: { name: "notes", runtime: "nodejs20", target: "preview" },
  entrypoints: { server: "server.mjs", client: "index.html" },
  schema: { tables: {} },
  queries: [],
  mutations: [],
  endpoints: [],
  jobs: [],
  workflows: [],
  services: [],
  capabilities: {},
  agents: {},
} as const satisfies CellManifest;

describe("runPreviewAdapterConformance", () => {
  it("accepts a stable provider-neutral deployment plan", () => {
    const adapter: DeploymentPlanAdapter = {
      name: "test",
      plan: () => conformantPlan(),
    };

    expect(runPreviewAdapterConformance({ adapter, manifest })).toEqual({
      ok: true,
      adapter: "test",
      environment: "preview",
      diagnostics: [],
    });
  });

  it("reports mismatched adapter names and unstable ids", () => {
    const adapter: DeploymentPlanAdapter = {
      name: "expected",
      plan: () => ({
        ...conformantPlan(),
        adapter: "wrong",
        review: {
          ...conformantPlan().review,
          changeSet: [
            { id: "z", action: "create", concept: "runtime", name: "z" },
            { id: "a", action: "create", concept: "runtime", name: "a" },
          ],
        },
      }),
    };

    const result = runPreviewAdapterConformance({ adapter, manifest });

    expect(result.ok).toBe(false);
    expect(result.diagnostics.map((item) => item.code)).toEqual([
      "ADAPTER_PLAN_NAME_MISMATCH",
      "ADAPTER_REVIEW_IDS_NOT_SORTED",
    ]);
  });
});

function conformantPlan(): DeploymentPlan {
  const operations = {
    rollback: {
      supported: false,
      strategy: "manual" as const,
      commands: ["deploy again"],
      notes: ["Manual in tests."],
    },
    cost: {
      billingMode: "usage-based-preview" as const,
      drivers: ["Test runtime"],
      notes: ["No provider calls."],
    },
    cleanup: {
      commands: ["remove test"],
      notes: ["No resources created."],
    },
  };

  return {
    schemaVersion: "0.1",
    adapter: "test",
    environment: "preview",
    cell: "notes",
    changes: [{ kind: "create", concept: "runtime", name: "notes" }],
    review: {
      stableId: "test:notes:preview:deploy",
      operation: "deploy",
      summary: { creates: 1, updates: 0, reuses: 0, total: 1 },
      changeSummary: [
        {
          concept: "runtime",
          creates: 1,
          updates: 0,
          reuses: 0,
          total: 1,
          changeIds: ["create:runtime:notes"],
        },
      ],
      changeSet: [
        {
          id: "create:runtime:notes",
          action: "create",
          concept: "runtime",
          name: "notes",
        },
      ],
      capabilityDiffs: [
        {
          id: "runtime:notes",
          action: "add",
          capability: "runtime",
          name: "notes",
        },
      ],
      cost: {
        drivers: [
          { id: "runtime", label: "Test runtime", reason: "Conformance." },
        ],
        notes: operations.cost.notes,
      },
      rollback: operations.rollback,
      cleanup: operations.cleanup,
      approvalSummary: {
        required: 0,
        info: 1,
        review: 0,
        block: 0,
        hasBlockingGate: false,
      },
      approvalGates: [
        {
          id: "standard-review",
          required: false,
          severity: "info",
          reason: "Conformance test.",
          changeIds: ["create:runtime:notes"],
        },
      ],
    },
    warnings: [],
    operations,
  };
}
