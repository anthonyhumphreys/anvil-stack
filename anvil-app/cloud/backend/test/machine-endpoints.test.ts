import { env, runInDurableObject, SELF } from 'cloudflare:test';
import { afterEach, describe, expect, it } from 'vitest';

import type { DeviceSession, EnrollmentCodeIssueResult } from '../../contract/auth';
import type { MeshMachineHostsResponse } from '../../contract/machine';
import { machineEndpointStub, type MachineEndpointAllocationView } from '../src/hosted/machine-endpoints';
import type { MachineEndpointCoordinator } from '../src/hosted/machine-endpoints';
import { expectSuccess, postRpc } from './helpers';

const ADMIN_TOKEN = 'test-admin-credential';
const generation = () => `listener-${crypto.randomUUID()}`;
const machineId = () => `machine-${crypto.randomUUID()}`;
const randomId = (prefix: string) => `${prefix}-${crypto.randomUUID()}`;

async function issueCode(accountId: string): Promise<EnrollmentCodeIssueResult> {
  env.ENROLLMENT_ADMIN_TOKEN = ADMIN_TOKEN;
  const response = await SELF.fetch('https://spike.test/v1/enrollment-codes', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${ADMIN_TOKEN}` },
    body: JSON.stringify({ accountId }),
  });
  expect(response.status).toBe(200);
  return (await response.json()) as EnrollmentCodeIssueResult;
}

async function enroll(accountId: string, displayName: string): Promise<DeviceSession> {
  const code = await issueCode(accountId);
  return enrollWithCode(code.code, displayName);
}

async function enrollWithCode(code: string, displayName: string): Promise<DeviceSession> {
  const response = await SELF.fetch('https://spike.test/v1/enroll', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      proof: { method: 'enrollment-code', code },
      installationId: randomId('install'),
      displayName,
    }),
  });
  expect(response.status).toBe(200);
  return (await response.json()) as DeviceSession;
}

async function pairEnrollment(source: DeviceSession, displayName: string): Promise<DeviceSession> {
  const response = await SELF.fetch('https://spike.test/v1/enrollment-codes', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${source.accessToken}` },
    body: JSON.stringify({ accountId: '' }),
  });
  expect(response.status).toBe(200);
  const code = (await response.json()) as EnrollmentCodeIssueResult;
  const paired = await enrollWithCode(code.code, displayName);
  expectSuccess(await postRpc(
    'security.approve',
    { enrollmentId: paired.enrollmentId, source: 'pairing' },
    `Bearer ${source.accessToken}`,
  ));
  return paired;
}

