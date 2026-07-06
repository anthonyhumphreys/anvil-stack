import type { AppDefinition, FieldDefinition } from "./app.js";
import { createAgentManifest, type AgentManifest } from "./agent.js";
import {
  normaliseAuthRequirement,
  type AuthPolicyInspection,
} from "./auth-policy.js";

export type EndpointInspection = {
  name: string;
  method: string;
  path: string;
  auth: AuthPolicyInspection;
  agent?: string;
};

export type JobInspection = {
  name: string;
  schedule?: string;
  overlap?: "skip" | "queue";
  timeoutMs?: number;
};

export type WorkflowInspection = {
  name: string;
  steps: string[];
  agent?: string;
  trigger?: string;
};

export type ServiceInspection = {
  name: string;
  restart: string;
  maxRestarts: number;
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
  workflows: WorkflowInspection[];
  services: ServiceInspection[];
  agents: Record<string, AgentManifest>;
  authPolicies: {
    queries: Record<string, AuthPolicyInspection>;
    mutations: Record<string, AuthPolicyInspection>;
  };
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
    endpoints: Object.entries(app.endpoints ?? {}).map(([name, definition]) => {
      const inspected: EndpointInspection = {
        name,
        method: definition.method,
        path: definition.path,
        auth: normaliseAuthRequirement(definition.auth, "required"),
      };

      if (definition.agent !== undefined) {
        inspected.agent = definition.agent;
      }

      return inspected;
    }),
    authPolicies: {
      queries: Object.fromEntries(
        Object.entries(app.queries ?? {}).map(([name, definition]) => [
          name,
          normaliseAuthRequirement(definition.auth, "optional"),
        ]),
      ),
      mutations: Object.fromEntries(
        Object.entries(app.mutations ?? {}).map(([name, definition]) => [
          name,
          normaliseAuthRequirement(definition.auth, "optional"),
        ]),
      ),
    },
    jobs: Object.entries(app.jobs ?? {}).map(([name, definition]) => {
      const inspected: JobInspection = { name };

      if (definition.schedule !== undefined) {
        inspected.schedule = definition.schedule;
      }

      if (definition.overlap !== undefined) {
        inspected.overlap = definition.overlap;
      }

      if (definition.timeoutMs !== undefined) {
        inspected.timeoutMs = definition.timeoutMs;
      }

      return inspected;
    }),
    workflows: Object.entries(app.workflows ?? {}).map(([name, definition]) => {
      const inspected: WorkflowInspection = {
        name,
        steps: definition.steps.map((step) => step.name),
      };

      if (definition.agent !== undefined) {
        inspected.agent = definition.agent;
      }

      if (definition.trigger !== undefined) {
        inspected.trigger = definition.trigger;
      }

      return inspected;
    }),
    services: Object.entries(app.services ?? {}).map(([name, definition]) => ({
      name,
      restart: definition.restart ?? "on-failure",
      maxRestarts: definition.maxRestarts ?? 5,
    })),
    agents: Object.fromEntries(
      Object.entries(app.agents ?? {}).map(([mount, agent]) => [
        mount,
        createAgentManifest(agent, "cell"),
      ]),
    ),
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
