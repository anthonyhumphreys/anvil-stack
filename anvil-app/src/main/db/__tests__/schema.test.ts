import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { LEGACY_SCHEMA_REPAIR_SQL, MIGRATIONS, SCHEMA_SQL, SCHEMA_VERSION } from '../schema';
import {
  MAIN_V67_SCHEMA_SQL,
  MERGE_BASE_V66_SCHEMA_SQL,
  PRE_MERGE_BRANCH_MIGRATIONS,
} from './schema-merge-fixtures';

function applyMigration(db: Database.Database, migration: string): void {
  for (const statement of migration
    .replace(/^[ \t]*--[^\r\n]*/gm, '')
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
        'llm_gateway_api_key',
        'llm_gateway_billing_mode',
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

  it('includes the MOB-01 companion enrollment policy table', () => {
    const db = new Database(':memory:');
    try {
      db.exec(SCHEMA_SQL);
      const columns = new Set(
        (
          db.prepare('PRAGMA table_info(companion_enrollment_policies)').all() as Array<{
            name: string;
          }>
        ).map((column) => column.name),
      );
      for (const requiredColumn of [
        'enrollment_id',
        'account_id',
        'display_name',
        'tier',
        'first_seen_at',
        'decided_at',
        'updated_at',
      ]) {
        expect(columns.has(requiredColumn), `Missing ${requiredColumn}`).toBe(true);
      }
      // Migration 80 is idempotent over a fresh schema.
      applyMigration(db, MIGRATIONS[80]);
      expect(
        db
          .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'companion_enrollment_policies'",
          )
          .get(),
      ).toEqual({ name: 'companion_enrollment_policies' });
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

      expect(SCHEMA_VERSION).toBe(97);
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

  it('includes the sync mesh persistence tables', () => {
    const db = new Database(':memory:');
    try {
      db.exec(SCHEMA_SQL);
      const tableColumns = (table: string) =>
        new Set(
          (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(
            (column) => column.name,
          ),
        );

      expect(tableColumns('device_enrollments').has('enrollment_generation')).toBe(true);
      expect(tableColumns('device_enrollments').has('revoked_at')).toBe(true);
      expect(tableColumns('sync_bindings').has('base_payload_json')).toBe(true);
      expect(tableColumns('sync_bindings').has('local_edit_generation')).toBe(true);
      expect(tableColumns('sync_bindings').has('acknowledged_generation')).toBe(true);
      expect(tableColumns('sync_outbox').has('enrollment_sequence')).toBe(true);
      expect(tableColumns('sync_outbox').has('payload_hash')).toBe(true);
      expect(tableColumns('sync_outbox').has('result_json')).toBe(true);
      expect(tableColumns('sync_state').has('consumed_sequence_high_water')).toBe(true);
      expect(tableColumns('sync_state').has('reset_required')).toBe(true);
      expect(tableColumns('sync_conflicts').has('remote_payload_json')).toBe(true);
      expect(tableColumns('sync_conflicts').has('resolution')).toBe(true);
      expect(tableColumns('sync_backends').has('base_url')).toBe(true);
      expect(tableColumns('sync_backends').has('deployment_id')).toBe(true);
      expect(tableColumns('sync_backends').has('display_name')).toBe(true);
      expect(tableColumns('sync_backends').has('profiles_json')).toBe(true);
      expect(tableColumns('sync_backends').has('auth_modes_json')).toBe(true);
      expect(tableColumns('sync_backends').has('pinned_descriptor_json')).toBe(true);
      expect(tableColumns('sync_backends').has('state')).toBe(true);
      expect(tableColumns('sync_backends').has('created_at')).toBe(true);
      expect(tableColumns('sync_backends').has('updated_at')).toBe(true);
      expect(tableColumns('sync_entitlement').has('backend_id')).toBe(true);
      expect(tableColumns('sync_entitlement').has('account_id')).toBe(true);
      expect(tableColumns('sync_entitlement').has('state')).toBe(true);
      expect(tableColumns('sync_entitlement').has('source')).toBe(true);
      expect(tableColumns('sync_entitlement').has('checked_at')).toBe(true);
      expect(tableColumns('sync_entitlement').has('revision')).toBe(true);
      expect(tableColumns('sync_entitlement').has('reason')).toBe(true);
      expect(tableColumns('sync_entitlement').has('restricted')).toBe(true);

      const indexes = new Set(
        (
          db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all() as Array<{
            name: string;
          }>
        ).map((row) => row.name),
      );
      expect(indexes.has('uq_sync_bindings_scope_entity')).toBe(true);
      expect(indexes.has('idx_sync_outbox_scope_state')).toBe(true);
      expect(indexes.has('uq_sync_outbox_dispatched_entity')).toBe(true);
      expect(indexes.has('idx_sync_conflicts_scope_entity')).toBe(true);
      expect(indexes.has('uq_sync_backends_one_active')).toBe(true);
    } finally {
      db.close();
    }
  });

  it('includes explicit browser workspace grant and receipt storage', () => {
    const db = new Database(':memory:');
    try {
      db.exec(SCHEMA_SQL);
      const grantColumns = new Set(
        (
          db.prepare('PRAGMA table_info(mesh_dashboard_grants)').all() as Array<{ name: string }>
        ).map((column) => column.name),
      );
      expect(grantColumns.has('workspace_id')).toBe(true);
      expect(grantColumns.has('repo_ids_json')).toBe(true);
      expect(grantColumns.has('enrollment_id')).toBe(true);
      const receiptColumns = new Set(
        (
          db.prepare('PRAGMA table_info(mesh_browser_command_receipts)').all() as Array<{
            name: string;
          }>
        ).map((column) => column.name),
      );
      expect(receiptColumns.has('payload_hash')).toBe(true);
      expect(receiptColumns.has('command_envelope_json')).toBe(true);
      expect(receiptColumns.has('claim_fence')).toBe(true);
      expect(receiptColumns.has('result_wrapped')).toBe(true);
      expect(receiptColumns.has('result_envelope_json')).toBe(true);
      expect(receiptColumns.has('result_published')).toBe(true);
      expect(receiptColumns.has('state')).toBe(true);
    } finally {
      db.close();
    }
  });

  it('migrates a v68 database to the backend association table', () => {
    const db = new Database(':memory:');
    try {
      db.exec('CREATE TABLE settings (id INTEGER PRIMARY KEY)');
      applyMigration(db, MIGRATIONS[69]);
      const tables = new Set(
        (
          db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{
            name: string;
          }>
        ).map((row) => row.name),
      );
      expect(tables.has('sync_backends'), 'Missing table sync_backends').toBe(true);
      const columns = new Set(
        (db.prepare('PRAGMA table_info(sync_backends)').all() as Array<{ name: string }>).map(
          (column) => column.name,
        ),
      );
      for (const column of [
        'id',
        'base_url',
        'deployment_id',
        'display_name',
        'profiles_json',
        'auth_modes_json',
        'pinned_descriptor_json',
        'state',
        'created_at',
        'updated_at',
      ]) {
        expect(columns.has(column), `Missing sync_backends.${column}`).toBe(true);
      }
      const indexes = new Set(
        (
          db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all() as Array<{
            name: string;
          }>
        ).map((row) => row.name),
      );
      expect(indexes.has('uq_sync_backends_one_active')).toBe(true);

      db.exec(`
        INSERT INTO sync_backends (
          id, base_url, deployment_id, display_name, profiles_json, auth_modes_json,
          pinned_descriptor_json, state, created_at, updated_at
        ) VALUES (
          'one', 'https://one.example/', 'one', 'One', '[]', '[]', '{}', 'active',
          '2026-09-11T00:00:00.000Z', '2026-09-11T00:00:00.000Z'
        )
      `);
      expect(() =>
        db.exec(`
          INSERT INTO sync_backends (
            id, base_url, deployment_id, display_name, profiles_json, auth_modes_json,
            pinned_descriptor_json, state, created_at, updated_at
          ) VALUES (
            'two', 'https://two.example/', 'two', 'Two', '[]', '[]', '{}', 'active',
            '2026-09-11T00:00:00.000Z', '2026-09-11T00:00:00.000Z'
          )
        `),
      ).toThrow(/unique/i);
    } finally {
      db.close();
    }
  });

  it('repairs a v68 database missing device enrollments before v70 alters it', () => {
    const db = new Database(':memory:');
    try {
      db.exec(`
        CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT);
        INSERT INTO schema_meta (key, value) VALUES ('schema_version', '68');
      `);

      // This is the historical collision: v68 is stamped, but the table from
      // the pre-merge v67 migration was never created.
      db.exec(LEGACY_SCHEMA_REPAIR_SQL);
      applyMigration(db, MIGRATIONS[69]);
      applyMigration(db, MIGRATIONS[70]);

      const columns = new Set(
        (db.prepare('PRAGMA table_info(device_enrollments)').all() as Array<{ name: string }>).map(
          (column) => column.name,
        ),
      );
      expect(columns.has('next_sequence')).toBe(true);
      expect(
        db
          .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'sync_backends'")
          .get(),
      ).toEqual({ name: 'sync_backends' });
    } finally {
      db.close();
    }
  });

  it('migrates a v67 database to the sync mesh tables', () => {
    const db = new Database(':memory:');
    try {
      db.exec('CREATE TABLE settings (id INTEGER PRIMARY KEY)');
      applyMigration(db, MIGRATIONS[68]);
      const tables = new Set(
        (
          db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{
            name: string;
          }>
        ).map((row) => row.name),
      );
      for (const table of [
        'device_enrollments',
        'sync_bindings',
        'sync_outbox',
        'sync_state',
        'sync_conflicts',
      ]) {
        expect(tables.has(table), `Missing table ${table}`).toBe(true);
      }
    } finally {
      db.close();
    }
  });

  it('migrates a v78 database to the hosted entitlement table', () => {
    const db = new Database(':memory:');
    try {
      applyMigration(db, MIGRATIONS[79]);
      const columns = new Set(
        (db.prepare('PRAGMA table_info(sync_entitlement)').all() as Array<{ name: string }>).map(
          (column) => column.name,
        ),
      );
      for (const column of [
        'backend_id',
        'account_id',
        'state',
        'source',
        'plan_key',
        'preview_ends_at',
        'access_until',
        'grace_until',
        'checked_at',
        'revision',
        'reason',
        'restricted',
        'updated_at',
      ]) {
        expect(columns.has(column), `Missing column ${column}`).toBe(true);
      }
      // Re-running must be a no-op for databases that already have the table.
      applyMigration(db, MIGRATIONS[79]);
    } finally {
      db.close();
    }
  });

  it.each(['main', 'review development', 'workflow development'])(
    'reconciles version 62 from %s without losing review records',
    (variant) => {
      const db = new Database(':memory:');
      try {
        db.exec(SCHEMA_SQL);
        db.exec('ALTER TABLE automation_definitions DROP COLUMN workflow_template_id');
        if (variant !== 'main') {
          db.exec(`
            DROP TABLE change_reviews;
            DROP TABLE scoped_work_items_cache;
            ALTER TABLE code_reviews DROP COLUMN source_tree;
            ALTER TABLE security_audits DROP COLUMN source_tree;
          `);
        }
        if (variant === 'workflow development') {
          db.exec('ALTER TABLE automation_definitions ADD COLUMN workflow_template_id TEXT');
        }
        db.exec(`
          INSERT INTO repos (id, name, path) VALUES ('repo', 'Repo', '/repo');
          INSERT INTO code_reviews (id, repo_id, mode, scope_type)
            VALUES ('review', 'repo', 'quick_glance', 'latest_commit');
        `);
        applyMigration(db, MIGRATIONS[63]);
        applyMigration(db, MIGRATIONS[64]);
        expect(db.prepare('SELECT id, source_tree FROM code_reviews').get()).toEqual({
          id: 'review',
          source_tree: null,
        });
        expect(db.prepare('SELECT workflow_template_id FROM automation_definitions').all()).toEqual(
          [],
        );
        expect(db.prepare('SELECT * FROM change_reviews').all()).toEqual([]);
        expect(db.prepare('SELECT * FROM scoped_work_items_cache').all()).toEqual([]);
        expect(db.prepare('SELECT source_tree FROM security_audits').all()).toEqual([]);
      } finally {
        db.close();
      }
    },
  );

  it('reconciles a v65 database missing the v20 docs columns', () => {
    const db = new Database(':memory:');
    try {
      db.exec('CREATE TABLE settings (id INTEGER PRIMARY KEY, confluence_base_url TEXT)');
      applyMigration(db, MIGRATIONS[66]);
      // Re-running must be a no-op for databases that already have the columns.
      applyMigration(db, MIGRATIONS[66]);

      const columns = new Set(
        (db.prepare('PRAGMA table_info(settings)').all() as Array<{ name: string }>).map(
          (column) => column.name,
        ),
      );
      for (const column of [
        'docs_provider',
        'notion_oauth_token',
        'notion_oauth_expiry',
        'notion_database_id',
      ]) {
        expect(columns.has(column), `Missing settings.${column}`).toBe(true);
      }
    } finally {
      db.close();
    }
  });

  it('adds LLMGateway credentials when upgrading a current main database', () => {
    const db = new Database(':memory:');
    try {
      db.exec(SCHEMA_SQL);
      db.exec(`
        INSERT INTO settings (id, llm_provider, docs_provider)
        VALUES (1, 'cursor', 'notion');
        ALTER TABLE settings DROP COLUMN llm_gateway_api_key;
        ALTER TABLE settings DROP COLUMN llm_gateway_billing_mode;
        INSERT INTO schema_meta (key, value) VALUES ('schema_version', '66');
      `);

      for (let version = 67; version <= SCHEMA_VERSION; version += 1) {
        const migration = MIGRATIONS[version];
        if (migration) applyMigration(db, migration);
      }

      const row = db
        .prepare(
          'SELECT llm_provider, docs_provider, llm_gateway_api_key, llm_gateway_billing_mode FROM settings WHERE id = 1',
        )
        .get() as {
        llm_provider: string;
        docs_provider: string;
        llm_gateway_api_key: Buffer | null;
        llm_gateway_billing_mode: string;
      };
      expect(row.llm_provider).toBe('cursor');
      expect(row.docs_provider).toBe('notion');
      expect(row.llm_gateway_api_key).toBeNull();
      expect(row.llm_gateway_billing_mode).toBe('devpass');
    } finally {
      db.close();
    }
  });

  it('ignores semicolons inside standalone SQL comment lines', () => {
    const db = new Database(':memory:');
    try {
      applyMigration(
        db,
        'CREATE TABLE retained (id INTEGER);\n-- a comment; not SQL\nINSERT INTO retained VALUES (1);',
      );
      expect(db.prepare('SELECT id FROM retained').all()).toEqual([{ id: 1 }]);
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

  describe('post-merge migration convergence', () => {
    const schemaShape = (db: Database.Database) => {
      const objects = (
        db
          .prepare(
            "SELECT type, name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name",
          )
          .all() as Array<{ type: string; name: string }>
      ).map((row) => `${row.type}:${row.name}`);
      const columns: Record<string, string[]> = {};
      for (const row of db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
        .all() as Array<{ name: string }>) {
        columns[row.name] = (
          db.prepare(`PRAGMA table_info(${row.name})`).all() as Array<{ name: string }>
        )
          .map((column) => column.name)
          .sort();
      }
      return { objects, columns };
    };

    const freshShape = () => {
      const db = new Database(':memory:');
      try {
        db.exec(SCHEMA_SQL);
        return schemaShape(db);
      } finally {
        db.close();
      }
    };

    const seedRows = (db: Database.Database, includeOutbox: boolean) => {
      db.exec(`
        INSERT INTO settings (id, llm_provider) VALUES (1, 'cursor');
        INSERT INTO workspaces (id, name, created_at, updated_at)
          VALUES ('ws-1', 'Seeded', '2026-09-11T00:00:00.000Z', '2026-09-11T00:00:00.000Z');
      `);
      if (includeOutbox) {
        db.exec(`
          INSERT INTO sync_outbox (
            change_id, backend_id, account_id, dataset_epoch, enrollment_id,
            entity_type, entity_id, schema_version, operation, payload_hash,
            local_edit_generation, created_at
          ) VALUES (
            'change-1', 'backend', 'account', 'epoch', 'enrollment',
            'workspace', 'ws-1', 76, 'update', 'hash', 1,
            '2026-09-11T00:00:00.000Z'
          );
        `);
      }
    };

    const buildBranchSnapshot = (throughVersion: number) => {
      const db = new Database(':memory:');
      db.exec(MERGE_BASE_V66_SCHEMA_SQL);
      for (let version = 67; version <= throughVersion; version += 1) {
        applyMigration(db, PRE_MERGE_BRANCH_MIGRATIONS[version]);
      }
      return db;
    };

    it.each([
      {
        name: 'main v67 (released gateway migration)',
        fromVersion: 67,
        includeOutbox: false,
        build: () => {
          const db = new Database(':memory:');
          db.exec(MAIN_V67_SCHEMA_SQL);
          return db;
        },
      },
      {
        name: 'pre-merge branch v67',
        fromVersion: 67,
        includeOutbox: false,
        build: () => buildBranchSnapshot(67),
      },
      {
        name: 'pre-merge branch v69',
        fromVersion: 69,
        includeOutbox: false,
        build: () => buildBranchSnapshot(69),
      },
      {
        name: 'pre-merge branch v76',
        fromVersion: 76,
        includeOutbox: true,
        build: () => buildBranchSnapshot(76),
      },
      {
        name: 'fresh merged schema',
        fromVersion: SCHEMA_VERSION,
        includeOutbox: true,
        build: () => {
          const db = new Database(':memory:');
          db.exec(SCHEMA_SQL);
          return db;
        },
      },
    ])('converges $name to the merged schema', ({ fromVersion, includeOutbox, build }) => {
      const db = build();
      try {
        seedRows(db, includeOutbox);
        for (let version = fromVersion + 1; version <= SCHEMA_VERSION; version += 1) {
          const migration = MIGRATIONS[version];
          if (migration) applyMigration(db, migration);
        }

        expect(schemaShape(db)).toEqual(freshShape());
        expect(db.prepare('SELECT id, llm_provider FROM settings WHERE id = 1').get()).toEqual({
          id: 1,
          llm_provider: 'cursor',
        });
        expect(db.prepare('SELECT id, name FROM workspaces WHERE id = ?').get('ws-1')).toEqual({
          id: 'ws-1',
          name: 'Seeded',
        });
        if (includeOutbox) {
          expect(
            db
              .prepare('SELECT change_id, entity_id, state FROM sync_outbox WHERE change_id = ?')
              .get('change-1'),
          ).toEqual({ change_id: 'change-1', entity_id: 'ws-1', state: 'pending' });
        }
      } finally {
        db.close();
      }
    });
  });
});