async function publicPost(path: string, authorization: string, body: unknown): Promise<Response> {
  return SELF.fetch(`https://spike.test${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization },
    body: JSON.stringify(body),
  });
}

function standardBase64(bytes: ArrayBuffer): string {
  let binary = '';
  for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

async function clientPublicKey(): Promise<string> {
  const pair = (await crypto.subtle.generateKey('X25519', true, ['deriveBits'])) as CryptoKeyPair;
  return standardBase64((await crypto.subtle.exportKey('raw', pair.publicKey)) as ArrayBuffer);
}

function hostAdvertisement(hostEnrollmentId: string, id: string, endpointGeneration: string) {
  return {
    endpoints: [{ kind: 'lan', host: '192.168.1.21', port: 47631 }],
    capabilities: ['observe', 'approve', 'steer'],
    machine: {
      hostEnrollmentId,
      machineId: id,
      endpointGeneration,
      protocolVersion: 1,
      capabilities: ['machine.session/1'],
      operations: ['read.snapshot', 'command.submit'],
    },
  };
}

function machineStub() {
  return machineEndpointStub(env);
}

async function machineRequest(path: string, body: unknown): Promise<Response> {
  return machineStub().fetch(`https://internal.anvil${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

afterEach(() => {
  env.ANVIL_MESH_MANAGED_ENDPOINTS = 'false';
  env.CLOUDFLARE_TUNNEL_ACCOUNT_ID = '';
  env.CLOUDFLARE_TUNNEL_ZONE_ID = '';
  env.CLOUDFLARE_TUNNEL_API_TOKEN = '';
  env.MACHINE_ENDPOINT_DOMAIN = '';
});

describe('managed machine endpoint broker', () => {
  it('discovers a host across enrollments and fences one-use admission to its current identity', async () => {
    const accountId = randomId('acct');
    const source = await enroll(accountId, 'Mesh client');
    const host = await pairEnrollment(source, 'Mesh host');
    const hostMachineId = machineId();
    const endpointGeneration = generation();
    const hostAuth = `Bearer ${host.accessToken}`;
    const sourceAuth = `Bearer ${source.accessToken}`;

    expectSuccess(await postRpc('device.advertise', hostAdvertisement(host.enrollmentId, hostMachineId, endpointGeneration), hostAuth));

    const discovery = await SELF.fetch('https://spike.test/v1/mesh/hosts', {
      headers: { authorization: sourceAuth },
    });
    expect(discovery.status).toBe(200);
    const hosts = (await discovery.json()) as MeshMachineHostsResponse;
    expect(hosts.hosts).toHaveLength(1);
    expect(hosts.hosts[0]).toMatchObject({ enrollmentId: host.enrollmentId, machineId: hostMachineId });
    expect(hosts.hosts[0]?.routes[0]).toMatchObject({ kind: 'private', machineId: hostMachineId, endpointGeneration });
    expect(JSON.stringify(hosts)).not.toMatch(/connectorToken|accessToken|test-cloudflare-token/);

    const arbitraryOrigin = await publicPost(`/v1/mesh/hosts/${hostMachineId}/endpoint`, hostAuth, {
      action: 'allocate',
      endpointGeneration,
      requestId: randomId('allocation-request'),
      localOrigin: 'https://attacker.example/redirect',
    });
    expect(arbitraryOrigin.status).toBe(400);
    const defaultOff = await publicPost(`/v1/mesh/hosts/${hostMachineId}/endpoint`, hostAuth, {
      action: 'allocate',
      endpointGeneration,
      requestId: randomId('allocation-request'),
      localOrigin: 'http://127.0.0.1:43127',
    });
    expect(defaultOff.status).toBe(503);

    const claimsInput = {
      kind: 'enrollment',
      endpointGeneration,
      clientPublicKey: await clientPublicKey(),
      requestedCapabilities: ['machine.session/1'],
      operations: ['read.snapshot'],
      scopes: ['workspace:read'],
      bootstrapChallenge: randomId('challenge'),
      requestId: randomId('ticket-request'),
    };
    const issuedResponse = await publicPost(
      `/v1/mesh/hosts/${hostMachineId}/admission-tickets`,
      sourceAuth,
      claimsInput,
    );
    expect(issuedResponse.status, await issuedResponse.clone().text()).toBe(200);
    const issued = (await issuedResponse.json()) as {
      v: 1;
      ticket: string;
      claims: { accountId: string; hostMachineId: string; endpointGeneration: string; principal: { kind: string; sourceEnrollmentId?: string } };
      sealedProofKey: { enc: string; ephPub: string; nonce: string; ct: string };
    };
    expect(issued.claims).toMatchObject({
      accountId,
      hostMachineId,
      endpointGeneration,
      principal: { kind: 'enrollment', sourceEnrollmentId: source.enrollmentId },
    });
    expect(issued.sealedProofKey.enc).toBe('x25519-aes-256-gcm');
    expect(JSON.stringify(issued)).not.toContain(source.accessToken);

    const wrongHost = await publicPost(
      `/v1/mesh/hosts/${machineId()}/admission-tickets`,
      sourceAuth,
      claimsInput,
    );
    expect(wrongHost.status).toBe(404);
    const unrelatedAccount = await enroll(randomId('acct'), 'Unrelated client');
    const crossAccount = await publicPost(
      `/v1/mesh/hosts/${hostMachineId}/admission-tickets`,
      `Bearer ${unrelatedAccount.accessToken}`,
      claimsInput,
    );
    expect(crossAccount.status).toBe(404);

    const consume = () => publicPost('/v1/mesh/admission-tickets/consume', hostAuth, { ticket: issued.ticket });
    const results = await Promise.all([consume(), consume()]);
    expect(results.map((result) => result.status).sort()).toEqual([200, 409]);
    const accepted = results.find((result) => result.status === 200);
    const consumed = (await accepted?.json()) as { claims: unknown; proofKey: string };
    expect(consumed.proofKey).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(consumed.claims).toEqual(issued.claims);
  });

  it('burns an admission ticket after source-device revocation, before returning its proof key', async () => {
    const accountId = randomId('acct');
    const source = await enroll(accountId, 'Mesh client');
    const host = await pairEnrollment(source, 'Mesh host');
    const hostMachineId = machineId();
    const endpointGeneration = generation();
    const hostAuth = `Bearer ${host.accessToken}`;
    expectSuccess(await postRpc('device.advertise', hostAdvertisement(host.enrollmentId, hostMachineId, endpointGeneration), hostAuth));

    const issue = await publicPost(`/v1/mesh/hosts/${hostMachineId}/admission-tickets`, `Bearer ${source.accessToken}`, {
      kind: 'enrollment',
      endpointGeneration,
      clientPublicKey: await clientPublicKey(),
      requestedCapabilities: ['machine.session/1'],
      operations: ['read.snapshot'],
      scopes: ['workspace:read'],
      bootstrapChallenge: randomId('challenge'),
      requestId: randomId('ticket-request'),
    });
    expect(issue.status, await issue.clone().text()).toBe(200);
    const { ticket } = (await issue.json()) as { ticket: string };

    expectSuccess(await postRpc('device.revoke', { enrollmentId: source.enrollmentId }, hostAuth));
    const consumed = await publicPost('/v1/mesh/admission-tickets/consume', hostAuth, { ticket });
    expect(consumed.status).toBe(403);
    expect(await consumed.json()).toMatchObject({ error: { code: 'source-no-longer-trusted' } });
    const replay = await publicPost('/v1/mesh/admission-tickets/consume', hostAuth, { ticket });
    expect(replay.status).toBe(409);
  });

  it('keeps provisioning default-off and makes release durable until provider cleanup is available', async () => {
    const accountId = randomId('acct');
    const hostMachineId = machineId();
    const endpointGeneration = generation();
    const allocationInput = {
      accountId,
      machineId: hostMachineId,
      hostEnrollmentId: randomId('enrollment'),
      endpointGeneration,
      requestId: randomId('allocation-request'),
      localOrigin: 'http://127.0.0.1:43127',
    };
    const allocate = await machineRequest('/internal/allocate', allocationInput);
    expect(allocate.status).toBe(503);

    await runInDurableObject(machineStub(), (_instance: MachineEndpointCoordinator, state) => {
      const now = Date.now();
      state.storage.sql.exec(
        `INSERT INTO machine_endpoint_allocations
         (account_id, machine_id, host_enrollment_id, endpoint_generation, allocation_generation, state,
          stable_host_label, stable_tunnel_name, hostname, provider_operation_id, provider_tunnel_id,
          provider_dns_record_id, request_id, created_at, updated_at, last_reachable_at, retry_at,
          attempts, lock_id, lock_until, error_code)
         VALUES (?, ?, ?, ?, 1, 'ready', 'host-0123456789abcdef01234567', 'anvil-host-0123456789abcdef01234567-g1',
           'host-0123456789abcdef01234567.mesh.example.test', ?, ?, ?, ?, ?, ?, ?, ?, 1, NULL, 0, NULL)`,
        accountId,
        hostMachineId,
        allocationInput.hostEnrollmentId,
        endpointGeneration,
        crypto.randomUUID(),
        crypto.randomUUID(),
        crypto.randomUUID(),
        allocationInput.requestId,
        now,
        now,
        now,
        now,
      );
    });
    const released = await machineRequest('/internal/release', {
      accountId,
      machineId: hostMachineId,
      endpointGeneration,
      allocationGeneration: 1,
    });
    expect(released.status).toBe(200);
    expect(await released.json()).toMatchObject({ allocation: { state: 'retiring', allocationGeneration: 1 } });

    const stalePresence = await machineRequest('/internal/presence', {
      accountId,
      machineId: hostMachineId,
      endpointGeneration,
      allocationGeneration: 1,
    });
    expect(stalePresence.status).toBe(409);
    const list = await machineRequest('/internal/list', { accountId });
    const view = (await list.json()) as { allocations: MachineEndpointAllocationView[] };
    expect(view.allocations[0]).toMatchObject({ state: 'retiring' });
    expect(JSON.stringify(view)).not.toContain('connectorToken');
  });

  it('serializes concurrent allocation retries around one durable provider operation', async () => {
    env.ANVIL_MESH_MANAGED_ENDPOINTS = 'true';
    env.CLOUDFLARE_TUNNEL_ACCOUNT_ID = 'test-cloudflare-account';
    env.CLOUDFLARE_TUNNEL_ZONE_ID = 'test-cloudflare-zone';
    env.CLOUDFLARE_TUNNEL_API_TOKEN = 'test-cloudflare-token-value';
    env.MACHINE_ENDPOINT_DOMAIN = 'mesh.example.test';
    const accountId = randomId('acct');
    const hostMachineId = machineId();
    const endpointGeneration = generation();
    const hostEnrollmentId = randomId('enrollment');
    const requestId = randomId('allocation-request');
    const operationId = crypto.randomUUID();
    const now = Date.now();

    await runInDurableObject(machineStub(), (_instance: MachineEndpointCoordinator, state) => {
      state.storage.sql.exec(
        `INSERT INTO machine_endpoint_allocations
         (account_id, machine_id, host_enrollment_id, endpoint_generation, allocation_generation, state,
          stable_host_label, stable_tunnel_name, hostname, local_service, provider_operation_id, provider_tunnel_id,
          provider_dns_record_id, request_id, created_at, updated_at, last_reachable_at, retry_at,
          attempts, lock_id, lock_until, error_code)
         VALUES (?, ?, ?, ?, 1, 'allocating', 'host-0123456789abcdef01234567',
           'anvil-host-0123456789abcdef01234567-g1', 'host-0123456789abcdef01234567.mesh.example.test',
           'http://127.0.0.1:43127', ?, NULL, NULL, ?, ?, ?, ?, ?, 0, ?, ?, NULL)`,
        accountId,
        hostMachineId,
        hostEnrollmentId,
        endpointGeneration,
        operationId,
        requestId,
        now,
        now,
        now,
        now,
        randomId('lock'),
        now + 90_000,
      );
    });

    const body = {
      accountId,
      machineId: hostMachineId,
      hostEnrollmentId,
      endpointGeneration,
      requestId,
      localOrigin: 'http://127.0.0.1:43127',
    };
    const responses = await Promise.all([
      machineRequest('/internal/allocate', body),
      machineRequest('/internal/allocate', body),
    ]);
    expect(responses.map((response) => response.status)).toEqual([202, 202]);
    for (const response of responses) {
      expect(await response.json()).toMatchObject({
        allocation: { machineId: hostMachineId, endpointGeneration, allocationGeneration: 1, state: 'allocating' },
      });
    }
    await runInDurableObject(machineStub(), (_instance: MachineEndpointCoordinator, state) => {
      const rows = state.storage.sql.exec<{ provider_operation_id: string; allocation_generation: number }>(
        `SELECT provider_operation_id, allocation_generation FROM machine_endpoint_allocations
         WHERE account_id = ? AND machine_id = ?`,
        accountId,
        hostMachineId,
      ).toArray();
      expect(rows).toEqual([{ provider_operation_id: operationId, allocation_generation: 1 }]);
    });
  });
});
