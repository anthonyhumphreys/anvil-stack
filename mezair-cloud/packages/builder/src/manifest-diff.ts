import type { CellManifest } from "./manifest.js";

export type ManifestDiffSeverity = "info" | "warning" | "error";
export type ManifestDiffAction = "add" | "remove" | "change";
export type ManifestDiffCategory =
  | "agent"
  | "capability"
  | "cell"
  | "client"
  | "endpoint"
  | "job"
  | "mutation"
  | "query"
  | "schema"
  | "service"
  | "workflow";

export type ManifestDiffChange = {
  id: string;
  category: ManifestDiffCategory;
  action: ManifestDiffAction;
  severity: ManifestDiffSeverity;
  path: string;
  message: string;
  before?: unknown;
  after?: unknown;
  hint?: string;
};

export type ManifestDiffSummary = {
  additions: number;
  removals: number;
  changes: number;
  warnings: number;
  errors: number;
};

export type ManifestDiffResult = {
  changed: boolean;
  changes: ManifestDiffChange[];
  summary: ManifestDiffSummary;
};

export function diffCellManifests(
  previous: CellManifest,
  next: CellManifest,
): ManifestDiffResult {
  const changes: ManifestDiffChange[] = [
    ...diffCell(previous, next),
    ...diffClient(previous, next),
    ...diffCapabilities(previous, next),
    ...diffSchema(previous, next),
    ...diffStringList(previous.queries, next.queries, {
      category: "query",
      pathPrefix: "queries",
      removeSeverity: "warning",
      removeHint:
        "Removing a query can break generated clients and deployed callers.",
    }),
    ...diffStringList(previous.mutations, next.mutations, {
      category: "mutation",
      pathPrefix: "mutations",
      removeSeverity: "warning",
      removeHint:
        "Removing a mutation can break generated clients and deployed callers.",
    }),
    ...diffNamedRecords(
      arrayByName(previous.endpoints),
      arrayByName(next.endpoints),
      {
        category: "endpoint",
        pathPrefix: "endpoints",
        removeSeverity: "warning",
        removeHint: "Removing an endpoint can break external HTTP callers.",
        classifyAdd: (_name, endpoint) =>
          endpointAuthMode(endpoint) === "public" ? "warning" : "info",
        classifyChange: (_name, before, after) =>
          endpointAuthMode(before) !== endpointAuthMode(after)
            ? "warning"
            : "info",
      },
    ),
    ...diffNamedRecords(arrayByName(previous.jobs), arrayByName(next.jobs), {
      category: "job",
      pathPrefix: "jobs",
      removeSeverity: "warning",
      removeHint: "Removing a job can strand queued or scheduled work.",
    }),
    ...diffNamedRecords(
      arrayByName(previous.workflows),
      arrayByName(next.workflows),
      {
        category: "workflow",
        pathPrefix: "workflows",
        removeSeverity: "warning",
        removeHint: "Removing a workflow can break resumable or external runs.",
      },
    ),
    ...diffNamedRecords(
      arrayByName(previous.services),
      arrayByName(next.services),
      {
        category: "service",
        pathPrefix: "services",
        removeSeverity: "warning",
        removeHint: "Removing a service can stop background runtime behavior.",
      },
    ),
    ...diffNamedRecords(previous.agents ?? {}, next.agents ?? {}, {
      category: "agent",
      pathPrefix: "agents",
      removeSeverity: "warning",
      removeHint: "Removing an agent can break agent endpoints or workflows.",
    }),
  ];

  changes.sort((left, right) => left.id.localeCompare(right.id));

  return {
    changed: changes.length > 0,
    changes,
    summary: summarizeChanges(changes),
  };
}

function diffCell(
  previous: CellManifest,
  next: CellManifest,
): ManifestDiffChange[] {
  const changes: ManifestDiffChange[] = [];

  for (const key of ["name", "runtime", "target"] as const) {
    if (previous.cell[key] !== next.cell[key]) {
      changes.push({
        id: `cell.${key}.changed`,
        category: "cell",
        action: "change",
        severity: key === "name" ? "warning" : "info",
        path: `cell.${key}`,
        message: `Cell ${key} changed from '${previous.cell[key]}' to '${next.cell[key]}'.`,
        before: previous.cell[key],
        after: next.cell[key],
      });
    }
  }

  return changes;
}

