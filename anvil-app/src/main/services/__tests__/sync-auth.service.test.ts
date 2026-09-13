import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const safeStorageMock = vi.hoisted(() => ({
  isEncryptionAvailable: vi.fn(() => true),
  encryptString: vi.fn((value: string) => Buffer.from(`enc:${value}`, 'utf-8')),
  decryptString: vi.fn((encrypted: Buffer) => {
    const text = encrypted.toString('utf-8');
    if (!text.startsWith('enc:')) {
      throw new Error('Error while decrypting the ciphertext.');
    }
    return text.slice('enc:'.length);
  }),
}));

vi.mock('electron', () => ({
  safeStorage: safeStorageMock,
}));

import type {
  DeviceSession,
  EnrollParams,
  SessionRefreshParams,
} from '../../../../cloud/contract/auth.js';
import {
  createSyncAuthService,
  type EnrollFn,
  type SyncAuthService,
} from '../sync-auth.service.js';

const EXPIRES_AT = '2026-09-12T10:00:00.000Z';

interface FakeBackend {
  enroll: EnrollFn;
  refreshCalls: SessionRefreshParams[];
  revokeCalls: number;
  lastEnrollProof: EnrollParams['proof'] | null;
}

/** Deterministic fake backend with refresh-reuse tracking. */
function createFakeBackend(): FakeBackend {
  const generations = new Map<string, number>();
  const usedRefreshTokens = new Set<string>();
  const issuedRefreshTokens = new Map<string, { enrollmentId: string; generation: number }>();
  let counter = 0;
  const fake: FakeBackend = {
    enroll: async (params) => {
      fake.lastEnrollProof = params.proof;
      if (params.proof.method === 'enrollment-code' && params.proof.code === 'USED') {
        throw Object.assign(new Error('code consumed'), { code: 'enrollment-code-used' as const });
      }
      counter += 1;
      const enrollmentId = params.proof.method === 'oidc-pkce' ? 'enr-oidc' : 'enr-1';
      const session: DeviceSession = {
        accessToken: `access-${counter}`,
        accessExpiresAt: EXPIRES_AT,
        refreshToken: `refresh-${counter}`,
        credentialGeneration: 1,
        enrollmentId,
        accountId: 'acct-1',
        datasetEpoch: '1',
      };
      generations.set(enrollmentId, 1);
      issuedRefreshTokens.set(session.refreshToken, { enrollmentId, generation: 1 });
      return session;
    },
    refreshCalls: [],
    revokeCalls: 0,
    lastEnrollProof: null,
  };
  const refresh = async (params: SessionRefreshParams): Promise<DeviceSession> => {
    fake.refreshCalls.push(params);
    const issued = issuedRefreshTokens.get(params.refreshToken);
    if (issued === undefined || usedRefreshTokens.has(params.refreshToken)) {
      throw Object.assign(new Error('refresh already rotated'), {
        code: 'refresh-reuse-detected' as const,
      });
    }
    usedRefreshTokens.add(params.refreshToken);
    counter += 1;
    const generation = (generations.get(params.enrollmentId) ?? 1) + 1;
    generations.set(params.enrollmentId, generation);
    const rotated: DeviceSession = {
      accessToken: `access-${counter}`,
      accessExpiresAt: EXPIRES_AT,
      refreshToken: `refresh-${counter}`,
      credentialGeneration: generation,
      enrollmentId: params.enrollmentId,
      accountId: 'acct-1',
      datasetEpoch: '1',
    };
    issuedRefreshTokens.set(rotated.refreshToken, {
      enrollmentId: params.enrollmentId,
      generation,
    });
    return rotated;
  };
  const revoke = async (): Promise<{ revoked: boolean }> => {
    fake.revokeCalls += 1;
    return { revoked: true };
  };
  return Object.assign(fake, { refresh, revoke });
}

type FullFake = FakeBackend & {
  refresh: (params: SessionRefreshParams) => Promise<DeviceSession>;
  revoke: () => Promise<{ revoked: boolean }>;
};

function sessionFilePath(userDataDir: string): string {
  return join(userDataDir, 'sync-mesh-session.json');
}

function readSessionFile(userDataDir: string): Record<string, unknown> {
  return JSON.parse(readFileSync(sessionFilePath(userDataDir), 'utf-8')) as Record<string, unknown>;
}

function storedRefreshToken(userDataDir: string): string {
  const file = readSessionFile(userDataDir);
  const encoded = file['refreshTokenEncrypted'];
  expect(typeof encoded).toBe('string');
  const encrypted = Buffer.from(encoded as string, 'base64');
  return encrypted.toString('utf-8').replace(/^enc:/, '');
}

let userDataDir: string;
let service: SyncAuthService;
let fake: FullFake;

beforeEach(() => {
  vi.clearAllMocks();
  safeStorageMock.isEncryptionAvailable.mockReturnValue(true);
  userDataDir = mkdtempSync(join(tmpdir(), 'sync-auth-'));
  fake = createFakeBackend() as FullFake;
  service = createSyncAuthService({ userDataDir });
});

