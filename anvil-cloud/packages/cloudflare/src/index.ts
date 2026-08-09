import type { CellManifest } from "@anvil-cloud/builder";
import type {
  DeploymentEnvironment,
  DeploymentPlan,
  DeploymentPlanAdapter,
  DeploymentPlanApprovalGate,
  DeploymentPlanChange,
  DeploymentPlanOperations,
  DeploymentPlanReviewChange,
} from "@anvil-cloud/deployment";

export type CloudflarePreviewSupportDiagnostic = {
  code: "CLOUDFLARE_PREVIEW_UNSUPPORTED_FEATURE";
  feature:
    | "agentSandboxes"
    | "files"
    | "jobs"
    | "secrets"
    | "services"
    | "workflows";
  message: string;
  hint: string;
  names: string[];
};

export type CloudflareAuthenticationMode = "permanent" | "temporary";

export type CloudflarePreviewDeploymentAdapterOptions = {
  authentication?: CloudflareAuthenticationMode;
};

export class CloudflarePreviewDeploymentAdapter implements DeploymentPlanAdapter {
  readonly name = "cloudflare";

  constructor(
    private readonly options: CloudflarePreviewDeploymentAdapterOptions = {},
  ) {}

  plan(
    manifest: CellManifest,
    environment: DeploymentEnvironment = "preview",
  ): DeploymentPlan {
    return createCloudflarePreviewDeploymentPlan(manifest, environment, {
      authentication: this.options.authentication ?? "permanent",
    });
  }
}

export function createCloudflarePreviewDeploymentPlan(
  manifest: CellManifest,
  environment: DeploymentEnvironment = "preview",
  options: CloudflarePreviewDeploymentAdapterOptions = {},
): DeploymentPlan {
  const authentication = options.authentication ?? "permanent";
  const declaredSecrets = readStringArray(manifest.capabilities.secrets);
  const resourceName = `${slug(manifest.cell.name)}-${environment}`;
  const changes: DeploymentPlanChange[] = [
    change("runtime", resourceName, {
      service: "workers",
      compatibility: "workerd",
    }),
    change("http-ingress", resourceName, {
      service: "workers-routes",
      queries: manifest.queries.length,
      mutations: manifest.mutations.length,
      endpoints: manifest.endpoints.map(({ method, path }) => ({
        method,
        path,
      })),
    }),
    change("client-assets", resourceName, {
      service: "workers-assets",
    }),
    change("environment", resourceName, {
      service: "workers-bindings",
      secrets: declaredSecrets,
      authentication,
      ...(authentication === "temporary"
        ? { wranglerMinimumVersion: "4.102.0", claimWithinMinutes: 60 }
        : {}),
    }),
    change("logs", resourceName, {
      service: "workers-observability",
    }),
    change("audit", resourceName, {
      service: "adapter-metadata",
    }),
  ];

  if (manifest.capabilities.database === true) {
    changes.push(
      change("database", resourceName, {
        service: "d1",
        tables: Object.keys(manifest.schema.tables).sort(),
      }),
    );
  }

  if (manifest.capabilities.files) {
    changes.push(
      change("files", resourceName, {
        service: "r2",
        publicRead:
          isObject(manifest.capabilities.files) &&
          manifest.capabilities.files.publicRead === true,
      }),
    );
  }

  if (manifest.capabilities.events) {
    changes.push(change("events", resourceName, { service: "queues" }));
  }

  if (manifest.jobs.length > 0) {
    changes.push(
      change("jobs", resourceName, {
        scheduled: manifest.jobs.filter((job) => job.schedule).length,
        queued: manifest.jobs.filter((job) => !job.schedule).length,
      }),
    );
  }

  if (manifest.workflows.length > 0) {
    changes.push(
      change("workflows", resourceName, {
        workflows: manifest.workflows.map((workflow) => workflow.name),
      }),
    );
  }

  if (manifest.services.length > 0) {
    changes.push(
      change("services", resourceName, {
        services: manifest.services.map((service) => service.name),
      }),
    );
  }

  const sandboxAgents = Object.values(manifest.agents ?? {}).filter(
    (agent) => agent.requires.sandbox,
  );
  if (sandboxAgents.length > 0) {
    changes.push(
      change("agent-sandboxes", resourceName, {
        agents: sandboxAgents.map((agent) => agent.name),
      }),
    );
  }

  changes.sort(compareChange);
  const operations = createOperations(manifest, environment, authentication);
  const changeSet = changes.map(toReviewChange).sort(compareById);
  const capabilityDiffs = changes
    .map((item) => ({
      id: `${slug(item.concept)}:${slug(item.name)}`,
      action: "add" as const,
      capability: item.concept,
      name: item.name,
      ...(item.details === undefined ? {} : { details: item.details }),
    }))
    .sort(compareById);
  const supportDiagnostics = checkCloudflarePreviewSupport(manifest, {
    authentication,
  });
  const approvalGates = createApprovalGates(changeSet, supportDiagnostics);
  const costDrivers = createCostDrivers(manifest);

  return {
    schemaVersion: "0.1",
    adapter: "cloudflare",
    environment,
    cell: manifest.cell.name,
    changes,
    review: {
      stableId: `cloudflare-preview:${authentication}:${slug(manifest.cell.name)}:${environment}:deploy`,
      operation: "deploy",
      summary: {
        creates: changes.length,
        updates: 0,
        reuses: 0,
        total: changes.length,
      },
      changeSummary: Array.from(
        changes
          .reduce((summaries, item) => {
            const entry = summaries.get(item.concept) ?? {
              concept: item.concept,
              creates: 0,
              updates: 0,
              reuses: 0,
              total: 0,
              changeIds: [] as string[],
            };
            entry.creates += 1;
            entry.total += 1;
            entry.changeIds.push(toReviewChange(item).id);
            summaries.set(item.concept, entry);
            return summaries;
          }, new Map<DeploymentPlanChange["concept"], DeploymentPlan["review"]["changeSummary"][number]>())
          .values(),
      ).sort((left, right) => left.concept.localeCompare(right.concept)),
      changeSet,
      capabilityDiffs,
      cost: {
        drivers: costDrivers,
        notes: operations.cost.notes,
      },
      rollback: operations.rollback,
      cleanup: operations.cleanup,
      approvalSummary: {
        required: approvalGates.filter((gate) => gate.required).length,
        info: approvalGates.filter((gate) => gate.severity === "info").length,
        review: approvalGates.filter((gate) => gate.severity === "review")
          .length,
        block: approvalGates.filter((gate) => gate.severity === "block").length,
        hasBlockingGate: approvalGates.some(
          (gate) => gate.severity === "block",
        ),
      },
      approvalGates,
    },
    warnings: supportDiagnostics.map((diagnostic) => diagnostic.message),
    operations,
  };
}