function diffClient(
  previous: CellManifest,
  next: CellManifest,
): ManifestDiffChange[] {
  const changes: ManifestDiffChange[] = [];

  if (!sameJson(previous.client, next.client)) {
    changes.push({
      id: "client.changed",
      category: "client",
      action: "change",
      severity: "info",
      path: "client",
      message: "Client target changed.",
      before: previous.client,
      after: next.client,
    });
  }

  if (!sameJson(previous.entrypoints, next.entrypoints)) {
    changes.push({
      id: "client.entrypoints.changed",
      category: "client",
      action: "change",
      severity: "info",
      path: "entrypoints",
      message: "Build entrypoints changed.",
      before: previous.entrypoints,
      after: next.entrypoints,
    });
  }

  return changes;
}

function diffCapabilities(
  previous: CellManifest,
  next: CellManifest,
): ManifestDiffChange[] {
  const changes: ManifestDiffChange[] = [];
  const keys = sortedUnion(
    Object.keys(previous.capabilities),
    Object.keys(next.capabilities),
  );

  for (const key of keys) {
    const before = previous.capabilities[key];
    const after = next.capabilities[key];

    if (before === undefined && after !== undefined) {
      changes.push({
        id: `capabilities.${key}.added`,
        category: "capability",
        action: "add",
        severity: "warning",
        path: `capabilities.${key}`,
        message: `Capability '${key}' was added.`,
        after,
        hint: "Review new capabilities before preview deployment.",
      });
      continue;
    }

    if (before !== undefined && after === undefined) {
      changes.push({
        id: `capabilities.${key}.removed`,
        category: "capability",
        action: "remove",
        severity: "info",
        path: `capabilities.${key}`,
        message: `Capability '${key}' was removed.`,
        before,
      });
      continue;
    }

    if (!sameJson(before, after)) {
      changes.push({
        id: `capabilities.${key}.changed`,
        category: "capability",
        action: "change",
        severity: publicFileReadEscalated(key, before, after)
          ? "error"
          : "warning",
        path: `capabilities.${key}`,
        message: `Capability '${key}' changed.`,
        before,
        after,
        hint: publicFileReadEscalated(key, before, after)
          ? "Review public file exposure before enabling public reads."
          : "Review capability changes before preview deployment.",
      });
    }
  }

  return changes;
}

function diffSchema(
  previous: CellManifest,
  next: CellManifest,
): ManifestDiffChange[] {
  const changes: ManifestDiffChange[] = [];
  const tableNames = sortedUnion(
    Object.keys(previous.schema.tables),
    Object.keys(next.schema.tables),
  );

  for (const tableName of tableNames) {
    const beforeTable = previous.schema.tables[tableName];
    const afterTable = next.schema.tables[tableName];

    if (!beforeTable && afterTable) {
      changes.push({
        id: `schema.tables.${tableName}.added`,
        category: "schema",
        action: "add",
        severity: "info",
        path: `schema.tables.${tableName}`,
        message: `Schema table '${tableName}' was added.`,
        after: afterTable,
      });
      continue;
    }

    if (beforeTable && !afterTable) {
      changes.push({
        id: `schema.tables.${tableName}.removed`,
        category: "schema",
        action: "remove",
        severity: "error",
        path: `schema.tables.${tableName}`,
        message: `Schema table '${tableName}' was removed.`,
        before: beforeTable,
        hint: "Add an explicit migration plan before removing Cell-owned data tables.",
      });
      continue;
    }

    if (!beforeTable || !afterTable) {
      continue;
    }

    const fieldNames = sortedUnion(
      Object.keys(beforeTable.fields),
      Object.keys(afterTable.fields),
    );

    for (const fieldName of fieldNames) {
      const beforeField = beforeTable.fields[fieldName];
      const afterField = afterTable.fields[fieldName];
      const path = `schema.tables.${tableName}.fields.${fieldName}`;

      if (!beforeField && afterField) {
        changes.push({
          id: `${path}.added`,
          category: "schema",
          action: "add",
          severity: "info",
          path,
          message: `Schema field '${tableName}.${fieldName}' was added.`,
          after: afterField,
        });
        continue;
      }

      if (beforeField && !afterField) {
        changes.push({
          id: `${path}.removed`,
          category: "schema",
          action: "remove",
          severity: "error",
          path,
          message: `Schema field '${tableName}.${fieldName}' was removed.`,
          before: beforeField,
          hint: "Add an explicit migration plan before removing Cell-owned data fields.",
        });
        continue;
      }

      if (!beforeField || !afterField || sameJson(beforeField, afterField)) {
        continue;
      }

      const typeChanged = fieldType(beforeField) !== fieldType(afterField);
      changes.push({
        id: `${path}.changed`,
        category: "schema",
        action: "change",
        severity: typeChanged ? "error" : "warning",
        path,
        message: typeChanged
          ? `Schema field '${tableName}.${fieldName}' changed type from '${fieldType(beforeField)}' to '${fieldType(afterField)}'.`
          : `Schema field '${tableName}.${fieldName}' constraints changed.`,
        before: beforeField,
        after: afterField,
        hint: typeChanged
          ? "Add an explicit migration plan before changing Cell-owned data field types."
          : "Review generated client and validation behavior for constraint changes.",
      });
    }
  }

  return changes;
}

