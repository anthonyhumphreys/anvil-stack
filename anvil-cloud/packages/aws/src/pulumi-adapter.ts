import type { AnvilCellGraph } from "@anvil-cloud/builder";

export type DeployInput = {
  appName: string;
  stage: string;
  cellGraph: AnvilCellGraph;
  previousCellGraph?: AnvilCellGraph;
  options?: Record<string, unknown>;
};

export type RemoveInput = DeployInput;

export type DeployPlan = {
  schemaVersion: "0.1";
  adapter: "aws";
  engine: "pulumi";
  appName: string;
  stage: string;
  changes: AnvilPlanChange[];
  review: PlanReview;
  pulumi?: PulumiMapping[];
};

export type AnvilPlanChange = {
  kind: "create" | "delete";
  concept:
    | "Cell"
    | "HTTP route"
    | "Function"
    | "Table"
    | "Secret"
    | "Permission";
  name: string;
  details?: Record<string, unknown>;
};

export type PlanReview = {
  stableId: string;
  operation: "deploy" | "remove";
  summary: {
    creates: number;
    deletes: number;
    total: number;
  };
  changeSet: ReviewPlanChange[];
  capabilityDiffs: CapabilityDiff[];
  cost: {
    drivers: CostDriver[];
    notes: string[];
  };
  rollback: {
    supported: boolean;
    strategy: "redeploy-or-remove" | "manual-cleanup";
    commands: string[];
    notes: string[];
  };
  approvalGates: ApprovalGate[];
};

export type ReviewPlanChange = {
  id: string;
  action: "create" | "delete";
  concept: AnvilPlanChange["concept"];
  name: string;
  details?: Record<string, unknown>;
};

export type CapabilityDiff = {
  id: string;
  action: "add" | "remove" | "unchanged";
  capability:
    | "cell"
    | "http-route"
    | "function"
    | "table"
    | "secret"
    | "permission";
  name: string;
  details?: Record<string, unknown>;
};

export type CostDriver = {
  id: string;
  label: string;
  reason: string;
};

export type ApprovalGate = {
  id: string;
  required: boolean;
  severity: "info" | "review" | "block";
  reason: string;
  changeIds: string[];
};

export type PulumiMapping = { anvil: string; type: string; name: string };
export type DeployResult = {
  ok: true;
  appName: string;
  stage: string;
  outputs: Record<string, unknown>;
  plan: DeployPlan;
};
export type RemoveResult = {
  ok: true;
  appName: string;
  stage: string;
  removed: string[];
  plan: DeployPlan;
};

export interface AnvilDeployAdapter {
  readonly name: string;
  plan(input: DeployInput): Promise<DeployPlan> | DeployPlan;
  deploy(input: DeployInput): Promise<DeployResult>;
  remove(input: RemoveInput): Promise<RemoveResult>;
}

export class AwsPulumiDeployAdapter implements AnvilDeployAdapter {
  readonly name = "aws";

  plan(input: DeployInput): DeployPlan {
    return createAwsPulumiPlan(input, false);
  }

  async deploy(input: DeployInput): Promise<DeployResult> {
    const plan = this.plan(input);
    await loadPulumiEngineIfRequested(input);
    return {
      ok: true,
      appName: input.appName,
      stage: input.stage,
      outputs: createAnvilOutputs(input),
      plan,
    };
  }

  async remove(input: RemoveInput): Promise<RemoveResult> {
    const plan = createAwsPulumiPlan(input, true);
    await loadPulumiEngineIfRequested(input);
    return {
      ok: true,
      appName: input.appName,
      stage: input.stage,
      removed: plan.changes.map((change) => change.name),
      plan,
    };
  }
}

