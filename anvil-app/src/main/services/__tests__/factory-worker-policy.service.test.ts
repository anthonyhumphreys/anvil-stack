import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { SCHEMA_SQL } from '../../db/schema.js';
import { FactoryStore } from '../factory-persistence.service.js';
import type { FactoryDefinition } from '../../../shared/factories.js';
const state = vi.hoisted(() => ({
  db: undefined as unknown as Database.Database,
  root: '',
  mode: 'workspace-auto',
  actor: null as { id: string; accountScope: string } | null,
}));
vi.mock('electron', () => ({ app: { getPath: () => state.root } }));
vi.mock('../../db/database.js', () => ({ getDb: () => state.db }));
vi.mock('../settings.service.js', () => ({ getSettings: () => ({ codexMode: state.mode }) }));
vi.mock('../factory-access.service.js', () => ({ getFactoryActor: () => state.actor }));
import {
  factorySandboxPolicy,
  assertFactoryWorkerActive,
  isolatedFactoryEnvironment,
  observeFactoryWorkerEvent,
} from '../factory-worker-policy.service.js';
let store: FactoryStore, runId: string;
beforeEach(() => {
  state.db = new Database(':memory:');
  state.db.exec(SCHEMA_SQL);
  state.root = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-isolation-'));
  state.mode = 'workspace-auto';
  state.actor = null;
  store = new FactoryStore(state.db);
  state.db
    .prepare("INSERT INTO workspaces(id,name,created_at,updated_at)VALUES('ws','Workspace','','')")
    .run();
  const factory = {
    id: 'factory',
    workspaceId: 'ws',
    revision: 1,
    status: 'active',
    ownerId: `local:${createHash('sha256').update(state.db.name).digest('hex')}`,
    accountScope: `local:${state.db.name}`,
    definition: {
      repoId: 'repo',
      github: {
        host: 'github.com',
        owner: 'acme',
        repo: 'repo',
        label: 'ready',
        baseBranch: 'main',
      },
      checks: ['npm test'],
      postMergeChecks: ['npm test'],
      limits: { maxCommands: 4, maxRunMinutes: 90 },
    },
    createdAt: '',
    updatedAt: '',
    workflow: {},
  } as FactoryDefinition;
  store.saveRevision(factory);
  let run = store.intake(
    factory,
    {
      number: 1,
      title: 'Issue',
      body: '',
      url: '',
      state: 'open',
      labels: ['ready'],
      createdAt: '',
      updatedAt: '',
    },
    new Date(),
  );
  run = store.updateRun({ ...run, stage: 'implementing' });
  runId = run.id;
});
afterEach(() => {
  state.db.close();
  fs.rmSync(state.root, { recursive: true, force: true });
});
describe('isolated factory workers', () => {
  it('explicitly disables network and preserves read-only persona ceilings on every turn', () => {
    expect(factorySandboxPolicy('/owned', false)).toEqual({
      type: 'workspaceWrite',
      writableRoots: ['/owned'],
      networkAccess: false,
      excludeTmpdirEnvVar: true,
      excludeSlashTmp: true,
    });
    expect(factorySandboxPolicy('/owned', true)).toEqual({
      type: 'readOnly',
      networkAccess: false,
    });
  });
  it('does not inherit GitHub tokens, SSH agent, user config or arbitrary MCP environment', () => {
    const codex = path.join(state.root, 'original-codex');
    fs.mkdirSync(codex);
    fs.writeFileSync(path.join(codex, 'auth.json'), 'model-auth');
    fs.writeFileSync(path.join(codex, 'config.toml'), '[mcp_servers.privileged]');
    const env = isolatedFactoryEnvironment(runId, 'worker', {
      HOME: '/real/home',
      CODEX_HOME: codex,
      GH_TOKEN: 'github-secret',
      GITHUB_TOKEN: 'secret',
      SSH_AUTH_SOCK: '/agent',
      ANVIL_TOOL_ENDPOINT: 'http://privileged',
      OPENAI_API_KEY: 'model-key',
      PATH: '/bin',
    });
    expect(env.GH_TOKEN).toBeUndefined();
    expect(env.GITHUB_TOKEN).toBeUndefined();
    expect(env.SSH_AUTH_SOCK).toBeUndefined();
    expect(env.ANVIL_TOOL_ENDPOINT).toBeUndefined();
    expect(env.HOME).not.toBe('/real/home');
    expect(env.OPENAI_API_KEY).toBe('model-key');
    expect(fs.readFileSync(path.join(env.CODEX_HOME!, 'auth.json'), 'utf8')).toBe('model-auth');
    expect(fs.existsSync(path.join(env.CODEX_HOME!, 'config.toml'))).toBe(false);
  });
  it('counts command starts once, includes all workers and reserves acceptance/post-merge checks', () => {
    observeFactoryWorkerEvent(runId, 'first', {
      type: 'command_exec',
      itemId: '1',
      command: 'one',
      toolStatus: 'running',
    });
    observeFactoryWorkerEvent(runId, 'first', {
      type: 'command_exec',
      itemId: '1',
      command: 'one',
      toolStatus: 'running',
    });
    observeFactoryWorkerEvent(runId, 'second', {
      type: 'command_exec',
      itemId: '2',
      command: 'two',
      toolStatus: 'running',
    });
    expect(() => assertFactoryWorkerActive(runId)).not.toThrow();
    expect(() =>
      observeFactoryWorkerEvent(runId, 'second', {
        type: 'command_exec',
        itemId: '3',
        command: 'over budget',
        toolStatus: 'running',
      }),
    ).toThrow('budget');
    expect(
      (
        state.db.prepare('SELECT SUM(commands) AS n FROM factory_worker_usage').get() as {
          n: number;
        }
      ).n,
    ).toBe(3);
  });
  it('revokes worker execution for pause, source changes, read-only policy and account switch', () => {
    expect(() => assertFactoryWorkerActive(runId)).not.toThrow();
    state.mode = 'read-only';
    expect(() => assertFactoryWorkerActive(runId)).toThrow('read-only');
    state.mode = 'workspace-auto';
    state.actor = { id: 'other', accountScope: 'other' };
    expect(() => assertFactoryWorkerActive(runId)).toThrow('account changed');
    state.actor = null;
    const run = store.getRun(runId)!;
    store.updateRun({ ...run, stage: 'paused' });
    expect(() => assertFactoryWorkerActive(runId)).toThrow('paused');
  });
});