describe('enrollWithCode', () => {
  it('stores the session and reports a signed-in snapshot', async () => {
    const snapshot = await service.enrollWithCode('HELLO', fake.enroll, 'backend-1');

    expect(snapshot).toEqual({
      state: 'signed-in',
      accountId: 'acct-1',
      enrollmentId: 'enr-1',
      expiresAt: EXPIRES_AT,
    });
    expect(fake.lastEnrollProof).toEqual({ method: 'enrollment-code', code: 'HELLO' });
    expect(existsSync(sessionFilePath(userDataDir))).toBe(true);
    const fileText = readFileSync(sessionFilePath(userDataDir), 'utf-8');
    expect(fileText).not.toContain('access-1');
    expect(fileText).not.toContain('refresh-1');
    expect(safeStorageMock.encryptString).toHaveBeenCalled();
  });

  it('rejects an empty code without writing a session', async () => {
    await expect(service.enrollWithCode('   ', fake.enroll, 'backend-1')).rejects.toThrow(
      /Missing enrollment code/,
    );
    expect(existsSync(sessionFilePath(userDataDir))).toBe(false);
    expect(service.getPublicSnapshot().state).toBe('signed-out');
  });
});

describe('PKCE login', () => {
  function serviceWithStubLoopback(): { svc: SyncAuthService; close: () => void } {
    const close = vi.fn();
    const svc = createSyncAuthService({
      userDataDir,
      listenLoopback: async () => ({
        redirectUri: 'http://127.0.0.1:54321/callback',
        close,
      }),
    });
    return { svc, close };
  }

  it('builds a placeholder authorization URL with S256 challenge and state', async () => {
    const { svc } = serviceWithStubLoopback();
    const result = await svc.createPkceLogin({ issuer: 'https://identity.example.org' });

    expect(result.redirectUri).toBe('http://127.0.0.1:54321/callback');
    expect(result.state.length).toBeGreaterThan(0);
    expect(result.authorizationUrl.startsWith('https://identity.example.org/authorize?')).toBe(
      true,
    );
    expect(result.authorizationUrl).toContain('code_challenge_method=S256');
    expect(result.authorizationUrl).toContain('code_challenge=');
    expect(result.authorizationUrl).toContain(`state=${encodeURIComponent(result.state)}`);
    expect(result.authorizationUrl).toContain(
      `redirect_uri=${encodeURIComponent('http://127.0.0.1:54321/callback')}`,
    );
    expect(svc.getPublicSnapshot().state).toBe('enrolling');
  });

  it('rejects a state mismatch without writing a session', async () => {
    const { svc } = serviceWithStubLoopback();
    const created = await svc.createPkceLogin();

    await expect(
      svc.completePkceLogin({ state: 'wrong-state', authorizationCode: 'code-123' }, fake.enroll, 'backend-1'),
    ).rejects.toThrow(/state mismatch/);
    expect(existsSync(sessionFilePath(userDataDir))).toBe(false);
    expect(svc.getPublicSnapshot().state).toBe('enrolling');

    const snapshot = await svc.completePkceLogin(
      { state: created.state, authorizationCode: 'code-123' },
      fake.enroll,
      'backend-1',
    );
    expect(snapshot.state).toBe('signed-in');
    expect(snapshot.enrollmentId).toBe('enr-oidc');
    expect(fake.lastEnrollProof).toMatchObject({
      method: 'oidc-pkce',
      authorizationCode: 'code-123',
    });
  });
});

describe('refreshSession', () => {
  it('rotates credentials and increments the credential generation', async () => {
    await service.enrollWithCode('HELLO', fake.enroll, 'backend-1');
    expect(readSessionFile(userDataDir)['credentialGeneration']).toBe(1);

    const snapshot = await service.refreshSession(fake.refresh);

    expect(snapshot.state).toBe('signed-in');
    expect(readSessionFile(userDataDir)['credentialGeneration']).toBe(2);
    expect(fake.refreshCalls).toHaveLength(1);
    expect(fake.refreshCalls[0]).toEqual({ refreshToken: 'refresh-1', enrollmentId: 'enr-1' });
  });

  it('wipes the local session when the old refresh is flagged as reused', async () => {
    await service.enrollWithCode('HELLO', fake.enroll, 'backend-1');
    const oldRefresh = storedRefreshToken(userDataDir);
    await service.refreshSession(fake.refresh);
    expect(service.getPublicSnapshot().state).toBe('signed-in');

    // Presenting the already-rotated refresh token trips reuse detection.
    await expect(
      fake.refresh({ refreshToken: oldRefresh, enrollmentId: 'enr-1' }),
    ).rejects.toMatchObject({
      code: 'refresh-reuse-detected',
    });
    const snapshot = await service.refreshSession(() =>
      fake.refresh({ refreshToken: oldRefresh, enrollmentId: 'enr-1' }),
    );

    expect(snapshot).toEqual({
      state: 'signed-out',
      accountId: null,
      enrollmentId: null,
      expiresAt: null,
    });
    expect(existsSync(sessionFilePath(userDataDir))).toBe(false);
  });

  it('returns signed-out when no session exists', async () => {
    const snapshot = await service.refreshSession(fake.refresh);
    expect(snapshot.state).toBe('signed-out');
    expect(fake.refreshCalls).toHaveLength(0);
  });
});