export function createAwsPulumiPlan(
  input: DeployInput,
  deleting = false,
): DeployPlan {
  const prefix = deterministicName(input.appName, input.stage);
  const kind: "create" | "delete" = deleting ? "delete" : "create";
  const changes: AnvilPlanChange[] = sortPlanChanges([
    ...input.cellGraph.cells.map((cell) => ({
      kind,
      concept: "Cell" as const,
      name: cell.name,
      details: { runtime: cell.runtime },
    })),
    ...input.cellGraph.httpRoutes.map((route) => ({
      kind,
      concept: "HTTP route" as const,
      name: `${route.method} ${route.path}`,
      details: { function: route.handler, auth: route.auth },
    })),
    ...input.cellGraph.functions.map((fn) => ({
      kind,
      concept: "Function" as const,
      name: fn.name,
      details: { runtime: fn.runtime, resourceName: `${prefix}-${fn.name}` },
    })),
    ...input.cellGraph.tables.map((table) => ({
      kind,
      concept: "Table" as const,
      name: table.name,
      details: {
        access: table.access,
        resourceName: `${prefix}-${table.name}`,
      },
    })),
    ...input.cellGraph.secrets.map((secret) => ({
      kind,
      concept: "Secret" as const,
      name: secret.name,
      details: { resourceName: `/${prefix}/secrets/${secret.name}` },
    })),
    ...input.cellGraph.permissions.map((permission) => ({
      kind,
      concept: "Permission" as const,
      name: `${permission.from} can ${
        permission.action === "read-write" ? "read/write" : "read"
      } ${permission.to}`,
      details: { targetKind: permission.targetKind },
    })),
  ]);

  return {
    schemaVersion: "0.1",
    adapter: "aws",
    engine: "pulumi",
    appName: input.appName,
    stage: input.stage,
    changes,
    review: createPlanReview(input, changes, deleting),
    pulumi: createPulumiMappings(input),
  };
}

export function createPulumiMappings(input: DeployInput): PulumiMapping[] {
  const prefix = deterministicName(input.appName, input.stage);
  return [
    ...input.cellGraph.httpRoutes.map((route) => ({
      anvil: `HTTP route ${route.method} ${route.path}`,
      type: "aws:apigatewayv2/api:Api",
      name: `${prefix}-http`,
    })),
    ...input.cellGraph.functions.map((fn) => ({
      anvil: `Function ${fn.name}`,
      type: "aws:lambda/function:Function",
      name: `${prefix}-${fn.name}`,
    })),
    ...input.cellGraph.tables.map((table) => ({
      anvil: `Table ${table.name}`,
      type: "aws:dynamodb/table:Table",
      name: `${prefix}-${table.name}`,
    })),
    ...input.cellGraph.secrets.map((secret) => ({
      anvil: `Secret ${secret.name}`,
      type: "aws:ssm/parameter:Parameter",
      name: `/${prefix}/secrets/${secret.name}`,
    })),
    ...input.cellGraph.functions.map((fn) => ({
      anvil: `Permissions for ${fn.name}`,
      type: "aws:iam/rolePolicy:RolePolicy",
      name: `${prefix}-${fn.name}-policy`,
    })),
  ];
}

export function deterministicName(appName: string, stage: string): string {
  return (
    `${slug(appName)}-${slug(stage)}`.replace(/^-+|-+$/g, "").slice(0, 63) ||
    "anvil"
  );
}

function createPlanReview(
  input: DeployInput,
  changes: AnvilPlanChange[],
  deleting: boolean,
): PlanReview {
  const operation = deleting ? "remove" : "deploy";
  const changeSet = changes.map(toReviewPlanChange);
  const capabilityDiffs = deleting
    ? createRemovalCapabilityDiffs(input.cellGraph)
    : createCapabilityDiffs(input.cellGraph, input.previousCellGraph);

  return {
    stableId: `aws:${input.appName}:${input.stage}:${operation}`,
    operation,
    summary: {
      creates: changes.filter((change) => change.kind === "create").length,
      deletes: changes.filter((change) => change.kind === "delete").length,
      total: changes.length,
    },
    changeSet,
    capabilityDiffs,
    cost: {
      drivers: createCostDrivers(input.cellGraph),
      notes: [
        "These are cost drivers, not price estimates.",
        "Use them to review which provider resources this Cell requires before deployment.",
      ],
    },
    rollback: createRollbackReview(input.appName, input.stage, deleting),
    approvalGates: createApprovalGates(capabilityDiffs, changeSet, deleting),
  };
}

function toReviewPlanChange(change: AnvilPlanChange): ReviewPlanChange {
  const reviewChange: ReviewPlanChange = {
    id: [change.kind, slug(change.concept), slug(change.name)].join(":"),
    action: change.kind,
    concept: change.concept,
    name: change.name,
  };

  if (change.details !== undefined) {
    reviewChange.details = change.details;
  }

  return reviewChange;
}

function sortPlanChanges(changes: AnvilPlanChange[]): AnvilPlanChange[] {
  return [...changes].sort((left, right) => {
    return (
      left.kind.localeCompare(right.kind) ||
      left.concept.localeCompare(right.concept) ||
      left.name.localeCompare(right.name)
    );
  });
}

