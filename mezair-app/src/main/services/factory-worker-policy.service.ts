import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';
import { getDb } from '../db/database.js';
import { getSettings } from './settings.service.js';
import { FactoryStore } from './factory-persistence.service.js';
import type { CodexEvent } from '../../shared/types.js';
import { createHash } from 'node:crypto';
import { getFactoryActor } from './factory-access.service.js';

export function factoryRunIdFromRequest(requestId?: string): string | undefined {
  return requestId?.startsWith('factory:') ? requestId.split(':')[1] : undefined;
}
export function factorySandboxPolicy(cwd: string, readOnly: boolean): Record<string, unknown> {
  return readOnly
    ? { type: 'readOnly', networkAccess: false }
    : {
        type: 'workspaceWrite',
        writableRoots: [cwd],
        networkAccess: false,
        excludeTmpdirEnvVar: true,
        excludeSlashTmp: true,
      };
}
export function assertFactoryWorkerActive(runId: string): void {
  const store = new FactoryStore(getDb());
  const run = store.getRun(runId);
  const factory = run && store.getFactory(run.factoryId);
  if (
    !run ||
    !factory ||
    factory.status !== 'active' ||
    !['implementing', 'repairing'].includes(run.stage) ||
    run.pendingControl
  )
    throw new Error('Factory execution was paused, revoked or taken over.');
  const actor = getFactoryActor() ?? {
    id: `local:${createHash('sha256').update(getDb().name).digest('hex')}`,
    accountScope: `local:${getDb().name}`,
  };
  if (
    actor.id !== run.snapshot.ownerId ||
    actor.accountScope !== run.snapshot.accountScope ||
    factory.executionOwner === false
  )
    throw new Error('The factory execution account changed.');
  if (
    factory.definition.repoId !== run.snapshot.definition.repoId ||
    JSON.stringify(factory.definition.github) !== JSON.stringify(run.snapshot.definition.github)
  )
    throw new Error('The factory source scope changed.');
  if ((getSettings().codexMode ?? 'on-request') === 'read-only')
    throw new Error('Current access is read-only.');
  if (Date.now() > Date.parse(run.deadlineAt))
    throw new Error('Factory wall-clock budget exhausted.');
  const used = getDb()
    .prepare('SELECT COALESCE(SUM(commands),0) AS n FROM factory_worker_usage WHERE run_id=?')
    .get(run.id) as { n: number };
  const reserved =
    run.snapshot.definition.checks.length + run.snapshot.definition.postMergeChecks.length;
  const verification = run.receipts
    .filter((r) => r.status === 'succeeded' && (r.kind === 'verify' || r.kind === 'post-merge'))
    .reduce((n, r) => n + ((r.result as { commands?: unknown[] })?.commands?.length ?? 0), 0);
  if (
    used.n + verification + reserved >
    Math.min(run.snapshot.definition.limits.maxCommands, factory.definition.limits.maxCommands)
  )
    throw new Error('Factory command budget exhausted.');
}

export function observeFactoryWorkerEvent(
  runId: string,
  workerKey: string,
  event: CodexEvent,
): void {
  assertFactoryWorkerActive(runId);
  if (event.type !== 'command_exec') return;
  // The app-server emits command start and completion; only starts consume a slot.
  if (event.exitCode !== undefined || event.output || event.toolStatus !== 'running') return;
  const db = getDb();
  db.transaction(() => {
    const row = db
      .prepare(
        'SELECT commands,command_ids_json FROM factory_worker_usage WHERE run_id=? AND worker_key=?',
      )
      .get(runId, workerKey) as { commands: number; command_ids_json: string } | undefined;
    const ids: string[] = row ? JSON.parse(row.command_ids_json) : [];
    if (event.itemId && ids.includes(event.itemId)) return;
    if (event.itemId) ids.push(event.itemId);
    db.prepare(
      'INSERT INTO factory_worker_usage(run_id,worker_key,commands) VALUES(?,?,1) ON CONFLICT(run_id,worker_key) DO UPDATE SET commands=commands+1',
    ).run(runId, workerKey);
    db.prepare(
      'UPDATE factory_worker_usage SET command_ids_json=? WHERE run_id=? AND worker_key=?',
    ).run(JSON.stringify(ids), runId, workerKey);
    if ((row?.commands ?? 0) > 100000) throw new Error('Invalid factory command accounting.');
  })();
  assertFactoryWorkerActive(runId);
}

/** Isolated model configuration. GitHub/SSH credentials and user MCP configuration are not inherited. */
export function isolatedFactoryEnvironment(
  runId: string,
  workerKey: string,
  original: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const home = path.join(
    app.getPath('userData'),
    'factory-workers',
    runId,
    workerKey.replace(/[^a-zA-Z0-9-]/g, '_'),
  );
  const codexHome = path.join(home, '.codex');
  fs.mkdirSync(codexHome, { recursive: true, mode: 0o700 });
  const source = path.join(
    original.CODEX_HOME ?? path.join(process.env.HOME ?? '', '.codex'),
    'auth.json',
  );
  const auth = path.join(codexHome, 'auth.json');
  if (fs.existsSync(source)) {
    fs.copyFileSync(source, auth);
    fs.chmodSync(auth, 0o600);
  }
  const env: NodeJS.ProcessEnv = {
    HOME: home,
    CODEX_HOME: codexHome,
    XDG_CONFIG_HOME: path.join(home, '.config'),
    PATH: original.PATH ?? process.env.PATH,
    TMPDIR: original.TMPDIR ?? process.env.TMPDIR,
    LANG: original.LANG ?? process.env.LANG,
  };
  // Provider model authentication is mediated by the model process, not a shell tool grant.
  for (const key of [
    'OPENAI_API_KEY',
    'OPENAI_BASE_URL',
    'AZURE_OPENAI_API_KEY',
    'AZURE_OPENAI_ENDPOINT',
    'AZURE_OPENAI_API_VERSION',
    'LLMGATEWAY_API_KEY',
  ])
    if (original[key]) env[key] = original[key];
  return env;
}
