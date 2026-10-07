import type { AppSettings } from '../../shared/types.js';
import type {
  CredentialMigrationResult,
  CredentialStorageStatus,
} from '../../shared/secret-storage.js';
import { getDb } from '../db/database.js';
import { encryptSecret, getSecretStorageStatus, readStoredSecret } from './auth.service.js';
import { SECRET_ENVELOPE_PREFIX } from './secret-vault.service.js';

export const SETTINGS_SECRET_COLUMNS = {
  foundryApiKey: 'foundry_api_key',
  openaiApiKey: 'openai_api_key',
  llmGatewayApiKey: 'llm_gateway_api_key',
  adoPat: 'ado_pat',
  linearApiKey: 'linear_api_key',
  jiraApiToken: 'jira_api_token',
  confluencePat: 'confluence_pat',
  notionOauthToken: 'notion_oauth_token',
  githubPat: 'github_pat',
  workItemConnections: 'work_item_connections',
} as const;

export function getCredentialStorageStatus(): CredentialStorageStatus {
  const row = getDb().prepare('SELECT * FROM settings WHERE id = 1').get() as
    | Record<string, Buffer | null>
    | undefined;
  const credentials: CredentialStorageStatus['credentials'] = {};
  for (const [name, column] of Object.entries(SETTINGS_SECRET_COLUMNS))
    credentials[name] = readStoredSecret(row?.[column] ?? null).state;
  return { ...getSecretStorageStatus(), credentials };
}

/** A saved-but-locked secret must still appear configured in credential forms. */
export function maskSavedSettings(settings: AppSettings): AppSettings {
  const status = getCredentialStorageStatus();
  const masked: AppSettings = { ...settings, credentialStorage: status };
  for (const name of Object.keys(SETTINGS_SECRET_COLUMNS)) {
    if (name !== 'workItemConnections' && status.credentials[name] !== 'not-configured')
      Object.assign(masked, { [name]: '••••••••' });
  }
  masked.workItemConnections = settings.workItemConnections.map((connection) => ({
    ...connection,
    adoPat: connection.adoPat ? '••••••••' : undefined,
    linearApiKey: connection.linearApiKey ? '••••••••' : undefined,
    jiraApiToken: connection.jiraApiToken ? '••••••••' : undefined,
  }));
  return masked;
}

/** All readable integration values move in one transaction; unreadable values stay byte-for-byte intact. */
export function migrateSavedCredentials(): CredentialMigrationResult {
  const status = getSecretStorageStatus();
  if (status.state !== 'ready')
    throw new Error('Unlock the selected credential storage before migrating saved keys.');
  const db = getDb();
  const targets = [
    { table: 'settings', columns: Object.values(SETTINGS_SECRET_COLUMNS) },
    { table: 'cloud_execution_connection', columns: ['token'] },
    { table: 'cloud_provider_connections', columns: ['secret_blob'] },
  ];
  return db.transaction(() => {
    let migrated = 0;
    let retained = 0;
    for (const target of targets) {
      const table = db
        .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
        .get(target.table);
      if (table === undefined) continue;
      const existing = new Set(
        (db.prepare(`PRAGMA table_info(${target.table})`).all() as { name: string }[]).map(
          (column) => column.name,
        ),
      );
      for (const column of target.columns.filter((name) => existing.has(name))) {
        const rows = db
          .prepare(
            `SELECT rowid AS credential_row, ${column} AS value FROM ${target.table} WHERE ${column} IS NOT NULL`,
          )
          .all() as { credential_row: number; value: Buffer }[];
        for (const row of rows) {
          const read = readStoredSecret(row.value);
          if (read.state !== 'available') {
            retained += 1;
            continue;
          }
          const selectedProvider =
            status.provider === 'keychain' && status.legacyFileStorage
              ? 'daemon-file'
              : status.provider;
          const selectedPrefix = `${SECRET_ENVELOPE_PREFIX}${selectedProvider}:`;
          if (
            read.provider === selectedProvider &&
            row.value.subarray(0, selectedPrefix.length).toString() === selectedPrefix
          )
            continue;
          const encrypted = encryptSecret(read.value);
          const verified = readStoredSecret(encrypted, false);
          if (verified.state !== 'available' || verified.value !== read.value)
            throw new Error(
              'Credential migration could not verify encryption. Original values were retained.',
            );
          db.prepare(`UPDATE ${target.table} SET ${column} = ? WHERE rowid = ?`).run(
            encrypted,
            row.credential_row,
          );
          migrated += 1;
        }
      }
    }
    return { migrated, retained };
  })();
}
