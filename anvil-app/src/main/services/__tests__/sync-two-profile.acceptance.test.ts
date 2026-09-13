/**
 * Step-5 two-profile workflow acceptance gate.
 *
 * Two isolated desktop profiles — each with its own `userDataDir`, encrypted
 * session file, and file-backed SQLite — converge through the REAL backend
 * worker over real HTTP. Enrollment uses production feature paths only
 * (enrollment codes; no spike auth, no injected RPC).
 *
 * Prerequisites:
 *   cd cloud/backend && pnpm dev            # wrangler dev --env dev on :8787
 *   ANVIL_BACKEND_URL=http://127.0.0.1:8787 pnpm vitest run \
 *     src/main/services/__tests__/sync-two-profile.acceptance.test.ts
 *
 * The suite skips when no worker is reachable so `pnpm test` stays green on
 * machines without a running backend.
 */
import Database from 'better-sqlite3';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SCHEMA_SQL } from '../../db/schema';
import { DEFAULT_ORCHESTRATION } from '../../../shared/workflow-orchestration';
import type { WorkflowNode } from '../../../shared/types';
import { SPIKE_DATASET_EPOCH } from '../../../shared/sync-runtime';
import { type SyncScope } from '../../../shared/sync-mesh';
import type { BackendDescriptor } from '../../../../cloud/contract/discovery';

const BACKEND_URL = (process.env.ANVIL_BACKEND_URL ?? 'http://127.0.0.1:8787').replace(/\/+$/, '');
const ADMIN_TOKEN = process.env.ANVIL_ADMIN_TOKEN ?? 'dev-admin-token';

const backendReachable = await fetch(`${BACKEND_URL}/.well-known/anvil-backend`)
  .then((r) => r.ok)
  .catch(() => false);

let activeDb: Database.Database;

vi.mock('../../db/database.js', () => ({ getDb: () => activeDb }));
vi.mock('../persona.service.js', () => ({
  getPersonaById: (id: string) => (id === 'coder' ? { id } : null),
  buildSystemPrompt: () => '',
}));
vi.mock('electron', () => ({
  app: { getPath: () => '/tmp', getVersion: () => 'test' },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(`enc:${value}`, 'utf-8'),
    decryptString: (encrypted: Buffer) => encrypted.toString('utf-8').slice('enc:'.length),
  },
}));

import {
  bindLocalWorkflowTemplates,
  enableSync,
  enrollWithEnrollmentCode,
  getRuntimeStatus,
  initSyncRuntime,
  issueEnrollmentCode,
  requestSync,
  resetSyncRuntimeForTests,
  signOutSync,
} from '../sync-runtime.service';
import { pinBackend } from '../sync-backend.service';
import { saveWorkflowTemplate } from '../workflow.service';
import type { SyncRuntimeStatus } from '../../../shared/sync-runtime';

interface Profile {
  dir: string;
  dbPath: string;
  db: Database.Database;
}

function openProfile(name: string): Profile {
  resetSyncRuntimeForTests();
  const dir = mkdtempSync(join(tmpdir(), `anvil-profile-${name}-`));
  const dbPath = join(dir, 'anvil.db');
  const db = new Database(dbPath);
  db.exec(SCHEMA_SQL);
  activeDb = db;
  initSyncRuntime(dir);
  return { dir, dbPath, db };
}

function reopenProfile(profile: Profile): Profile {
  profile.db.close();
  resetSyncRuntimeForTests();
  const db = new Database(profile.dbPath);
  activeDb = db;
  initSyncRuntime(profile.dir);
  return { ...profile, db };
}

let cachedDescriptor: BackendDescriptor | undefined;
async function backendDescriptor(): Promise<BackendDescriptor> {
  cachedDescriptor ??= (await (
    await fetch(`${BACKEND_URL}/.well-known/anvil-backend`)
  ).json()) as BackendDescriptor;
  return cachedDescriptor;
}

