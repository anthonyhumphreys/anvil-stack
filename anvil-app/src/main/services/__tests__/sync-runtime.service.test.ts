import Database from 'better-sqlite3';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SCHEMA_SQL } from '../../db/schema';
import { DEFAULT_ORCHESTRATION } from '../../../shared/workflow-orchestration';
import type { WorkflowNode } from '../../../shared/types';
import { SPIKE_DATASET_EPOCH, type SyncFairUseStatus } from '../../../shared/sync-runtime';
import {
  SYNC_ENTITY_SETTINGS,
  SYNC_ENTITY_WORKFLOW_TEMPLATE,
  SYNC_ENTITY_WORKSPACE_DEFINITION,
  SYNC_SETTINGS_ENTITY_ID,
  type SyncScope,
} from '../../../shared/sync-mesh';
import type { SyncBackendDescriptor } from '../../../shared/sync-backend';
import {
  CRYPTO_ENTITY_DEVICE_IDENTITY,
  CRYPTO_ENTITY_KEYRING_WRAP,
} from '../../../../cloud/contract/sealed';

let db = new Database(':memory:');
db.exec(SCHEMA_SQL);

vi.mock('../../db/database.js', () => ({ getDb: () => db }));
vi.mock('../persona.service.js', () => ({
  getPersonaById: (id: string) => (id === 'coder' ? { id } : null),
  buildSystemPrompt: () => '',
}));
const { openExternalCalls, secretStorageEnvironment } = vi.hoisted(() => ({
  openExternalCalls: [] as string[],
  secretStorageEnvironment: { dataDir: '/tmp' },
}));
vi.mock('electron', () => ({
  app: { getPath: () => secretStorageEnvironment.dataDir, getVersion: () => 'test' },
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
  enrollEphemeralEnvironment,
  exportSyncDiagnostics,
  approveDeviceTrust,
  activeSyncScope,
  getDeviceSecurityStatus,
  getRuntimeStatus,
  initSyncRuntime,
  issueEnrollmentCode,
  onAppFocus,
  onSystemResume,
  openHostedAccountPage,
  resolveHostedAccountUrl,
  previewAdoption,
  resumeSyncAfterCredentialStorageReady,
  refreshHostedEntitlement,
  refreshDeviceIdentitiesForOneShot,
  resetSyncRuntimeForTests,
  requestSync,
  resetEncryptedSyncAccount,
  setupDeviceRecovery,
  setSyncRuntimeRpcForTests,
  signInWithWorkOSDevice,
  signInWithOidc,
  signOutSync,
  stopSyncRuntimeForOneShot,
  spikeEnroll,
  listDevices,
  listCloudEnvironments,
  resumeCloudEnvironment,
} from '../sync-runtime.service';
import {
  configureSecretVault,
  lockSecretVault,
  resetSecretStorageForTests,
  selectSecretStorageProvider,
  unlockSecretVault,
} from '../auth.service';
import {
  deriveSas,
  currentAccountKey,
  deviceTrustState,
  ensureDeviceIdentity,
  hasAccountKey,
  installAccountKey,
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
import { createWorkspace } from '../workspace.service';
import { DESCRIPTOR_VERSION, PROTOCOL } from '../../../../cloud/contract/version';
import { WORKOS_DEVICE_AUTHORIZATION_URL } from '../workos-device-auth.service';
import { encodePairingPayload } from '../../../../cloud/contract/sealed';

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
    profiles: ['sync/2'],
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
     DELETE FROM workspace_repos; DELETE FROM workspace_repo_definitions;
     DELETE FROM workspace_preferences; DELETE FROM workspaces; DELETE FROM editable_agents;
     DELETE FROM repos;
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

  it('adopts only workspaces explicitly selected for Sync', () => {
    upsertEnrollment({
      displayName: 'Test device',
      id: 'enrollment-1',
      installationId: 'installation-1',
      scope: SCOPE,
      state: 'active',
    });
    const local = createWorkspace({ name: 'Local workspace' });
    const selected = createWorkspace({ name: 'Selected workspace', syncSelected: true });

    expect(
      previewAdoption()
        .filter((item) => item.entityType === SYNC_ENTITY_WORKSPACE_DEFINITION)
        .map((item) => item.entityId),
    ).toEqual([selected.id]);
    expect(bindLocalEntities(SCOPE)).toBe(2); // settings and selected workspace
    expect(getBinding(SCOPE, SYNC_ENTITY_WORKSPACE_DEFINITION, selected.id)).not.toBeNull();
    expect(getBinding(SCOPE, SYNC_ENTITY_WORKSPACE_DEFINITION, local.id)).toBeNull();
    expect(
      listOutboxRows(SCOPE).some(
        (row) => row.entityType === SYNC_ENTITY_WORKSPACE_DEFINITION && row.entityId === local.id,
      ),
    ).toBe(false);
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
    expect(getRuntimeStatus().datasetEpoch).toBeNull();
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
    expect(getRuntimeStatus().datasetEpoch).toBe(SCOPE.datasetEpoch);
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
  proofMethod?: 'oidc-pkce' | 'workos-device' | 'enrollment-code';
  enrollmentClass?: 'device' | 'ephemeral';
  enrollmentExpiresAt?: string;
}

function fakeBackend(
  options: {
    accessTtlMs?: number;
    /** When set, `session.describe` reports this hosted entitlement (BILL-05). */
    entitlement?: Record<string, unknown> | (() => Record<string, unknown> | undefined);
    fairUse?: SyncFairUseStatus;
    /** When set, `sync.push` is refused 403 with this `details.reason`. */
    denyPush?: string;
    /** When set, encrypted-account reset is rejected definitively. */
    denyReset?: string;
    /** Security rows that another device has already trusted. */
    trustedEnrollmentIds?: string[];
    /** Explicit account opt-in for provider-authenticated device trust. */
    autoTrustPolicy?: 'auto-trust-authenticated' | 'require-approval';
    /** WorkOS device code accepted by the fake backend enrollment exchange. */
    workosDeviceCode?: string;
    /** Overrides the account's first durable enrollment for bootstrap tests. */
    bootstrapEnrollmentId?: string;
    /** Simulate an authoritative remote revoke. */
    revokedEnrollmentIds?: string[];
    /** Existing authenticated enrollment which has not been approved yet. */
    pendingEnrollmentIds?: string[];
    /** Back a focused two-profile sync test with a shared in-memory journal. */
    remoteSync?: boolean;
  } = {},
) {
  const accessTtlMs = options.accessTtlMs ?? 15 * 60 * 1000;
  const codes = new Map<string, string>();
  const sessions = new Map<string, FakeSession>();
  const refreshIndex = new Map<string, string>();
  const accessIndex = new Map<string, string>();
  const identityBindings = new Map<string, string>();
  const identityBoundTimes = new Map<string, string>();
  const bootstrapByAccount = new Map<string, string>();
  const remoteChanges: Array<{ accountId: string; change: Record<string, unknown> }> = [];
  const remoteEntityRevisions = new Map<string, number>();
  let activeTrustPolicy = options.autoTrustPolicy ?? 'require-approval';
  let remoteSequence = 0;
  const identityChallenges = new Map<
    string,
    { enrollmentId: string; accountId: string; identityPub: string; expiresAt: string }
  >();
  const calls: {
    path: string;
    operation: string | null;
    authorization: string | null;
    params: unknown;
  }[] = [];
  let recoveryEnvelope: Record<string, unknown> | null = null;
  const trustInfo = (
    candidate: FakeSession,
  ): { trustState: 'pending' | 'trusted' | 'revoked'; trustSource: string } => {
    if ((options.revokedEnrollmentIds ?? []).includes(candidate.enrollmentId)) {
      return { trustState: 'revoked', trustSource: 'unknown' };
    }
    const bootstrapEnrollmentId =
      options.bootstrapEnrollmentId ?? bootstrapByAccount.get(candidate.accountId);
    if (candidate.enrollmentId === bootstrapEnrollmentId) {
      return { trustState: 'trusted', trustSource: 'first-device' };
    }
    if ((options.trustedEnrollmentIds ?? []).includes(candidate.enrollmentId)) {
      return { trustState: 'trusted', trustSource: 'manual-approval' };
    }
    if ((options.pendingEnrollmentIds ?? []).includes(candidate.enrollmentId)) {
      return { trustState: 'pending', trustSource: 'unknown' };
    }
    if (
      activeTrustPolicy === 'auto-trust-authenticated' &&
      candidate.enrollmentClass !== 'ephemeral' &&
      candidate.enrollmentExpiresAt === undefined &&
      (candidate.proofMethod === 'oidc-pkce' || candidate.proofMethod === 'workos-device')
    ) {
      return { trustState: 'trusted', trustSource: 'automatic-auth' };
    }
    return { trustState: 'pending', trustSource: 'unknown' };
  };

  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const path = new URL(url).pathname;
    const headers = new Headers(init?.headers);
    const authorization = headers.get('Authorization');
    const body = JSON.parse((init?.body as string) ?? '{}') as Record<string, unknown>;
    calls.push({
      path,
      operation: (body['operation'] as string) ?? null,
      authorization,
      params: body['params'],
    });
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
      const codeBody = crypto.randomUUID().replace(/-/g, '').slice(0, 20).toUpperCase();
      const code = `anvil-ec-${codeBody.slice(0, 5)}-${codeBody.slice(5, 10)}-${codeBody.slice(10, 15)}-${codeBody.slice(15)}`;
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
          proofMethod: 'enrollment-code',
          enrollmentClass: 'device',
        };
        sessions.set(session.enrollmentId, session);
        if (!bootstrapByAccount.has(accountId))
          bootstrapByAccount.set(accountId, session.enrollmentId);
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
          proofMethod: 'oidc-pkce',
          enrollmentClass: 'device',
        };
        sessions.set(session.enrollmentId, session);
        if (!bootstrapByAccount.has(session.accountId)) {
          bootstrapByAccount.set(session.accountId, session.enrollmentId);
        }
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
          proofMethod: 'workos-device',
          enrollmentClass: 'device',
        };
        sessions.set(session.enrollmentId, session);
        if (!bootstrapByAccount.has(session.accountId)) {
          bootstrapByAccount.set(session.accountId, session.enrollmentId);
        }
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
              ...(options.fairUse === undefined ? {} : { fairUse: options.fairUse }),
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
              .map((candidate) => {
                const trust = trustInfo(candidate);
                return {
                  enrollmentId: candidate.enrollmentId,
                  installationId: `installation-${candidate.enrollmentId}`,
                  credentialGeneration: candidate.generation,
                  revoked: trust.trustState === 'revoked',
                  createdAt: new Date().toISOString(),
                  self: candidate.enrollmentId === session.enrollmentId,
                  trustState: trust.trustState,
                  trustSource: trust.trustSource,
                  proofMethod: candidate.proofMethod,
                  enrollmentClass: candidate.enrollmentClass ?? 'device',
                  ...(candidate.enrollmentExpiresAt === undefined
                    ? {}
                    : { enrollmentExpiresAt: candidate.enrollmentExpiresAt }),
                  ...(identityBindings.has(candidate.enrollmentId)
                    ? {
                        identityPub: identityBindings.get(candidate.enrollmentId),
                        identityBoundAt: identityBoundTimes.get(candidate.enrollmentId),
                      }
                    : { identityPub: null, identityBoundAt: null }),
                };
              }),
          },
        });
      }
      if (operation === 'security.identityChallenge') {
        const params = body['params'] as { identityPub?: unknown } | undefined;
        const identityPub = params?.identityPub;
        if (typeof identityPub !== 'string') {
          return Response.json(
            { requestId, error: { code: 'bad-request', retryable: false } },
            { status: 400 },
          );
        }
        const challengeId = crypto.randomUUID();
        const expiresAt = new Date(Date.now() + 60_000).toISOString();
        const server = generateKeyPairSync('x25519');
        const serverPublicKey = server.publicKey
          .export({ format: 'der', type: 'spki' })
          .subarray(-32)
          .toString('base64url');
        const challenge = randomBytes(32).toString('base64url');
        identityChallenges.set(challengeId, {
          enrollmentId: session.enrollmentId,
          accountId: session.accountId,
          identityPub,
          expiresAt,
        });
        return Response.json({
          requestId,
          serverTime: new Date().toISOString(),
          result: {
            challengeId,
            challenge,
            accountId: session.accountId,
            enrollmentId: session.enrollmentId,
            identityPub,
            serverPublicKey,
            expiresAt,
          },
        });
      }
      if (operation === 'security.bindIdentity') {
        const params = body['params'] as
          | {
              challengeId?: unknown;
              identityPub?: unknown;
              proof?: unknown;
            }
          | undefined;
        const challengeId = params?.challengeId;
        const identityPub = params?.identityPub;
        const challenge =
          typeof challengeId === 'string' ? identityChallenges.get(challengeId) : undefined;
        if (
          challenge === undefined ||
          challenge.accountId !== session.accountId ||
          challenge.enrollmentId !== session.enrollmentId ||
          challenge.identityPub !== identityPub ||
          Date.parse(challenge.expiresAt) <= Date.now() ||
          typeof params?.proof !== 'string' ||
          !/^[A-Za-z0-9_-]{43}$/.test(params.proof)
        ) {
          return Response.json(
            { requestId, error: { code: 'conflict', retryable: false } },
            { status: 409 },
          );
        }
        identityChallenges.delete(challengeId as string);
        identityBindings.set(session.enrollmentId, challenge.identityPub);
        identityBoundTimes.set(session.enrollmentId, new Date().toISOString());
        return Response.json({
          requestId,
          serverTime: new Date().toISOString(),
          result: {
            accountId: session.accountId,
            enrollmentId: session.enrollmentId,
            identityPub: challenge.identityPub,
            identityBoundAt: identityBoundTimes.get(session.enrollmentId),
          },
        });
      }
      if (operation === 'security.get') {
        const trustPolicy = activeTrustPolicy;
        const bootstrapEnrollmentId =
          options.bootstrapEnrollmentId ?? bootstrapByAccount.get(session.accountId);
        const currentTrust = trustInfo(session);
        return Response.json({
          requestId,
          serverTime: new Date().toISOString(),
          result: {
            accountId: session.accountId,
            policy: trustPolicy,
            newDeviceTrustPolicy: trustPolicy,
            revision: 1,
            configured: recoveryEnvelope !== null,
            recovery:
              recoveryEnvelope === null
                ? null
                : {
                    envelope: recoveryEnvelope,
                    verifierPublicKey: recoveryEnvelope['publicKey'],
                    revision: 1,
                    recoveryId: recoveryEnvelope['recoveryId'],
                  },
            trustState: currentTrust.trustState,
            trustSource: currentTrust.trustSource,
            canConfigure:
              recoveryEnvelope === null && bootstrapEnrollmentId === session.enrollmentId,
            bootstrapEnrollmentId,
            requiresRecovery: false,
            recentEvents: [],
            enrollments: [...sessions.values()]
              .filter((candidate) => candidate.accountId === session.accountId)
              .map((candidate) => {
                const identityPub = identityBindings.get(candidate.enrollmentId);
                const trust = trustInfo(candidate);
                return {
                  enrollmentId: candidate.enrollmentId,
                  trustState: trust.trustState,
                  trustSource: trust.trustSource,
                  proofMethod: candidate.proofMethod,
                  enrollmentClass: candidate.enrollmentClass ?? 'device',
                  ...(candidate.enrollmentExpiresAt === undefined
                    ? {}
                    : { enrollmentExpiresAt: candidate.enrollmentExpiresAt }),
                  ...(identityPub === undefined
                    ? {}
                    : {
                        identityPub,
                        identityBoundAt: identityBoundTimes.get(candidate.enrollmentId) ?? null,
                      }),
                };
              }),
          },
        });
      }
      if (operation === 'security.configure') {
        const params = body['params'] as {
          policy?: unknown;
          recovery?: { envelope?: unknown };
        };
        if (params.policy === 'auto-trust-authenticated' || params.policy === 'require-approval') {
          activeTrustPolicy = params.policy;
        }
        const envelope = params.recovery?.envelope;
        if (typeof envelope !== 'object' || envelope === null || Array.isArray(envelope)) {
          return Response.json(
            { requestId, error: { code: 'bad-request', retryable: false } },
            { status: 400 },
          );
        }
        recoveryEnvelope = envelope as Record<string, unknown>;
        return Response.json({
          requestId,
          serverTime: new Date().toISOString(),
          result: {
            accountId: session.accountId,
            policy: params.policy,
            revision: 1,
            configured: true,
            recovery: {
              envelope: recoveryEnvelope,
              verifierPublicKey: recoveryEnvelope['publicKey'],
              revision: 1,
              recoveryId: recoveryEnvelope['recoveryId'],
            },
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
        if (options.remoteSync === true) {
          const params = body['params'] as { cursor?: unknown };
          const cursor =
            typeof params?.cursor === 'string' && /^\d+$/.test(params.cursor)
              ? Number(params.cursor)
              : 0;
          const changes = remoteChanges
            .filter(
              (entry) =>
                entry.accountId === session.accountId &&
                typeof entry.change['sequence'] === 'number' &&
                entry.change['sequence'] > cursor,
            )
            .map((entry) => entry.change);
          const nextCursor =
            changes.length === 0 ? String(cursor) : String(changes[changes.length - 1]['sequence']);
          return Response.json({
            requestId,
            serverTime: new Date().toISOString(),
            result: { changes, nextCursor, hasMore: false, recoveryFloor: 0 },
          });
        }
        return Response.json({
          requestId,
          serverTime: new Date().toISOString(),
          result: { changes: [], nextCursor: '0', hasMore: false, recoveryFloor: 0 },
        });
      }
      if (operation === 'sync.snapshot.get') {
        return Response.json({
          requestId,
          serverTime: new Date().toISOString(),
          result: {
            manifest: null,
            previousManifest: null,
            datasetEpoch: SPIKE_DATASET_EPOCH,
            keyVersion: 0,
            currentCursor: '0',
            recoveryFloor: 0,
          },
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
        if (options.remoteSync === true) {
          const params = body['params'] as { changes?: unknown };
          const pushed = Array.isArray(params?.changes) ? params.changes : [];
          const results: Array<{ changeId: string; revision: number; status: string }> = [];
          for (const item of pushed) {
            if (typeof item !== 'object' || item === null || Array.isArray(item)) continue;
            const change = item as Record<string, unknown>;
            if (
              typeof change['changeId'] !== 'string' ||
              typeof change['entityType'] !== 'string' ||
              typeof change['entityId'] !== 'string' ||
              typeof change['operation'] !== 'string' ||
              typeof change['schemaVersion'] !== 'number'
            ) {
              continue;
            }
            const entityKey = `${session.accountId}\u0000${change['entityType']}\u0000${change['entityId']}`;
            const revision = (remoteEntityRevisions.get(entityKey) ?? 0) + 1;
            remoteEntityRevisions.set(entityKey, revision);
            const remoteChange: Record<string, unknown> = {
              entityType: change['entityType'],
              entityId: change['entityId'],
              operation: change['operation'],
              revision,
              schemaVersion: change['schemaVersion'],
              sequence: ++remoteSequence,
              ...(change['operation'] === 'delete' ? {} : { payload: change['payload'] }),
            };
            remoteChanges.push({ accountId: session.accountId, change: remoteChange });
            results.push({ changeId: change['changeId'], revision, status: 'accepted' });
          }
          return Response.json({
            requestId,
            serverTime: new Date().toISOString(),
            result: { results },
          });
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

  const seedRemoteIdentity = (candidate: FakeSession, identityPub: string): void => {
    sessions.set(candidate.enrollmentId, candidate);
    identityBindings.set(candidate.enrollmentId, identityPub);
    const identityBoundAt = new Date().toISOString();
    identityBoundTimes.set(candidate.enrollmentId, identityBoundAt);
    remoteChanges.push({
      accountId: candidate.accountId,
      change: {
        entityType: CRYPTO_ENTITY_DEVICE_IDENTITY,
        entityId: candidate.enrollmentId,
        operation: 'create',
        revision: 1,
        schemaVersion: 1,
        sequence: ++remoteSequence,
        payload: { v: 1, enrollmentId: candidate.enrollmentId, pub: identityPub },
      },
    });
  };

  return {
    fetchFn,
    codes,
    sessions,
    identityBindings,
    identityBoundTimes,
    remoteChanges,
    calls,
    seedRemoteIdentity,
    setTrustPolicy: (policy: 'auto-trust-authenticated' | 'require-approval') => {
      activeTrustPolicy = policy;
    },
  };
}

function oidcDescriptorFixture(deploymentId = 'backend-1'): SyncBackendDescriptor {
  const descriptor = descriptorFixture(deploymentId);
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

function workosFetch(backend: ReturnType<typeof fakeBackend>): typeof fetch {
  return async (input, init) => {
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
}

async function enrollTestSession(
  dir: string,
  backend: ReturnType<typeof fakeBackend>,
  descriptor = oidcDescriptorFixture(),
): Promise<void> {
  initSyncRuntime(dir, { fetchFn: backend.fetchFn });
  pinBackend({ baseUrl: 'https://backend.example.test/', descriptor });
  const minted = (await (
    await backend.fetchFn('https://backend.example.test/v1/enrollment-codes', {
      method: 'POST',
      headers: { 'content-type': 'application/json', Authorization: 'Bearer admin-token' },
      body: JSON.stringify({ accountId: 'account-1' }),
    })
  ).json()) as { code: string };
  await enrollWithEnrollmentCode(minted.code);
}

describe('session backend isolation', () => {
  it('keeps an unbound legacy session local and never sends its credentials to the selected backend', async () => {
    const backend = fakeBackend();
    const dir = mkdtempSync(join(tmpdir(), 'sync-runtime-'));
    await enrollTestSession(dir, backend);

    const sessionPath = join(dir, 'sync-mesh-session.json');
    const persisted = JSON.parse(readFileSync(sessionPath, 'utf-8')) as {
      backendId: string | null;
      accessExpiresAt: string;
    };
    // Legacy session files predate backend association. Make it near-expiry so
    // requestSync would exercise refresh if the runtime treated it as usable.
    persisted.backendId = null;
    persisted.accessExpiresAt = new Date(Date.now() + 30_000).toISOString();
    writeFileSync(sessionPath, JSON.stringify(persisted), 'utf-8');

    resetSyncRuntimeForTests();
    initSyncRuntime(dir, { fetchFn: backend.fetchFn });
    activateBackend('backend-1');
    backend.calls.length = 0;

    expect(getRuntimeStatus().auth).toMatchObject({ state: 'signed-in', accountId: 'account-1' });
    expect(activeSyncScope()).toBeNull();
    expect(() => enableSync()).toThrow(/not bound to this backend/);
    await refreshHostedEntitlement();
    await requestSync();
    const diagnostics = await exportSyncDiagnostics();
    expect(diagnostics.remote).toBeNull();
    await signOutSync();

    expect(backend.calls).toEqual([]);
  });

  it('blocks account operations when the saved session belongs to a different backend', async () => {
    const backend = fakeBackend();
    const dir = mkdtempSync(join(tmpdir(), 'sync-runtime-'));
    await enrollTestSession(dir, backend);
    activateBackend('backend-1');
    pinBackend({
      baseUrl: 'https://other-backend.example.test/',
      descriptor: oidcDescriptorFixture('backend-2'),
    });
    activateBackend('backend-2');
    backend.calls.length = 0;

    expect(getRuntimeStatus().auth.state).toBe('signed-in');
    expect(activeSyncScope()).toBeNull();
    expect(() => enableSync()).toThrow(/different backend/);
    await expect(listCloudEnvironments()).rejects.toThrow(/different backend/);
    await refreshHostedEntitlement();
    expect((await exportSyncDiagnostics()).remote).toBeNull();

    expect(backend.calls).toEqual([]);
  });
});

describe('credential storage becoming ready', () => {
  it('resumes an active saved session after vault unlock without re-enrolling or changing its account key', async () => {
    const previousStorageDir = secretStorageEnvironment.dataDir;
    const storageDir = mkdtempSync(join(tmpdir(), 'sync-runtime-vault-'));
    const runtimeDir = mkdtempSync(join(tmpdir(), 'sync-runtime-'));
    secretStorageEnvironment.dataDir = storageDir;
    resetSecretStorageForTests();

    try {
      const passphrase = 'test vault passphrase';
      await configureSecretVault({ mode: 'passphrase', passphrase });
      selectSecretStorageProvider('vault');

      const backend = fakeBackend({ accessTtlMs: 0 });
      const sockets = fakeSocketFactory();
      initSyncRuntime(runtimeDir, {
        fetchFn: backend.fetchFn,
        createSocket: sockets.createSocket,
      });
      const pinned = pinBackend({
        baseUrl: 'https://backend.example.test/',
        descriptor: descriptorFixture(),
      });
      const minted = (await (
        await backend.fetchFn('https://backend.example.test/v1/enrollment-codes', {
          method: 'POST',
          headers: { 'content-type': 'application/json', Authorization: 'Bearer admin-token' },
          body: JSON.stringify({ accountId: 'account-1' }),
        })
      ).json()) as { code: string };
      const enrolled = await enrollWithEnrollmentCode(minted.code);

      // Model a previously established account key from another device.
      // Startup recovery must reuse this material after the session unlocks.
      resetSyncRuntimeForTests();
      const originalAccountKey = randomBytes(32);
      installAccountKey(SCOPE, 1, originalAccountKey, 'wrap');
      const savedAccountKey = currentAccountKey(SCOPE);
      activateBackend(pinned.id);
      const enrollmentCount = backend.calls.filter((call) => call.path === '/v1/enroll').length;
      const serverSession = backend.sessions.get(enrolled.enrollmentId!)!;
      const generationBeforeUnlock = serverSession.generation;

      lockSecretVault();
      initSyncRuntime(runtimeDir, {
        fetchFn: backend.fetchFn,
        createSocket: sockets.createSocket,
      });
      expect(getRuntimeStatus().auth).toMatchObject({
        state: 'signed-in',
        accountId: enrolled.accountId,
        enrollmentId: enrolled.enrollmentId,
      });
      expect(sockets.connections).toHaveLength(0);

      await unlockSecretVault(passphrase);
      await resumeSyncAfterCredentialStorageReady();

      expect(getRuntimeStatus().auth).toMatchObject({
        state: 'signed-in',
        accountId: enrolled.accountId,
        enrollmentId: enrolled.enrollmentId,
      });
      expect(backend.calls.filter((call) => call.path === '/v1/enroll')).toHaveLength(
        enrollmentCount,
      );
      expect(serverSession.generation).toBeGreaterThan(generationBeforeUnlock);
      expect(sockets.connections.length).toBeGreaterThan(0);
      expect(currentAccountKey(SCOPE)).toEqual(savedAccountKey);
      expect(hasAccountKey(SCOPE)).toBe(true);
    } finally {
      resetSyncRuntimeForTests();
      resetSecretStorageForTests();
      secretStorageEnvironment.dataDir = previousStorageDir;
      rmSync(storageDir, { recursive: true, force: true });
    }
  });
});

describe('real auth transport (contract routes over injected fetch)', () => {
  it.each(['ephemeral', 'device', undefined] as const)(
    'installs an internal bootstrap session only when the server returns ephemeral class (%s)',
    async (enrollmentClass) => {
      const backend = fakeBackend();
      const minted = (await (
        await backend.fetchFn('https://backend.example.test/v1/enrollment-codes', {
          method: 'POST',
          headers: { 'content-type': 'application/json', Authorization: 'Bearer admin-token' },
          body: JSON.stringify({ accountId: 'account-1' }),
        })
      ).json()) as { code: string };
      const fetchFn: typeof fetch = async (input, init) => {
        const response = await backend.fetchFn(input, init);
        const url =
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (new URL(url).pathname !== '/v1/enroll' || !response.ok) return response;
        return Response.json({
          ...((await response.json()) as Record<string, unknown>),
          enrollmentClass,
        });
      };
      initSyncRuntime(mkdtempSync(join(tmpdir(), 'sync-runtime-')), { fetchFn });
      pinBackend({
        baseUrl: 'https://backend.example.test/',
        descriptor: workosDescriptorFixture(),
        connectionMode: 'hosted',
      });
      if (enrollmentClass === 'ephemeral') {
        await expect(enrollEphemeralEnvironment(minted.code)).resolves.toMatchObject({
          state: 'signed-in',
        });
      } else {
        await expect(enrollEphemeralEnvironment(minted.code)).rejects.toThrow(
          'did not enroll a temporary environment',
        );
        expect(getRuntimeStatus().auth.state).toBe('signed-out');
      }
      expect(hasAccountKey(SCOPE)).toBe(false);
      expect(getRuntimeStatus().syncEnabled).toBe(false);
    },
  );

  it('rejects rich pairing payloads on the internal environment entry point', async () => {
    const backend = fakeBackend();
    initSyncRuntime(mkdtempSync(join(tmpdir(), 'sync-runtime-')), { fetchFn: backend.fetchFn });
    pinBackend({ baseUrl: 'https://backend.example.test/', descriptor: workosDescriptorFixture() });
    await expect(enrollEphemeralEnvironment('anvil-pair-invalid')).rejects.toThrow(
      'plain, class-bound',
    );
    expect(backend.calls).toHaveLength(0);
  });

  it('rejects temporary sessions on the ordinary user-device code path before installing credentials', async () => {
    const backend = fakeBackend();
    const minted = (await (
      await backend.fetchFn('https://backend.example.test/v1/enrollment-codes', {
        method: 'POST',
        headers: { 'content-type': 'application/json', Authorization: 'Bearer admin-token' },
        body: JSON.stringify({ accountId: 'account-1' }),
      })
    ).json()) as { code: string };
    const fetchFn: typeof fetch = async (input, init) => {
      const response = await backend.fetchFn(input, init);
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (new URL(url).pathname !== '/v1/enroll' || !response.ok) return response;
      return Response.json({
        ...((await response.json()) as Record<string, unknown>),
        enrollmentClass: 'ephemeral',
      });
    };
    initSyncRuntime(mkdtempSync(join(tmpdir(), 'sync-runtime-')), { fetchFn });
    pinTestBackend();
    await expect(enrollWithEnrollmentCode(minted.code)).rejects.toThrow(
      'cannot connect a user device',
    );
    expect(getRuntimeStatus().auth.state).toBe('signed-out');
    expect(hasAccountKey(SCOPE)).toBe(false);
    expect(backend.calls.some((call) => call.operation?.startsWith('security.'))).toBe(false);
  });

  it.each(['hosted', 'workos'] as const)(
    'rejects human codes before transport on a %s service',
    async (kind) => {
      const backend = fakeBackend();
      initSyncRuntime(mkdtempSync(join(tmpdir(), 'sync-runtime-')), { fetchFn: backend.fetchFn });
      pinBackend({
        baseUrl: 'https://backend.example.test/',
        descriptor:
          kind === 'workos'
            ? { ...workosDescriptorFixture(), authModes: ['workos-device', 'enrollment-code'] }
            : descriptorFixture(),
        connectionMode: kind === 'hosted' ? 'hosted' : 'compatible',
      });

      await expect(enrollWithEnrollmentCode('unused-code')).rejects.toThrow('Sign in with WorkOS');
      await expect(issueEnrollmentCode()).rejects.toThrow('Sign in with WorkOS');
      expect(backend.calls).toHaveLength(0);
      expect(getRuntimeStatus().auth.state).not.toBe('signed-in');
    },
  );

  it('preserves authenticated ephemeral bootstrap without advertising human codes', async () => {
    const backend = fakeBackend({ workosDeviceCode: 'private-device-code' });
    initSyncRuntime(mkdtempSync(join(tmpdir(), 'sync-runtime-')), {
      fetchFn: workosFetch(backend),
    });
    pinBackend({ baseUrl: 'https://backend.example.test/', descriptor: workosDescriptorFixture() });
    await signInWithWorkOSDevice({ startRuntime: false, timeoutMs: 10_000 });

    await expect(issueEnrollmentCode()).rejects.toThrow('Sign in with WorkOS');
    const result = await issueEnrollmentCode({
      enrollmentClass: 'ephemeral',
      environmentId: 'env-test',
      provider: 'test-provider',
      sessionTtlSeconds: 600,
    });
    expect(result.accountId).toBe('workos-account-1');
    expect(result.pairingPayload).toBeNull();
    expect(backend.calls.filter((call) => call.path === '/v1/enrollment-codes')).toHaveLength(1);
  });

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
    const selectedWorkspace = createWorkspace({ name: 'Selected workspace', syncSelected: true });
    const pausedWorkspace = createWorkspace({ name: 'Local workspace' });
    const otherAccountTemplate = saveWorkflowTemplate({
      name: 'Other account template',
      description: '',
      orchestration: { ...DEFAULT_ORCHESTRATION },
      nodes: [node('step-1')],
      edges: [],
    });
    upsertBinding(OTHER_SCOPE, ET, otherAccountTemplate.id);
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
    expect(getRuntimeStatus().syncEnabled).toBe(false);
    expect(activeSyncScope()).toBeNull();
    expect(factory.sockets).toHaveLength(0);
    expect(backend.calls.some((call) => call.operation === 'sync.pull')).toBe(true);
    expect(backend.calls.some((call) => call.operation === 'sync.scan.begin')).toBe(false);
    const identityOnlyChanges = backend.calls
      .filter((call) => call.operation === 'sync.push')
      .flatMap((call) => {
        const params = call.params as { changes?: Array<{ entityType: string }> } | undefined;
        return params?.changes ?? [];
      });
    expect(identityOnlyChanges).toHaveLength(1);
    expect(identityOnlyChanges[0].entityType).toBe(CRYPTO_ENTITY_DEVICE_IDENTITY);
    expect(
      previewAdoption()
        .filter((item) => item.entityType === SYNC_ENTITY_WORKSPACE_DEFINITION)
        .map((item) => item.entityId),
    ).toEqual([selectedWorkspace.id]);
    expect(previewAdoption().some((item) => item.entityId === otherAccountTemplate.id)).toBe(false);
    expect(previewAdoption().some((item) => item.entityId === pausedWorkspace.id)).toBe(false);

    const security = await getDeviceSecurityStatus();
    expect(security.canConfigure).toBe(true);
    const recovery = await setupDeviceRecovery('auto-trust-authenticated');
    expect(recovery.recoveryCode).toMatch(/-/);
    expect((await getDeviceSecurityStatus()).configured).toBe(true);
    expect(getRuntimeStatus().syncEnabled).toBe(false);
    expect(JSON.stringify(challenge)).not.toContain('private-device-code');
    expect(enableSync().syncEnabled).toBe(true);
  });

  it('delivers an account key to a second paused profile without uploading its app data', async () => {
    const backend = fakeBackend({
      remoteSync: true,
      workosDeviceCode: 'private-device-code',
      pendingEnrollmentIds: ['enr-existing-pending'],
      revokedEnrollmentIds: ['enr-revoked'],
    });
    const sourceDb = db;
    const recipientDb = new Database(':memory:');
    recipientDb.exec(SCHEMA_SQL);
    const sourceDir = mkdtempSync(join(tmpdir(), 'sync-runtime-source-'));
    const recipientDir = mkdtempSync(join(tmpdir(), 'sync-runtime-recipient-'));
    const fetchFn = workosFetch(backend);
    const newPublicIdentity = () =>
      generateKeyPairSync('x25519')
        .publicKey.export({ format: 'der', type: 'spki' })
        .subarray(-32)
        .toString('base64');
    const candidate = (
      enrollmentId: string,
      enrollmentClass: 'device' | 'ephemeral' = 'device',
      enrollmentExpiresAt?: string,
    ): FakeSession => ({
      accountId: 'workos-account-1',
      enrollmentId,
      refreshToken: `refresh-${enrollmentId}`,
      accessToken: `access-${enrollmentId}`,
      generation: 1,
      accessExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      proofMethod: 'workos-device',
      enrollmentClass,
      ...(enrollmentExpiresAt === undefined ? {} : { enrollmentExpiresAt }),
    });
    const recipientWorkflow = {
      name: 'Recipient local-only workflow',
      description: '',
      orchestration: { ...DEFAULT_ORCHESTRATION },
      nodes: [node('recipient-step')],
      edges: [],
    };

    try {
      initSyncRuntime(sourceDir, { fetchFn });
      pinBackend({
        baseUrl: 'https://backend.example.test/',
        descriptor: workosDescriptorFixture(),
      });
      const source = await signInWithWorkOSDevice({ startRuntime: false, timeoutMs: 10_000 });
      expect(source.state).toBe('signed-in');
      const sourceEnrollmentId = source.enrollmentId!;
      const sourceScope: SyncScope = {
        backendId: 'backend-1',
        accountId: 'workos-account-1',
        datasetEpoch: SPIKE_DATASET_EPOCH,
      };
      await setupDeviceRecovery('auto-trust-authenticated');
      saveWorkflowTemplate({
        name: 'Source private workflow',
        description: '',
        orchestration: { ...DEFAULT_ORCHESTRATION },
        nodes: [node('source-step')],
        edges: [],
      });

      backend.seedRemoteIdentity(candidate('enr-existing-pending'), newPublicIdentity());
      backend.seedRemoteIdentity(
        candidate('enr-ephemeral', 'ephemeral', new Date(Date.now() + 60_000).toISOString()),
        newPublicIdentity(),
      );
      backend.seedRemoteIdentity(candidate('enr-revoked'), newPublicIdentity());
      enableSync();
      await requestSync();
      expect(
        backend.remoteChanges.some(
          (entry) => entry.change['entityType'] === SYNC_ENTITY_WORKFLOW_TEMPLATE,
        ),
      ).toBe(true);

      resetSyncRuntimeForTests();
      resetSyncEngineForTests();
      db = recipientDb;
      initSyncRuntime(recipientDir, { fetchFn });
      pinBackend({
        baseUrl: 'https://backend.example.test/',
        descriptor: workosDescriptorFixture(),
      });
      const recipientTemplate = saveWorkflowTemplate(recipientWorkflow);
      const recipient = await signInWithWorkOSDevice({ startRuntime: false, timeoutMs: 10_000 });
      const recipientEnrollmentId = recipient.enrollmentId!;
      const recipientScope: SyncScope = { ...sourceScope };
      expect(getRuntimeStatus().syncEnabled).toBe(false);
      expect(hasAccountKey(recipientScope)).toBe(false);

      const recipientSession = backend.sessions.get(recipientEnrollmentId)!;
      const recipientPushes = backend.calls.filter(
        (call) =>
          call.operation === 'sync.push' &&
          call.authorization === `Bearer ${recipientSession.accessToken}`,
      );
      const recipientChanges = recipientPushes.flatMap((call) => {
        const params = call.params as { changes?: Array<Record<string, unknown>> } | undefined;
        return params?.changes ?? [];
      });
      expect(recipientChanges).toHaveLength(1);
      expect(recipientChanges[0]).toMatchObject({
        entityType: CRYPTO_ENTITY_DEVICE_IDENTITY,
        entityId: recipientEnrollmentId,
      });
      expect(
        backend.remoteChanges.some(
          (entry) =>
            entry.change['entityType'] === SYNC_ENTITY_WORKFLOW_TEMPLATE &&
            entry.change['entityId'] === recipientTemplate.id,
        ),
      ).toBe(false);
      expect(getBinding(recipientScope, ET, recipientTemplate.id)).toBeNull();

      resetSyncRuntimeForTests();
      resetSyncEngineForTests();
      db = sourceDb;
      initSyncRuntime(sourceDir, { fetchFn });
      await requestSync();
      await vi.waitFor(() => {
        expect(
          backend.remoteChanges.some(
            (entry) =>
              entry.change['entityType'] === CRYPTO_ENTITY_KEYRING_WRAP &&
              entry.change['entityId'] === recipientEnrollmentId &&
              (entry.change['payload'] as Record<string, unknown> | undefined)?.[
                'senderEnrollmentId'
              ] === sourceEnrollmentId,
          ),
        ).toBe(true);
      });
      expect(deviceTrustState(sourceScope, recipientEnrollmentId)).toBe('trusted');
      expect(deviceTrustState(sourceScope, 'enr-existing-pending')).toBe('pending');
      expect(deviceTrustState(sourceScope, 'enr-ephemeral')).toBe('pending');
      expect(deviceTrustState(sourceScope, 'enr-revoked')).toBe('revoked');
      expect(
        backend.remoteChanges.some(
          (entry) =>
            entry.change['entityType'] === CRYPTO_ENTITY_KEYRING_WRAP &&
            ['enr-existing-pending', 'enr-ephemeral', 'enr-revoked'].includes(
              entry.change['entityId'] as string,
            ),
        ),
      ).toBe(false);

      const challengeCount = backend.calls.filter(
        (call) => call.operation === 'security.identityChallenge',
      ).length;
      resetSyncRuntimeForTests();
      resetSyncEngineForTests();
      db = recipientDb;
      initSyncRuntime(recipientDir, { fetchFn });
      const realNow = Date.now;
      const offsetClock = vi.spyOn(Date, 'now').mockImplementation(() => realNow() + 31_000);
      try {
        onSystemResume();
        await vi.waitFor(() => expect(hasAccountKey(recipientScope)).toBe(true), {
          timeout: 5_000,
        });
      } finally {
        offsetClock.mockRestore();
      }
      expect(getRuntimeStatus().syncEnabled).toBe(false);
      expect(
        backend.calls.filter((call) => call.operation === 'security.identityChallenge'),
      ).toHaveLength(challengeCount);
      expect(
        backend.calls
          .filter((call) => call.operation === 'sync.push')
          .flatMap((call) => {
            const params = call.params as { changes?: Array<Record<string, unknown>> } | undefined;
            return params?.changes ?? [];
          })
          .filter((change) => change['entityId'] === recipientTemplate.id),
      ).toHaveLength(0);
    } finally {
      resetSyncRuntimeForTests();
      resetSyncEngineForTests();
      db = sourceDb;
      recipientDb.close();
    }
  });

  it('keeps provider-authenticated peers pending when account policy requires approval', async () => {
    const backend = fakeBackend({
      remoteSync: true,
      workosDeviceCode: 'private-device-code',
      trustedEnrollmentIds: ['enr-manually-trusted-peer'],
    });
    const fetchFn = workosFetch(backend);
    const dir = mkdtempSync(join(tmpdir(), 'sync-runtime-opt-out-'));
    const peer = {
      accountId: 'workos-account-1',
      enrollmentId: 'enr-manually-trusted-peer',
      refreshToken: 'peer-refresh',
      accessToken: 'peer-access',
      generation: 1,
      accessExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      proofMethod: 'workos-device' as const,
      enrollmentClass: 'device' as const,
    };
    backend.seedRemoteIdentity(
      peer,
      generateKeyPairSync('x25519')
        .publicKey.export({ format: 'der', type: 'spki' })
        .subarray(-32)
        .toString('base64'),
    );
    initSyncRuntime(dir, { fetchFn });
    pinBackend({ baseUrl: 'https://backend.example.test/', descriptor: workosDescriptorFixture() });
    await signInWithWorkOSDevice({ startRuntime: false, timeoutMs: 10_000 });

    expect(
      deviceTrustState({ ...SCOPE, accountId: 'workos-account-1' }, 'enr-manually-trusted-peer'),
    ).toBe('pending');
    expect(
      backend.remoteChanges.some(
        (entry) =>
          entry.change['entityType'] === CRYPTO_ENTITY_KEYRING_WRAP &&
          entry.change['entityId'] === 'enr-manually-trusted-peer',
      ),
    ).toBe(false);
    expect(getRuntimeStatus().syncEnabled).toBe(false);
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
    expect(
      backend.calls.some(
        (call) =>
          call.path === '/v1/enrollment-codes' &&
          call.authorization?.startsWith('Bearer at-') === true,
      ),
    ).toBe(true);
  });

  it('persists an E2E pairing secret while the backend is paused', async () => {
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
    const pairing = encodePairingPayload({
      enrollmentCode: minted.code,
      pairingNonce: 'b'.repeat(16),
      pairingSecret: 'a'.repeat(64),
    });
    expect(pairing).not.toBeNull();

    await enrollWithEnrollmentCode(pairing!);
    // Enrollment is intentionally still paused, but the reviewed session
    // scope is sufficient to wrap the one-time secret locally. This keeps a
    // restart between enrollment and the Sync opt-in from losing the key.
    expect(
      db.prepare("SELECT role FROM sync_pairing WHERE nonce = 'bbbbbbbbbbbbbbbb'").get(),
    ).toEqual({ role: 'redeemer' });

    // Recreate the runtime from the same persisted session. No plaintext
    // pairing secret is needed after the first call above.
    resetSyncRuntimeForTests();
    initSyncRuntime(dir, { fetchFn: backend.fetchFn });
    expect(
      db.prepare("SELECT role FROM sync_pairing WHERE nonce = 'bbbbbbbbbbbbbbbb'").get(),
    ).toEqual({ role: 'redeemer' });

    enableSync();
    expect(
      db.prepare("SELECT role FROM sync_pairing WHERE nonce = 'bbbbbbbbbbbbbbbb'").get(),
    ).toEqual({ role: 'redeemer' });
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
    // Enrollment publishes its immutable device identity before app entities.
    expect(listOutboxRows(SCOPE).length).toBe(3);

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
          ? { changes: [], nextCursor: '0', hasMore: false, recoveryFloor: 0 }
          : operation === 'sync.snapshot.get'
            ? {
                manifest: null,
                previousManifest: null,
                datasetEpoch: SPIKE_DATASET_EPOCH,
                keyVersion: 0,
                currentCursor: '0',
                recoveryFloor: 0,
              }
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
  it('rejects a direct Anvil Cloud Agent resume while the flag is off', async () => {
    const previous = process.env['ANVIL_CLOUD_AGENTS_ENABLED'];
    delete process.env['ANVIL_CLOUD_AGENTS_ENABLED'];
    try {
      await expect(resumeCloudEnvironment('existing-environment')).rejects.toThrow(
        'Anvil Cloud Agents are unavailable',
      );
    } finally {
      if (previous === undefined) delete process.env['ANVIL_CLOUD_AGENTS_ENABLED'];
      else process.env['ANVIL_CLOUD_AGENTS_ENABLED'] = previous;
    }
  });

  const RESTRICTED_ENTITLEMENT = {
    state: 'restricted',
    source: 'none',
    planKey: null,
    fundedBy: 'none',
    organizationId: null,
    capabilities: { syncWrite: false, meshSubmit: false },
    limits: { devices: 5, artifactBytes: 0, historyBytes: 0 },
    previewEndsAt: '2026-11-01T00:00:00Z',
    accessUntil: null,
    graceUntil: null,
    checkedAt: '2026-09-11T10:00:00Z',
    revision: 7,
    reason: 'account-deleted',
  };
  const PREVIEW_ENTITLEMENT = {
    state: 'preview',
    source: 'preview',
    planKey: 'hosted-preview',
    fundedBy: 'preview',
    organizationId: null,
    capabilities: { syncWrite: true, meshSubmit: true },
    limits: { devices: 5, artifactBytes: 1048576, historyBytes: 67108864 },
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
    expect(hosted?.fundedBy).toBe('preview');
    expect(hosted?.deviceLimit).toBe(5);
    expect(hosted?.previewEndsAt).toBe('2026-11-01T00:00:00Z');
    expect(getRuntimeStatus().hosted).toEqual(hosted);
    const row = getSyncEntitlement('backend-1', 'account-1');
    expect(row?.revision).toBe(2);
    expect(row?.reason).toBe('preview');
  });

  it('accepts the free entitlement without a plan, funding source or expiry', async () => {
    const backend = fakeBackend({
      entitlement: {
        ...PREVIEW_ENTITLEMENT,
        state: 'active',
        source: 'none',
        planKey: null,
        fundedBy: 'none',
        accessUntil: null,
        reason: 'free',
      },
    });
    const dir = mkdtempSync(join(tmpdir(), 'sync-runtime-'));
    initSyncRuntime(dir, {
      fetchFn: backend.fetchFn,
      createSocket: fakeSocketFactory().createSocket,
    });
    pinBackend({ baseUrl: 'https://backend.example.test/', descriptor: oidcDescriptorFixture() });
    await enrollOn(backend);
    enableSync();
    const hosted = await refreshHostedEntitlement();
    expect(hosted).toMatchObject({
      state: 'active',
      source: 'none',
      planKey: null,
      fundedBy: 'none',
      accessUntil: null,
      reason: 'free',
      restricted: false,
    });
  });

  it('shows the account-specific fair-use notice with its effective date in hosted status', async () => {
    const fairUseNotice: SyncFairUseStatus = {
      status: 'notice',
      usage: { historyBytes: 4096, artifactBytes: 1024 },
      notice: {
        code: 'storage-usage',
        message: 'Please reduce retained storage before the stated date.',
        noticeAt: '2026-09-11T10:00:00.000Z',
        restrictAt: '2026-09-18T10:00:00.000Z',
        emergency: false,
      },
    };
    const options: {
      entitlement?: Record<string, unknown>;
      fairUse?: SyncFairUseStatus;
    } = { entitlement: PREVIEW_ENTITLEMENT, fairUse: fairUseNotice };
    const backend = fakeBackend(options);
    const dir = mkdtempSync(join(tmpdir(), 'sync-runtime-'));
    initSyncRuntime(dir, {
      fetchFn: backend.fetchFn,
      createSocket: fakeSocketFactory().createSocket,
    });
    pinBackend({ baseUrl: 'https://backend.example.test/', descriptor: oidcDescriptorFixture() });
    await enrollOn(backend);
    enableSync();

    const hosted = await refreshHostedEntitlement();
    expect(hosted?.fairUse).toEqual(fairUseNotice);
    expect(getRuntimeStatus().hosted?.fairUse).toEqual(fairUseNotice);

    options.fairUse = {
      status: 'restricted',
      usage: fairUseNotice.usage,
      notice: fairUseNotice.notice,
    };
    const restricted = await refreshHostedEntitlement();
    expect(restricted?.fairUse?.status).toBe('restricted');
    expect(restricted?.fairUse?.notice?.restrictAt).toBe(fairUseNotice.notice?.restrictAt);
  });

  it('does not surface a failed request from a stale sync cycle in the next runtime', async () => {
    const backend = fakeBackend();
    let resolveDeviceListStarted!: () => void;
    const deviceListStarted = new Promise<void>((resolve) => {
      resolveDeviceListStarted = resolve;
    });
    let rejectDeviceList!: (reason: Error) => void;
    let shouldHoldDeviceList = false;
    let heldDeviceList = false;
    const fetchFn: typeof fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const body = JSON.parse((init?.body as string) ?? '{}') as { operation?: string };
      if (
        new URL(url).pathname === '/v1/rpc' &&
        body.operation === 'device.list' &&
        shouldHoldDeviceList &&
        !heldDeviceList
      ) {
        heldDeviceList = true;
        return new Promise<Response>((_resolve, reject) => {
          rejectDeviceList = reject;
          resolveDeviceListStarted();
        });
      }
      return backend.fetchFn(input, init);
    };
    const dir = mkdtempSync(join(tmpdir(), 'sync-runtime-'));
    initSyncRuntime(dir, {
      fetchFn,
      createSocket: fakeSocketFactory().createSocket,
    });
    pinBackend({ baseUrl: 'https://backend.example.test/', descriptor: oidcDescriptorFixture() });
    await enrollOn(backend);

    // enableSync starts a background cycle; hold its first account RPC while the
    // runtime is reset, then make the old request fail.
    shouldHoldDeviceList = true;
    enableSync();
    await deviceListStarted;
    resetSyncRuntimeForTests();
    initSyncRuntime(mkdtempSync(join(tmpdir(), 'sync-runtime-next-')), {
      fetchFn: fakeBackend().fetchFn,
    });
    rejectDeviceList(new Error('stale device roster failed'));
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(getRuntimeStatus().lastError).toBeNull();
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
      fundedBy: 'none',
      organizationId: null,
      deviceLimit: 5,
      previewEndsAt: null,
      accessUntil: null,
      graceUntil: null,
      checkedAt: '2026-09-11T10:00:00Z',
      revision: 7,
      reason: 'account-paused',
      restricted: true,
    });
    const hosted = await refreshHostedEntitlement();
    expect(hosted).toBeNull();
    expect(getSyncEntitlement('backend-1', 'account-1')).toBeNull();
    expect(getRuntimeStatus().hosted).toBeNull();
  });

  it('an account lifecycle restriction pauses writes while pulls keep running', async () => {
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
    for (const value of [
      'http://evil.example/account',
      'javascript:alert(1)',
      'data:text/html,hello',
      'file:///etc/passwd',
      'ftp://localhost/account',
      'https://user:password@anvil.dev/account',
    ]) {
      expect(resolveHostedAccountUrl(value, false)).toBe('https://anvil.dev/account');
    }
  });
});
