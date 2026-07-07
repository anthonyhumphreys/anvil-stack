import type {
  AgentManifest,
  AgentValidationIssue,
  AppDefinition,
  AppInspection,
} from "@anvil-cloud/runtime";
import {
  inspectAppDefinition,
  validateAgentDefinition,
} from "@anvil-cloud/runtime";

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
  client: CellConfig["client"];
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
  workflows: AppInspection["workflows"];
  services: AppInspection["services"];
  channels: AppInspection["channels"];
  agents: Record<string, AgentManifest>;
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
      client:
        config.client.kind === "vite-react"
          ? "dist/client/index.html"
          : config.entrypoints.client,
    },
    client: config.client,
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
    workflows: inspection.workflows,
    services: inspection.services,
    channels: inspection.channels,
    agents: inspection.agents,
    capabilities: inspection.capabilities,
  };
}

export async function validateCellAgents(options: {
  app: AppDefinition;
  rootDir: string;
}): Promise<AgentValidationIssue[]> {
  const issues: AgentValidationIssue[] = [];
  const agents = options.app.agents ?? {};
  const declaredSecrets = readCapabilityNames(
    options.app.capabilities?.secrets,
  );

  for (const [mount, agent] of Object.entries(agents)) {
    issues.push(
      ...(await validateAgentDefinition(agent, { baseDir: options.rootDir })),
    );

    for (const brokered of agent.credentialBroker?.credentials ?? []) {
      if (!declaredSecrets.has(brokered.credential)) {
        issues.push({
          code: "AGENT_CREDENTIAL_BROKER_SECRET_NOT_DECLARED",
          severity: "error",
          message: `Agent '${agent.name}' brokers credential '${brokered.credential}', but it is not declared in capabilities.secrets.`,
          path: `agents.${mount}.credentialBroker`,
        });
      }
    }

    if (agent.name !== mount) {
      issues.push({
        code: "AGENT_MOUNT_NAME_MISMATCH",
        severity: "warning",
        message: `Mounted agent '${mount}' compiles as '${agent.name}'.`,
        path: `agents.${mount}`,
      });
    }
  }

  for (const [name, endpoint] of Object.entries(options.app.endpoints ?? {})) {
    if (endpoint.agent !== undefined && !(endpoint.agent in agents)) {
      issues.push({
        code: "AGENT_ENDPOINT_REFERENCE_MISSING",
        severity: "error",
        message: `Endpoint '${name}' references missing mounted agent '${endpoint.agent}'.`,
        path: `endpoints.${name}.agent`,
      });
    }
  }

  for (const [name, workflow] of Object.entries(options.app.workflows ?? {})) {
    if (workflow.agent !== undefined && !(workflow.agent in agents)) {
      issues.push({
        code: "AGENT_WORKFLOW_REFERENCE_MISSING",
        severity: "error",
        message: `Workflow '${name}' references missing mounted agent '${workflow.agent}'.`,
        path: `workflows.${name}.agent`,
      });
    }
  }

  for (const [name, channel] of Object.entries(options.app.channels ?? {})) {
    if (!(channel.agent in agents)) {
      issues.push({
        code: "AGENT_CHANNEL_REFERENCE_MISSING",
        severity: "error",
        message: `Channel '${name}' references missing mounted agent '${channel.agent}'.`,
        path: `channels.${name}.agent`,
      });
    }
  }

  return issues;
}

function readCapabilityNames(value: unknown): Set<string> {
  if (Array.isArray(value)) {
    return new Set(
      value.filter((entry): entry is string => typeof entry === "string"),
    );
  }

  if (value && typeof value === "object") {
    return new Set(Object.keys(value as Record<string, unknown>));
  }

  return new Set();
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
