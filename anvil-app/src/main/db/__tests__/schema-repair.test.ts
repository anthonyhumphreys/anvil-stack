import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { SCHEMA_SQL } from '../schema';
import { canAddColumn, parseSchemaColumns, repairMissingColumns } from '../schema-repair';

const quiet = () => undefined;

describe('repairMissingColumns', () => {
  it('finds nothing to repair on a fresh install', () => {
    const db = new Database(':memory:');
    try {
      db.exec(SCHEMA_SQL);
      expect(repairMissingColumns(db, SCHEMA_SQL, quiet)).toEqual([]);
    } finally {
      db.close();
    }
  });

  it('restores settings columns older installs never received (github_pat, thread_assist_model)', () => {
    const db = new Database(':memory:');
    try {
      db.exec(SCHEMA_SQL);
      db.exec('INSERT OR IGNORE INTO settings (id) VALUES (1)');
      for (const column of ['github_pat', 'github_username', 'thread_assist_model']) {
        db.exec(`ALTER TABLE settings DROP COLUMN ${column}`);
      }
      expect(repairMissingColumns(db, SCHEMA_SQL, quiet)).toEqual([
        'settings.thread_assist_model',
        'settings.github_pat',
        'settings.github_username',
      ]);
      const row = db.prepare('SELECT * FROM settings WHERE id = 1').get() as Record<
        string,
        unknown
      >;
      expect(row).toHaveProperty('github_pat', null);
      expect(repairMissingColumns(db, SCHEMA_SQL, quiet)).toEqual([]);
    } finally {
      db.close();
    }
  });

  it('parses every column of the settings table', () => {
    const settings = parseSchemaColumns(SCHEMA_SQL).filter((column) => column.table === 'settings');
    expect(settings.map((column) => column.name)).toEqual(
      expect.arrayContaining(['id', 'github_pat', 'github_username', 'llm_gateway_api_key']),
    );
  });

  it('skips definitions SQLite cannot add to an existing table', () => {
    expect(canAddColumn('id INTEGER PRIMARY KEY CHECK (id = 1)')).toBe(false);
    expect(canAddColumn("updated_at TEXT DEFAULT (datetime('now'))")).toBe(false);
    expect(canAddColumn('repo_id TEXT NOT NULL')).toBe(false);
    expect(canAddColumn('cloud_features_enabled INTEGER NOT NULL DEFAULT 0')).toBe(true);
    expect(canAddColumn("theme TEXT DEFAULT 'system'")).toBe(true);
    expect(canAddColumn('github_pat BLOB')).toBe(true);
  });
});
