import type Database from 'better-sqlite3';

export interface ColumnDefinition {
  table: string;
  name: string;
  definition: string;
}

const CONSTRAINT_LINE = /^(PRIMARY|UNIQUE|FOREIGN|CHECK|CONSTRAINT)\b/i;
const COLUMN_LINE = /^([a-z_][a-z0-9_]*)\s+(TEXT|INTEGER|BLOB|REAL|NUMERIC)\b(.*)$/i;

/** Column definitions from the fresh-install schema's `CREATE TABLE` blocks. */
export function parseSchemaColumns(schemaSql: string): ColumnDefinition[] {
  const columns: ColumnDefinition[] = [];
  for (const block of schemaSql.matchAll(/CREATE TABLE IF NOT EXISTS (\w+) \(([\s\S]*?)\n\);/g)) {
    const [, table, body] = block;
    for (const raw of body.split('\n')) {
      const line = raw.trim().replace(/,$/, '');
      if (!line || line.startsWith('--') || CONSTRAINT_LINE.test(line)) continue;
      const match = COLUMN_LINE.exec(line);
      if (match) columns.push({ table, name: match[1], definition: line });
    }
  }
  return columns;
}

/**
 * SQLite's ADD COLUMN can't add keys, unique columns, non-constant defaults,
 * or NOT NULL columns without a default.
 */
export function canAddColumn(definition: string): boolean {
  if (/\bPRIMARY\s+KEY\b|\bUNIQUE\b/i.test(definition)) return false;
  const defaultClause = /\bDEFAULT\s+(.+?)(?:\s+(?:NOT\s+NULL|REFERENCES|CHECK)\b|$)/i.exec(
    definition,
  );
  if (defaultClause && defaultClause[1].trim().startsWith('(')) return false;
  if (/\bNOT\s+NULL\b/i.test(definition) && !defaultClause) return false;
  return true;
}

/**
 * Adds columns the fresh-install schema declares but an existing table lacks.
 * Older fresh installs and stamped dev builds drifted from the migrations
 * (e.g. settings.github_pat); code reading those columns sees `undefined`.
 * Never throws: a column that can't be added is logged and skipped.
 */
export function repairMissingColumns(
  database: Database.Database,
  schemaSql: string,
  log: (message: string) => void = console.log,
): string[] {
  const added: string[] = [];
  const existing = new Map<string, Set<string> | null>();
  const columnsOf = (table: string) => {
    if (!existing.has(table)) {
      const rows = database.prepare(`SELECT name FROM pragma_table_info(?)`).all(table) as Array<{
        name: string;
      }>;
      existing.set(table, rows.length ? new Set(rows.map((row) => row.name)) : null);
    }
    return existing.get(table)!;
  };
  for (const column of parseSchemaColumns(schemaSql)) {
    const have = columnsOf(column.table);
    if (!have || have.has(column.name) || !canAddColumn(column.definition)) continue;
    try {
      database.exec(`ALTER TABLE ${column.table} ADD COLUMN ${column.definition}`);
      have.add(column.name);
      added.push(`${column.table}.${column.name}`);
    } catch (error) {
      log(
        `[Database] Could not repair ${column.table}.${column.name}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  if (added.length) log(`[Database] Repaired missing columns: ${added.join(', ')}`);
  return added;
}