describe('revokeSession', () => {
  it('revokes idempotently and clears the local session', async () => {
    await service.enrollWithCode('HELLO', fake.enroll, 'backend-1');
    const snapshot = await service.revokeSession(fake.revoke);

    expect(snapshot.state).toBe('signed-out');
    expect(fake.revokeCalls).toBe(1);
    expect(existsSync(sessionFilePath(userDataDir))).toBe(false);

    const again = await service.revokeSession(fake.revoke);
    expect(again.state).toBe('signed-out');
    expect(fake.revokeCalls).toBe(1);
  });
});

describe('getPublicSnapshot', () => {
  it('never exposes tokens, even when stringified', async () => {
    await service.enrollWithCode('HELLO', fake.enroll, 'backend-1');
    const snapshot = service.getPublicSnapshot();

    expect(Object.keys(snapshot).sort()).toEqual(
      ['accountId', 'enrollmentId', 'expiresAt', 'state'].sort(),
    );
    const serialized = JSON.stringify(snapshot);
    expect(serialized).not.toContain('access-');
    expect(serialized).not.toContain('refresh-');
  });

  it('starts signed-out with no session file', () => {
    expect(service.getPublicSnapshot()).toEqual({
      state: 'signed-out',
      accountId: null,
      enrollmentId: null,
      expiresAt: null,
    });
  });
});

describe('installDeviceSession', () => {
  it('stores a spike session whose public snapshot still has no tokens', () => {
    const snapshot = service.installDeviceSession({
      accessToken: 'spike:acct:enr',
      accessExpiresAt: EXPIRES_AT,
      refreshToken: 'spike-refresh:enr',
      credentialGeneration: 1,
      enrollmentId: 'enr',
      accountId: 'acct',
      datasetEpoch: 'spike-epoch-1',
    }, 'backend-1');
    expect(snapshot).toEqual({
      state: 'signed-in',
      accountId: 'acct',
      enrollmentId: 'enr',
      expiresAt: EXPIRES_AT,
    });
    expect(service.getAccessToken()).toBe('spike:acct:enr');
    expect(JSON.stringify(snapshot)).not.toContain('spike:acct:enr');
    service.signOutLocal();
    expect(service.getAccessToken()).toBeNull();
  });
});

describe('backend binding and session fencing', () => {
  it('binds the session to the backend it was enrolled against', async () => {
    await service.enrollWithCode('HELLO', fake.enroll, 'backend-1');
    expect(service.getSessionScopeFields()).toEqual({
      accountId: 'acct-1',
      enrollmentId: 'enr-1',
      datasetEpoch: '1',
      backendId: 'backend-1',
    });
    expect(readSessionFile(userDataDir)['backendId']).toBe('backend-1');
  });

  it('shares one rotation between concurrent refresh callers', async () => {
    await service.enrollWithCode('HELLO', fake.enroll, 'backend-1');
    const [first, second] = await Promise.all([
      service.refreshSession(fake.refresh),
      service.refreshSession(fake.refresh),
    ]);
    expect(first.state).toBe('signed-in');
    expect(second.state).toBe('signed-in');
    expect(fake.refreshCalls).toHaveLength(1);
    expect(readSessionFile(userDataDir)['credentialGeneration']).toBe(2);
  });

  it('discards a rotation response that lands after sign-out', async () => {
    await service.enrollWithCode('HELLO', fake.enroll, 'backend-1');
    let release!: (value: DeviceSession) => void;
    const slowRefresh = () =>
      new Promise<DeviceSession>((resolve) => {
        release = resolve;
      });
    const pending = service.refreshSession(slowRefresh);
    service.signOutLocal();
    release({
      accessToken: 'access-stale',
      accessExpiresAt: EXPIRES_AT,
      refreshToken: 'refresh-stale',
      credentialGeneration: 2,
      enrollmentId: 'enr-1',
      accountId: 'acct-1',
      datasetEpoch: '1',
    });
    const snapshot = await pending;
    expect(snapshot.state).toBe('signed-out');
    expect(existsSync(sessionFilePath(userDataDir))).toBe(false);
    expect(service.getAccessToken()).toBeNull();
  });

  it('discards an enrollment response that lands after sign-out', async () => {
    let release!: (value: DeviceSession) => void;
    const slowEnroll: EnrollFn = () =>
      new Promise<DeviceSession>((resolve) => {
        release = resolve;
      });
    const pending = service.enrollWithCode('HELLO', slowEnroll, 'backend-1');
    service.signOutLocal();
    release({
      accessToken: 'access-late',
      accessExpiresAt: EXPIRES_AT,
      refreshToken: 'refresh-late',
      credentialGeneration: 1,
      enrollmentId: 'enr-late',
      accountId: 'acct-1',
      datasetEpoch: '1',
    });
    const snapshot = await pending;
    expect(snapshot.state).toBe('signed-out');
    expect(existsSync(sessionFilePath(userDataDir))).toBe(false);
  });
});
