import { existsSync, mkdirSync } from 'node:fs';
import Database from 'better-sqlite3';
import { app } from 'electron';
import path from 'node:path';
import { SCHEMA_SQL, SCHEMA_VERSION, MIGRATIONS } from './schema.js';
import { LEGACY_DB_FILENAME, PRIMARY_DB_FILENAME } from '../../shared/app-identity.js';
import type { AppTheme } from '../../shared/types.js';

let db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (!db) {
    throw new Error('Database not initialised. Call initDatabase() first.');
  }
  return db;
}

export function initDatabase(defaultTheme: AppTheme = 'dark'): void {
  const userDataPath = app.getPath('userData');
  mkdirSync(userDataPath, { recursive: true });
  const primaryDbPath = path.join(userDataPath, PRIMARY_DB_FILENAME);
  const legacyDbPaths = [path.join(userDataPath, LEGACY_DB_FILENAME)];
  const dbPath =
    [primaryDbPath, ...legacyDbPaths].find((candidate) => existsSync(candidate)) ?? primaryDbPath;
  console.log(`[Database] Opening database at ${dbPath}`);

  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  runMigrations(db, defaultTheme);
}

function runMigrations(database: Database.Database, defaultTheme: AppTheme): void {
  database.exec('CREATE TABLE IF NOT EXISTS schema_meta (key TEXT PRIMARY KEY, value TEXT)');

  const row = database
    .prepare("SELECT value FROM schema_meta WHERE key = 'schema_version'")
    .get() as { value: string } | undefined;

  const currentVersion = row ? parseInt(row.value, 10) : 0;

  if (currentVersion < SCHEMA_VERSION) {
    console.log(`[Database] Migrating from v${currentVersion} to v${SCHEMA_VERSION}`);

    if (currentVersion === 0) {
      // Fresh install — run full schema
      database.exec(SCHEMA_SQL);
    } else {
      // Incremental migrations
      for (let v = currentVersion + 1; v <= SCHEMA_VERSION; v++) {
        const migration = MIGRATIONS[v];
        if (migration) {
          console.log(`[Database] Running migration to v${v}`);
          // Run each ALTER statement separately (SQLite doesn't support multiple ALTERs in one exec)
          for (const stmt of migration
            .split(';')
            .map((s) => s.trim())
            .filter(Boolean)) {
            try {
              database.exec(stmt);
            } catch (err) {
              // Column may already exist if user ran a dev build — ignore
              const msg = err instanceof Error ? err.message : '';
              if (msg.includes('duplicate column')) {
                console.log(`[Database] Column already exists, skipping: ${stmt.slice(0, 60)}`);
              } else {
                throw err;
              }
            }
          }
        }
      }
    }

    database
      .prepare("INSERT OR REPLACE INTO schema_meta (key, value) VALUES ('schema_version', ?)")
      .run(String(SCHEMA_VERSION));

    // Ensure settings row exists
    database.exec('INSERT OR IGNORE INTO settings (id) VALUES (1)');
    if (currentVersion === 0 && defaultTheme !== 'dark') {
      database.prepare("UPDATE settings SET theme = 'system' WHERE id = 1").run();
    }

    console.log('[Database] Migration complete');
  }
}
