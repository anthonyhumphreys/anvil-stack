import { describe, expect, it } from "vitest";

import { runPreviewAdapterConformance } from "@anvil-cloud/deployment";
import {
  CloudflarePreviewDeploymentAdapter,
  checkCloudflarePreviewSupport,
  createCloudflarePreviewDeploymentPlan,
} from "../src/index.js";

const manifest = {
  schemaVersion: "0.1",
  cell: { name: "notes", runtime: "nodejs20", target: "preview" },
  entrypoints: {
    server: "dist/server/index.mjs",
    client: "dist/client/index.html",
  },
  schema: { tables: { notes: { fields: {} } } },
  queries: ["listNotes"],
  mutations: ["createNote"],
  endpoints: [],
  jobs: [],
  workflows: [],
  services: [],
  capabilities: {
    database: true,
    files: { publicRead: false },
    secrets: ["API_TOKEN"],
  },
  agents: {},
} as const;

describe("Cloudflare preview planning", () => {
  it("maps portable Cell capabilities without making provider calls", () => {
    const plan = createCloudflarePreviewDeploymentPlan(manifest);

    expect(plan).toMatchObject({
      schemaVersion: "0.1",
      adapter: "cloudflare",
      environment: "preview",
      cell: "notes",
      review: {
        stableId: "cloudflare-preview:permanent:notes:preview:deploy",
      },
    });
    expect(plan.changes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          concept: "runtime",
          details: { service: "workers", compatibility: "workerd" },
        }),
        expect.objectContaining({
          concept: "database",
          details: { service: "d1", tables: ["notes"] },
        }),
        expect.objectContaining({
          concept: "files",
          details: { service: "r2", publicRead: false },
        }),
      ]),
    );
    expect(plan.review.approvalGates).toContainEqual(
      expect.objectContaining({
        id: "cloudflare-plan-only-gate",
        severity: "block",
      }),
    );
  });

  it("passes shared adapter plan conformance", () => {
    expect(
      runPreviewAdapterConformance({
        adapter: new CloudflarePreviewDeploymentAdapter(),
        manifest,
      }),
    ).toEqual({
      ok: true,
      adapter: "cloudflare",
      environment: "preview",
      diagnostics: [],
    });
  });

  it("reports unsupported runtime capabilities explicitly", () => {
    const diagnostics = checkCloudflarePreviewSupport({
      ...manifest,
      jobs: [{ name: "refresh", schedule: "rate(1 hour)" }],
      workflows: [{ name: "sync", steps: ["fetch"] }],
      services: [{ name: "worker", restart: "on-failure", maxRestarts: 3 }],
    });

    expect(diagnostics.map((item) => item.feature)).toEqual([
      "database",
      "files",
      "secrets",
      "services",
      "workflows",
      "jobs",
    ]);
  });

  it("models temporary-account limits without exposing credentials", () => {
    const plan = createCloudflarePreviewDeploymentPlan(manifest, "preview", {
      authentication: "temporary",
    });

    expect(plan.changes).toContainEqual(
      expect.objectContaining({
        concept: "environment",
        details: expect.objectContaining({
          authentication: "temporary",
          wranglerMinimumVersion: "4.102.0",
          claimWithinMinutes: 60,
        }),
      }),
    );
    expect(plan.warnings).toContain(
      "Cloudflare Temporary Accounts do not currently list R2 as a supported resource, and the Anvil files host is not implemented.",
    );
    expect(plan.warnings).toContain(
      "Cloudflare Temporary Accounts do not document secret-binding operations as supported, and Anvil secret provisioning is not implemented.",
    );
    expect(JSON.stringify(plan)).not.toContain("apiToken");
    expect(JSON.stringify(plan)).not.toContain("claim.url");
  });
});
