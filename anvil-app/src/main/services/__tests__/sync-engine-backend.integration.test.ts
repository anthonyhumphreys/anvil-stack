import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SCHEMA_SQL } from '../../db/schema';
import { DEFAULT_ORCHESTRATION } from '../../../shared/workflow-orchestration';
import type { WorkflowNode } from '../../../shared/types';
import { SYNC_ENTITY_WORKFLOW_TEMPLATE, type SyncScope } from '../../../shared/sync-mesh';
import { FakeAccountCoordinator } from './fake-account-coordinator';

/**
 * SYNC-03 ↔ BACKEND-01 round-trip in Node vitest.
 *
 * cloud/backend vitest (workerd / @cloudflare/vitest-plugin) is the real
 * Durable Object proof. This file uses a Node fake Account that implements
 * the same apply rules and is injected as `rpc` (via the BYOB-01 client and
 * the fake's fetch) so the engine never imports cloud/backend.
 */

const { active } = vi.hoisted(() => ({
  active: { db: null as unknown as InstanceType<typeof Database> },
}));

vi.mock('../../db/database.js', () => ({ getDb: () => active.db }));
vi.mock('../persona.service.js', () => ({
  getPersonaById: (id: string) => (id === 'coder' ? { id } : null),
  buildSystemPrompt: () => '',
}));
vi.mock('electron', () => ({
  app: { getPath: () => '/tmp', getVersion: () => 'test' },
}));

import { rpc } from '../sync-backend-client.service';
import { resetSyncEngineForTests, runSyncCycle, type SyncEngineRpc } from '../sync-engine.service';
import {
  getBinding,
  listOutboxRows,
  recordLocalChange,
  upsertBinding,
  upsertEnrollment,
} from '../sync-persistence.service';
import { getWorkflowTemplate, saveWorkflowTemplate } from '../workflow.service';
import { setAccountKeyBootstrapEligibility } from '../sync-keyring.service';

const SCOPE: SyncScope = {
  backendId: 'backend-1',
  accountId: 'account-1',
  datasetEpoch: 'spike-epoch-1',
};
const ET = SYNC_ENTITY_WORKFLOW_TEMPLATE;
const CONNECTION = { apiUrl: 'https://example.test/api/' };
const ENROLLMENT_A = 'enrollment-a';
const ENROLLMENT_B = 'enrollment-b';

function createAppDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(SCHEMA_SQL);
  return db;
}

function node(id: string): WorkflowNode {
  return {
    id,
    name: id,
    prompt: `Run ${id}`,
    personaId: 'coder',
    model: 'gpt-5.6-terra',
    reasoningEffort: 'medium',
    executionStrategy: 'adaptive',
    position: { x: 0, y: 0 },
  };
}

function templateInput(name: string) {
  return {
    name,
    description: 'SYNC-03 / BACKEND-01 round-trip',
    orchestration: { ...DEFAULT_ORCHESTRATION },
    nodes: [node('step-1')],
    edges: [],
  };
}

function templatePayload(id: string, name: string) {
  return {
    id,
    name,
    description: 'SYNC-03 / BACKEND-01 round-trip',
    nodes: [node('step-1')],
    edges: [],
    orchestration: { ...DEFAULT_ORCHESTRATION },
  };
}

function spikeToken(enrollmentId: string): string {
  return `spike:${SCOPE.accountId}:${enrollmentId}`;
}

function activateEnrollment(enrollmentId: string, installationId: string): void {
  upsertEnrollment({
    displayName: `Device ${enrollmentId}`,
    id: enrollmentId,
    installationId,
    scope: SCOPE,
    state: 'active',
  });
}

function injectRpc(account: FakeAccountCoordinator): SyncEngineRpc {
  return (connection, operation, params, accessToken) =>
    rpc(connection, operation, params, accessToken, { fetchFn: account.fetch });
}

function cycle(account: FakeAccountCoordinator, enrollmentId: string) {
  return runSyncCycle({
    accessToken: spikeToken(enrollmentId),
    connection: CONNECTION,
    enrollmentId,
    rpc: injectRpc(account),
    scope: SCOPE,
  });
}

let deviceA: Database.Database;
let deviceB: Database.Database;
let account: FakeAccountCoordinator;

beforeEach(() => {
  resetSyncEngineForTests();
  deviceA = createAppDb();
  deviceB = createAppDb();
  active.db = deviceA;
  account = new FakeAccountCoordinator();
});

describe('SYNC-03 engine through BACKEND-01 apply rules', () => {
  it('pushes a bound workflow-template and pulls it onto a second in-memory db', async () => {
    active.db = deviceA;
    activateEnrollment(ENROLLMENT_A, 'installation-a');
    // Only A owns the backend's first-device bootstrap claim.
    setAccountKeyBootstrapEligibility(SCOPE, ENROLLMENT_A, true);
    const saved = saveWorkflowTemplate(templateInput('Shared template'));
    upsertBinding(SCOPE, ET, saved.id);
    // First upload is a create with null baseRevision (BACKEND-01). A second
    // saveWorkflowTemplate after bind is labeled update and the spike rejects
    // update-without-base; enqueue the adoption create explicitly.
    active.db.transaction(() => {
      recordLocalChange(SCOPE, {
        entityId: saved.id,
        entityType: ET,
        operation: 'create',
        payload: templatePayload(saved.id, 'Shared template'),
        schemaVersion: 1,
      });
    })();
    expect(listOutboxRows(SCOPE)).toHaveLength(1);

    // A fresh device cannot mint ADK v1 until it has completed a pull, so
    // the first cycle defers the sealed change; the second pushes it.
    await cycle(account, ENROLLMENT_A);
    expect(listOutboxRows(SCOPE)[0]?.state).toBe('pending');
    await cycle(account, ENROLLMENT_A);

    expect(listOutboxRows(SCOPE)[0]?.state).toBe('acknowledged');
    expect(getBinding(SCOPE, ET, saved.id)?.baseRevision).toBe(1);

    resetSyncEngineForTests();
    active.db = deviceB;
    activateEnrollment(ENROLLMENT_B, 'installation-b');
    expect(getWorkflowTemplate(saved.id)).toBeNull();

    // E2E: device B pulls ciphertext, so it needs the ADK A sealed under.
    // The shipped path is a keyring-wrap entity delivered over sync; in
    // this Node fake the equivalent is copying the wrapped key rows.
    const keyRows = deviceA
      .prepare(
        'SELECT backend_id, account_id, key_version, key_wrapped, created_at FROM sync_keyring',
      )
      .all() as Array<{
      backend_id: string;
      account_id: string;
      key_version: number;
      key_wrapped: Buffer;
      created_at: string;
    }>;
    for (const row of keyRows) {
      deviceB
        .prepare(
          `INSERT OR REPLACE INTO sync_keyring (backend_id, account_id, key_version, key_wrapped, created_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(row.backend_id, row.account_id, row.key_version, row.key_wrapped, row.created_at);
    }

    await cycle(account, ENROLLMENT_B);

    const pulled = getWorkflowTemplate(saved.id);
    expect(pulled?.name).toBe('Shared template');
    expect(pulled?.description).toBe('SYNC-03 / BACKEND-01 round-trip');
    expect(pulled?.nodes).toHaveLength(1);
    expect(getBinding(SCOPE, ET, saved.id)?.baseRevision).toBe(1);
    expect(listOutboxRows(SCOPE)).toEqual([]);
  });
});
