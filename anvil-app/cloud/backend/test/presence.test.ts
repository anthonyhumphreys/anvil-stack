import { env, runInDurableObject, SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import type { DeviceSession, EnrollmentCodeIssueResult } from '../../contract/auth';
import type {
  DeviceAdvertiseResult,
  DevicePresenceResult,
  SessionAttestResult,
} from '../../contract/companion';
import { MESH_MACHINE_OPERATIONS, MESH_MACHINE_PROTOCOL_VERSION } from '../../contract/machine';
import { isRpcError } from '../../contract/envelope';
import type { AccountCoordinator } from '../src/account-coordinator';
import { expectSuccess, postRpc, spikeBearer, uniqueIds, withSelfHostedBackend } from './helpers';

const ADMIN_TOKEN = 'test-admin-credential';

function accountStub(accountId: string) {
  return env.ACCOUNT.get(env.ACCOUNT.idFromName(accountId));
}

async function issueCode(accountId: string): Promise<EnrollmentCodeIssueResult> {
  env.ENROLLMENT_ADMIN_TOKEN = ADMIN_TOKEN;
  const response = await withSelfHostedBackend(() =>
    SELF.fetch('https://spike.test/v1/enrollment-codes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ADMIN_TOKEN}` },
      body: JSON.stringify({ accountId }),
    }),
  );
  expect(response.status).toBe(200);
  return (await response.json()) as EnrollmentCodeIssueResult;
}

async function enroll(code: string, installationId: string): Promise<DeviceSession> {
  const response = await withSelfHostedBackend(() =>
    SELF.fetch('https://spike.test/v1/enroll', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        proof: { method: 'enrollment-code', code },
        installationId,
        displayName: 'Presence test device',
      }),
    }),
  );
  expect(response.status).toBe(200);
  return (await response.json()) as DeviceSession;
}

const HOST_AD = {
  endpoints: [
    { kind: 'tailscale', host: '100.64.0.1', port: 47631 },
    { kind: 'lan', host: '192.168.1.20', port: 47631 },
  ],
  capabilities: ['observe', 'approve', 'steer'],
};

function machineAd(
  machineId: string,
  hostEnrollmentId: string,
  endpointGeneration = 'generation-1',
) {
  return {
    ...HOST_AD,
    machine: {
      machineId,
      endpointGeneration,
      protocolVersion: MESH_MACHINE_PROTOCOL_VERSION,
      capabilities: ['machine.session/1'],
      operations: [...MESH_MACHINE_OPERATIONS],
      hostEnrollmentId,
    },
  };
}

