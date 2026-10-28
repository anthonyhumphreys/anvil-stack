import type { D1Database, D1DatabaseSession } from "@cloudflare/workers-types";
import {
  RuntimeError,
  databaseConflict,
  databasePageLimit,
  databaseRecordJson,
  validateDatabaseWrites,
  type DatabaseAdapter,
  type DatabasePageOptions,
  type DatabaseRecord,
  type DatabaseTableClient,
  type DatabaseWhereOperator,
  type DatabaseWrite,
} from "@mezair-cloud/runtime";

/** Apply through a D1 migration before serving requests. No request-time DDL. */
export const CLOUDFLARE_DATABASE_MIGRATION = `
CREATE TABLE IF NOT EXISTS mezair_records (
  table_name TEXT NOT NULL,
  id TEXT NOT NULL,
  data TEXT NOT NULL CHECK(json_valid(data)),
  PRIMARY KEY (table_name, id)
);
CREATE TABLE IF NOT EXISTS mezair_commit_guard (
  id TEXT PRIMARY KEY,
  ok INTEGER NOT NULL CHECK(ok = 1)
);
`;

export class CloudflareD1DatabaseAdapter implements DatabaseAdapter {
  constructor(private readonly database: D1Database) {}

  table(name: string): DatabaseTableClient {
    const session = () => this.database.withSession("first-primary");
    const get = async (id: string) => {
      const row = await session()
        .prepare(
          "SELECT data FROM mezair_records WHERE table_name = ? AND id = ?",
        )
        .bind(name, id)
        .first<{ data: string }>();
      return row ? parseRecord(row.data) : null;
    };
    const page = async (options: DatabasePageOptions = {}) => {
      const limit = databasePageLimit(options);
      const result = await session()
        .prepare(
          "SELECT data FROM mezair_records WHERE table_name = ? AND id > ? ORDER BY id LIMIT ?",
        )
        .bind(name, options.cursor ?? "", limit + 1)
        .all<{ data: string }>();
      const records = result.results
        .slice(0, limit)
        .map((row) => parseRecord(row.data));
      return {
        records,
        cursor:
          result.results.length > limit ? String(records.at(-1)?.id) : null,
      };
    };
    const all = async () => {
      const records: DatabaseRecord[] = [];
      let cursor: string | null = null;
      do {
        const result = await page(cursor === null ? {} : { cursor });
        records.push(...result.records);
        cursor = result.cursor;
      } while (cursor !== null);
      return records;
    };
    const put = async (record: DatabaseRecord) => {
      const stored = {
        ...record,
        id:
          record.id === undefined
            ? `${name}_${crypto.randomUUID()}`
            : String(record.id),
      };
      await session()
        .prepare(
          "INSERT INTO mezair_records (table_name, id, data) VALUES (?, ?, ?) ON CONFLICT(table_name, id) DO UPDATE SET data = excluded.data",
        )
        .bind(name, stored.id, databaseRecordJson(stored))
        .run();
      return structuredClone(stored);
    };
    const matching = async (
      field: string,
      operator: DatabaseWhereOperator,
      value: unknown,
    ) =>
      (await all()).filter((record) => compare(record[field], operator, value));
    return {
      all,
      page,
      get,
      insert: put,
      update: async (id, patch) => {
        const previous = await get(id);
        if (!previous)
          throw new RuntimeError(
            "NOT_FOUND",
            `Record '${id}' does not exist in table '${name}'.`,
            404,
          );
        const record = { ...previous, ...patch, id };
        await this.commit([{ table: name, id, expected: previous, record }]);
        return record;
      },
      delete: async (id) => {
        const previous = await get(id);
        if (!previous) return false;
        await this.commit([
          { table: name, id, expected: previous, record: null },
        ]);
        return true;
      },
      where: (field, operator, value) => ({
        all: () => matching(field, operator, value),
        first: async () => (await matching(field, operator, value))[0] ?? null,
        count: async () => (await matching(field, operator, value)).length,
      }),
    };
  }

  async commit(writes: readonly DatabaseWrite[]): Promise<void> {
    validateDatabaseWrites(writes);
    const session = this.database.withSession("first-primary");
    const guardId = crypto.randomUUID();
    const bindings: string[] = [guardId];
    const conditions = writes.map((write) => {
      bindings.push(write.table, write.id);
      if (write.expected === null)
        return "NOT EXISTS (SELECT 1 FROM mezair_records WHERE table_name = ? AND id = ?)";
      bindings.push(databaseRecordJson(write.expected));
      return "EXISTS (SELECT 1 FROM mezair_records WHERE table_name = ? AND id = ? AND data = ?)";
    });
    const guard = session
      .prepare(
        `INSERT INTO mezair_commit_guard (id, ok) SELECT ?, CASE WHEN ${conditions.join(" AND ")} THEN 1 ELSE 0 END`,
      )
      .bind(...bindings);
    try {
      // D1 batch rolls back every statement if the guard's CHECK fails.
      await session.batch([
        guard,
        ...writes.map((write) => writeStatement(session, write)),
        session
          .prepare("DELETE FROM mezair_commit_guard WHERE id = ?")
          .bind(guardId),
      ]);
    } catch (error) {
      if (
        error instanceof Error &&
        error.message.includes("CHECK constraint failed: ok = 1")
      )
        throw databaseConflict();
      throw error;
    }
  }
}

function writeStatement(session: D1DatabaseSession, write: DatabaseWrite) {
  return write.record === null
    ? session
        .prepare("DELETE FROM mezair_records WHERE table_name = ? AND id = ?")
        .bind(write.table, write.id)
    : session
        .prepare(
          "INSERT INTO mezair_records (table_name, id, data) VALUES (?, ?, ?) ON CONFLICT(table_name, id) DO UPDATE SET data = excluded.data",
        )
        .bind(write.table, write.id, databaseRecordJson(write.record));
}

function parseRecord(data: string): DatabaseRecord {
  return JSON.parse(data) as DatabaseRecord;
}

function compare(
  left: unknown,
  operator: DatabaseWhereOperator,
  right: unknown,
): boolean {
  if (operator === "=") return left === right;
  if (operator === "!=") return left !== right;
  if (
    typeof left !== typeof right ||
    (typeof left !== "number" && typeof left !== "string")
  )
    return false;
  const a = left as string | number;
  const b = right as string | number;
  switch (operator) {
    case ">":
      return a > b;
    case ">=":
      return a >= b;
    case "<":
      return a < b;
    case "<=":
      return a <= b;
  }
}
