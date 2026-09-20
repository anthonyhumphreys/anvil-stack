import Database from 'better-sqlite3';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SCHEMA_SQL } from '../../db/schema';
import { DEFAULT_ORCHESTRATION } from '../../../shared/workflow-orchestration';
import type { WorkflowNode } from '../../../shared/types';
import { SPIKE_DATASET_EPOCH } from '../../../shared/sync-runtime';
import {
  SYNC_ENTITY_SETTINGS,
  SYNC_ENTITY_WORKFLOW_TEMPLATE,
  SYNC_SETTINGS_ENTITY_ID,
  type SyncScope,
} from '../../../shared/sync-mesh';
import type { SyncBackendDescriptor } from '../../../shared/sync-backend';

const db = new Database(':memory:');
db.exec(SCHEMA_SQL);

vi.mock('../../db/database.js', () => ({ getDb: () => db }));
vi.mock('../persona.service.js', () => ({
  getPersonaById: (id: string) => (id === 'coder' ? { id } : null),
  buildSystemPrompt: () => '',
}));
const { openExternalCalls } = vi.hoisted(() => ({
  openExternalCalls: [] as string[],
}));
vi.mock('electron', () => ({
  app: { getPath: () => '/tmp', getVersion: () => 'test' },
  shell: {
    openExternal: async (url: string) => {
      openExternalCalls.push(url);
    },
  },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(`enc:${value}`, 'utf-8'),
    decryptString: (encrypted: Buffer) => {
      const text = encrypted.toString('utf-8');
      return text.slice('enc:'.length);
    },
  },
}));

import {
  bindLocalEntities,
  deviceVerificationCode,
  enableSync,
  enrollWithEnrollmentCode,
  exportSyncDiagnostics,
  approveDeviceTrust,
  getDeviceSecurityStatus,
  getRuntimeStatus,
  initSyncRuntime,
  issueEnrollmentCode,
  onAppFocus,
  openHostedAccountPage,
  resolveHostedAccountUrl,
  previewAdoption,
  refreshHostedEntitlement,
  refreshDeviceIdentitiesForOneShot,
  resetSyncRuntimeForTests,
  requestSync,
  resetEncryptedSyncAccount,
  setSyncRuntimeRpcForTests,
  signInWithWorkOSDevice,
  signInWithOidc,
  signOutSync,
  stopSyncRuntimeForOneShot,
  spikeEnroll,
  listDevices,
} from '../sync-runtime.service';
import {
  deriveSas,
  ensureDeviceIdentity,
  hasAccountKey,
  provisionAccountKey,
  setDeviceTrust,
} from '../sync-keyring.service';
import {
  clearSyncEntitlement,
  getSyncEntitlement,
  getBinding,
  listOutboxRows,
  updateSyncState,
  upsertBinding,
  upsertEnrollment,
  upsertSyncEntitlement,
} from '../sync-persistence.service';
import { activateBackend, pinBackend } from '../sync-backend.service';
import { resetSyncEngineForTests } from '../sync-engine.service';
import type { BackendWebSocketLike } from '../sync-backend-client.service';
import { saveWorkflowTemplate } from '../workflow.service';
import { DESCRIPTOR_VERSION, PROTOCOL } from '../../../../cloud/contract/version';
import { WORKOS_DEVICE_AUTHORIZATION_URL } from '../workos-device-auth.service';

const SCOPE: SyncScope = {
  backendId: 'backend-1',
  accountId: 'account-1',
  datasetEpoch: SPIKE_DATASET_EPOCH,
};
const OTHER_SCOPE: SyncScope = {
  backendId: 'backend-1',
  accountId: 'account-2',
  datasetEpoch: SPIKE_DATASET_EPOCH,
};
const ET = SYNC_ENTITY_WORKFLOW_TEMPLATE;

function descriptorFixture(
  deploymentId = 'backend-1',
  issuer = 'https://idp.example.test',
): SyncBackendDescriptor {
  return {
    descriptorVersion: DESCRIPTOR_VERSION,
    deploymentId,
    displayName: 'Test backend',
    protocols: [PROTOCOL],
    profiles: ['sync/1'],
    apiPath: 'v1',
    socketPath: 'v1/connect',
    authModes: ['enrollment-code'],
    auth: { issuer, publicClientId: 'anvil-desktop', scopes: ['openid'] },
    limits: { entityBytes: 65536, pageBytes: 262144, batchChanges: 50, liveFrameBytes: 16384 },
  };
}

function pinTestBackend(baseUrl = 'https://backend.example.test/') {
  return pinBackend({ baseUrl, descriptor: descriptorFixture() });
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

beforeEach(() => {
  resetSyncRuntimeForTests();
  resetSyncEngineForTests();
  db.exec(
    `DELETE FROM sync_outbox; DELETE FROM sync_bindings; DELETE FROM sync_conflicts;
     DELETE FROM sync_state; DELETE FROM device_enrollments; DELETE FROM workflow_templates;
     DELETE FROM sync_scan_runs; DELETE FROM sync_scan_staging; DELETE FROM sync_installation;
     DELETE FROM sync_backends; DELETE FROM sync_entitlement;
     DELETE FROM sync_keyring; DELETE FROM sync_device_keys; DELETE FROM sync_pairing;
     DELETE FROM sync_keyring_deliveries; DELETE FROM sync_recovery_secrets;
     DELETE FROM sync_device_trust;
     DELETE FROM sync_key_bootstrap_eligibility; DELETE FROM sync_keyring_rotations;
     DELETE FROM sync_revocation_rotations; DELETE FROM sync_keyring_pending_wraps;`,
  );
  openExternalCalls.length = 0;
});

afterEach(() => {
  resetSyncRuntimeForTests();
});

describe('bindLocalEntities', () => {
  it('queues a create for each unbound local template', () => {
    upsertEnrollment({
      displayName: 'Test device',
      id: 'enrollment-1',
      installationId: 'installation-1',
      scope: SCOPE,
      state: 'active',
    });
    saveWorkflowTemplate({
      name: 'Ship it',
      description: '',
      orchestration: { ...DEFAULT_ORCHESTRATION },
      nodes: [node('step-1')],
      edges: [],
    });
    // The settings singleton adopts alongside the workflow template.
    expect(previewAdoption()).toHaveLength(2);
    expect(bindLocalEntities(SCOPE)).toBe(2);
    expect(bindLocalEntities(SCOPE)).toBe(0);
    const rows = listOutboxRows(SCOPE);
    expect(rows).toHaveLength(2);
    const workflowRow = rows.find((row) => row.entityType === ET);
    expect(workflowRow?.operation).toBe('create');
    expect(workflowRow?.baseRevision).toBeNull();
    const settingsRow = rows.find((row) => row.entityType === SYNC_ENTITY_SETTINGS);
    expect(settingsRow?.entityId).toBe(SYNC_SETTINGS_ENTITY_ID);
    expect(settingsRow?.operation).toBe('create');
  });

  it('never adopts a template already bound to another account scope', () => {
    upsertEnrollment({
      displayName: 'Test device',
      id: 'enrollment-1',
      installationId: 'installation-1',
      scope: SCOPE,
      state: 'active',
    });
    const saved = saveWorkflowTemplate({
      name: 'A-owned',
      description: '',
      orchestration: { ...DEFAULT_ORCHESTRATION },
      nodes: [node('step-1')],
      edges: [],
    });
    upsertBinding(OTHER_SCOPE, ET, saved.id);

    // The entity is associated with account-2's scope: adoption into
    // account-1's scope must not silently re-home it. The settings singleton
    // still adopts — it is a separate entity.
    expect(bindLocalEntities(SCOPE)).toBe(1);
    const rows = listOutboxRows(SCOPE);
    expect(rows).toHaveLength(1);
    expect(rows[0].entityType).toBe(SYNC_ENTITY_SETTINGS);
    expect(getBinding(OTHER_SCOPE, ET, saved.id)).not.toBeNull();
    expect(getBinding(SCOPE, ET, saved.id)).toBeNull();
  });
});

describe('spikeEnroll', () => {
  it('writes a public snapshot without the spike token', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sync-runtime-'));
    initSyncRuntime(dir, { devSpikeEnabled: true });
    pinTestBackend();
    const snapshot = spikeEnroll({ accountId: 'account-1' });
    expect(snapshot.state).toBe('signed-in');
    expect(snapshot.accountId).toBe('account-1');
    expect(snapshot.enrollmentId).toBeTruthy();
    expect(JSON.stringify(snapshot)).not.toContain('spike:');
  });

  it('refuses enrollment before a backend is pinned', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sync-runtime-'));
    initSyncRuntime(dir, { devSpikeEnabled: true });
    expect(() => spikeEnroll({ accountId: 'account-1' })).toThrow(/Pin a backend/);
  });

  it('fails closed when the dev spike fixture is not enabled', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sync-runtime-'));
    initSyncRuntime(dir);
    pinTestBackend();
    expect(() => spikeEnroll({ accountId: 'account-1' })).toThrow(/development builds/);
  });
});