export function checkCloudflarePreviewSupport(
  manifest: CellManifest,
  options: CloudflarePreviewDeploymentAdapterOptions = {},
): CloudflarePreviewSupportDiagnostic[] {
  const diagnostics: CloudflarePreviewSupportDiagnostic[] = [];
  const declaredSecrets = readStringArray(manifest.capabilities.secrets);
  const sandboxAgents = Object.values(manifest.agents ?? {}).filter(
    (agent) => agent.requires.sandbox,
  );

  if (manifest.services.length > 0) {
    diagnostics.push(
      unsupported(
        "services",
        manifest.services.map((item) => item.name),
        "Cloudflare preview cannot execute long-running Cell services.",
        "Run services locally or move the handler behind a request or queue boundary.",
      ),
    );
  }
  if (manifest.workflows.length > 0) {
    diagnostics.push(
      unsupported(
        "workflows",
        manifest.workflows.map((item) => item.name),
        "Cloudflare preview does not yet implement the Anvil workflow durability contract.",
        "Run workflows locally until a durable Cloudflare workflow host passes conformance.",
      ),
    );
  }
  if (manifest.jobs.length > 0) {
    diagnostics.push(
      unsupported(
        "jobs",
        manifest.jobs.map((item) => item.name),
        "Cloudflare preview does not yet execute scheduled or queued jobs.",
        "Run jobs locally until Queues and Cron Trigger runtime bridges are implemented.",
      ),
    );
  }
  if (sandboxAgents.length > 0) {
    diagnostics.push(
      unsupported(
        "agentSandboxes",
        sandboxAgents.map((item) => item.name),
        "Cloudflare preview cannot provide Anvil Agent Sandbox isolation.",
        "Use an agent without required sandbox execution for this target.",
      ),
    );
  }
  if (options.authentication === "temporary" && manifest.capabilities.files) {
    diagnostics.push(
      unsupported(
        "files",
        [manifest.cell.name],
        "Cloudflare Temporary Accounts do not currently list R2 as a supported resource.",
        "Use permanent Cloudflare authentication for Cells with files, or remove the files capability from this temporary preview.",
      ),
    );
  }
  if (options.authentication === "temporary" && declaredSecrets.length > 0) {
    diagnostics.push(
      unsupported(
        "secrets",
        declaredSecrets,
        "Cloudflare Temporary Accounts do not document secret-binding operations as supported.",
        "Use permanent Cloudflare authentication for Cells with secrets until temporary secret binding is provider-verified.",
      ),
    );
  }

  return diagnostics;
}

