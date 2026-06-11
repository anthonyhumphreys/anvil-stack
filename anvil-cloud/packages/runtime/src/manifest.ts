import type { AppDefinition, FieldDefinition } from "./app.js";

export type EndpointInspection = {
  name: string;
  method: string;
  path: string;
  auth: "none" | "optional" | "required";
};

export type JobInspection = {
  name: string;
  schedule?: string;
};

export type TableInspection = {
  name: string;
  fields: Record<string, FieldInspection>;
};

export type FieldInspection = {
  type: string;
  constraints: Record<string, unknown>;
};

export type AppInspection = {
  schemaVersion: "0.1";
  schema: {
    tables: TableInspection[];
  };
  capabilities: Record<string, unknown>;
  queries: string[];
  mutations: string[];
  endpoints: EndpointInspection[];
  jobs: JobInspection[];
};

export function inspectAppDefinition(app: AppDefinition): AppInspection {
  return {
    schemaVersion: "0.1",
    schema: {
      tables: Object.entries(app.schema ?? {}).map(([name, table]) => ({
        name,
        fields: inspectFields(table.fields),
      })),
    },
    capabilities: app.capabilities ?? {},
    queries: Object.keys(app.queries ?? {}),
    mutations: Object.keys(app.mutations ?? {}),
    endpoints: Object.entries(app.endpoints ?? {}).map(
      ([name, definition]) => ({
        name,
        method: definition.method,
        path: definition.path,
        auth: definition.auth ?? "required",
      }),
    ),
    jobs: Object.entries(app.jobs ?? {}).map(([name, definition]) => {
      const inspected: JobInspection = { name };

      if (definition.schedule !== undefined) {
        inspected.schedule = definition.schedule;
      }

      return inspected;
    }),
  };
}

function inspectFields(
  fields: Record<string, unknown>,
): Record<string, FieldInspection> {
  const inspected: Record<string, FieldInspection> = {};

  for (const [name, field] of Object.entries(fields)) {
    inspected[name] = inspectField(field);
  }

  return inspected;
}

function inspectField(field: unknown): FieldInspection {
  if (isFieldDefinition(field)) {
    return {
      type: field.type,
      constraints: field.constraints,
    };
  }

  return {
    type: typeof field === "string" ? field : "unknown",
    constraints: {},
  };
}

function isFieldDefinition(field: unknown): field is FieldDefinition {
  return (
    typeof field === "object" &&
    field !== null &&
    "kind" in field &&
    field.kind === "field" &&
    "type" in field &&
    typeof field.type === "string" &&
    "constraints" in field &&
    typeof field.constraints === "object" &&
    field.constraints !== null
  );
}
