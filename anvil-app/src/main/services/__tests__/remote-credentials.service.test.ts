import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockRpc, mockSeal, mockTrustState, mockIdentities, mockGetSettings } = vi.hoisted(() => ({
  mockRpc: vi.fn(),
  mockSeal: vi.fn(),
  mockTrustState: vi.fn(),
  mockIdentities: vi.fn(),
  mockGetSettings: vi.fn(),
}));

vi.mock('../sync-backend-client.service.js', () => ({ rpc: mockRpc }));
vi.mock('../sync-keyring.service.js', () => ({
  deviceTrustState: mockTrustState,
  listDeviceIdentities: mockIdentities,
  sealCredentialGrant: mockSeal,
}));
vi.mock('../settings.service.js', () => ({ getSettings: mockGetSettings }));

import {
  ensureRemoteCredentialGrant,
  resetRemoteCredentialGrantsForTests,
  validateRemoteCredentialChoice,
} from '../remote-credentials.service.js';
import type { JobGetResult } from '../../../../cloud/contract/jobs.js';
import type { SyncScope } from '../../../shared/sync-mesh.js';

const SCOPE: SyncScope = {
  backendId: 'backend-a',
  accountId: 'account-a',
  datasetEpoch: 'epoch-a',
};
const TARGET = 'enrollment-target';
const KEY = 'sk-live-test-secret';

function jobResult(overrides: Partial<JobGetResult['job']> = {}, fence = 7): JobGetResult {
  return {
    job: {
      id: 'job-a',
      requestId: 'request-a',
      payloadHash: 'hash-a',
      kind: 'start-session',
      sourceEnrollmentId: 'source-a',
      requestedTarget: { kind: 'device', enrollmentId: TARGET },
      targetEnrollmentId: TARGET,
      inputManifest: {
        workspaceDefinitionRevision: 'revision-a',
        repositories: [],
        bootstrapDigest: 'digest-a',
        provider: 'codex',
        model: 'gpt-5',
        configVersions: {},
        inputs: {},
      },
      state: 'running',
      queueDeadline: '2026-10-04T00:00:00.000Z',
      retryPolicy: 'safe',
      placementExplanation: null,
      ...overrides,
    },
    attempts: [
      {
        id: 'attempt-a',
        jobId: 'job-a',
        workerIncarnation: 'worker-a',
        fence,
        leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
        state: 'running',
      },
    ],
  };
}

const INPUT_BASE = {
  choice: 'openai-api-key' as const,
  provider: 'codex' as const,
  targetEnrollmentId: TARGET,
  scope: SCOPE,
  context: { apiUrl: 'https://sync.example', accessToken: 'access-token' },
};

describe('remote-credentials.service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetRemoteCredentialGrantsForTests();
    mockIdentities.mockReturnValue([{ enrollmentId: TARGET, pub: 'target-public-key' }]);
    mockTrustState.mockReturnValue('trusted');
    mockGetSettings.mockReturnValue({ openaiApiKey: KEY });
    mockSeal.mockImplementation((input: { env: Record<string, string> }) => ({
      v: 1,
      enc: 'x25519-aes-256-gcm',
      jobId: 'job-a',
      attemptId: 'attempt-a',
      fence: 7,
      targetEnrollmentId: TARGET,
      expiresAt: new Date(Date.now() + 30_000).toISOString(),
      ephPub: 'ephemeral-public-key',
      nonce: 'nonce',
      ct: `encrypted:${Object.keys(input.env).join(',')}`,
    }));
    mockRpc.mockResolvedValue({
      result: { delivered: true },
      serverTime: new Date().toISOString(),
    });
  });

  it('requires an explicit choice and a trusted target identity', () => {
    expect(() => validateRemoteCredentialChoice('codex', TARGET, SCOPE, undefined)).toThrow(
      /Choose how/,
    );
    mockTrustState.mockReturnValue('pending');
    expect(() => validateRemoteCredentialChoice('codex', TARGET, SCOPE, 'codex-account')).toThrow(
      /trusted device/,
    );
  });

  it('rejects a target that differs from the selected device', async () => {
    await expect(
      ensureRemoteCredentialGrant({
        ...INPUT_BASE,
        result: jobResult({ targetEnrollmentId: 'another-device' }),
      }),
    ).rejects.toThrow(/does not match/);
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('seals the saved key for a live attempt without exposing it in the RPC payload or marker', async () => {
    const result = await ensureRemoteCredentialGrant({ ...INPUT_BASE, result: jobResult() });
    expect(result).toEqual({ delivered: true, marker: `attempt-a:7:${TARGET}` });
    expect(mockSeal).toHaveBeenCalledWith(
      expect.objectContaining({ env: { OPENAI_API_KEY: KEY }, targetEnrollmentId: TARGET }),
    );
    const rpcBody = JSON.stringify(mockRpc.mock.calls[0]);
    expect(rpcBody).not.toContain(KEY);
    expect(result.marker).not.toContain(KEY);
    expect(mockRpc).toHaveBeenCalledWith(
      { apiUrl: 'https://sync.example' },
      'credential.deliver',
      {
        grant: expect.objectContaining({
          attemptId: 'attempt-a',
          fence: 7,
          targetEnrollmentId: TARGET,
        }),
      },
      'access-token',
    );
  });

  it('does not redeliver the same persisted fence marker but permits a new fence', async () => {
    const first = await ensureRemoteCredentialGrant({ ...INPUT_BASE, result: jobResult() });
    const sameFence = await ensureRemoteCredentialGrant({
      ...INPUT_BASE,
      result: jobResult(),
      deliveredMarker: first.marker,
    });
    expect(sameFence).toEqual({ delivered: false, marker: first.marker });
    expect(mockRpc).toHaveBeenCalledTimes(1);

    await ensureRemoteCredentialGrant({ ...INPUT_BASE, result: jobResult({}, 8) });
    expect(mockRpc).toHaveBeenCalledTimes(2);
  });

  it('does not grant a key for account-login or target-local choices', async () => {
    for (const choice of ['codex-account', 'target-local'] as const) {
      await expect(
        ensureRemoteCredentialGrant({ ...INPUT_BASE, choice, result: jobResult() }),
      ).resolves.toEqual({ delivered: false });
    }
    expect(mockSeal).not.toHaveBeenCalled();
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('refuses missing or placeholder saved API keys', async () => {
    mockGetSettings.mockReturnValue({ openaiApiKey: '••••••••' });
    await expect(
      ensureRemoteCredentialGrant({ ...INPUT_BASE, result: jobResult() }),
    ).rejects.toThrow(/usable OpenAI API key/);
    expect(mockRpc).not.toHaveBeenCalled();
  });
});
