import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  runWorkOSDeviceFlow,
  WORKOS_AUTHKIT_ISSUER,
  WORKOS_DEVICE_AUTHORIZATION_URL,
  type WorkOSDeviceEnrollParams,
} from '../workos-device-auth.service.js';
import type { DeviceSession } from '../../../../cloud/contract/auth.js';

const DEVICE_CODE = 'private-device-code-that-must-never-be-public';
const CLIENT_ID = 'client_01M2XPX4PF98H2P7HCNRBZATTE';
const SESSION: DeviceSession = {
  accessToken: 'anvil-access-token',
  accessExpiresAt: '2026-09-20T12:15:00.000Z',
  refreshToken: 'anvil-refresh-token',
  credentialGeneration: 1,
  enrollmentId: 'enr_1',
  accountId: 'acct_1',
  datasetEpoch: 'epoch_1',
};

function authorizationResponse(overrides: Record<string, unknown> = {}): Response {
  return new Response(
    JSON.stringify({
      device_code: DEVICE_CODE,
      user_code: 'RRGQ-BJVS',
      verification_uri: 'https://authkit.example/device',
      verification_uri_complete: 'https://authkit.example/device?user_code=RRGQ-BJVS',
      expires_in: 300,
      interval: 5,
      ...overrides,
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

function setup(
  enrollFn: (params: WorkOSDeviceEnrollParams, signal: AbortSignal) => Promise<DeviceSession>,
  fetchFn: typeof fetch = vi.fn(async () => authorizationResponse()),
) {
  const challenge = vi.fn();
  const sleep = vi.fn(async () => undefined);
  const flow = runWorkOSDeviceFlow({
    clientId: CLIENT_ID,
    installationId: 'install_1',
    fetchFn,
    enrollFn,
    onChallenge: challenge,
    sleep,
    now: () => 0,
  });
  return { flow, challenge, sleep, fetchFn };
}

describe('runWorkOSDeviceFlow', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('requests the public challenge directly and sends only the private proof to Anvil', async () => {
    const enroll = vi.fn(async (params: WorkOSDeviceEnrollParams) => {
      expect(params.proof).toEqual({
        method: 'workos-device',
        issuer: WORKOS_AUTHKIT_ISSUER,
        deviceCode: DEVICE_CODE,
      });
      return SESSION;
    });
    const result = setup(enroll);
    await expect(result.flow).resolves.toEqual(SESSION);

    expect(result.fetchFn).toHaveBeenCalledWith(
      WORKOS_DEVICE_AUTHORIZATION_URL,
      expect.objectContaining({
        method: 'POST',
        body: `client_id=${encodeURIComponent(CLIENT_ID)}`,
      }),
    );
    expect(result.challenge).toHaveBeenCalledWith({
      userCode: 'RRGQ-BJVS',
      verificationUri: 'https://authkit.example/device',
      verificationUriComplete: 'https://authkit.example/device?user_code=RRGQ-BJVS',
      expiresAt: '1970-01-01T00:05:00.000Z',
      intervalSeconds: 5,
    });
    expect(JSON.stringify(result.challenge.mock.calls)).not.toContain(DEVICE_CODE);
  });

  it('retries pending authorization and honors slow_down by adding five seconds', async () => {
    const enroll = vi
      .fn<(params: WorkOSDeviceEnrollParams, signal: AbortSignal) => Promise<DeviceSession>>()
      .mockRejectedValueOnce({ code: 'device-authorization-pending' })
      .mockRejectedValueOnce({ code: 'device-authorization-slow-down' })
      .mockResolvedValueOnce(SESSION);
    const result = setup(enroll);

    await expect(result.flow).resolves.toEqual(SESSION);
    expect(result.sleep).toHaveBeenCalledWith(5_000, expect.any(AbortSignal));
    expect(result.sleep).toHaveBeenCalledWith(10_000, expect.any(AbortSignal));
    expect(enroll).toHaveBeenCalledTimes(3);
  });

  it.each([
    ['device-authorization-denied', 'access_denied'],
    ['device-authorization-expired', 'expired_token'],
  ] as const)('stops on terminal backend error %s', async (backendCode, expectedCode) => {
    const result = setup(
      vi.fn(async () => {
        throw { code: backendCode };
      }),
    );

    await expect(result.flow).rejects.toMatchObject({
      code: expectedCode,
    });
  });

  it('cancels during the bounded wait without polling or writing a secret', async () => {
    const controller = new AbortController();
    const enroll = vi.fn(async () => SESSION);
    const sleep = vi.fn(
      (_milliseconds: number, signal: AbortSignal) =>
        new Promise<void>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        }),
    );
    const promise = runWorkOSDeviceFlow({
      clientId: CLIENT_ID,
      installationId: 'install_1',
      fetchFn: vi.fn(async () => authorizationResponse()),
      enrollFn: enroll,
      sleep,
      signal: controller.signal,
      now: () => 0,
    });
    await Promise.resolve();
    controller.abort();

    await expect(promise).rejects.toMatchObject({ code: 'cancelled' });
    expect(enroll).not.toHaveBeenCalled();
  });

  it.each([
    { verification_uri: 'http://authkit.example/device' },
    { verification_uri: 'https://user:pass@authkit.example/device' },
    { verification_uri: 'https://authkit.example/device#private' },
    { verification_uri: 'https://authkit.example/device?device_code=private' },
    { verification_uri: `https://authkit.example/device?value=${DEVICE_CODE}` },
    { verification_uri_complete: 'https://authkit.example/device?access_token=private' },
    { user_code: 'RRGQ\nBJVS' },
    { expires_in: 0 },
    { device_code: '\u0000bad' },
  ])('rejects malformed or unsafe authorization responses', async (override) => {
    const enroll = vi.fn(async () => SESSION);
    const result = setup(
      enroll,
      vi.fn(async () => authorizationResponse(override)),
    );

    await expect(result.flow).rejects.toMatchObject({
      code: 'malformed-response',
    });
    expect(enroll).not.toHaveBeenCalled();
  });

  it('redacts unexpected backend error text so device codes never reach callers', async () => {
    const result = setup(
      vi.fn(async () => {
        throw new Error(`provider failure ${DEVICE_CODE} anvil-access-token`);
      }),
    );

    await expect(result.flow).rejects.toMatchObject({ code: 'http-error' });
    await expect(result.flow).rejects.not.toThrow(DEVICE_CODE);
  });

  it('rejects malformed Anvil sessions before the caller can persist them', async () => {
    const result = setup(
      vi.fn(
        async () =>
          ({
            ...SESSION,
            accessToken: '',
          }) as DeviceSession,
      ),
    );

    await expect(result.flow).rejects.toMatchObject({ code: 'malformed-response' });
  });

  it('does not poll when the caller is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const enroll = vi.fn(async () => SESSION);
    const result = runWorkOSDeviceFlow({
      clientId: CLIENT_ID,
      installationId: 'install_1',
      fetchFn: vi.fn(async () => authorizationResponse()),
      enrollFn: enroll,
      signal: controller.signal,
    });

    await expect(result).rejects.toMatchObject({ code: 'cancelled' });
    expect(enroll).not.toHaveBeenCalled();
  });
});
