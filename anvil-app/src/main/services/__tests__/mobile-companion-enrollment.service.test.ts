import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { SCHEMA_SQL } from '../../db/schema.js';

const inMemoryDb = new Database(':memory:');
inMemoryDb.exec(SCHEMA_SQL);

const mocks = vi.hoisted(() => ({
  auth: {
    state: 'signed-in' as 'signed-out' | 'enrolling' | 'signed-in',
    accountId: 'acct-1' as string | null,
    enrollmentId: 'enr-host' as string | null,
    expiresAt: null as string | null,
  },
  attestDeviceAccessToken: vi.fn(),
  publishCompanionAdvertisement: vi.fn(async () => ({})),
  listDevices: vi.fn(async () => ({ devices: [] })),
}));

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
}));

vi.mock('../../db/database.js', () => ({
  getDb: () => inMemoryDb,
}));

vi.mock('../settings.service.js', () => ({
  getSettings: () => ({}),
}));

vi.mock('../workspace.service.js', () => ({
  getWorkspace: vi.fn(),
  listWorkspaces: vi.fn(() => []),
}));

vi.mock('../companion-events.service.js', () => ({
  emitCompanionEvent: vi.fn(),
  onCompanionEvent: vi.fn(() => () => undefined),
}));

vi.mock('../codex-session.service.js', () => ({
  getCodexSession: vi.fn(),
  interruptTurn: vi.fn(),
  listActiveCodexSessions: vi.fn(() => []),
  listPendingApprovalRequests: vi.fn(() => [
    {
      sessionId: 's-1',
      requestKey: 'r-1',
      requestId: 'req-1',
      kind: 'command',
      createdAt: '2026-05-27T10:00:00.000Z',
      title: 'Command approval',
      summary: 'Test approval.',
      requestedAction: 'pnpm test',
      risk: 'low',
      allowedSurfaces: ['desktop', 'mobile'],
      requiresFullReview: false,
      carPlayApprovable: false,
      markedForLater: false,
    },
  ]),
  resolveApproval: vi.fn(),
  sendMessage: vi.fn(),
  startSession: vi.fn(),
}));

vi.mock('../chat-persistence.service.js', () => ({
  createChatSession: vi.fn(),
  createChatThread: vi.fn(),
  deleteChatThread: vi.fn(),
  findChatAttachment: vi.fn(),
  getChatThread: vi.fn(),
  loadChatHistory: vi.fn(() => []),
  saveChatEntry: vi.fn(),
}));

vi.mock('../sync-runtime.service.js', () => ({
  getRuntimeStatus: () => ({ auth: mocks.auth }),
  attestDeviceAccessToken: mocks.attestDeviceAccessToken,
  publishCompanionAdvertisement: mocks.publishCompanionAdvertisement,
  getDevicePresence: vi.fn(async () => ({ devices: [] })),
  listDevices: mocks.listDevices,
}));

import {
  clearCompanionAttestationCache,
  listCompanionEnrollmentPolicies,
  removeCompanionEnrollmentPolicy,
  setCompanionEnrollmentPolicy,
  startMobileCompanionServer,
  stopMobileCompanionServer,
} from '../mobile-companion.service.js';

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

async function reservePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const port = (probe.address() as AddressInfo).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

const PAIRED_TOKEN = 'paired-token-123';
const ENROLLMENT_TOKEN = 'enrollment-token-456';
let baseUrl = '';

async function api(
  path: string,
  options: { method?: string; token?: string; body?: unknown } = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${baseUrl}${path}`, {
    method: options.method ?? 'GET',
    headers: {
      ...(options.token === undefined ? {} : { authorization: `Bearer ${options.token}` }),
      ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: res.status, body };
}

beforeAll(async () => {
  const port = await reservePort();
  inMemoryDb
    .prepare(
      `INSERT INTO mobile_companion_settings (id, enabled, host, port, instance_id, updated_at)
       VALUES (1, 1, '127.0.0.1', ?, 'test-instance', datetime('now'))`,
    )
    .run(port);
  inMemoryDb
    .prepare(
      `INSERT INTO mobile_companion_devices (id, name, client_type, token_hash, created_at)
       VALUES ('dev-1', 'Paired iPhone', 'mobile', ?, datetime('now'))`,
    )
    .run(hashToken(PAIRED_TOKEN));
  baseUrl = `http://127.0.0.1:${port}`;
  await startMobileCompanionServer();
});

afterAll(async () => {
  await stopMobileCompanionServer();
  inMemoryDb.close();
});