function createCapabilityDiffs(
  current: AnvilCellGraph,
  previous: AnvilCellGraph | undefined,
): CapabilityDiff[] {
  const currentCapabilities = capabilityItems(current);
  const previousCapabilities = capabilityItems(previous ?? emptyGraph(current));
  const currentById = new Map(
    currentCapabilities.map((item) => [item.id, item]),
  );
  const previousById = new Map(
    previousCapabilities.map((item) => [item.id, item]),
  );
  const ids = Array.from(
    new Set([...currentById.keys(), ...previousById.keys()]),
  ).sort();

  return ids.map((id) => {
    const currentItem = currentById.get(id);
    const previousItem = previousById.get(id);
    const item = currentItem ?? previousItem;

    if (!item) {
      throw new Error(`Capability diff item '${id}' was not found.`);
    }

    return {
      ...item,
      action:
        currentItem && previousItem
          ? "unchanged"
          : currentItem
            ? "add"
            : "remove",
    };
  });
}

function createRemovalCapabilityDiffs(graph: AnvilCellGraph): CapabilityDiff[] {
  return capabilityItems(graph).map((item) => ({
    ...item,
    action: "remove",
  }));
}

function capabilityItems(
  graph: AnvilCellGraph,
): Array<Omit<CapabilityDiff, "action">> {
  return [
    ...graph.cells.map((cell) => ({
      id: `cell:${slug(cell.name)}`,
      capability: "cell" as const,
      name: cell.name,
      details: { runtime: cell.runtime },
    })),
    ...graph.httpRoutes.map((route) => ({
      id: `http-route:${slug(route.method)}:${slug(route.path)}`,
      capability: "http-route" as const,
      name: `${route.method} ${route.path}`,
      details: { handler: route.handler, auth: route.auth },
    })),
    ...graph.functions.map((fn) => ({
      id: `function:${slug(fn.name)}`,
      capability: "function" as const,
      name: fn.name,
      details: { runtime: fn.runtime },
    })),
    ...graph.tables.map((table) => ({
      id: `table:${slug(table.name)}`,
      capability: "table" as const,
      name: table.name,
      details: { access: table.access },
    })),
    ...graph.secrets.map((secret) => ({
      id: `secret:${slug(secret.name)}`,
      capability: "secret" as const,
      name: secret.name,
    })),
    ...graph.permissions.map((permission) => ({
      id: [
        "permission",
        slug(permission.from),
        slug(permission.action),
        slug(permission.targetKind),
        slug(permission.to),
      ].join(":"),
      capability: "permission" as const,
      name: `${permission.from} ${permission.action} ${permission.to}`,
      details: { targetKind: permission.targetKind },
    })),
  ].sort((left, right) => left.id.localeCompare(right.id));
}

function emptyGraph(graph: AnvilCellGraph): AnvilCellGraph {
  return {
    schemaVersion: "0.1",
    appName: graph.appName,
    cells: [],
    httpRoutes: [],
    functions: [],
    tables: [],
    secrets: [],
    permissions: [],
  };
}

function createCostDrivers(graph: AnvilCellGraph): CostDriver[] {
  const drivers: CostDriver[] = [
    {
      id: "api-gateway",
      label: "API Gateway HTTP requests",
      reason: `${graph.httpRoutes.length} HTTP route(s) require an ingress surface.`,
    },
    {
      id: "lambda",
      label: "Lambda requests and duration",
      reason: `${graph.functions.length} function(s) execute Cell handlers.`,
    },
    {
      id: "cloudwatch",
      label: "CloudWatch log ingestion and retention",
      reason: "Runtime and function logs are written for inspection.",
    },
  ];

  if (graph.tables.length > 0) {
    drivers.push({
      id: "dynamodb",
      label: "DynamoDB reads, writes, and storage",
      reason: `${graph.tables.length} table(s) are declared in the Cell graph.`,
    });
  }

  if (graph.secrets.length > 0) {
    drivers.push({
      id: "ssm",
      label: "SSM Parameter Store reads",
      reason: `${graph.secrets.length} secret reference(s) are declared.`,
    });
  }

  if (graph.permissions.length > 0) {
    drivers.push({
      id: "iam",
      label: "IAM policy surface area",
      reason: `${graph.permissions.length} generated permission statement(s) need review.`,
    });
  }

  return drivers;
}

