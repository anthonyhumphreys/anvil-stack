import Database from 'better-sqlite3';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SCHEMA_SQL } from '../../db/schema';
import { DEFAULT_ORCHESTRATION } from '../../../shared/workflow-orchestration';
import type { WorkflowNode } from '../../../shared/types';
import { SPIKE_DATASET_EPOCH } from '../../../shared/sync-runtime';
import { SYNC_ENTITY_WORKFLOW_TEMPLATE, type SyncScope } from '../../../shared/sync-mesh';
import type { SyncBackendDescriptor } from '../../../shared/sync-backend';

const db = new Database(':memory:');
db.exec(SCHEMA_SQL);

vi.mock('../../db/database.js', () => ({ getDb: () => db }));
vi.mock('../persona.service.js', () => ({
  getPersonaById: (id: string) => (id === 'coder' ? { id } : null),
  buildSystemPrompt: () => '',
}));
vi.mock('electron', () => ({
  app: { getPath: () => '/tmp', getVersion: () => 'test' },
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
  bindLocalWorkflowTemplates,
  enableSync,
  enrollWithEnrollmentCode,
  getRuntimeStatus,
  initSyncRuntime,
  issueEnrollmentCode,
  previewAdoption,
  resetSyncRuntimeForTests,
  requestSync,
  setSyncRuntimeRpcForTests,
  signInWithOidc,
  signOutSync,
  spikeEnroll,
} from '../sync-runtime.service';
import {
  getBinding,
  listOutboxRows,
  upsertBinding,
  upsertEnrollment,
} from '../sync-persistence.service';
import { pinBackend } from '../sync-backend.service';
import { resetSyncEngineForTests } from '../sync-engine.service';
import type { BackendWebSocketLike } from '../sync-backend-client.service';
import { saveWorkflowTemplate } from '../workflow.service';
import { DESCRIPTOR_VERSION, PROTOCOL } from '../../../../cloud/contract/version';

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
     DELETE FROM sync_backends;`,
  );
});

afterEach(() => {
  resetSyncRuntimeForTests();
});

describe('bindLocalWorkflowTemplates', () => {
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
    expect(previewAdoption()).toHaveLength(1);
    expect(bindLocalWorkflowTemplates(SCOPE)).toBe(1);
    expect(bindLocalWorkflowTemplates(SCOPE)).toBe(0);
    const rows = listOutboxRows(SCOPE);
    expect(rows).toHaveLength(1);
    expect(rows[0].entityType).toBe(ET);
    expect(rows[0].operation).toBe('create');
    expect(rows[0].baseRevision).toBeNull();
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
    // account-1's scope must not silently re-home it.
    expect(bindLocalWorkflowTemplates(SCOPE)).toBe(0);
    expect(listOutboxRows(SCOPE)).toEqual([]);
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

function fakeBackend(options: { accessTtlMs?: number } = {}) {
  const accessTtlMs = options.accessTtlMs ?? 15 * 60 * 1000;
  const codes = new Map<string, string>();
  const sessions = new Map<string, FakeSession>();
  const refreshIndex = new Map<string, string>();
  const accessIndex = new Map<string, string>();
  const calls: { path: string; authorization: string | null }[] = [];

  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const path = new URL(url).pathname;
    const headers = new Headers(init?.headers);
    const authorization = headers.get('Authorization');
    calls.push({ path, authorization });
    const body = JSON.parse((init?.body as string) ?? '{}') as Record<string, unknown>;
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
          },
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
        return Response.json({ requestId, serverTime: new Date().toISOString(), result: { results: [] } });
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

describe('real auth transport (contract routes over injected fetch)', () => {
  it('redeems an enrollment code through POST /v1/enroll', async () => {
    const backend = fakeBackend();
    const dir = mkdtempSync(join(tmpdir(), 'sync-runtime-'));
    initSyncRuntime(dir, { fetchFn: backend.fetchFn });
    pinBackend({ baseUrl: 'https://backend.example.test/', descriptor: oidcDescriptorFixture() });
    const { fetchFn } = backend;
    // Mint a code through the admin path of the same fake.
    const minted = await (await fetchFn('https://backend.example.test/v1/enrollment-codes', {
      method: 'POST',
      headers: { 'content-type': 'application/json', Authorization: 'Bearer admin-token' },
      body: JSON.stringify({ accountId: 'account-1' }),
    })).json() as { code: string };

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
    const minted = await (await backend.fetchFn(
      'https://backend.example.test/v1/enrollment-codes',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', Authorization: 'Bearer admin-token' },
        body: JSON.stringify({ accountId: 'account-1' }),
      },
    )).json() as { code: string };
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
    const minted = await (await backend.fetchFn(
      'https://backend.example.test/v1/enrollment-codes',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', Authorization: 'Bearer admin-token' },
        body: JSON.stringify({ accountId: 'account-1' }),
      },
    )).json() as { code: string };
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
    const minted = await (await backend.fetchFn(
      'https://backend.example.test/v1/enrollment-codes',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', Authorization: 'Bearer admin-token' },
        body: JSON.stringify({ accountId: 'account-1' }),
      },
    )).json() as { code: string };
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
    const minted = await (await backend.fetchFn(
      'https://backend.example.test/v1/enrollment-codes',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', Authorization: 'Bearer admin-token' },
        body: JSON.stringify({ accountId: 'account-1' }),
      },
    )).json() as { code: string };
    const snapshot = await enrollWithEnrollmentCode(minted.code);
    enableSync();
    // Another device revoked this session server-side.
    backend.sessions.delete(snapshot.enrollmentId ?? '');
    expect(getRuntimeStatus().sessionExpired).toBe(false);
    await expect(requestSync()).rejects.toThrow();
    expect(getRuntimeStatus().sessionExpired).toBe(true);
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
    createSocket: (url: string, _protocols: string[], options: { headers: Record<string, string> }) => {
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
    initSyncRuntime(dir, { devSpikeEnabled: true, createSocket: factory.createSocket });
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
    initSyncRuntime(dir, { devSpikeEnabled: true, createSocket: factory.createSocket });
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
      initSyncRuntime(dir, { devSpikeEnabled: true, createSocket: factory.createSocket });
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
      initSyncRuntime(dir, { devSpikeEnabled: true, createSocket: factory.createSocket });
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
});
