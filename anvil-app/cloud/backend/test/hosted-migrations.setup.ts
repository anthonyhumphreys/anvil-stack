// Applies migrations/hosted-billing/*.sql to the per-file D1 database
// before any test module evaluates — several suites construct fixtures at
// module scope, so beforeEach is too late. `d1_migrations` bookkeeping
// makes the application idempotent for suites that also apply migrations
// themselves.

import { env } from 'cloudflare:test';

import migration0001 from '../migrations/hosted-billing/0001_init.sql?raw';
import migration0002 from '../migrations/hosted-billing/0002_billing.sql?raw';
import migration0003 from '../migrations/hosted-billing/0003_preview_flag.sql?raw';

const MIGRATIONS: { id: string; sql: string }[] = [
  { id: '0001_init', sql: migration0001 },
  { id: '0002_billing', sql: migration0002 },
  { id: '0003_preview_flag', sql: migration0003 },
];

function statementsOf(sql: string): string[] {
  return sql
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n')
    .split(';')
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
}

const db = env.HOSTED_DB;
if (db !== undefined) {
  await db
    .prepare(
      'CREATE TABLE IF NOT EXISTS d1_migrations (id TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)',
    )
    .run();
  for (const migration of MIGRATIONS) {
    const seen = await db
      .prepare('SELECT id FROM d1_migrations WHERE id = ?')
      .bind(migration.id)
      .first();
    if (seen !== null) continue;
    await db.batch(
      statementsOf(migration.sql).map((statement) => db.prepare(statement)),
    );
    await db
      .prepare('INSERT INTO d1_migrations (id, applied_at) VALUES (?, ?)')
      .bind(migration.id, Date.now())
      .run();
  }
}