function createRollbackReview(
  appName: string,
  stage: string,
  deleting: boolean,
): PlanReview["rollback"] {
  if (deleting) {
    return {
      supported: false,
      strategy: "manual-cleanup",
      commands: [`anvil-cloud deploy --stage ${stage} --adapter aws --json`],
      notes: [
        "Remove plans delete stage resources.",
        "Recover by redeploying the Cell from a known-good checkout.",
      ],
    };
  }

  return {
    supported: false,
    strategy: "redeploy-or-remove",
    commands: [
      `anvil-cloud deploy --stage ${stage} --adapter aws --json`,
      `anvil-cloud remove --stage ${stage} --adapter aws --json`,
    ],
    notes: [
      "Automated artifact rollback is not implemented for graph adapter deployments yet.",
      `For ${appName}/${stage}, redeploy a known-good checkout or remove the stage resources.`,
    ],
  };
}

function createApprovalGates(
  capabilityDiffs: CapabilityDiff[],
  changeSet: ReviewPlanChange[],
  deleting: boolean,
): ApprovalGate[] {
  const gates: ApprovalGate[] = [];
  const additions = capabilityDiffs.filter((diff) => diff.action === "add");
  const removals = capabilityDiffs.filter((diff) => diff.action === "remove");
  const tableAdds = additions.filter((diff) => diff.capability === "table");
  const secretAdds = additions.filter((diff) => diff.capability === "secret");
  const permissionAdds = additions.filter(
    (diff) => diff.capability === "permission",
  );
  const publicRoutes = additions.filter((diff) => {
    return (
      diff.capability === "http-route" &&
      isObject(diff.details?.auth) &&
      diff.details.auth.mode === "public"
    );
  });

  if (deleting || removals.length > 0) {
    gates.push({
      id: "destructive-change-review",
      required: true,
      severity: "block",
      reason:
        "The plan removes Cell resources or capabilities. Confirm cleanup and data retention before applying.",
      changeIds: changeSet
        .filter((change) => change.action === "delete")
        .map((change) => change.id),
    });
  }

  if (tableAdds.length > 0) {
    gates.push({
      id: "data-resource-review",
      required: true,
      severity: "review",
      reason:
        "New table capability changes data persistence and backup/retention expectations.",
      changeIds: idsForCapabilities(changeSet, "Table", tableAdds),
    });
  }

  if (secretAdds.length > 0 || permissionAdds.length > 0) {
    gates.push({
      id: "permission-review",
      required: true,
      severity: "review",
      reason:
        "New secrets or generated permissions change the runtime access surface.",
      changeIds: [
        ...idsForCapabilities(changeSet, "Secret", secretAdds),
        ...idsForCapabilities(changeSet, "Permission", permissionAdds),
      ],
    });
  }

  if (publicRoutes.length > 0) {
    gates.push({
      id: "public-ingress-review",
      required: true,
      severity: "review",
      reason: "New public HTTP routes expose a runtime endpoint without auth.",
      changeIds: idsForCapabilities(changeSet, "HTTP route", publicRoutes),
    });
  }

  if (gates.length === 0) {
    gates.push({
      id: "standard-review",
      required: false,
      severity: "info",
      reason: "No high-risk capability changes were detected in this plan.",
      changeIds: changeSet.map((change) => change.id),
    });
  }

  return gates;
}

function idsForCapabilities(
  changeSet: ReviewPlanChange[],
  concept: AnvilPlanChange["concept"],
  diffs: CapabilityDiff[],
): string[] {
  const names = new Set(diffs.map((diff) => diff.name));
  return changeSet
    .filter((change) => change.concept === concept && names.has(change.name))
    .map((change) => change.id);
}

function createAnvilOutputs(input: DeployInput): Record<string, unknown> {
  const prefix = deterministicName(input.appName, input.stage);
  return {
    endpointUrl: `https://${prefix}.execute-api.aws.anvil.local`,
    functions: Object.fromEntries(
      input.cellGraph.functions.map((fn) => [fn.name, `${prefix}-${fn.name}`]),
    ),
    tables: Object.fromEntries(
      input.cellGraph.tables.map((table) => [
        table.name,
        `${prefix}-${table.name}`,
      ]),
    ),
    secrets: Object.fromEntries(
      input.cellGraph.secrets.map((secret) => [
        secret.name,
        `/${prefix}/secrets/${secret.name}`,
      ]),
    ),
  };
}

async function loadPulumiEngineIfRequested(input: DeployInput): Promise<void> {
  if (input.options?.executePulumi !== true) return;
  await import("@pulumi/pulumi");
  await import("@pulumi/aws");
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function slug(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "anvil"
  );
}
