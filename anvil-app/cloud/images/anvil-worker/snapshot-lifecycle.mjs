import { createRequire } from 'node:module';
import { existsSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const require = createRequire(import.meta.url);

/** Remove attempt/source credentials while retaining provider conversation data. */
export function pruneSourceCredentials(dataDir) {
  rmSync(join(dataDir, 'sync-mesh-session.json'), { force: true });
  for (const [parent, leaf] of [
    ['mesh-codex-auth', 'auth.json'],
    ['mesh-provider-data', join('devin', 'credentials.toml')],
  ]) {
    const root = join(dataDir, parent);
    if (!existsSync(root)) continue;
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (entry.isDirectory() && !entry.isSymbolicLink()) {
        rmSync(join(root, entry.name, leaf), { force: true });
      }
    }
  }
}

/** A fresh /run vault key cannot unlock credential ciphertext from the old boot. */
export function resetVolatileWorkerCredentials(dataDir, databasePath = join(dataDir, 'anvil.db')) {
  rmSync(join(dataDir, 'secret-storage.json'), { force: true });
  rmSync(join(dataDir, 'sync-mesh-session.json'), { force: true });
  if (!existsSync(databasePath)) return;

  const Database = require('better-sqlite3');
  const db = new Database(databasePath);
  try {
    db.pragma('busy_timeout = 5000');
    db.transaction(() => {
      const clearColumns = (table, columns) => {
        const present = db
          .prepare(`PRAGMA table_info("${table}")`)
          .all()
          .map((column) => column.name);
        for (const column of columns) {
          if (present.includes(column)) db.exec(`UPDATE "${table}" SET "${column}" = NULL`);
        }
      };
      clearColumns('settings', [
        'foundry_api_key', 'openai_api_key', 'ado_pat', 'work_item_connections', 'linear_api_key', 'jira_api_token',
        'confluence_pat', 'notion_oauth_token', 'github_pat', 'llm_gateway_api_key',
      ]);
      clearColumns('cloud_agent_provider_settings', ['credential_blob']);
      clearColumns('cloud_provider_connections', ['secret_blob']);
      db.exec('DELETE FROM cloud_execution_connection');
    })();
  } finally {
    db.close();
  }
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  if (process.argv[2] !== 'prune') throw new Error('unknown snapshot lifecycle operation');
  pruneSourceCredentials(process.env.ANVIL_DATA_DIR ?? '/var/lib/anvil');
}
