import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { MIGRATIONS, SCHEMA_SQL, SCHEMA_VERSION } from '../schema';

function applyMigration(db: Database.Database, migration: string): void {
  for (const statement of migration
    .split(';')
    .map((value) => value.trim())
    .filter(Boolean)) {
    try {
      db.exec(statement);
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes('duplicate column')) {
        throw error;
      }
    }
  }
}

describe('fresh database schema', () => {
  it('contains every settings column required by the settings service', () => {
    const db = new Database(':memory:');
    try {
      db.exec(SCHEMA_SQL);
      const columns = new Set(
        (db.prepare('PRAGMA table_info(settings)').all() as Array<{ name: string }>).map(
          (column) => column.name,
        ),
      );
      for (const requiredColumn of [
        'llm_provider',
        'enabled_llm_providers',
        'docs_provider',
        'notion_oauth_token',
        'notion_oauth_expiry',
        'notion_database_id',
        'github_pat',
        'github_username',
        'telemetry_enabled',
      ]) {
        expect(columns.has(requiredColumn), `Missing settings.${requiredColumn}`).toBe(true);
      }
    } finally {
      db.close();
    }
  });

  it('includes Canvas storage and Watchtower trigger columns', () => {
    const db = new Database(':memory:');
    try {
      db.exec(SCHEMA_SQL);
      const tableColumns = (table: string) =>
        new Set(
          (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(
            (column) => column.name,
          ),
        );

      expect(tableColumns('chat_artifacts').has('storage_scope')).toBe(true);
      expect(tableColumns('chat_artifact_revisions').has('storage_scope')).toBe(true);
      expect(tableColumns('automation_definitions').has('trigger_mode')).toBe(true);
      expect(tableColumns('automation_definitions').has('watch_event')).toBe(true);
      expect(tableColumns('automation_definitions').has('watch_target_json')).toBe(true);
      expect(tableColumns('automation_definitions').has('watch_state_json')).toBe(true);
      expect(tableColumns('automation_runs').has('trigger_context_json')).toBe(true);
      expect(tableColumns('watchtower_events').has('source_id')).toBe(true);
      expect(tableColumns('watchtower_events').has('run_id')).toBe(true);
      expect(tableColumns('cloud_execution_connection').has('token')).toBe(true);
      expect(tableColumns('cloud_execution_connection').has('endpoint')).toBe(true);
      expect(tableColumns('chat_threads').has('provider_thread_provider')).toBe(true);
      expect(tableColumns('chat_sessions').has('provider')).toBe(true);
      expect(tableColumns('dojo_configs').has('enabled')).toBe(true);
      expect(tableColumns('dojo_reports').has('metrics_json')).toBe(true);
    } finally {
      db.close();
    }
  });

  it.each([
    {
      name: 'cloud execution version 56',
      setup: `
        CREATE TABLE settings (
          id INTEGER PRIMARY KEY,
          apple_foundation_models_mode TEXT DEFAULT 'off'
        );
        CREATE TABLE cloud_execution_connection (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          endpoint TEXT NOT NULL,
          token BLOB NOT NULL,
          updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
      `,
    },
    {
      name: 'local model version 56',
      setup: `
        CREATE TABLE settings (
          id INTEGER PRIMARY KEY,
          apple_foundation_models_mode TEXT DEFAULT 'off',
          local_llm_mode TEXT DEFAULT 'off',
          local_llm_provider TEXT DEFAULT 'apple',
          local_llm_endpoint TEXT,
          local_llm_model TEXT
        );
      `,
    },
  ])('reconciles a database from $name', ({ setup }) => {
    const db = new Database(':memory:');
    try {
      db.exec(setup);
      applyMigration(db, MIGRATIONS[57]);

      const settingsColumns = new Set(
        (db.prepare('PRAGMA table_info(settings)').all() as Array<{ name: string }>).map(
          (column) => column.name,
        ),
      );
      const cloudColumns = new Set(
        (
          db.prepare('PRAGMA table_info(cloud_execution_connection)').all() as Array<{
            name: string;
          }>
        ).map((column) => column.name),
      );

      expect(SCHEMA_VERSION).toBe(61);
      for (const column of [
        'local_llm_mode',
        'local_llm_provider',
        'local_llm_endpoint',
        'local_llm_model',
      ]) {
        expect(settingsColumns.has(column), `Missing settings.${column}`).toBe(true);
      }
      expect(cloudColumns.has('endpoint')).toBe(true);
      expect(cloudColumns.has('token')).toBe(true);
    } finally {
      db.close();
    }
  });

  it('adds opt-in telemetry disabled by default', () => {
    const db = new Database(':memory:');
    try {
      db.exec('CREATE TABLE settings (id INTEGER PRIMARY KEY)');
      applyMigration(db, MIGRATIONS[58]);
      db.exec('INSERT INTO settings (id) VALUES (1)');

      const row = db.prepare('SELECT telemetry_enabled FROM settings WHERE id = 1').get() as {
        telemetry_enabled: number;
      };
      expect(row.telemetry_enabled).toBe(0);
    } finally {
      db.close();
    }
  });

  it('records Codex as the owner of existing provider thread ids', () => {
    const db = new Database(':memory:');
    try {
      db.exec('CREATE TABLE chat_threads (id TEXT PRIMARY KEY, provider_thread_id TEXT)');
      db.exec("INSERT INTO chat_threads (id, provider_thread_id) VALUES ('thread-1', 'remote-1')");
      applyMigration(db, MIGRATIONS[59]);

      const row = db
        .prepare('SELECT provider_thread_provider FROM chat_threads WHERE id = ?')
        .get('thread-1') as { provider_thread_provider: string };
      expect(row.provider_thread_provider).toBe('codex');
    } finally {
      db.close();
    }
  });

  it('adds Dojo storage and backfills session providers', () => {
    const db = new Database(':memory:');
    try {
      db.exec(`
        CREATE TABLE workspaces (id TEXT PRIMARY KEY);
        CREATE TABLE chat_threads (
          id TEXT PRIMARY KEY,
          provider_thread_provider TEXT
        );
        CREATE TABLE chat_sessions (
          id TEXT PRIMARY KEY,
          thread_id TEXT
        );
        INSERT INTO chat_threads (id, provider_thread_provider) VALUES ('thread-1', 'cursor');
        INSERT INTO chat_sessions (id, thread_id) VALUES ('session-1', 'thread-1');
      `);
      applyMigration(db, MIGRATIONS[60]);

      const session = db
        .prepare('SELECT provider FROM chat_sessions WHERE id = ?')
        .get('session-1') as { provider: string };
      expect(session.provider).toBe('cursor');
      expect(
        db
          .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'dojo_reports'")
          .get(),
      ).toBeTruthy();
    } finally {
      db.close();
    }
  });
});
