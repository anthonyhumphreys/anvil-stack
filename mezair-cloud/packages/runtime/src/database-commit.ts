import { RuntimeError } from "./errors.js";
import type { DatabaseRecord, DatabaseWrite } from "./host.js";

export const MAX_DATABASE_COMMIT_WRITES = 25;

export function validateDatabaseWrites(writes: readonly DatabaseWrite[]): void {
  if (
    !Array.isArray(writes) ||
    writes.length < 1 ||
    writes.length > MAX_DATABASE_COMMIT_WRITES
  ) {
    throw new RuntimeError(
      "VALIDATION_ERROR",
      `A database commit requires 1 to ${MAX_DATABASE_COMMIT_WRITES} writes.`,
      400,
    );
  }
  if (
    new TextEncoder().encode(databaseRecordJson(writes)).length >
    1024 * 1024
  ) {
    throw new RuntimeError(
      "VALIDATION_ERROR",
      "A database commit cannot exceed 1 MiB.",
      400,
    );
  }
  const keys = new Set<string>();
  for (const write of writes) {
    if (
      !write ||
      typeof write.table !== "string" ||
      !write.table ||
      ["__proto__", "constructor", "prototype"].includes(write.table) ||
      typeof write.id !== "string" ||
      !write.id ||
      new TextEncoder().encode(write.id).length > 1024 ||
      new TextEncoder().encode(write.table).length > 255
    ) {
      throw new RuntimeError(
        "VALIDATION_ERROR",
        "Every write needs a table name up to 255 UTF-8 bytes and a record id up to 1024 UTF-8 bytes.",
        400,
      );
    }
    const key = JSON.stringify([write.table, write.id]);
    if (keys.has(key))
      throw new RuntimeError(
        "VALIDATION_ERROR",
        "A database commit cannot write the same record twice.",
        400,
      );
    keys.add(key);
    for (const record of [write.record, write.expected]) {
      if (
        record !== null &&
        (typeof record !== "object" ||
          Array.isArray(record) ||
          record.id !== write.id)
      ) {
        throw new RuntimeError(
          "VALIDATION_ERROR",
          "Commit records must include the matching id, or be null.",
          400,
        );
      }
      if (record !== null) {
        const json = databaseRecordJson(record);
        if (new TextEncoder().encode(json).length > 256 * 1024) {
          throw new RuntimeError(
            "VALIDATION_ERROR",
            "Commit records cannot exceed 256 KiB.",
            400,
          );
        }
      }
    }
  }
}

export function databaseConflict(): RuntimeError {
  return new RuntimeError(
    "CONFLICT",
    "A record changed before the database commit. Read the latest records and retry.",
    409,
  );
}

/** A JSON snapshot is staged before validation so failed conditions cannot leak writes. */
export function applyDatabaseWrites(
  snapshot: Record<string, DatabaseRecord[]>,
  writes: readonly DatabaseWrite[],
): Record<string, DatabaseRecord[]> {
  validateDatabaseWrites(writes);
  const next = structuredClone(snapshot);
  for (const write of writes) {
    const current =
      (next[write.table] ?? []).find((record) => record.id === write.id) ??
      null;
    if (databaseRecordJson(current) !== databaseRecordJson(write.expected))
      throw databaseConflict();
    const rows = (next[write.table] ?? []).filter(
      (record) => record.id !== write.id,
    );
    if (write.record) rows.push(structuredClone(write.record));
    next[write.table] = rows;
  }
  return next;
}

/** Stable JSON for equality checks across adapters. Reject values JSON would silently change. */
export function databaseRecordJson(value: unknown): string {
  const ancestors = new Set<object>();
  const visit = (item: unknown): unknown => {
    if (item === null || typeof item === "string" || typeof item === "boolean")
      return item;
    if (typeof item === "number" && Number.isFinite(item)) return item;
    if (
      typeof item !== "object" ||
      ancestors.has(item) ||
      (!Array.isArray(item) &&
        Object.getPrototypeOf(item) !== Object.prototype &&
        Object.getPrototypeOf(item) !== null)
    ) {
      throw new RuntimeError(
        "VALIDATION_ERROR",
        "Database records must contain only JSON values.",
        400,
      );
    }
    ancestors.add(item);
    const result = Array.isArray(item)
      ? Array.from(item, visit)
      : Object.fromEntries(
          Object.entries(item)
            .sort(([left], [right]) =>
              left < right ? -1 : left > right ? 1 : 0,
            )
            .map(([key, child]) => [key, visit(child)]),
        );
    ancestors.delete(item);
    return result;
  };
  return JSON.stringify(visit(value));
}