describe('deviceVerificationCode', () => {
  async function enrollTestDevice(): Promise<string> {
    const backend = fakeBackend();
    const dir = mkdtempSync(join(tmpdir(), 'sync-runtime-'));
    initSyncRuntime(dir, { fetchFn: backend.fetchFn });
    pinBackend({
      baseUrl: 'https://backend.example.test/',
      descriptor: oidcDescriptorFixture(),
    });
    const minted = (await (
      await backend.fetchFn('https://backend.example.test/v1/enrollment-codes', {
        method: 'POST',
        headers: { 'content-type': 'application/json', Authorization: 'Bearer admin-token' },
        body: JSON.stringify({ accountId: 'account-1' }),
      })
    ).json()) as { code: string };
    const snapshot = await enrollWithEnrollmentCode(minted.code);
    enableSync();
    return snapshot.enrollmentId!;
  }

  it('derives the same 9-digit code both devices compute', async () => {
    const enrollmentId = await enrollTestDevice();
    const peer = ensureDeviceIdentity(SCOPE, 'enr-peer');

    const { code } = deviceVerificationCode('enr-peer');
    expect(code).toMatch(/^\d{9}$/);
    const own = ensureDeviceIdentity(SCOPE, enrollmentId);
    expect(code).toBe(deriveSas('account-1', own.pub, peer.pub));
  });

  it('throws when the peer identity has not been seen yet', async () => {
    await enrollTestDevice();
    expect(() => deviceVerificationCode('enr-unseen')).toThrow(/not seen yet/);
  });
});

describe('device security runtime integration', () => {
  async function enrollEstablishedDevice(
    options: { createSocket?: ReturnType<typeof fakeSocketFactory>['createSocket'] } = {},
  ) {
    const backend = fakeBackend();
    const dir = mkdtempSync(join(tmpdir(), 'sync-runtime-'));
    initSyncRuntime(dir, { fetchFn: backend.fetchFn, createSocket: options.createSocket });
    pinBackend({ baseUrl: 'https://backend.example.test/', descriptor: oidcDescriptorFixture() });
    const minted = (await (
      await backend.fetchFn('https://backend.example.test/v1/enrollment-codes', {
        method: 'POST',
        headers: { 'content-type': 'application/json', Authorization: 'Bearer admin-token' },
        body: JSON.stringify({ accountId: 'account-1' }),
      })
    ).json()) as { code: string };
    const snapshot = await enrollWithEnrollmentCode(minted.code);
    updateSyncState(SCOPE, { lastPullAt: new Date().toISOString() });
    enableSync();
    await requestSync();
    return { backend, enrollmentId: snapshot.enrollmentId! };
  }

  it('provisions the first account key without requiring recovery setup', async () => {
    const { enrollmentId } = await enrollEstablishedDevice();

    expect(hasAccountKey(SCOPE)).toBe(true);
    const status = await getDeviceSecurityStatus();
    expect(status.policy).toBe('require-approval');
    expect(status.configured).toBe(false);
    expect(status.hasAccountKey).toBe(true);
    expect(status.hasRecoverySecret).toBe(false);
    expect(deviceTrustStateForTest(enrollmentId)).toBe('trusted');
    const devices = await listDevices();
    expect(devices.devices.find((device) => device.self)?.trustState).toBe('trusted');
  });

  it('rejects manual approval for a mismatched SAS and for a revoked identity', async () => {
    const { backend } = await enrollEstablishedDevice();
    const peerEnrollmentId = 'enr-peer';
    backend.sessions.set(peerEnrollmentId, {
      accountId: 'account-1',
      enrollmentId: peerEnrollmentId,
      refreshToken: 'peer-refresh',
      accessToken: 'peer-access',
      generation: 1,
      accessExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    ensureDeviceIdentity(SCOPE, peerEnrollmentId);
    setDeviceTrust(SCOPE, peerEnrollmentId, 'pending');
    const expected = deviceVerificationCode(peerEnrollmentId).code;
    const wrong = expected === '000000000' ? '000000001' : '000000000';

    await expect(approveDeviceTrust(peerEnrollmentId, wrong)).rejects.toThrow(/does not match/);
    expect(deviceTrustStateForTest(peerEnrollmentId)).toBe('pending');
    setDeviceTrust(SCOPE, peerEnrollmentId, 'revoked');
    await expect(approveDeviceTrust(peerEnrollmentId, expected)).rejects.toThrow(/revoked/);
    expect(deviceTrustStateForTest(peerEnrollmentId)).toBe('revoked');
  });

  it('does not repeat approval when a fresh security row is already trusted', async () => {
    const backend = fakeBackend({ trustedEnrollmentIds: ['enr-peer'] });
    const dir = mkdtempSync(join(tmpdir(), 'sync-runtime-'));
    initSyncRuntime(dir, { fetchFn: backend.fetchFn });
    pinBackend({ baseUrl: 'https://backend.example.test/', descriptor: oidcDescriptorFixture() });
    const minted = (await (
      await backend.fetchFn('https://backend.example.test/v1/enrollment-codes', {
        method: 'POST',
        headers: { 'content-type': 'application/json', Authorization: 'Bearer admin-token' },
        body: JSON.stringify({ accountId: 'account-1' }),
      })
    ).json()) as { code: string };
    await enrollWithEnrollmentCode(minted.code);
    enableSync();
    await requestSync();

    backend.sessions.set('enr-peer', {
      accountId: 'account-1',
      enrollmentId: 'enr-peer',
      refreshToken: 'peer-refresh',
      accessToken: 'peer-access',
      generation: 1,
      accessExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    ensureDeviceIdentity(SCOPE, 'enr-peer');
    setDeviceTrust(SCOPE, 'enr-peer', 'pending');
    await approveDeviceTrust('enr-peer', deviceVerificationCode('enr-peer').code);

    expect(deviceTrustStateForTest('enr-peer')).toBe('trusted');
    expect(backend.calls.filter((call) => call.operation === 'security.approve')).toHaveLength(0);
  });

  it('resets only the captured encrypted account scope', async () => {
    await enrollEstablishedDevice();
    expect(hasAccountKey(SCOPE)).toBe(true);
    provisionAccountKey(OTHER_SCOPE);

    await resetEncryptedSyncAccount('RESET ENCRYPTED DATA');

    expect(hasAccountKey(SCOPE)).toBe(false);
    expect(hasAccountKey(OTHER_SCOPE)).toBe(true);
    expect(getRuntimeStatus().auth.state).toBe('signed-out');
  });

  it('restores polling/live sync after a definitive reset rejection', async () => {
    const factory = fakeSocketFactory();
    // A rejected reset leaves the server/session intact, so the runtime may
    // safely resume the channel it fenced around the attempted mutation.
    const backend = fakeBackend({ denyReset: 'conflict' });
    const dir = mkdtempSync(join(tmpdir(), 'sync-runtime-'));
    initSyncRuntime(dir, {
      fetchFn: backend.fetchFn,
      createSocket: factory.createSocket,
    });
    pinBackend({ baseUrl: 'https://backend.example.test/', descriptor: oidcDescriptorFixture() });
    const minted = (await (
      await backend.fetchFn('https://backend.example.test/v1/enrollment-codes', {
        method: 'POST',
        headers: { 'content-type': 'application/json', Authorization: 'Bearer admin-token' },
        body: JSON.stringify({ accountId: 'account-1' }),
      })
    ).json()) as { code: string };
    await enrollWithEnrollmentCode(minted.code);
    enableSync();
    const before = factory.sockets.length;
    await expect(resetEncryptedSyncAccount('RESET ENCRYPTED DATA')).rejects.toMatchObject({
      code: 'conflict',
    });
    expect(factory.sockets.length).toBeGreaterThan(before);
    expect(getRuntimeStatus().auth.state).toBe('signed-in');
  });
});

function deviceTrustStateForTest(enrollmentId: string): string | null {
  const row = db
    .prepare(
      `SELECT state FROM sync_device_trust
       WHERE backend_id = ? AND account_id = ? AND enrollment_id = ?`,
    )
    .get(SCOPE.backendId, SCOPE.accountId, enrollmentId) as { state: string } | undefined;
  return row?.state ?? null;
}

describe('sign-out fencing and session/backend binding', () => {
  it('stays signed-out for sync after signOutSync even with stale in-flight state', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sync-runtime-'));
    initSyncRuntime(dir, { devSpikeEnabled: true });
    pinTestBackend();
    spikeEnroll({ accountId: 'account-1' });
    const status = await signOutSync();
    expect(status.auth.state).toBe('signed-out');
    expect(status.syncEnabled).toBe(false);
  });

  it('reports identity review when the pinned backend endpoint changes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sync-runtime-'));
    initSyncRuntime(dir, { devSpikeEnabled: true });
    pinTestBackend('https://a.example.test/');
    spikeEnroll({ accountId: 'account-1' });
    // Re-pin the same deployment ID under a different URL: the deployment ID
    // alone does not prove the new endpoint shares authority.
    const updated = pinBackend({
      baseUrl: 'https://b.example.test/',
      descriptor: descriptorFixture(),
    });
    expect(updated.identityReviewRequired).toBe(true);
    expect(updated.state).toBe('paused');
    const status = getRuntimeStatus();
    expect(status.backendIdentityReviewRequired).toBe(true);
    expect(() => enableSync()).toThrow(/re-reviewed/);
  });
});

