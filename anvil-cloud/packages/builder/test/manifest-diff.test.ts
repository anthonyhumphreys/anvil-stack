import { describe, expect, it } from "vitest";

import { diffCellManifests, type CellManifest } from "../src/index.js";

describe("diffCellManifests", () => {
  it("reports destructive schema changes as errors", () => {
    const previous = createManifest({
      schema: {
        notes: {
          fields: {
            title: { type: "text", constraints: {} },
            published: { type: "boolean", constraints: {} },
          },
        },
      },
    });
    const next = createManifest({
      schema: {
        notes: {
          fields: {
            title: { type: "boolean", constraints: {} },
          },
        },
      },
    });

    expect(diffCellManifests(previous, next)).toMatchObject({
      changed: true,
      summary: {
        additions: 0,
        removals: 1,
        changes: 1,
        warnings: 0,
        errors: 2,
      },
      changes: [
        {
          id: "schema.tables.notes.fields.published.removed",
          category: "schema",
          action: "remove",
          severity: "error",
        },
        {
          id: "schema.tables.notes.fields.title.changed",
          category: "schema",
          action: "change",
          severity: "error",
        },
      ],
    });
  });

  it("reports capability and route changes with review severity", () => {
    const previous = createManifest({
      capabilities: {
        files: { publicRead: false },
      },
      queries: ["listNotes"],
    });
    const next = createManifest({
      capabilities: {
        database: true,
        files: { publicRead: true },
      },
      queries: ["searchNotes"],
      endpoints: [
        {
          name: "publicFeed",
          method: "GET",
          path: "/api/feed",
          auth: { mode: "public" },
        },
      ],
    });

    expect(diffCellManifests(previous, next)).toMatchObject({
      changed: true,
      summary: {
        additions: 3,
        removals: 1,
        changes: 1,
        warnings: 3,
        errors: 1,
      },
      changes: expect.arrayContaining([
        expect.objectContaining({
          id: "capabilities.files.changed",
          severity: "error",
        }),
        expect.objectContaining({
          id: "capabilities.database.added",
          severity: "warning",
        }),
        expect.objectContaining({
          id: "endpoints.publicFeed.added",
          severity: "warning",
        }),
        expect.objectContaining({
          id: "queries.listNotes.removed",
          severity: "warning",
        }),
      ]),
    });
  });

  it("returns an empty summary for equivalent manifests", () => {
    const manifest = createManifest();

    expect(diffCellManifests(manifest, manifest)).toEqual({
      changed: false,
      changes: [],
      summary: {
        additions: 0,
        removals: 0,
        changes: 0,
        warnings: 0,
        errors: 0,
      },
    });
  });
});

function createManifest(
  overrides: Partial<Omit<CellManifest, "schema">> & {
    schema?: CellManifest["schema"]["tables"];
  } = {},
): CellManifest {
  return {
    schemaVersion: "0.1",
    cell: {
      name: "notes",
      runtime: "nodejs20",
      target: "local",
      ...overrides.cell,
    },
    entrypoints: {
      server: "dist/server/index.mjs",
      client: "dist/client/index.html",
      ...overrides.entrypoints,
    },
    client: overrides.client ?? { kind: "vite-react" },
    schema: { tables: overrides.schema ?? {} },
    queries: overrides.queries ?? [],
    mutations: overrides.mutations ?? [],
    endpoints: overrides.endpoints ?? [],
    jobs: overrides.jobs ?? [],
    workflows: overrides.workflows ?? [],
    services: overrides.services ?? [],
    agents: overrides.agents ?? {},
    capabilities: overrides.capabilities ?? {},
  };
}