describe('device.advertise + device.presence', () => {
  it('publishes self-scoped endpoints and lists them in presence', async () => {
    const accountId = `acct-${crypto.randomUUID()}`;
    const host = await enroll((await issueCode(accountId)).code, 'install-host');
    const phone = await enroll((await issueCode(accountId)).code, 'install-phone');
    const hostAuth = `Bearer ${host.accessToken}`;
    const phoneAuth = `Bearer ${phone.accessToken}`;

    const advertised = expectSuccess<DeviceAdvertiseResult>(
      await postRpc('device.advertise', HOST_AD, hostAuth),
    );
    expect(advertised.advertised).toBe(true);

    const presence = expectSuccess<DevicePresenceResult>(
      await postRpc('device.presence', {}, phoneAuth),
    );
    const hostEntry = presence.devices.find((d) => d.enrollmentId === host.enrollmentId);
    expect(hostEntry).toBeDefined();
    expect(hostEntry?.online).toBe(false);
    expect(hostEntry?.self).toBe(false);
    expect(hostEntry?.endpoints).toEqual(HOST_AD.endpoints);
    expect(hostEntry?.capabilities).toEqual(HOST_AD.capabilities);
    // The phone never advertised or pushed — it is absent from the roster.
    expect(presence.devices.find((d) => d.enrollmentId === phone.enrollmentId)).toBeUndefined();
  });

  it('rejects malformed advertisements', async () => {
    const auth = spikeBearer(...(Object.values(uniqueIds('ad-bad')) as [string, string]));
    for (const bad of [
      { endpoints: [{ kind: 'lan', host: 'http://evil.test/', port: 1 }], capabilities: [] },
      { endpoints: [{ kind: 'lan', host: 'h', port: 0 }], capabilities: [] },
      { endpoints: [], capabilities: ['admin'] },
      { endpoints: 'x', capabilities: [] },
    ]) {
      const res = await postRpc('device.advertise', bad, auth);
      expect(res.status).not.toBe(200);
      expect(isRpcError(res.body) && res.body.error.code).toBe('malformed-request');
    }
  });

  it('persists caller-owned machine identity and rejects duplicate owners', async () => {
    const accountId = `acct-${crypto.randomUUID()}`;
    const host = await enroll((await issueCode(accountId)).code, 'install-machine-host');
    const other = await enroll((await issueCode(accountId)).code, 'install-machine-other');
    const machine = machineAd(`machine-${crypto.randomUUID()}`, host.enrollmentId);
    expectSuccess<DeviceAdvertiseResult>(
      await postRpc('device.advertise', machine, `Bearer ${host.accessToken}`),
    );

    const presence = expectSuccess<DevicePresenceResult>(
      await postRpc('device.presence', {}, `Bearer ${other.accessToken}`),
    );
    expect(
      presence.devices.find((entry) => entry.enrollmentId === host.enrollmentId)?.machine,
    ).toEqual(machine.machine);

    const forged = await postRpc(
      'device.advertise',
      machineAd(`machine-${crypto.randomUUID()}`, host.enrollmentId),
      `Bearer ${other.accessToken}`,
    );
    expect(forged.status).toBe(400);
    expect(isRpcError(forged.body) && forged.body.error.details?.['reason']).toBe(
      'machine-host-enrollment-mismatch',
    );

    const duplicate = await postRpc(
      'device.advertise',
      machineAd(machine.machine.machineId, other.enrollmentId),
      `Bearer ${other.accessToken}`,
    );
    expect(duplicate.status).toBe(409);
    expect(isRpcError(duplicate.body) && duplicate.body.error.details?.['reason']).toBe(
      'machine-id-already-advertised',
    );
  });

  it('fails closed on duplicate machine identities already in storage', async () => {
    const accountId = `acct-${crypto.randomUUID()}`;
    const first = await enroll((await issueCode(accountId)).code, 'install-machine-first');
    const second = await enroll((await issueCode(accountId)).code, 'install-machine-second');
    const firstAd = machineAd(`machine-${crypto.randomUUID()}`, first.enrollmentId);
    const secondAd = machineAd(`machine-${crypto.randomUUID()}`, second.enrollmentId);
    expectSuccess<DeviceAdvertiseResult>(
      await postRpc('device.advertise', firstAd, `Bearer ${first.accessToken}`),
    );
    expectSuccess<DeviceAdvertiseResult>(
      await postRpc('device.advertise', secondAd, `Bearer ${second.accessToken}`),
    );
    await runInDurableObject(accountStub(accountId), (_instance: AccountCoordinator, state) => {
      state.storage.sql.exec(
        'UPDATE presence_advertisements SET machine = ? WHERE enrollment_id = ?',
        JSON.stringify(firstAd.machine),
        second.enrollmentId,
      );
    });

    const presence = expectSuccess<DevicePresenceResult>(
      await postRpc('device.presence', {}, `Bearer ${first.accessToken}`),
    );
    expect(
      presence.devices
        .filter((entry) => [first.enrollmentId, second.enrollmentId].includes(entry.enrollmentId))
        .map((entry) => entry.machine),
    ).toEqual([undefined, undefined]);
  });

  it('marks a socket-connected enrollment online and hides stale offline endpoints', async () => {
    const accountId = `acct-${crypto.randomUUID()}`;
    const host = await enroll((await issueCode(accountId)).code, 'install-host-2');
    const hostAuth = `Bearer ${host.accessToken}`;
    expectSuccess<DeviceAdvertiseResult>(await postRpc('device.advertise', HOST_AD, hostAuth));

    // Backdate the ad beyond its TTL: offline + stale → row stays, endpoints hide.
    await runInDurableObject(accountStub(accountId), (_i: AccountCoordinator, state) => {
      state.storage.sql.exec(
        'UPDATE presence_advertisements SET updated_at = ? WHERE enrollment_id = ?',
        Date.now() - 60 * 60 * 1000,
        host.enrollmentId,
      );
    });
    const stale = expectSuccess<DevicePresenceResult>(
      await postRpc('device.presence', {}, hostAuth),
    );
    const staleEntry = stale.devices.find((d) => d.enrollmentId === host.enrollmentId);
    expect(staleEntry?.online).toBe(false);
    expect(staleEntry?.endpoints).toBeUndefined();

    // A live socket re-marks the same enrollment online and resurfaces the ad.
    const upgrade = await SELF.fetch('https://spike.test/v1/connect', {
      headers: { Upgrade: 'websocket', Authorization: hostAuth },
    });
    expect(upgrade.status).toBe(101);
    upgrade.webSocket?.accept();
    const live = expectSuccess<DevicePresenceResult>(
      await postRpc('device.presence', {}, hostAuth),
    );
    const liveEntry = live.devices.find((d) => d.enrollmentId === host.enrollmentId);
    expect(liveEntry?.online).toBe(true);
    expect(liveEntry?.endpoints).toEqual(HOST_AD.endpoints);
    expect(liveEntry?.self).toBe(true);
  });

  it('scopes presence to the caller account only', async () => {
    const accountA = `acct-${crypto.randomUUID()}`;
    const accountB = `acct-${crypto.randomUUID()}`;
    const host = await enroll((await issueCode(accountA)).code, 'install-host-3');
    const outsider = await enroll((await issueCode(accountB)).code, 'install-outsider');
    expectSuccess<DeviceAdvertiseResult>(
      await postRpc('device.advertise', HOST_AD, `Bearer ${host.accessToken}`),
    );
    const presence = expectSuccess<DevicePresenceResult>(
      await postRpc('device.presence', {}, `Bearer ${outsider.accessToken}`),
    );
    expect(presence.devices.find((d) => d.enrollmentId === host.enrollmentId)).toBeUndefined();
  });
});

