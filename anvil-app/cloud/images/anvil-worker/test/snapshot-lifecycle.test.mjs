import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';
import { pruneSourceCredentials, resetVolatileWorkerCredentials } from '../snapshot-lifecycle.mjs';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');

test('snapshot pruning removes source auth files but retains native continuation data', () => {
  const root = mkdtempSync(join(tmpdir(), 'anvil-snapshot-prune-'));
  try {
    const codex = join(root, 'mesh-codex-auth', 'session-hash');
    const devin = join(root, 'mesh-provider-data', 'session-hash', 'devin');
    mkdirSync(codex, { recursive: true });
    mkdirSync(devin, { recursive: true });
    writeFileSync(join(root, 'sync-mesh-session.json'), 'old token');
    writeFileSync(join(codex, 'auth.json'), 'codex credential');
    writeFileSync(join(codex, 'session.db'), 'conversation');
    writeFileSync(join(devin, 'credentials.toml'), 'devin credential');
    writeFileSync(join(devin, 'session.json'), 'conversation');

    pruneSourceCredentials(root);

    assert.equal(existsSync(join(root, 'sync-mesh-session.json')), false);
    assert.equal(existsSync(join(codex, 'auth.json')), false);
    assert.equal(existsSync(join(devin, 'credentials.toml')), false);
    assert.equal(readFileSync(join(codex, 'session.db'), 'utf8'), 'conversation');
    assert.equal(readFileSync(join(devin, 'session.json'), 'utf8'), 'conversation');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('resume reset drops old vault/auth state while preserving non-credential workspace database rows', () => {
  const root = mkdtempSync(join(tmpdir(), 'anvil-snapshot-resume-'));
  const databasePath = join(root, 'anvil.db');
  const db = new Database(databasePath);
  try {
    db.exec(`
      CREATE TABLE settings (openai_api_key BLOB, work_item_connections BLOB);
      INSERT INTO settings VALUES (X'0102', X'0304');
      CREATE TABLE cloud_agent_provider_settings (credential_blob BLOB);
      INSERT INTO cloud_agent_provider_settings VALUES (X'0506');
      CREATE TABLE cloud_provider_connections (secret_blob BLOB);
      INSERT INTO cloud_provider_connections VALUES (X'0708');
      CREATE TABLE cloud_execution_connection (id INTEGER PRIMARY KEY, token BLOB NOT NULL);
      INSERT INTO cloud_execution_connection VALUES (1, X'090A');
      CREATE TABLE sync_recovery_secrets (secret_wrapped BLOB);
      INSERT INTO sync_recovery_secrets VALUES (X'0B0C');
      CREATE TABLE workspaces (id TEXT PRIMARY KEY);
      INSERT INTO workspaces VALUES ('preserved-workspace');
    `);
    db.close();
    writeFileSync(join(root, 'secret-storage.json'), '{}');
    writeFileSync(join(root, 'sync-mesh-session.json'), '{}');

    resetVolatileWorkerCredentials(root, databasePath);

    assert.equal(existsSync(join(root, 'secret-storage.json')), false);
    assert.equal(existsSync(join(root, 'sync-mesh-session.json')), false);
    const after = new Database(databasePath, { readonly: true });
    assert.deepEqual(after.prepare('SELECT * FROM settings').get(), { openai_api_key: null, work_item_connections: null });
    assert.equal(after.prepare('SELECT credential_blob FROM cloud_agent_provider_settings').get().credential_blob, null);
    assert.equal(after.prepare('SELECT secret_blob FROM cloud_provider_connections').get().secret_blob, null);
    assert.equal(after.prepare('SELECT COUNT(*) AS n FROM cloud_execution_connection').get().n, 0);
    assert.equal(after.prepare('SELECT COUNT(*) AS n FROM sync_recovery_secrets').get().n, 1);
    assert.equal(after.prepare('SELECT id FROM workspaces').get().id, 'preserved-workspace');
    after.close();
  } finally {
    try { db.close(); } catch {}
    rmSync(root, { recursive: true, force: true });
  }
});
