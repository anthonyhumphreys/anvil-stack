import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SCHEMA_SQL } from '../../db/schema.js';

const state = vi.hoisted(() => ({ dataDir: '', available: true }));
const db = new Database(':memory:');
db.exec(SCHEMA_SQL);
vi.mock('../../db/database.js', () => ({ getDb: () => db }));
vi.mock('electron', () => ({
  app: { getPath: () => state.dataDir },
  safeStorage: {
    isEncryptionAvailable: () => state.available,
    encryptString: (value: string) => Buffer.concat([Buffer.from('v10'), Buffer.from(value)]),
    decryptString: (value: Buffer) => {
      if (value.subarray(0, 3).toString() !== 'v10') throw new Error('unreadable keychain');
      return value.subarray(3).toString();
    },
  },
}));
import {
  configureSecretVault,
  decryptSecret,
  encryptSecret,
  lockSecretVault,
  resetSecretStorageForTests,
  unlockSecretVault,
} from '../auth.service.js';
import {
  getCredentialStorageStatus,
  maskSavedSettings,
  migrateSavedCredentials,
} from '../credential-storage.service.js';
import { getSettings, updateSettings } from '../settings.service.js';

beforeEach(() => {
  state.dataDir = mkdtempSync(join(tmpdir(), 'anvil-credential-migration-'));
  state.available = true;
  resetSecretStorageForTests();
  db.exec(
    'DELETE FROM settings; INSERT INTO settings (id) VALUES (1); DELETE FROM cloud_execution_connection; DELETE FROM cloud_provider_connections;',
  );
});
afterEach(() => {
  db.exec('DROP TRIGGER IF EXISTS stop_migration');
  resetSecretStorageForTests();
  rmSync(state.dataDir, { recursive: true, force: true });
});

function saved(): { openai_api_key: Buffer; linear_api_key: Buffer } {
  return db
    .prepare('SELECT openai_api_key, linear_api_key FROM settings WHERE id = 1')
    .get() as ReturnType<typeof saved>;
}

describe('credential migration', () => {
  it('migrates readable keychain and legacy keys, including connection tokens, then retains them through lock/restart', async () => {
    db.prepare('UPDATE settings SET openai_api_key = ?, linear_api_key = ? WHERE id = 1').run(
      encryptSecret('openai-key'),
      Buffer.from('legacy-linear-key'),
    );
    db.prepare('INSERT INTO cloud_execution_connection (id, endpoint, token) VALUES (1, ?, ?)').run(
      'https://example.invalid',
      encryptSecret('cloud-token'),
    );
    await configureSecretVault({ mode: 'passphrase', passphrase: 'test vault passphrase' });
    expect(migrateSavedCredentials()).toEqual({ migrated: 3, retained: 0 });
    expect(decryptSecret(saved().openai_api_key)).toBe('openai-key');
    expect(decryptSecret(saved().linear_api_key)).toBe('legacy-linear-key');
    expect(saved().openai_api_key.toString()).not.toContain('openai-key');
    expect(migrateSavedCredentials()).toEqual({ migrated: 0, retained: 0 });
    resetSecretStorageForTests();
    const status = getCredentialStorageStatus();
    expect(status.credentials.openaiApiKey).toBe('locked');
    expect(JSON.stringify(status)).not.toContain('openai-key');
    await unlockSecretVault('test vault passphrase');
    expect(getSettings().openaiApiKey).toBe('openai-key');
  });

  it('keeps unavailable keychain ciphertext intact while moving readable plaintext to the selected vault', async () => {
    const original = encryptSecret('keychain-only');
    db.prepare('UPDATE settings SET openai_api_key = ?, linear_api_key = ? WHERE id = 1').run(
      original,
      Buffer.from('legacy-linear-key'),
    );
    state.available = false;
    await configureSecretVault({ mode: 'passphrase', passphrase: 'test vault passphrase' });
    expect(migrateSavedCredentials()).toEqual({ migrated: 1, retained: 1 });
    expect(saved().openai_api_key).toEqual(original);
    expect(maskSavedSettings(getSettings()).openaiApiKey).toBe('••••••••');
    expect(getCredentialStorageStatus().credentials.openaiApiKey).toBe('unavailable');
    state.available = true;
    expect(migrateSavedCredentials()).toEqual({ migrated: 1, retained: 0 });
    expect(decryptSecret(saved().openai_api_key)).toBe('keychain-only');
  });

  it('rolls back all credential replacements if migration is interrupted', async () => {
    const originalOpenai = encryptSecret('original-openai');
    const originalLinear = encryptSecret('original-linear');
    db.prepare('UPDATE settings SET openai_api_key = ?, linear_api_key = ? WHERE id = 1').run(
      originalOpenai,
      originalLinear,
    );
    await configureSecretVault({ mode: 'passphrase', passphrase: 'test vault passphrase' });
    db.exec(
      "CREATE TRIGGER stop_migration BEFORE UPDATE OF linear_api_key ON settings BEGIN SELECT RAISE(ABORT, 'migration interrupted'); END;",
    );
    expect(() => migrateSavedCredentials()).toThrow('migration interrupted');
    expect(saved()).toEqual({ openai_api_key: originalOpenai, linear_api_key: originalLinear });
  });

  it('preserves masked keys on settings saves and refuses edits to an unreadable connection bundle', async () => {
    await configureSecretVault({ mode: 'passphrase', passphrase: 'test vault passphrase' });
    const connections = encryptSecret(
      JSON.stringify([
        {
          id: 'connection',
          provider: 'linear',
          name: 'Linear',
          linearApiKey: 'saved-integration-token',
        },
      ]),
    );
    db.prepare(
      'UPDATE settings SET openai_api_key = ?, work_item_connections = ? WHERE id = 1',
    ).run(encryptSecret('saved-provider-key'), connections);
    lockSecretVault();
    const masked = maskSavedSettings(getSettings());
    expect(masked.openaiApiKey).toBe('••••••••');
    expect(masked.credentialStorage?.credentials.workItemConnections).toBe('locked');
    expect(() => updateSettings({ workItemConnections: [] })).toThrow('Unlock credential storage');
    expect(
      (
        db.prepare('SELECT work_item_connections FROM settings WHERE id = 1').get() as {
          work_item_connections: Buffer;
        }
      ).work_item_connections,
    ).toEqual(connections);
    updateSettings({ openaiModel: 'gpt-5.6-sol' });
    expect(saved().openai_api_key).toBeDefined();
  });
});