describe('session.attest', () => {
  it('returns the presented token’s verified claims', async () => {
    const accountId = `acct-${crypto.randomUUID()}`;
    const host = await enroll((await issueCode(accountId)).code, 'install-attest-host');
    const phone = await enroll((await issueCode(accountId)).code, 'install-attest-phone');

    const result = expectSuccess<SessionAttestResult>(
      await postRpc(
        'session.attest',
        { accessToken: phone.accessToken },
        `Bearer ${host.accessToken}`,
      ),
    );
    expect(result).toEqual({ accountId, enrollmentId: phone.enrollmentId });
  });

  it('does not disclose verified claims from another account', async () => {
    const accountA = `acct-${crypto.randomUUID()}`;
    const accountB = `acct-${crypto.randomUUID()}`;
    const host = await enroll((await issueCode(accountA)).code, 'install-attest-cross-host');
    const foreignPhone = await enroll(
      (await issueCode(accountB)).code,
      'install-attest-cross-phone',
    );

    const response = await postRpc(
      'session.attest',
      { accessToken: foreignPhone.accessToken },
      `Bearer ${host.accessToken}`,
    );

    expect(response.status).toBe(401);
    expect(isRpcError(response.body) && response.body.error.code).toBe('unauthenticated');
    expect(response.body).not.toHaveProperty('result');
  });

  it('fails unauthenticated for an unknown token and malformed for empty input', async () => {
    const ids = uniqueIds('attest-bad');
    const auth = spikeBearer(ids.accountId, ids.enrollmentId);

    const bad = await postRpc('session.attest', { accessToken: 'tok_nope' }, auth);
    expect(bad.status).toBe(401);
    expect(isRpcError(bad.body) && bad.body.error.code).toBe('unauthenticated');

    const malformed = await postRpc('session.attest', {}, auth);
    expect(isRpcError(malformed.body) && malformed.body.error.code).toBe('malformed-request');
  });

  it('fails unauthenticated after the presented session is revoked', async () => {
    const accountId = `acct-${crypto.randomUUID()}`;
    const host = await enroll((await issueCode(accountId)).code, 'install-rev-host');
    const phone = await enroll((await issueCode(accountId)).code, 'install-rev-phone');

    const revoke = await SELF.fetch('https://spike.test/v1/session/revoke', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${phone.accessToken}`,
      },
      body: JSON.stringify({ enrollmentId: phone.enrollmentId }),
    });
    expect(revoke.status).toBe(200);

    const res = await postRpc(
      'session.attest',
      { accessToken: phone.accessToken },
      `Bearer ${host.accessToken}`,
    );
    expect(res.status).toBe(401);
  });
});