function createApprovalGates(
  changeSet: DeploymentPlanReviewChange[],
  diagnostics: CloudflarePreviewSupportDiagnostic[],
): DeploymentPlanApprovalGate[] {
  const gates: DeploymentPlanApprovalGate[] = [
    {
      id: "cloudflare-plan-only-gate",
      required: true,
      severity: "block",
      reason:
        "Cloudflare support is plan-only until the Worker runtime bridge and deploy/remove operations pass provider smoke tests.",
      changeIds: changeSet.map((item) => item.id),
    },
  ];

  if (diagnostics.length > 0) {
    const unsupportedConcepts = new Set<string>(
      diagnostics.map((item) =>
        item.feature === "agentSandboxes"
          ? "agent-sandboxes"
          : item.feature === "secrets"
            ? "environment"
            : item.feature,
      ),
    );
    gates.push({
      id: "cloudflare-preview-support-gate",
      required: true,
      severity: "block",
      reason:
        "The Cell declares capabilities without a Cloudflare runtime mapping.",
      changeIds: changeSet
        .filter((item) => unsupportedConcepts.has(item.concept))
        .map((item) => item.id),
    });
  }

  return gates;
}

function createOperations(
  manifest: CellManifest,
  environment: DeploymentEnvironment,
  authentication: CloudflareAuthenticationMode,
): DeploymentPlanOperations {
  const temporaryFlag = authentication === "temporary" ? " --temporary" : "";
  return {
    rollback: {
      supported: false,
      strategy: "manual",
      commands: [
        `anvil-cloud plan --stage ${environment} --adapter cloudflare${temporaryFlag} --json`,
      ],
      notes: [
        "Cloudflare deployment is not enabled by this plan-only adapter.",
      ],
    },
    cost: {
      billingMode: "usage-based-preview",
      drivers: createCostDrivers(manifest).map((driver) => driver.label),
      notes: [
        "The plan identifies Cloudflare cost drivers but does not query account pricing or create resources.",
      ],
    },
    cleanup: {
      commands: [
        `anvil-cloud plan --stage ${environment} --adapter cloudflare${temporaryFlag} --json`,
      ],
      notes: ["No Cloudflare resources are created by the plan-only adapter."],
    },
  };
}

function createCostDrivers(manifest: CellManifest) {
  const drivers = [
    {
      id: "workers",
      label: "Workers requests and duration",
      reason: "The Cell runtime and HTTP ingress map to a Worker.",
    },
    {
      id: "workers-assets",
      label: "Workers static asset requests",
      reason: "Built client assets map to Workers Assets.",
    },
    {
      id: "workers-observability",
      label: "Workers logs and observability",
      reason: "Runtime logs require provider retention and inspection.",
    },
  ];
  if (manifest.capabilities.database === true)
    drivers.push({
      id: "d1",
      label: "D1 reads, writes, and storage",
      reason: "Database capability maps supported tables to D1.",
    });
  if (manifest.capabilities.files)
    drivers.push({
      id: "r2",
      label: "R2 storage and operations",
      reason: "Files capability maps Cell objects to R2.",
    });
  if (manifest.capabilities.events || manifest.jobs.length > 0)
    drivers.push({
      id: "queues",
      label: "Queues operations",
      reason: "Events and queued jobs require Cloudflare Queues.",
    });
  return drivers.sort(compareById);
}

function change(
  concept: DeploymentPlanChange["concept"],
  name: string,
  details?: Record<string, unknown>,
): DeploymentPlanChange {
  return { kind: "create", concept, name, ...(details ? { details } : {}) };
}

function toReviewChange(
  item: DeploymentPlanChange,
): DeploymentPlanReviewChange {
  return {
    id: `${item.kind}:${slug(item.concept)}:${slug(item.name)}`,
    action: item.kind,
    concept: item.concept,
    name: item.name,
    ...(item.details === undefined ? {} : { details: item.details }),
  };
}

function unsupported(
  feature: CloudflarePreviewSupportDiagnostic["feature"],
  names: string[],
  message: string,
  hint: string,
): CloudflarePreviewSupportDiagnostic {
  return {
    code: "CLOUDFLARE_PREVIEW_UNSUPPORTED_FEATURE",
    feature,
    message,
    hint,
    names,
  };
}

function compareById(left: { id: string }, right: { id: string }): number {
  return left.id.localeCompare(right.id);
}

function compareChange(
  left: DeploymentPlanChange,
  right: DeploymentPlanChange,
): number {
  return `${left.concept}:${left.name}`.localeCompare(
    `${right.concept}:${right.name}`,
  );
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function slug(value: string): string {
  const normalized = value.toLowerCase().replace(/[^a-z0-9-]+/g, "-");
  let start = 0;
  let end = normalized.length;
  while (start < end && normalized[start] === "-") start += 1;
  while (end > start && normalized[end - 1] === "-") end -= 1;
  return normalized.slice(start, end).slice(0, 48) || "anvil";
}
