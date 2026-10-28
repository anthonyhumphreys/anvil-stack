import { RuntimeError } from "./errors.js";
import type {
  DatabasePage,
  DatabasePageOptions,
  DatabaseRecord,
} from "./host.js";

export function databasePageLimit(options: DatabasePageOptions = {}): number {
  const limit = options.limit ?? 100;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new RuntimeError(
      "VALIDATION_ERROR",
      "Page limit must be an integer from 1 to 100.",
      400,
    );
  }
  if (
    options.cursor !== undefined &&
    (typeof options.cursor !== "string" || options.cursor.length === 0)
  ) {
    throw new RuntimeError(
      "VALIDATION_ERROR",
      "Page cursor must be a non-empty record id.",
      400,
    );
  }
  return limit;
}

export function pageDatabaseRecords(
  records: DatabaseRecord[],
  options: DatabasePageOptions = {},
): DatabasePage {
  const limit = databasePageLimit(options);
  const ordered = records
    .filter(
      (row) =>
        options.cursor === undefined ||
        compareIds(String(row.id), options.cursor) > 0,
    )
    .sort((a, b) => compareIds(String(a.id), String(b.id)));
  const page = ordered.slice(0, limit);
  return {
    records: page,
    cursor: ordered.length > limit ? String(page.at(-1)?.id) : null,
  };
}

// D1 and DynamoDB order string keys by UTF-8 bytes, including non-ASCII ids.
function compareIds(left: string, right: string): number {
  const encoder = new TextEncoder();
  const a = encoder.encode(left);
  const b = encoder.encode(right);
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    if (a[i] !== b[i]) return a[i]! - b[i]!;
  }
  return a.length - b.length;
}
