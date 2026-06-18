import type { AnvilCellGraph } from "@anvil-cloud/builder";

export type DeployInput = { appName: string; stage: string; cellGraph: AnvilCellGraph; options?: Record<string, unknown> };
export type RemoveInput = DeployInput;
export type DeployPlan = { schemaVersion: "0.1"; adapter: "aws"; engine: "pulumi"; appName: string; stage: string; changes: AnvilPlanChange[]; pulumi?: PulumiMapping[] };
export type AnvilPlanChange = { kind: "create" | "delete"; concept: "Cell" | "HTTP route" | "Function" | "Table" | "Secret" | "Permission"; name: string; details?: Record<string, unknown> };
export type PulumiMapping = { anvil: string; type: string; name: string };
export type DeployResult = { ok: true; appName: string; stage: string; outputs: Record<string, unknown>; plan: DeployPlan };
export type RemoveResult = { ok: true; appName: string; stage: string; removed: string[]; plan: DeployPlan };

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
    return { ok: true, appName: input.appName, stage: input.stage, outputs: createAnvilOutputs(input), plan };
  }

  async remove(input: RemoveInput): Promise<RemoveResult> {
    const plan = createAwsPulumiPlan(input, true);
    await loadPulumiEngineIfRequested(input);
    return { ok: true, appName: input.appName, stage: input.stage, removed: plan.changes.map((change) => change.name), plan };
  }
}

export function createAwsPulumiPlan(input: DeployInput, deleting = false): DeployPlan {
  const prefix = deterministicName(input.appName, input.stage);
  const kind: "create" | "delete" = deleting ? "delete" : "create";
  const changes: AnvilPlanChange[] = [
    ...input.cellGraph.cells.map((cell) => ({ kind, concept: "Cell" as const, name: cell.name, details: { runtime: cell.runtime } })),
    ...input.cellGraph.httpRoutes.map((route) => ({ kind, concept: "HTTP route" as const, name: `${route.method} ${route.path}`, details: { function: route.handler } })),
    ...input.cellGraph.functions.map((fn) => ({ kind, concept: "Function" as const, name: fn.name, details: { runtime: fn.runtime, resourceName: `${prefix}-${fn.name}` } })),
    ...input.cellGraph.tables.map((table) => ({ kind, concept: "Table" as const, name: table.name, details: { access: table.access, resourceName: `${prefix}-${table.name}` } })),
    ...input.cellGraph.secrets.map((secret) => ({ kind, concept: "Secret" as const, name: secret.name, details: { resourceName: `/${prefix}/secrets/${secret.name}` } })),
    ...input.cellGraph.permissions.map((permission) => ({ kind, concept: "Permission" as const, name: `${permission.from} can ${permission.action === "read-write" ? "read/write" : "read"} ${permission.to}`, details: { targetKind: permission.targetKind } })),
  ];
  return { schemaVersion: "0.1", adapter: "aws", engine: "pulumi", appName: input.appName, stage: input.stage, changes, pulumi: createPulumiMappings(input) };
}

export function createPulumiMappings(input: DeployInput): PulumiMapping[] {
  const prefix = deterministicName(input.appName, input.stage);
  return [
    ...input.cellGraph.httpRoutes.map((route) => ({ anvil: `HTTP route ${route.method} ${route.path}`, type: "aws:apigatewayv2/api:Api", name: `${prefix}-http` })),
    ...input.cellGraph.functions.map((fn) => ({ anvil: `Function ${fn.name}`, type: "aws:lambda/function:Function", name: `${prefix}-${fn.name}` })),
    ...input.cellGraph.tables.map((table) => ({ anvil: `Table ${table.name}`, type: "aws:dynamodb/table:Table", name: `${prefix}-${table.name}` })),
    ...input.cellGraph.secrets.map((secret) => ({ anvil: `Secret ${secret.name}`, type: "aws:ssm/parameter:Parameter", name: `/${prefix}/secrets/${secret.name}` })),
    ...input.cellGraph.functions.map((fn) => ({ anvil: `Permissions for ${fn.name}`, type: "aws:iam/rolePolicy:RolePolicy", name: `${prefix}-${fn.name}-policy` })),
  ];
}

export function deterministicName(appName: string, stage: string): string {
  return `${slug(appName)}-${slug(stage)}`;
}

function createAnvilOutputs(input: DeployInput): Record<string, unknown> {
  const prefix = deterministicName(input.appName, input.stage);
  return { endpointUrl: `https://${prefix}.execute-api.aws.anvil.local`, functions: Object.fromEntries(input.cellGraph.functions.map((fn) => [fn.name, `${prefix}-${fn.name}`])), tables: Object.fromEntries(input.cellGraph.tables.map((table) => [table.name, `${prefix}-${table.name}`])), secrets: Object.fromEntries(input.cellGraph.secrets.map((secret) => [secret.name, `/${prefix}/secrets/${secret.name}`])) };
}

async function loadPulumiEngineIfRequested(input: DeployInput): Promise<void> {
  if (input.options?.executePulumi !== true) return;
  await import("@pulumi/pulumi");
  await import("@pulumi/aws");
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "anvil";
}
