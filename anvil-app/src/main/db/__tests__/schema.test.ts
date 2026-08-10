import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { SCHEMA_SQL } from '../schema';

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
      expect(tableColumns('automation_runs').has('trigger_context_json')).toBe(true);
    } finally {
      db.close();
    }
  });
});