/**
 * In-process backend implementing the contract auth routes. The runtime's
 * real `postAuthRoute`/`rpc` transport exercises it through injected fetch.
 */
interface FakeSession {
  accountId: string;
  enrollmentId: string;
  refreshToken: string;
  accessToken: string;
  generation: number;
  accessExpiresAt: string;
}

function fakeBackend(
  options: {
    accessTtlMs?: number;
    /** When set, `session.describe` reports this hosted entitlement (BILL-05). */
    entitlement?: Record<string, unknown> | (() => Record<string, unknown> | undefined);
    /** When set, `sync.push` is refused 403 with this `details.reason`. */
    denyPush?: string;
    /** When set, encrypted-account reset is rejected definitively. */
    denyReset?: string;
    /** Security rows that another device has already trusted. */
    trustedEnrollmentIds?: string[];
    /** WorkOS device code accepted by the fake backend enrollment exchange. */
    workosDeviceCode?: string;
  } = {},
) {
  const accessTtlMs = options.accessTtlMs ?? 15 * 60 * 1000;
  const codes = new Map<string, string>();
  const sessions = new Map<string, FakeSession>();
  const refreshIndex = new Map<string, string>();
  const accessIndex = new Map<string, string>();
  const calls: { path: string; operation: string | null; authorization: string | null }[] = [];

  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const path = new URL(url).pathname;
    const headers = new Headers(init?.headers);
    const authorization = headers.get('Authorization');
    const body = JSON.parse((init?.body as string) ?? '{}') as Record<string, unknown>;
    calls.push({ path, operation: (body['operation'] as string) ?? null, authorization });
    const err = (code: string, status = 401) =>
      Response.json({ error: { code, retryable: false } }, { status });

    if (path === '/v1/enrollment-codes') {
      const token = authorization?.replace(/^Bearer /, '') ?? '';
      const session = sessions.get(accessIndex.get(token) ?? '');
      const isAdmin = token === 'admin-token';
      if (session === undefined && !isAdmin) {
        return err('unauthenticated');
      }
      const accountId = isAdmin ? (body['accountId'] as string) : session?.accountId;
      if (accountId === undefined) {
        return err('unauthenticated');
      }
      const code = `anvil-ec-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
      codes.set(code, accountId);
      return Response.json({
        code,
        expiresAt: new Date(Date.now() + 600_000).toISOString(),
        accountId,
      });
    }

    if (path === '/v1/enroll') {
      const proof = body['proof'] as Record<string, unknown>;
      if (proof?.['method'] === 'enrollment-code') {
        const accountId = codes.get(proof['code'] as string);
        if (accountId === undefined) {
          return err('enrollment-code-used');
        }
        codes.delete(proof['code'] as string);
        const session: FakeSession = {
          accountId,
          enrollmentId: `enr-${crypto.randomUUID()}`,
          refreshToken: `rt-${crypto.randomUUID()}`,
          accessToken: `at-${crypto.randomUUID()}`,
          generation: 1,
          accessExpiresAt: new Date(Date.now() + accessTtlMs).toISOString(),
        };
        sessions.set(session.enrollmentId, session);
        refreshIndex.set(session.refreshToken, session.enrollmentId);
        accessIndex.set(session.accessToken, session.enrollmentId);
        return Response.json({
          accessToken: session.accessToken,
          accessExpiresAt: session.accessExpiresAt,
          refreshToken: session.refreshToken,
          credentialGeneration: session.generation,
          enrollmentId: session.enrollmentId,
          accountId: session.accountId,
          datasetEpoch: SPIKE_DATASET_EPOCH,
        } satisfies Record<string, unknown>);
      }
      if (proof?.['method'] === 'oidc-pkce') {
        if (typeof proof['authorizationCode'] !== 'string' || proof['authorizationCode'] === '') {
          return err('invalid-proof');
        }
        const session: FakeSession = {
          accountId: 'oidc-account-1',
          enrollmentId: `enr-${crypto.randomUUID()}`,
          refreshToken: `rt-${crypto.randomUUID()}`,
          accessToken: `at-${crypto.randomUUID()}`,
          generation: 1,
          accessExpiresAt: new Date(Date.now() + accessTtlMs).toISOString(),
        };
        sessions.set(session.enrollmentId, session);
        refreshIndex.set(session.refreshToken, session.enrollmentId);
        accessIndex.set(session.accessToken, session.enrollmentId);
        return Response.json({
          accessToken: session.accessToken,
          accessExpiresAt: session.accessExpiresAt,
          refreshToken: session.refreshToken,
          credentialGeneration: session.generation,
          enrollmentId: session.enrollmentId,
          accountId: session.accountId,
          datasetEpoch: SPIKE_DATASET_EPOCH,
        } satisfies Record<string, unknown>);
      }
      if (proof?.['method'] === 'workos-device') {
        if (
          proof['deviceCode'] !== (options.workosDeviceCode ?? 'workos-device-code') ||
          proof['issuer'] !== 'https://api.workos.com/user_management'
        ) {
          return err('device-authorization-pending', 202);
        }
        const session: FakeSession = {
          accountId: 'workos-account-1',
          enrollmentId: `enr-${crypto.randomUUID()}`,
          refreshToken: `rt-${crypto.randomUUID()}`,
          accessToken: `at-${crypto.randomUUID()}`,
          generation: 1,
          accessExpiresAt: new Date(Date.now() + accessTtlMs).toISOString(),
        };
        sessions.set(session.enrollmentId, session);
        refreshIndex.set(session.refreshToken, session.enrollmentId);
        accessIndex.set(session.accessToken, session.enrollmentId);
        return Response.json({
          accessToken: session.accessToken,
          accessExpiresAt: session.accessExpiresAt,
          refreshToken: session.refreshToken,
          credentialGeneration: session.generation,
          enrollmentId: session.enrollmentId,
          accountId: session.accountId,
          datasetEpoch: SPIKE_DATASET_EPOCH,
        } satisfies Record<string, unknown>);
      }
      return err('invalid-proof');
    }

    if (path === '/v1/session/refresh') {
      const enrollmentId = body['enrollmentId'] as string;
      const presented = body['refreshToken'] as string;
      const session = sessions.get(enrollmentId);
      if (session === undefined || refreshIndex.get(presented) !== enrollmentId) {
        return err('invalid-proof');
      }
      refreshIndex.delete(session.refreshToken);
      accessIndex.delete(session.accessToken);
      session.refreshToken = `rt-${crypto.randomUUID()}`;
      session.accessToken = `at-${crypto.randomUUID()}`;
      session.generation += 1;
      session.accessExpiresAt = new Date(Date.now() + accessTtlMs).toISOString();
      refreshIndex.set(session.refreshToken, enrollmentId);
      accessIndex.set(session.accessToken, enrollmentId);
      return Response.json({
        accessToken: session.accessToken,
        accessExpiresAt: session.accessExpiresAt,
        refreshToken: session.refreshToken,
        credentialGeneration: session.generation,
        enrollmentId: session.enrollmentId,
        accountId: session.accountId,
        datasetEpoch: SPIKE_DATASET_EPOCH,
      } satisfies Record<string, unknown>);
    }

    if (path === '/v1/session/revoke') {
      const session = sessions.get(body['enrollmentId'] as string);
      if (session !== undefined) {
        sessions.delete(session.enrollmentId);
        refreshIndex.delete(session.refreshToken);
        accessIndex.delete(session.accessToken);
      }
      return Response.json({ revoked: true });
    }

    if (path === '/v1/rpc') {
      const token = authorization?.replace(/^Bearer /, '') ?? '';
      const session = sessions.get(accessIndex.get(token) ?? '');
      if (session === undefined) {
        return err('unauthenticated');
      }
      const operation = body['operation'] as string;
      const requestId = body['requestId'] as string;
      if (operation === 'session.describe') {
        return Response.json({
          requestId,
          serverTime: new Date().toISOString(),
          result: {
            accountId: session.accountId,
            enrollmentId: session.enrollmentId,
            datasetEpoch: SPIKE_DATASET_EPOCH,
            credentialGeneration: session.generation,
            accessExpiresAt: session.accessExpiresAt,
            accountStats: {
              historyBytes: 4096,
              historyQuotaBytes: 67108864,
              retentionFloor: 7,
              counters: { push_total: 3, pull_total: 5 },
            },
            // Self-host shape: the field is simply absent.
            ...(() => {
              const entitlement =
                typeof options.entitlement === 'function'
                  ? options.entitlement()
                  : options.entitlement;
              return entitlement === undefined ? {} : { entitlement };
            })(),
          },
        });
      }
      if (operation === 'device.list') {
        return Response.json({
          requestId,
          serverTime: new Date().toISOString(),
          result: {
            devices: [...sessions.values()]
              .filter((candidate) => candidate.accountId === session.accountId)
              .map((candidate) => ({
                enrollmentId: candidate.enrollmentId,
                installationId: `installation-${candidate.enrollmentId}`,
                credentialGeneration: candidate.generation,
                revoked: false,
                createdAt: new Date().toISOString(),
                self: candidate.enrollmentId === session.enrollmentId,
              })),
          },
        });
      }
      if (operation === 'security.get') {
        return Response.json({
          requestId,
          serverTime: new Date().toISOString(),
          result: {
            accountId: session.accountId,
            policy: 'require-approval',
            revision: 1,
            configured: false,
            recovery: null,
            trustState: 'trusted',
            trustSource: 'first-device',
            canConfigure: true,
            bootstrapEnrollmentId: session.enrollmentId,
            requiresRecovery: false,
            recentEvents: [],
            enrollments: (options.trustedEnrollmentIds ?? []).map((enrollmentId) => ({
              enrollmentId,
              trustState: 'trusted',
              trustSource: 'manual-approval',
            })),
          },
        });
      }
      if (operation === 'security.approve') {
        return Response.json({
          requestId,
          serverTime: new Date().toISOString(),
          result: {
            accountId: session.accountId,
            policy: 'require-approval',
            revision: 1,
            configured: false,
            trustState: 'trusted',
            trustSource: 'manual-approval',
            canConfigure: true,
            requiresRecovery: false,
            recentEvents: [],
          },
        });
      }
      if (operation === 'security.reset') {
        if (options.denyReset !== undefined) {
          return Response.json(
            { requestId, error: { code: options.denyReset, retryable: false } },
            { status: 409 },
          );
        }
        return Response.json({
          requestId,
          serverTime: new Date().toISOString(),
          result: { reset: true, accountId: session.accountId },
        });
      }
      if (operation === 'sync.pull') {
        return Response.json({
          requestId,
          serverTime: new Date().toISOString(),
          result: { changes: [], nextCursor: '0', hasMore: false },
        });
      }
      if (operation === 'sync.push') {
        if (options.denyPush !== undefined) {
          return Response.json(
            {
              requestId,
              error: {
                code: 'forbidden',
                retryable: false,
                details: { reason: options.denyPush },
              },
            },
            { status: 403 },
          );
        }
        return Response.json({
          requestId,
          serverTime: new Date().toISOString(),
          result: { results: [] },
        });
      }
      return Response.json(
        { requestId, error: { code: 'unsupported-operation', retryable: false } },
        { status: 400 },
      );
    }
    return new Response('not found', { status: 404 });
  }) as typeof fetch;

  return { fetchFn, codes, sessions, calls };
}

function oidcDescriptorFixture(): SyncBackendDescriptor {
  const descriptor = descriptorFixture();
  return { ...descriptor, authModes: ['enrollment-code', 'oidc-pkce'] };
}

function workosDescriptorFixture(): SyncBackendDescriptor {
  const descriptor = descriptorFixture();
  return {
    ...descriptor,
    authModes: ['workos-device'],
    auth: {
      issuer: 'https://api.workos.com/user_management',
      publicClientId: 'client_test',
      scopes: ['openid'],
    },
  };
}

describe('real auth transport (contract routes over injected fetch)', () => {
  it('runs one-shot WorkOS bootstrap without starting runtime timers or sockets', async () => {
    const backend = fakeBackend({ workosDeviceCode: 'private-device-code' });
    const factory = fakeSocketFactory();
    const dir = mkdtempSync(join(tmpdir(), 'sync-runtime-'));
    const fetchFn: typeof fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url === WORKOS_DEVICE_AUTHORIZATION_URL) {
        return Response.json({
          device_code: 'private-device-code',
          user_code: 'RRGQ-BJVS',
          verification_uri: 'https://authkit.example/device',
          expires_in: 300,
          interval: 1,
        });
      }
      return backend.fetchFn(input, init);
    };
    initSyncRuntime(dir, { fetchFn, createSocket: factory.createSocket });
    pinBackend({ baseUrl: 'https://backend.example.test/', descriptor: workosDescriptorFixture() });
    let challenge: { userCode: string; verificationUri: string } | null = null;

    const snapshot = await signInWithWorkOSDevice({
      startRuntime: false,
      timeoutMs: 10_000,
      onChallenge: (next) => {
        challenge = next;
      },
    });

    expect(snapshot.state).toBe('signed-in');
    expect(challenge).toMatchObject({
      userCode: 'RRGQ-BJVS',
      verificationUri: 'https://authkit.example/device',
    });
    expect(getRuntimeStatus().syncEnabled).toBe(true);
    expect(factory.sockets).toHaveLength(0);
    expect(backend.calls.some((call) => call.operation === 'sync.pull')).toBe(true);
    expect(backend.calls.some((call) => call.operation === 'sync.push')).toBe(true);
    expect(JSON.stringify(challenge)).not.toContain('private-device-code');
  });

  it('registers a replacement enrollment before resuming pending changes', async () => {
    const backend = fakeBackend();
    const dir = mkdtempSync(join(tmpdir(), 'sync-runtime-'));
    initSyncRuntime(dir, { fetchFn: backend.fetchFn });
    pinBackend({ baseUrl: 'https://backend.example.test/', descriptor: oidcDescriptorFixture() });
    activateBackend('backend-1');
    upsertEnrollment({
      id: 'old-enrollment',
      scope: SCOPE,
      installationId: 'installation-1',
      displayName: 'Old device session',
      state: 'active',
    });
    saveWorkflowTemplate({
      name: 'Pending template',
      description: '',
      orchestration: { ...DEFAULT_ORCHESTRATION },
      nodes: [node('step-1')],
      edges: [],
    });
    bindLocalEntities(SCOPE);

    const minted = (await (
      await backend.fetchFn('https://backend.example.test/v1/enrollment-codes', {
        method: 'POST',
        headers: { 'content-type': 'application/json', Authorization: 'Bearer admin-token' },
        body: JSON.stringify({ accountId: 'account-1' }),
      })
    ).json()) as { code: string };
    const snapshot = await enrollWithEnrollmentCode(minted.code);

    expect(snapshot.enrollmentId).not.toBe('old-enrollment');
    expect(
      db.prepare('SELECT state FROM device_enrollments WHERE id = ?').get(snapshot.enrollmentId),
    ).toEqual({ state: 'active' });
    await expect(requestSync()).resolves.toBeUndefined();
    expect(getRuntimeStatus().lastError).toBeNull();
  });

  it('redeems an enrollment code through POST /v1/enroll', async () => {
    const backend = fakeBackend();
    const dir = mkdtempSync(join(tmpdir(), 'sync-runtime-'));
    initSyncRuntime(dir, { fetchFn: backend.fetchFn });
    pinBackend({ baseUrl: 'https://backend.example.test/', descriptor: oidcDescriptorFixture() });
    const { fetchFn } = backend;
    // Mint a code through the admin path of the same fake.
    const minted = (await (
      await fetchFn('https://backend.example.test/v1/enrollment-codes', {
        method: 'POST',
        headers: { 'content-type': 'application/json', Authorization: 'Bearer admin-token' },
        body: JSON.stringify({ accountId: 'account-1' }),
      })
    ).json()) as { code: string };

    const snapshot = await enrollWithEnrollmentCode(minted.code);
    expect(snapshot.state).toBe('signed-in');
    expect(snapshot.accountId).toBe('account-1');
    expect(backend.calls.map((c) => c.path)).toContain('/v1/enroll');
  });

  it('refreshes a near-expiry session before a sync cycle', async () => {
    // Access tokens die immediately, so requestSync must rotate first.
    const backend = fakeBackend({ accessTtlMs: 0 });
    const dir = mkdtempSync(join(tmpdir(), 'sync-runtime-'));
    initSyncRuntime(dir, { fetchFn: backend.fetchFn });
    pinBackend({ baseUrl: 'https://backend.example.test/', descriptor: oidcDescriptorFixture() });
    const minted = (await (
      await backend.fetchFn('https://backend.example.test/v1/enrollment-codes', {
        method: 'POST',
        headers: { 'content-type': 'application/json', Authorization: 'Bearer admin-token' },
        body: JSON.stringify({ accountId: 'account-1' }),
      })
    ).json()) as { code: string };
    const snapshot = await enrollWithEnrollmentCode(minted.code);
    const enrollmentId = snapshot.enrollmentId;
    expect(enrollmentId).toBeTruthy();

    enableSync();
    await requestSync();
    const session = [...backend.sessions.values()].find((s) => s.enrollmentId === enrollmentId);
    expect(session?.generation).toBeGreaterThan(1);
    expect(backend.calls.filter((c) => c.path === '/v1/session/refresh').length).toBeGreaterThan(0);
  });

  it('issues a pairing code against the signed-in account', async () => {
    const backend = fakeBackend();
    const dir = mkdtempSync(join(tmpdir(), 'sync-runtime-'));
    initSyncRuntime(dir, { fetchFn: backend.fetchFn });
    pinBackend({ baseUrl: 'https://backend.example.test/', descriptor: oidcDescriptorFixture() });
    const minted = (await (
      await backend.fetchFn('https://backend.example.test/v1/enrollment-codes', {
        method: 'POST',
        headers: { 'content-type': 'application/json', Authorization: 'Bearer admin-token' },
        body: JSON.stringify({ accountId: 'account-1' }),
      })
    ).json()) as { code: string };
    await enrollWithEnrollmentCode(minted.code);

    const issued = await issueEnrollmentCode();
    expect(issued.accountId).toBe('account-1');
    const last = backend.calls[backend.calls.length - 1];
    expect(last.path).toBe('/v1/enrollment-codes');
    expect(last.authorization?.startsWith('Bearer at-')).toBe(true);
  });

  it('completes browser OIDC sign-in through the loopback callback', async () => {
    const backend = fakeBackend();
    const dir = mkdtempSync(join(tmpdir(), 'sync-runtime-'));
    let capturedUrl = '';
    const callback: { deliver?: (cb: { state: string; authorizationCode: string }) => void } = {};
    initSyncRuntime(dir, {
      fetchFn: backend.fetchFn,
      openExternal: async (url) => {
        capturedUrl = url;
      },
      listenLoopback: async () => ({
        redirectUri: 'http://127.0.0.1:54321/callback',
        waitForCallback: () =>
          new Promise((resolve) => {
            callback.deliver = resolve;
          }),
        close: () => undefined,
      }),
    });
    pinBackend({ baseUrl: 'https://backend.example.test/', descriptor: oidcDescriptorFixture() });

    const signing = signInWithOidc();
    await vi.waitFor(() => {
      expect(capturedUrl).toContain('/authorize?');
      expect(callback.deliver).toBeTruthy();
    });
    const state = new URL(capturedUrl).searchParams.get('state') ?? '';
    callback.deliver?.({ state, authorizationCode: 'oidc-code-1' });
    const snapshot = await signing;
    expect(snapshot.state).toBe('signed-in');
    expect(snapshot.accountId).toBe('oidc-account-1');
    const enroll = backend.calls.find((c) => c.path === '/v1/enroll');
    expect(enroll).toBeTruthy();
  });

  it('revokes remotely on sign-out and never sends tokens to another backend', async () => {
    const backend = fakeBackend();
    const dir = mkdtempSync(join(tmpdir(), 'sync-runtime-'));
    initSyncRuntime(dir, { fetchFn: backend.fetchFn });
    pinBackend({ baseUrl: 'https://backend.example.test/', descriptor: oidcDescriptorFixture() });
    const minted = (await (
      await backend.fetchFn('https://backend.example.test/v1/enrollment-codes', {
        method: 'POST',
        headers: { 'content-type': 'application/json', Authorization: 'Bearer admin-token' },
        body: JSON.stringify({ accountId: 'account-1' }),
      })
    ).json()) as { code: string };
    await enrollWithEnrollmentCode(minted.code);
    const status = await signOutSync();
    expect(status.auth.state).toBe('signed-out');
    expect(backend.calls.some((c) => c.path === '/v1/session/revoke')).toBe(true);
  });

  it('flags sessionExpired when the backend rejects the refresh credential', async () => {
    // accessTtlMs 0 → the first requestSync must refresh before cycling.
    const backend = fakeBackend({ accessTtlMs: 0 });
    const dir = mkdtempSync(join(tmpdir(), 'sync-runtime-'));
    initSyncRuntime(dir, { fetchFn: backend.fetchFn });
    pinBackend({ baseUrl: 'https://backend.example.test/', descriptor: oidcDescriptorFixture() });
    const minted = (await (
      await backend.fetchFn('https://backend.example.test/v1/enrollment-codes', {
        method: 'POST',
        headers: { 'content-type': 'application/json', Authorization: 'Bearer admin-token' },
        body: JSON.stringify({ accountId: 'account-1' }),
      })
    ).json()) as { code: string };
    const snapshot = await enrollWithEnrollmentCode(minted.code);
    enableSync();
    // Another device revoked this session server-side.
    backend.sessions.delete(snapshot.enrollmentId ?? '');
    expect(getRuntimeStatus().sessionExpired).toBe(false);
    await expect(requestSync()).rejects.toThrow();
    expect(getRuntimeStatus().sessionExpired).toBe(true);
  });

  it('exports a redacted diagnostics bundle with local rollups and remote stats', async () => {
    const backend = fakeBackend();
    const dir = mkdtempSync(join(tmpdir(), 'sync-runtime-'));
    initSyncRuntime(dir, { fetchFn: backend.fetchFn });
    pinBackend({ baseUrl: 'https://backend.example.test/', descriptor: oidcDescriptorFixture() });
    const minted = (await (
      await backend.fetchFn('https://backend.example.test/v1/enrollment-codes', {
        method: 'POST',
        headers: { 'content-type': 'application/json', Authorization: 'Bearer admin-token' },
        body: JSON.stringify({ accountId: 'account-1' }),
      })
    ).json()) as { code: string };
    await enrollWithEnrollmentCode(minted.code);
    const template = saveWorkflowTemplate({
      name: 'Diagnostic flow',
      nodes: [node('a')],
      edges: [],
    });
    bindLocalEntities(SCOPE);
    expect(listOutboxRows(SCOPE).length).toBe(2);

    const bundle = await exportSyncDiagnostics();
    expect(bundle.protocol).toBe(PROTOCOL);
    expect(bundle.schemaVersion).toBeGreaterThan(0);
    expect(bundle.installationId).toBeTruthy();
    const scopeDiag = bundle.scopes.find(
      (s) => s.backendId === SCOPE.backendId && s.accountId === SCOPE.accountId,
    );
    expect(scopeDiag?.outboxByState['pending']).toBe(2);
    expect(scopeDiag?.bindingsByEntityType[ET]).toBe(1);
    expect(scopeDiag?.bindingsByEntityType[SYNC_ENTITY_SETTINGS]).toBe(1);
    expect(scopeDiag?.openConflicts).toBe(0);
    expect(bundle.remote?.historyBytes).toBe(4096);
    expect(bundle.remote?.counters['pull_total']).toBe(5);

    // Redaction: no tokens, codes, payloads, or template content anywhere.
    const raw = JSON.stringify(bundle);
    expect(raw).not.toContain('at-');
    expect(raw).not.toContain('rt-');
    expect(raw).not.toContain(minted.code);
    expect(raw).not.toContain('Diagnostic flow');
    expect(raw).not.toContain(template.id);
  });
});

/** Minimal ws-shaped fake capturing listeners so tests can emit frames. */
class FakeSocket implements BackendWebSocketLike {
  readonly listeners = new Map<string, Array<(...args: unknown[]) => void>>();
  closedWith: { code?: number; reason?: string } | null = null;
  sent: string[] = [];

  on(event: string, listener: (...args: unknown[]) => void): void {
    const list = this.listeners.get(event) ?? [];
    list.push(listener);
    this.listeners.set(event, list);
  }
  send(data: string): void {
    this.sent.push(data);
  }
  close(code?: number, reason?: string): void {
    this.closedWith = { code, reason };
    this.emit('close', code ?? 1000, reason ?? '');
  }
  emit(event: string, ...args: unknown[]): void {
    for (const listener of this.listeners.get(event) ?? []) {
      listener(...args);
    }
  }
}

function fakeSocketFactory() {
  const sockets: FakeSocket[] = [];
  const connections: { url: string; headers: Record<string, string> }[] = [];
  return {
    sockets,
    connections,
    createSocket: (
      url: string,
      _protocols: string[],
      options: { headers: Record<string, string> },
    ) => {
      const socket = new FakeSocket();
      sockets.push(socket);
      connections.push({ url, headers: options.headers });
      return socket;
    },
  };
}

/** Per-operation canned answers so a real cycle can run push/scan/pull. */
function cannedSyncRpc(onCall: () => void) {
  return (async (_conn: unknown, operation: string) => {
    onCall();
    const result =
      operation === 'sync.push'
        ? { results: [] }
        : operation === 'sync.pull'
          ? { changes: [], nextCursor: '0', hasMore: false }
          : operation === 'sync.scan.begin'
            ? {
                scanId: 'scan-1',
                watermarkStart: 0,
                resumeCursor: '0',
                epoch: SPIKE_DATASET_EPOCH,
              }
            : operation === 'sync.scan.page'
              ? { entities: [], nextCursor: null, done: true }
              : operation === 'sync.scan.finish'
                ? {
                    scanId: 'scan-1',
                    complete: true,
                    watermarkEnd: 0,
                    nextCursor: '0',
                    epoch: SPIKE_DATASET_EPOCH,
                  }
                : {};
    return { result, serverTime: new Date().toISOString() };
  }) as never;
}

/** Control-plane answers for live-channel tests; sync operations use the RPC seam above. */
const liveControlFetch = (async (
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  if (new URL(url).pathname !== '/v1/rpc') return new Response('not found', { status: 404 });
  const body = JSON.parse((init?.body as string) ?? '{}') as {
    operation?: string;
    requestId?: string;
  };
  const result =
    body.operation === 'device.list'
      ? { devices: [] }
      : body.operation === 'security.get'
        ? {
            accountId: 'account-1',
            policy: 'require-approval',
            revision: 1,
            configured: false,
            recovery: null,
            trustState: 'trusted',
            trustSource: 'first-device',
            canConfigure: true,
            bootstrapEnrollmentId: 'spike-enrollment',
            requiresRecovery: false,
            recentEvents: [],
          }
        : {};
  return Response.json({
    requestId: body.requestId ?? 'test-request',
    serverTime: new Date().toISOString(),
    result,
  });
}) as typeof fetch;

describe('live channel', () => {
  beforeEach(() => {
    // Fire-and-forget cycles kicked by enableSync must not hit real DNS.
    setSyncRuntimeRpcForTests(cannedSyncRpc(() => undefined));
  });
  afterEach(() => {
    setSyncRuntimeRpcForTests(undefined);
  });

  it('opens the socket with the session bearer and flips to live on hello', async () => {
    const factory = fakeSocketFactory();
    const dir = mkdtempSync(join(tmpdir(), 'sync-runtime-'));
    initSyncRuntime(dir, {
      devSpikeEnabled: true,
      createSocket: factory.createSocket,
      fetchFn: liveControlFetch,
    });
    pinTestBackend();
    spikeEnroll({ accountId: 'account-1' });
    enableSync();

    expect(factory.sockets).toHaveLength(1);
    expect(factory.connections[0]?.url).toContain('/v1/connect');
    expect(factory.connections[0]?.headers.Authorization).toMatch(/^Bearer /);
    expect(getRuntimeStatus().connectionState).toBe('connecting');

    factory.sockets[0]?.emit(
      'message',
      JSON.stringify({ type: 'hello', version: 1, id: 'h1', enrollmentId: 'e', profiles: [] }),
    );
    expect(getRuntimeStatus().connectionState).toBe('live');
  });

  it('drives a sync cycle on sync.invalidate frames', async () => {
    const factory = fakeSocketFactory();
    const dir = mkdtempSync(join(tmpdir(), 'sync-runtime-'));
    initSyncRuntime(dir, {
      devSpikeEnabled: true,
      createSocket: factory.createSocket,
      fetchFn: liveControlFetch,
    });
    pinTestBackend();
    spikeEnroll({ accountId: 'account-1' });
    let calls = 0;
    setSyncRuntimeRpcForTests(cannedSyncRpc(() => (calls += 1)));
    enableSync();
    await vi.waitFor(() => {
      expect(getRuntimeStatus().lastError).toBeNull();
      expect(calls).toBeGreaterThan(0);
    });
    const before = calls;
    factory.sockets[0]?.emit(
      'message',
      JSON.stringify({ type: 'sync.invalidate', version: 1, id: 'i1' }),
    );
    await vi.waitFor(() => expect(calls).toBeGreaterThan(before));
  });

  it('reconnects with jittered backoff after the socket closes', async () => {
    vi.useFakeTimers();
    try {
      const factory = fakeSocketFactory();
      const dir = mkdtempSync(join(tmpdir(), 'sync-runtime-'));
      initSyncRuntime(dir, {
        devSpikeEnabled: true,
        createSocket: factory.createSocket,
        fetchFn: liveControlFetch,
      });
      pinTestBackend();
      spikeEnroll({ accountId: 'account-1' });
      enableSync();
      expect(factory.sockets).toHaveLength(1);

      factory.sockets[0]?.emit('close', 1006, 'lost');
      expect(getRuntimeStatus().connectionState).toBe('offline');
      await vi.advanceTimersByTimeAsync(35_000);
      expect(factory.sockets.length).toBeGreaterThanOrEqual(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('tears the channel down on sign-out and does not reconnect', async () => {
    vi.useFakeTimers();
    try {
      const factory = fakeSocketFactory();
      const dir = mkdtempSync(join(tmpdir(), 'sync-runtime-'));
      initSyncRuntime(dir, {
        devSpikeEnabled: true,
        createSocket: factory.createSocket,
        fetchFn: liveControlFetch,
      });
      pinTestBackend();
      spikeEnroll({ accountId: 'account-1' });
      enableSync();
      expect(factory.sockets).toHaveLength(1);
      await signOutSync();
      expect(factory.sockets[0]?.closedWith).not.toBeNull();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(factory.sockets).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('runs a bounded one-shot identity refresh and leaves the session for run', async () => {
    const factory = fakeSocketFactory();
    const dir = mkdtempSync(join(tmpdir(), 'sync-runtime-'));
    initSyncRuntime(dir, {
      devSpikeEnabled: true,
      createSocket: factory.createSocket,
      fetchFn: liveControlFetch,
    });
    pinTestBackend();
    spikeEnroll({ accountId: 'account-1' });
    enableSync();

    await refreshDeviceIdentitiesForOneShot();

    expect(getRuntimeStatus().auth.state).toBe('signed-in');
    expect(getRuntimeStatus().syncEnabled).toBe(true);
    expect(factory.sockets[0]?.closedWith).not.toBeNull();
    stopSyncRuntimeForOneShot();
  });
});

describe('hosted entitlement (BILL-05)', () => {
  const RESTRICTED_ENTITLEMENT = {
    state: 'restricted',
    source: 'none',
    planKey: null,
    capabilities: { syncWrite: false, meshSubmit: false },
    limits: { devices: 3, artifactBytes: 0, historyBytes: 0 },
    previewEndsAt: '2026-11-01T00:00:00Z',
    accessUntil: null,
    graceUntil: null,
    checkedAt: '2026-09-11T10:00:00Z',
    revision: 7,
    reason: 'subscription-required',
  };
  const PREVIEW_ENTITLEMENT = {
    state: 'preview',
    source: 'preview',
    planKey: 'hosted-preview',
    capabilities: { syncWrite: true, meshSubmit: true },
    limits: { devices: 3, artifactBytes: 1048576, historyBytes: 67108864 },
    previewEndsAt: '2026-11-01T00:00:00Z',
    accessUntil: '2026-11-01T00:00:00Z',
    graceUntil: null,
    checkedAt: '2026-09-11T10:00:00Z',
    revision: 2,
    reason: 'preview',
  };

  async function enrollOn(backend: ReturnType<typeof fakeBackend>) {
    const minted = (await (
      await backend.fetchFn('https://backend.example.test/v1/enrollment-codes', {
        method: 'POST',
        headers: { 'content-type': 'application/json', Authorization: 'Bearer admin-token' },
        body: JSON.stringify({ accountId: 'account-1' }),
      })
    ).json()) as { code: string };
    const snapshot = await enrollWithEnrollmentCode(minted.code);
    // These scenarios model an established device: provisioned keys require a
    // completed pull, which a fresh enrollment has not done yet.
    updateSyncState(SCOPE, { lastPullAt: new Date().toISOString() });
    return snapshot;
  }

  function rpcOps(backend: ReturnType<typeof fakeBackend>): string[] {
    return backend.calls.map((c) => c.operation).filter((op): op is string => op !== null);
  }

  it('persists the session.describe entitlement and exposes it on runtime status', async () => {
    const backend = fakeBackend({ entitlement: PREVIEW_ENTITLEMENT });
    const dir = mkdtempSync(join(tmpdir(), 'sync-runtime-'));
    initSyncRuntime(dir, {
      fetchFn: backend.fetchFn,
      createSocket: fakeSocketFactory().createSocket,
    });
    pinBackend({ baseUrl: 'https://backend.example.test/', descriptor: oidcDescriptorFixture() });
    await enrollOn(backend);
    enableSync(); // hosted rides status only for the active scope

    const hosted = await refreshHostedEntitlement();
    expect(hosted?.state).toBe('preview');
    expect(hosted?.restricted).toBe(false);
    expect(hosted?.planKey).toBe('hosted-preview');
    expect(hosted?.previewEndsAt).toBe('2026-11-01T00:00:00Z');
    expect(getRuntimeStatus().hosted).toEqual(hosted);
    const row = getSyncEntitlement('backend-1', 'account-1');
    expect(row?.revision).toBe(2);
    expect(row?.reason).toBe('preview');
  });

  it('clears a stale hosted row when session.describe omits entitlement (self-host)', async () => {
    const backend = fakeBackend();
    const dir = mkdtempSync(join(tmpdir(), 'sync-runtime-'));
    initSyncRuntime(dir, { fetchFn: backend.fetchFn });
    pinBackend({ baseUrl: 'https://backend.example.test/', descriptor: oidcDescriptorFixture() });
    await enrollOn(backend);

    upsertSyncEntitlement({
      backendId: 'backend-1',
      accountId: 'account-1',
      state: 'restricted',
      source: 'none',
      planKey: null,
      previewEndsAt: null,
      accessUntil: null,
      graceUntil: null,
      checkedAt: '2026-09-11T10:00:00Z',
      revision: 7,
      reason: 'subscription-required',
      restricted: true,
    });
    const hosted = await refreshHostedEntitlement();
    expect(hosted).toBeNull();
    expect(getSyncEntitlement('backend-1', 'account-1')).toBeNull();
    expect(getRuntimeStatus().hosted).toBeNull();
  });

  it('a restricted entitlement pauses sync writes while pulls keep running', async () => {
    const backend = fakeBackend({ entitlement: RESTRICTED_ENTITLEMENT });
    const dir = mkdtempSync(join(tmpdir(), 'sync-runtime-'));
    initSyncRuntime(dir, {
      fetchFn: backend.fetchFn,
      createSocket: fakeSocketFactory().createSocket,
    });
    pinBackend({ baseUrl: 'https://backend.example.test/', descriptor: oidcDescriptorFixture() });
    await enrollOn(backend);
    enableSync();
    await refreshHostedEntitlement(); // deterministic restricted row

    backend.calls.length = 0;
    await requestSync();
    const ops = rpcOps(backend);
    expect(ops).not.toContain('sync.push');
    expect(ops).not.toContain('sync.scan.begin');
    expect(ops).toContain('sync.pull');
    expect(getRuntimeStatus().lastError).toBeNull();
    // Outbox rows stay queued — nothing was dispatched or dropped.
    expect(listOutboxRows(SCOPE).length).toBeGreaterThan(0);
  });

  it('un-gates the next cycle once session.describe reports access restored', async () => {
    const options: { entitlement?: Record<string, unknown> } = {
      entitlement: RESTRICTED_ENTITLEMENT,
    };
    const backend = fakeBackend(options);
    const dir = mkdtempSync(join(tmpdir(), 'sync-runtime-'));
    initSyncRuntime(dir, {
      fetchFn: backend.fetchFn,
      createSocket: fakeSocketFactory().createSocket,
    });
    pinBackend({ baseUrl: 'https://backend.example.test/', descriptor: oidcDescriptorFixture() });
    await enrollOn(backend);
    enableSync();
    await refreshHostedEntitlement();

    options.entitlement = PREVIEW_ENTITLEMENT;
    const hosted = await refreshHostedEntitlement();
    expect(hosted?.restricted).toBe(false);

    backend.calls.length = 0;
    await requestSync();
    expect(rpcOps(backend)).toContain('sync.push');
  });

  it('a mid-flight hosted 403 still pulls, keeps outbox rows, and stays quiet', async () => {
    const backend = fakeBackend({
      // Authoritative describe flips to restricted the moment a push was denied.
      entitlement: () =>
        backend.calls.some((c) => c.operation === 'sync.push')
          ? RESTRICTED_ENTITLEMENT
          : PREVIEW_ENTITLEMENT,
      denyPush: 'subscription-required',
    });
    const dir = mkdtempSync(join(tmpdir(), 'sync-runtime-'));
    initSyncRuntime(dir, {
      fetchFn: backend.fetchFn,
      createSocket: fakeSocketFactory().createSocket,
    });
    pinBackend({ baseUrl: 'https://backend.example.test/', descriptor: oidcDescriptorFixture() });
    await enrollOn(backend);
    enableSync(); // the kick itself runs the denied cycle

    // The 403 → record → refresh sequence converges on a restricted row.
    await vi.waitFor(() => {
      const row = getSyncEntitlement('backend-1', 'account-1');
      expect(row?.restricted).toBe(true);
      expect(row?.reason).toBe('subscription-required');
    });
    // The pull still ran before the refusal propagated.
    expect(rpcOps(backend)).toContain('sync.pull');
    expect(getRuntimeStatus().lastError).toBeNull();
    // The denied push must not consume or drop local outbox rows.
    expect(listOutboxRows(SCOPE).length).toBeGreaterThan(0);

    // An explicit cycle resolves quietly too — the pause is not a failure.
    await requestSync();
    expect(getRuntimeStatus().lastError).toBeNull();
  });

  it('onAppFocus re-reads hosted access once the throttle window passes', async () => {
    const backend = fakeBackend({ entitlement: PREVIEW_ENTITLEMENT });
    const dir = mkdtempSync(join(tmpdir(), 'sync-runtime-'));
    initSyncRuntime(dir, {
      fetchFn: backend.fetchFn,
      createSocket: fakeSocketFactory().createSocket,
    });
    pinBackend({ baseUrl: 'https://backend.example.test/', descriptor: oidcDescriptorFixture() });
    await enrollOn(backend);
    enableSync();

    let describes = 0;
    vi.useFakeTimers();
    try {
      await vi.advanceTimersByTimeAsync(61_000);
      describes = backend.calls.filter((c) => c.operation === 'session.describe').length;
      clearSyncEntitlement('backend-1', 'account-1');
      onAppFocus();
      await vi.advanceTimersByTimeAsync(0);
    } finally {
      vi.useRealTimers();
    }
    await vi.waitFor(() => {
      expect(
        backend.calls.filter((c) => c.operation === 'session.describe').length,
      ).toBeGreaterThan(describes);
    });
    await vi.waitFor(() => {
      expect(getSyncEntitlement('backend-1', 'account-1')?.state).toBe('preview');
    });
  });

  it('opens only the fixed hosted account URL in the system browser', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sync-runtime-'));
    initSyncRuntime(dir, {});
    await openHostedAccountPage();
    expect(openExternalCalls).toEqual(['https://anvil.dev/account']);
  });

  it('accepts an HTTPS hosted account override in packaged and development builds', () => {
    expect(resolveHostedAccountUrl('https://localhost:3000/account', true)).toBe(
      'https://localhost:3000/account',
    );
    expect(resolveHostedAccountUrl('https://account.example.test/settings', false)).toBe(
      'https://account.example.test/settings',
    );
  });

  it('accepts loopback HTTP only for unpackaged development', () => {
    expect(resolveHostedAccountUrl('http://localhost:3000/account', false)).toBe(
      'http://localhost:3000/account',
    );
    expect(resolveHostedAccountUrl('http://127.0.0.1:3000/account', true)).toBe(
      'https://anvil.dev/account',
    );
  });

  it('falls back for unsafe hosted account overrides', () => {
    expect(resolveHostedAccountUrl('http://evil.example/account', false)).toBe(
      'https://anvil.dev/account',
    );
    expect(resolveHostedAccountUrl('javascript:alert(1)', false)).toBe('https://anvil.dev/account');
  });
});
