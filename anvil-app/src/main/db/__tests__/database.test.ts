import Database from 'better-sqlite3';
import { describe, expect, it, vi } from 'vitest';
import { runMigrations } from '../database';
import { MIGRATIONS, SCHEMA_SQL, SCHEMA_VERSION } from '../schema';
import { MAIN_V67_SCHEMA_SQL } from './schema-merge-fixtures';

vi.mock('electron', () => ({ app: {} }));

describe('legacy database startup', () => {
  it.each([68, 69, 81])('repairs missing sync tables after migration v%i', (throughVersion) => {
    const version = Math.min(throughVersion, 69);
    const db = new Database(':memory:');
    const fresh = new Database(':memory:');
    try {
      db.exec(MAIN_V67_SCHEMA_SQL);
      db.prepare("INSERT OR REPLACE INTO schema_meta VALUES ('schema_version', ?)").run(
        String(version),
      );
      db.exec("INSERT INTO settings (id, llm_provider) VALUES (1, 'cursor')");

      if (throughVersion === 81) {
        // Reproduce the persisted state after the old repair got as far as v82.
        db.exec(MIGRATIONS[68]);
        for (const table of ['sync_bindings', 'sync_outbox', 'sync_state', 'sync_conflicts']) {
          db.exec(`DROP TABLE ${table}`);
        }
        for (let migration = 69; migration <= 81; migration += 1) {
          for (const statement of MIGRATIONS[migration]
            .replace(/^[ \t]*--[^\r\n]*/gm, '')
            .split(';')
            .map((value) => value.trim())
            .filter(Boolean)) {
            try {
              db.exec(statement);
            } catch (error) {
              if (!(error instanceof Error) || !error.message.includes('duplicate column'))
                throw error;
            }
          }
        }
      }

      runMigrations(db, 'dark');
      // A second startup must leave the upgraded database usable.
      runMigrations(db, 'dark');
      fresh.exec(SCHEMA_SQL);
      const tables = (database: Database.Database) =>
        database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all();
      expect(tables(db)).toEqual(tables(fresh));
      for (const { name } of tables(fresh) as Array<{ name: string }>) {
        const columns = (database: Database.Database) =>
          (database.prepare(`PRAGMA table_info(${name})`).all() as Array<{ name: string }>)
            .map((column) => column.name)
            .sort();
        expect(columns(db), name).toEqual(columns(fresh));
      }
      expect(
        db.prepare("SELECT value FROM schema_meta WHERE key = 'schema_version'").get(),
      ).toEqual({
        value: String(SCHEMA_VERSION),
      });
      expect(db.prepare('SELECT llm_provider FROM settings WHERE id = 1').get()).toEqual({
        llm_provider: 'cursor',
      });
    } finally {
      db.close();
      fresh.close();
    }
  });
});