function diffStringList(
  previous: string[],
  next: string[],
  options: {
    category: ManifestDiffCategory;
    pathPrefix: string;
    removeSeverity: ManifestDiffSeverity;
    removeHint: string;
  },
): ManifestDiffChange[] {
  return diffNamedRecords(
    Object.fromEntries(previous.map((name) => [name, name])),
    Object.fromEntries(next.map((name) => [name, name])),
    options,
  );
}

function diffNamedRecords<T>(
  previous: Record<string, T>,
  next: Record<string, T>,
  options: {
    category: ManifestDiffCategory;
    pathPrefix: string;
    removeSeverity: ManifestDiffSeverity;
    removeHint: string;
    classifyAdd?: (name: string, value: T) => ManifestDiffSeverity;
    classifyChange?: (
      name: string,
      before: T,
      after: T,
    ) => ManifestDiffSeverity;
  },
): ManifestDiffChange[] {
  const changes: ManifestDiffChange[] = [];
  const names = sortedUnion(Object.keys(previous), Object.keys(next));

  for (const name of names) {
    const before = previous[name];
    const after = next[name];
    const path = `${options.pathPrefix}.${name}`;

    if (before === undefined && after !== undefined) {
      const severity = options.classifyAdd?.(name, after) ?? "info";
      changes.push({
        id: `${path}.added`,
        category: options.category,
        action: "add",
        severity,
        path,
        message: `${labelFor(options.category)} '${name}' was added.`,
        after,
      });
      continue;
    }

    if (before !== undefined && after === undefined) {
      changes.push({
        id: `${path}.removed`,
        category: options.category,
        action: "remove",
        severity: options.removeSeverity,
        path,
        message: `${labelFor(options.category)} '${name}' was removed.`,
        before,
        hint: options.removeHint,
      });
      continue;
    }

    if (
      before !== undefined &&
      after !== undefined &&
      !sameJson(before, after)
    ) {
      changes.push({
        id: `${path}.changed`,
        category: options.category,
        action: "change",
        severity: options.classifyChange?.(name, before, after) ?? "info",
        path,
        message: `${labelFor(options.category)} '${name}' changed.`,
        before,
        after,
      });
    }
  }

  return changes;
}

function summarizeChanges(changes: ManifestDiffChange[]): ManifestDiffSummary {
  return {
    additions: changes.filter((change) => change.action === "add").length,
    removals: changes.filter((change) => change.action === "remove").length,
    changes: changes.filter((change) => change.action === "change").length,
    warnings: changes.filter((change) => change.severity === "warning").length,
    errors: changes.filter((change) => change.severity === "error").length,
  };
}

function arrayByName<T extends { name: string }>(
  items: T[],
): Record<string, T> {
  return Object.fromEntries(items.map((item) => [item.name, item]));
}

function sortedUnion(left: string[], right: string[]): string[] {
  return Array.from(new Set([...left, ...right])).sort((a, b) =>
    a.localeCompare(b),
  );
}

function sameJson(left: unknown, right: unknown): boolean {
  return stableStringify(left) === stableStringify(right);
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }

  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
      .join(",")}}`;
  }

  return JSON.stringify(value);
}

function publicFileReadEscalated(
  key: string,
  before: unknown,
  after: unknown,
): boolean {
  return (
    key === "files" &&
    filesPublicRead(before) !== true &&
    filesPublicRead(after) === true
  );
}

function filesPublicRead(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    "publicRead" in value &&
    value.publicRead === true
  );
}

function endpointAuthMode(value: unknown): string | undefined {
  if (
    typeof value === "object" &&
    value !== null &&
    "auth" in value &&
    typeof value.auth === "object" &&
    value.auth !== null &&
    "mode" in value.auth &&
    typeof value.auth.mode === "string"
  ) {
    return value.auth.mode;
  }

  return undefined;
}

function fieldType(value: unknown): string {
  if (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    typeof value.type === "string"
  ) {
    return value.type;
  }

  return "unknown";
}

function labelFor(category: ManifestDiffCategory): string {
  switch (category) {
    case "query":
      return "Query";
    case "mutation":
      return "Mutation";
    case "endpoint":
      return "Endpoint";
    case "job":
      return "Job";
    case "workflow":
      return "Workflow";
    case "service":
      return "Service";
    case "agent":
      return "Agent";
    default:
      return "Manifest item";
  }
}