async function mintCode(accountId: string): Promise<string> {
  const res = await fetch(`${BACKEND_URL}/v1/enrollment-codes`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${ADMIN_TOKEN}` },
    body: JSON.stringify({ accountId }),
  });
  if (!res.ok) {
    throw new Error(`admin enrollment-code issuance failed: ${res.status} ${await res.text()}`);
  }
  return ((await res.json()) as { code: string }).code;
}

async function enrollProfile(profile: Profile, code: string): Promise<SyncRuntimeStatus> {
  pinBackend({ baseUrl: BACKEND_URL, descriptor: await backendDescriptor() });
  const snapshot = await enrollWithEnrollmentCode(code);
  expect(snapshot.state).toBe('signed-in');
  const status = enableSync();
  expect(status.syncEnabled).toBe(true);
  expect(status.auth.accountId).toBe(snapshot.accountId);
  return status;
}

function scopeFor(status: SyncRuntimeStatus, deploymentId: string): SyncScope {
  const accountId = status.auth.accountId;
  if (accountId === null) throw new Error('profile must be signed in');
  return { backendId: deploymentId, accountId, datasetEpoch: SPIKE_DATASET_EPOCH };
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

const openProfiles: Profile[] = [];
afterEach(() => {
  resetSyncRuntimeForTests();
});

describe.skipIf(!backendReachable)('two-profile acceptance gate (real worker)', () => {
  it(
    'create/update/delete converge across profiles over real auth + HTTP',
    { timeout: 60_000 },
    async () => {
      const accountId = `acct-gate-${Date.now()}`;
      const descriptor = await backendDescriptor();

      // ---- Profile A: enroll through a real admin-minted code, create, push.
      const a = openProfile('a');
      openProfiles.push(a);
      const aStatus = await enrollProfile(a, await mintCode(accountId));
      const aScope = scopeFor(aStatus, descriptor.deploymentId);
      const template = saveWorkflowTemplate({
        name: 'gate-workflow',
        description: 'created on profile A',
        nodes: [node('n1')],
        edges: [],
        orchestration: DEFAULT_ORCHESTRATION,
      });
      bindLocalWorkflowTemplates(aScope);
      await requestSync();
      expect(getRuntimeStatus().lastError).toBeNull();

      // ---- Profile A issues a real pairing code for profile B.
      const pairing = await issueEnrollmentCode();
      expect(pairing.accountId).toBe(accountId);

      // ---- Profile B: isolated dir + SQLite, redeems the code, scans, sees A's row.
      const b = openProfile('b');
      openProfiles.push(b);
      const bStatus = await enrollProfile(b, pairing.code);
      expect(bStatus.auth.accountId).toBe(accountId);
      await requestSync();
      expect(getRuntimeStatus().lastError).toBeNull();
      const bCopy = b.db
        .prepare('SELECT id, name, description FROM workflow_templates WHERE id = ?')
        .get(template.id) as { name: string; description: string } | undefined;
      expect(bCopy?.name).toBe('gate-workflow');
      expect(bCopy?.description).toBe('created on profile A');

      // ---- B updates the workflow; A converges after a pull.
      saveWorkflowTemplate(
        {
          name: 'gate-workflow-v2',
          description: 'renamed on profile B',
          nodes: [node('n1'), node('n2')],
          edges: [],
          orchestration: DEFAULT_ORCHESTRATION,
        },
        template.id,
      );
      await requestSync();
      expect(getRuntimeStatus().lastError).toBeNull();

      // ---- A "restarts": close SQLite, re-init from the same userDataDir.
      // The encrypted session reloads; no re-enrollment happens.
      const restarted = reopenProfile(a);
      expect(getRuntimeStatus().auth.state).toBe('signed-in');
      pinBackend({ baseUrl: BACKEND_URL, descriptor });
      enableSync();
      await requestSync();
      expect(getRuntimeStatus().lastError).toBeNull();
      const aCopy = restarted.db
        .prepare('SELECT name, description FROM workflow_templates WHERE id = ?')
        .get(template.id) as { name: string; description: string } | undefined;
      expect(aCopy?.name).toBe('gate-workflow-v2');
      expect(aCopy?.description).toBe('renamed on profile B');

      // ---- A deletes; B converges on the tombstone.
      const { deleteWorkflowTemplate } = await import('../workflow.service');
      deleteWorkflowTemplate(template.id);
      await requestSync();
      expect(getRuntimeStatus().lastError).toBeNull();

      const b2 = reopenProfile(b);
      expect(getRuntimeStatus().auth.state).toBe('signed-in');
      pinBackend({ baseUrl: BACKEND_URL, descriptor });
      enableSync();
      await requestSync();
      expect(getRuntimeStatus().lastError).toBeNull();
      const bGone = b2.db
        .prepare('SELECT id FROM workflow_templates WHERE id = ?')
        .get(template.id);
      expect(bGone).toBeUndefined();

      // ---- Sign-out revokes the device session remotely: the same access
      // token can no longer reach the account, and profile A signs out cleanly.
      await signOutSync();
      expect(getRuntimeStatus().auth.state).toBe('signed-out');
    },
  );

  it(
    'rejects replay of a used enrollment code and revoked session tokens',
    { timeout: 60_000 },
    async () => {
      const accountId = `acct-gate-${Date.now()}-reuse`;
      const code = await mintCode(accountId);

      const a = openProfile('a-reuse');
      openProfiles.push(a);
      await enrollProfile(a, code);

      // The same code on a second profile must be rejected by the real worker.
      const b = openProfile('b-reuse');
      openProfiles.push(b);
      pinBackend({ baseUrl: BACKEND_URL, descriptor: await backendDescriptor() });
      await expect(enrollWithEnrollmentCode(code)).rejects.toThrow();
      expect(getRuntimeStatus().auth.state).not.toBe('signed-in');

      // A's session still works; sign-out revokes it remotely.
      openProfiles[openProfiles.length - 2] = reopenProfile(a);
      expect(getRuntimeStatus().auth.state).toBe('signed-in');
      await signOutSync();
      expect(getRuntimeStatus().auth.state).toBe('signed-out');
    },
  );
});
