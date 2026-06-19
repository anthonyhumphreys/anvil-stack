import type { CellManifest } from "./manifest.js";

export type AnvilCellGraph = {
  schemaVersion: "0.1";
  appName: string;
  cells: Array<{ name: string; runtime: string }>;
  httpRoutes: Array<{ cell: string; method: string; path: string; handler: string; auth: unknown }>;
  functions: Array<{ cell: string; name: string; runtime: string; handler: string }>;
  tables: Array<{ cell: string; name: string; access: "read-write" }>;
  secrets: Array<{ cell: string; name: string }>;
  permissions: Array<{ from: string; action: "read" | "read-write"; to: string; targetKind: "table" | "secret" }>;
};

export type GraphValidationDiagnostic = { code: string; message: string; path: string };

export function createAnvilCellGraph(manifest: CellManifest): AnvilCellGraph {
  const cellName = manifest.cell.name;
  const functions = new Map<string, { cell: string; name: string; runtime: string; handler: string }>();
  const httpRoutes = manifest.endpoints.map((endpoint) => {
    const functionName = endpoint.name;
    const handler = `endpoints.${endpoint.name}.handler`;
    functions.set(functionName, { cell: cellName, name: functionName, runtime: manifest.cell.runtime, handler });
    return { cell: cellName, method: endpoint.method, path: endpoint.path, handler: functionName, auth: endpoint.auth };
  });
  const tables = Object.keys(manifest.schema.tables).map((name) => ({ cell: cellName, name, access: "read-write" as const }));
  const secrets = readSecretNames(manifest.capabilities).map((name) => ({ cell: cellName, name }));
  const permissions = Array.from(functions.keys()).flatMap((functionName) => [
    ...tables.map((table) => ({ from: functionName, action: table.access, to: table.name, targetKind: "table" as const })),
    ...secrets.map((secret) => ({ from: functionName, action: "read" as const, to: secret.name, targetKind: "secret" as const })),
  ]);
  return { schemaVersion: "0.1", appName: manifest.cell.name, cells: [{ name: cellName, runtime: manifest.cell.runtime }], httpRoutes, functions: Array.from(functions.values()), tables, secrets, permissions };
}

export function validateAnvilCellGraph(graph: AnvilCellGraph): GraphValidationDiagnostic[] {
  const diagnostics: GraphValidationDiagnostic[] = [];
  const functions = new Set(graph.functions.map((fn) => fn.name));
  const tables = new Set(graph.tables.map((table) => table.name));
  const secrets = new Set(graph.secrets.map((secret) => secret.name));
  for (const route of graph.httpRoutes) {
    if (!functions.has(route.handler)) diagnostics.push({ code: "GRAPH_ROUTE_HANDLER_MISSING", message: `HTTP route ${route.method} ${route.path} references missing function '${route.handler}'.`, path: `httpRoutes.${route.method} ${route.path}.handler` });
  }
  for (const permission of graph.permissions) {
    const targets = permission.targetKind === "table" ? tables : secrets;
    if (!functions.has(permission.from)) diagnostics.push({ code: "GRAPH_PERMISSION_SOURCE_MISSING", message: `Permission source function '${permission.from}' is missing.`, path: `permissions.${permission.from}` });
    if (!targets.has(permission.to)) diagnostics.push({ code: "GRAPH_PERMISSION_TARGET_MISSING", message: `Permission target '${permission.to}' is missing.`, path: `permissions.${permission.to}` });
  }
  return diagnostics;
}

function readSecretNames(capabilities: Record<string, unknown>): string[] {
  const direct = capabilities.secrets;
  if (Array.isArray(direct)) return direct.filter((value): value is string => typeof value === "string");
  if (direct && typeof direct === "object") return Object.keys(direct as Record<string, unknown>);
  const env = capabilities.env;
  if (Array.isArray(env)) return env.filter((value): value is string => typeof value === "string");
  return [];
}