beforeEach(() => {
  inMemoryDb.exec('DELETE FROM companion_enrollment_policies');
  clearCompanionAttestationCache();
  mocks.auth.state = 'signed-in';
  mocks.auth.accountId = 'acct-1';
  mocks.attestDeviceAccessToken.mockReset();
  mocks.attestDeviceAccessToken.mockImplementation(async (token: string) =>
    token === ENROLLMENT_TOKEN ? { accountId: 'acct-1', enrollmentId: 'enr-phone' } : null,
  );
});

describe('account enrollment authentication', () => {
  it('rejects unknown bearer tokens', async () => {
    const res = await api('/api/chat/threads', { token: 'not-a-real-token' });
    expect(res.status).toBe(401);
  });

  it('keeps paired-device tokens working with full access', async () => {
    const res = await api('/api/chat/threads', { token: PAIRED_TOKEN });
    expect(res.status).toBe(200);
    expect(mocks.attestDeviceAccessToken).not.toHaveBeenCalled();
  });

  it('rejects account tokens while the host is signed out', async () => {
    mocks.auth.state = 'signed-out';
    mocks.auth.accountId = null;
    const res = await api('/api/chat/threads', { token: ENROLLMENT_TOKEN });
    expect(res.status).toBe(401);
  });

  it('rejects enrollments from a different account', async () => {
    mocks.attestDeviceAccessToken.mockImplementation(async () => ({
      accountId: 'acct-other',
      enrollmentId: 'enr-phone',
    }));
    const res = await api('/api/chat/threads', { token: ENROLLMENT_TOKEN });
    expect(res.status).toBe(401);
    expect(listCompanionEnrollmentPolicies()).toHaveLength(0);
  });
});

describe('per-enrollment host policy', () => {
  it('creates a pending policy on first verified contact and denies the request', async () => {
    const res = await api('/api/chat/threads', { token: ENROLLMENT_TOKEN });
    expect(res.status).toBe(403);
    expect(res.body.enrollmentId).toBe('enr-phone');

    const policies = listCompanionEnrollmentPolicies();
    expect(policies).toHaveLength(1);
    expect(policies[0]).toMatchObject({
      enrollmentId: 'enr-phone',
      accountId: 'acct-1',
      tier: 'pending',
    });
  });

  it('gates observe/approve/steer by cumulative tier', async () => {
    // Pend the enrollment.
    await api('/api/chat/threads', { token: ENROLLMENT_TOKEN });
    setCompanionEnrollmentPolicy('enr-phone', 'observe');

    // Observe: reads pass, writes fail.
    expect((await api('/api/chat/threads', { token: ENROLLMENT_TOKEN })).status).toBe(200);
    expect(
      (
        await api('/api/approvals/s-1/r-1/resolve', {
          method: 'POST',
          token: ENROLLMENT_TOKEN,
          body: { decision: 'accept' },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await api('/api/sessions/s-1/interrupt', {
          method: 'POST',
          token: ENROLLMENT_TOKEN,
        })
      ).status,
    ).toBe(403);

    // Approve: approval resolution passes, steering still fails.
    setCompanionEnrollmentPolicy('enr-phone', 'approve');
    expect(
      (
        await api('/api/approvals/s-1/r-1/resolve', {
          method: 'POST',
          token: ENROLLMENT_TOKEN,
          body: { decision: 'accept' },
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await api('/api/sessions/s-1/interrupt', {
          method: 'POST',
          token: ENROLLMENT_TOKEN,
        })
      ).status,
    ).toBe(403);

    // Steer: everything passes.
    setCompanionEnrollmentPolicy('enr-phone', 'steer');
    expect(
      (
        await api('/api/sessions/s-1/interrupt', {
          method: 'POST',
          token: ENROLLMENT_TOKEN,
        })
      ).status,
    ).toBe(200);
  });

  it('blocks denied enrollments even with a valid token', async () => {
    await api('/api/chat/threads', { token: ENROLLMENT_TOKEN });
    setCompanionEnrollmentPolicy('enr-phone', 'denied');

    const res = await api('/api/chat/threads', { token: ENROLLMENT_TOKEN });
    expect(res.status).toBe(403);
  });

  it('re-pends a forgotten enrollment on next contact', async () => {
    await api('/api/chat/threads', { token: ENROLLMENT_TOKEN });
    setCompanionEnrollmentPolicy('enr-phone', 'steer');
    removeCompanionEnrollmentPolicy('enr-phone');

    const res = await api('/api/chat/threads', { token: ENROLLMENT_TOKEN });
    expect(res.status).toBe(403);
    expect(listCompanionEnrollmentPolicies()[0]?.tier).toBe('pending');
  });
});
