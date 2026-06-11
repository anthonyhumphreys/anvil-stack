import type { AppDefinition, AppInspection } from "@anvil-cloud/runtime";
import { inspectAppDefinition } from "@anvil-cloud/runtime";

import type { CellConfig } from "./config.js";

export type CellManifest = {
  schemaVersion: "0.1";
  cell: {
    name: string;
    runtime: string;
    target: string;
  };
  entrypoints: {
    server: string;
    client: string;
  };
  schema: {
    tables: Record<
      string,
      {
        fields: AppInspection["schema"]["tables"][number]["fields"];
      }
    >;
  };
  queries: string[];
  mutations: string[];
  endpoints: AppInspection["endpoints"];
  jobs: AppInspection["jobs"];
  capabilities: Record<string, unknown>;
};

export function createCellManifest(
  app: AppDefinition,
  config: CellConfig,
  target = "local",
): CellManifest {
  const inspection = inspectAppDefinition(app);

  return {
    schemaVersion: "0.1",
    cell: {
      name: config.name,
      runtime: config.runtime,
      target,
    },
    entrypoints: {
      server: "dist/server/index.mjs",
      client: "dist/client/index.html",
    },
    schema: {
      tables: Object.fromEntries(
        inspection.schema.tables.map((table) => [
          table.name,
          {
            fields: table.fields,
          },
        ]),
      ),
    },
    queries: inspection.queries,
    mutations: inspection.mutations,
    endpoints: inspection.endpoints,
    jobs: inspection.jobs,
    capabilities: inspection.capabilities,
  };
}

export function isAppDefinition(value: unknown): value is AppDefinition {
  return (
    typeof value === "object" &&
    value !== null &&
    "queries" in value &&
    "mutations" in value &&
    "endpoints" in value &&
    "jobs" in value
  );
}
