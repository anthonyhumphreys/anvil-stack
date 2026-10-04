import { PROTOCOL } from '../../../contract/version';
import { COMPANION_ADVERTISEMENT_TTL_MS, type DevicePresenceEntry, type DevicePresenceResult } from '../../../contract/companion';
import {
  MESH_MACHINE_CAPABILITIES,
  MESH_MACHINE_OPERATIONS,
  MESH_MACHINE_PROTOCOL_VERSION,
  type MeshMachineAdmissionIssueRequest,
  type MeshMachineHost,
  type MeshMachineHostsResponse,
  type MeshMachineRoute,
} from '../../../contract/machine';

type EnrollmentAdmissionIssue = Extract<MeshMachineAdmissionIssueRequest, { kind: 'enrollment' }>;
import type { VerifiedAuth } from '../auth';
import { isRecord } from '../rpc';
import { machineEndpointStub, type MachineEndpointAllocationView } from './machine-endpoints';
import { normalizeLoopbackService } from './cloudflare-tunnel';

const MAX_REQUEST_BYTES = 16 * 1024;
const MACHINE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const GENERATION = /^[A-Za-z0-9_-]{16,128}$/;

type MachineMetadata = NonNullable<DevicePresenceEntry['machine']>;

/** Public account-scoped Mesh machine lifecycle routes. */
export async function handleMachineApiRequest(
  request: Request,
  env: Env,
  auth: VerifiedAuth,
): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === '/v1/mesh/hosts' && request.method === 'GET') {
    if (
      auth.enrollmentClass === 'ephemeral' ||
      !(await isTrustedEnrollment(env, auth.accountId, auth.enrollmentId))
    ) return apiError(403, 'untrusted-enrollment');
    return listMachineHosts(env, auth.accountId, auth.enrollmentId);
  }
  if (url.pathname === '/v1/mesh/admission-tickets/consume' && request.method === 'POST') {
    const body = await readJson(request);
    if (!isRecord(body) || typeof body['ticket'] !== 'string') return apiError(400, 'malformed-request');
    const presence = await readPresence(env, auth);
    if (presence === null) return apiError(503, 'unavailable');
    const host = presence.devices.find(
      (device) => device.self && device.enrollmentId === auth.enrollmentId && isMachine(device.machine),
    );
    if (host?.machine === undefined) return apiError(403, 'host-not-advertised');
    if (!(await isTrustedEnrollment(env, auth.accountId, auth.enrollmentId))) {
      return apiError(403, 'untrusted-enrollment');
    }
    const consumed = await callMachineEndpoints(env, '/internal/admission-consume', {
      accountId: auth.accountId,
      hostEnrollmentId: auth.enrollmentId,
      hostMachineId: host.machine.machineId,
      endpointGeneration: host.machine.endpointGeneration,
      ticket: body['ticket'],
    });
    if (!consumed.ok) return consumed;
    const payload = (await consumed.json().catch(() => null)) as {
      claims?: { principal?: { kind?: unknown; sourceEnrollmentId?: unknown } };
    } | null;
    if (!isRecord(payload) || !isRecord(payload['claims']) || !isRecord(payload['claims']['principal'])) {
      return apiError(503, 'unavailable');
    }
    if (
      payload['claims']['principal']['kind'] === 'enrollment' &&
      typeof payload['claims']['principal']['sourceEnrollmentId'] === 'string' &&
      !(await isTrustedEnrollment(env, auth.accountId, payload['claims']['principal']['sourceEnrollmentId']))
    ) return apiError(403, 'source-no-longer-trusted');
    return Response.json(payload, { headers: { 'cache-control': 'no-store', pragma: 'no-cache' } });
  }

  const route = /^\/v1\/mesh\/hosts\/([A-Za-z0-9_-]{1,128})\/(endpoint|connector-token|presence|admission-tickets|sessions\/revalidate)$/.exec(url.pathname);
  if (route === null) return apiError(404, 'not-found');
  const machineId = route[1] as string;
  const action = route[2] as string;
  if (request.method !== 'POST') return apiError(405, 'method-not-allowed');
  const body = await readJson(request);
  if (!isRecord(body)) return apiError(400, 'malformed-request');
  const presence = await readPresence(env, auth);
  if (presence === null) return apiError(503, 'unavailable');
  if (action === 'admission-tickets') {
    if (auth.enrollmentClass === 'ephemeral') return apiError(403, 'untrusted-enrollment');
    const targetHosts = presence.devices.filter(
      (device) => device.machine?.machineId === machineId && isMachine(device.machine),
    );
    if (targetHosts.length > 1) return apiError(409, 'machine-identity-conflict');
    const targetHost = targetHosts[0];
    if (targetHost?.machine === undefined) return apiError(404, 'host-not-found');
    if (!(await isTrustedEnrollment(env, auth.accountId, auth.enrollmentId))) {
      return apiError(403, 'untrusted-enrollment');
    }
    if (!(await isTrustedEnrollment(env, auth.accountId, targetHost.enrollmentId))) {
      return apiError(403, 'host-not-trusted');
    }
    const issue = parseAdmissionIssue(body);
    if (issue === null || issue.endpointGeneration !== targetHost.machine.endpointGeneration) {
      return apiError(issue === null ? 400 : 409, issue === null ? 'malformed-request' : 'stale-generation');
    }
    if (
      !isSubset(issue.requestedCapabilities, targetHost.machine.capabilities) ||
      !isSubset(issue.operations, targetHost.machine.operations)
    ) return apiError(403, 'capability-not-offered');
    return callMachineEndpoints(env, '/internal/admission-issue', {
      accountId: auth.accountId,
      hostEnrollmentId: targetHost.enrollmentId,
      hostMachineId: machineId,
      endpointGeneration: issue.endpointGeneration,
      clientPublicKey: issue.clientPublicKey,
      bootstrapChallenge: issue.bootstrapChallenge,
      requestId: issue.requestId,
      principal: {
        kind: 'enrollment',
        sourceEnrollmentId: auth.enrollmentId,
        requestedCapabilities: issue.requestedCapabilities,
        operations: issue.operations,
        scopes: issue.scopes,
      },
    });
  }
  const matchingHosts = presence.devices.filter(
    (device) =>
      device.enrollmentId === auth.enrollmentId &&
      device.self &&
      isMachine(device.machine) &&
      device.machine.machineId === machineId,
  );
  const host = matchingHosts[0];
  if (host?.machine === undefined) return apiError(403, 'host-not-advertised');
  if (!(await isTrustedEnrollment(env, auth.accountId, auth.enrollmentId))) {
    return apiError(403, 'untrusted-enrollment');
  }

  if (action === 'endpoint') {
    if (
      body['action'] !== 'allocate' && body['action'] !== 'release'
    ) return apiError(400, 'malformed-request');
    if (
      typeof body['endpointGeneration'] !== 'string' ||
      body['endpointGeneration'] !== host.machine.endpointGeneration
    ) return apiError(409, 'stale-generation');
    if (body['action'] === 'allocate') {
      if (typeof body['requestId'] !== 'string' || typeof body['localOrigin'] !== 'string') {
        return apiError(400, 'malformed-request');
      }
      let localOrigin: string;
      try {
        localOrigin = normalizeLoopbackService(body['localOrigin']);
      } catch {
        return apiError(400, 'malformed-request');
      }
      return callMachineEndpoints(env, '/internal/allocate', {
        accountId: auth.accountId,
        machineId,
        hostEnrollmentId: auth.enrollmentId,
        endpointGeneration: host.machine.endpointGeneration,
        requestId: body['requestId'],
        localOrigin,
      });
    }
    return callMachineEndpoints(env, '/internal/release', {
      accountId: auth.accountId,
      machineId,
      endpointGeneration: host.machine.endpointGeneration,
      ...(Number.isSafeInteger(body['allocationGeneration'])
        ? { allocationGeneration: body['allocationGeneration'] as number }
        : {}),
    });
  }

  if (action === 'connector-token' || action === 'presence') {
    if (
      typeof body['endpointGeneration'] !== 'string' ||
      body['endpointGeneration'] !== host.machine.endpointGeneration
    ) return apiError(409, 'stale-generation');
    if (action === 'connector-token') {
      if (!Number.isSafeInteger(body['allocationGeneration'])) return apiError(400, 'malformed-request');
      return callMachineEndpoints(env, '/internal/connector-token', {
        accountId: auth.accountId,
        machineId,
        endpointGeneration: host.machine.endpointGeneration,
        allocationGeneration: body['allocationGeneration'] as number,
      });
    }
    if (!Number.isSafeInteger(body['allocationGeneration'])) return apiError(400, 'malformed-request');
    return callMachineEndpoints(env, '/internal/presence', {
      accountId: auth.accountId,
      machineId,
      endpointGeneration: host.machine.endpointGeneration,
      allocationGeneration: body['allocationGeneration'] as number,
    });
  }

  if (action === 'sessions/revalidate') {
    if (
      typeof body['sourceEnrollmentId'] !== 'string' ||
      body['sourceEnrollmentId'].length === 0 ||
      body['sourceEnrollmentId'].length > 128 ||
      typeof body['endpointGeneration'] !== 'string' ||
      body['endpointGeneration'] !== host.machine.endpointGeneration
    ) return apiError(400, 'malformed-request');
    const active = await isTrustedEnrollment(env, auth.accountId, body['sourceEnrollmentId']);
    return Response.json(
      {
        v: 1,
        authorized: active,
        validUntil: new Date(Date.now() + (active ? 60_000 : 0)).toISOString(),
      },
      { headers: { 'cache-control': 'no-store' } },
    );
  }

  return apiError(404, 'not-found');
}

/** Shared by device-authenticated discovery and the signed website channel. */
export async function listMachineHostsForAccount(
  env: Env,
  accountId: string,
  enrollmentId: string,
): Promise<MeshMachineHostsResponse | null> {
  const presence = await readPresence(env, { accountId, enrollmentId, enrollmentClass: 'device' });
  if (presence === null) return null;
  const allocationResponse = await machineEndpointStub(env).fetch('https://internal.anvil/internal/list', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ accountId }),
  });
  const allocationPayload = (await allocationResponse.json().catch(() => null)) as {
    allocations?: unknown;
  } | null;
  if (!allocationResponse.ok || !Array.isArray(allocationPayload?.allocations)) return null;
  const allocations = allocationPayload.allocations.filter(isAllocationView);
  const allocationsByMachine = new Map(allocations.map((allocation) => [allocation.machineId, allocation]));
  const now = Date.now();
  const hosts: MeshMachineHost[] = [];
  const machineIdCounts = new Map<string, number>();
  for (const device of presence.devices) {
    if (isMachine(device.machine)) {
      machineIdCounts.set(device.machine.machineId, (machineIdCounts.get(device.machine.machineId) ?? 0) + 1);
    }
  }
  for (const device of presence.devices) {
    if (!(await isTrustedEnrollment(env, accountId, device.enrollmentId))) continue;
    const machine = device.machine;
    if (!isMachine(machine)) continue;
    if (machineIdCounts.get(machine.machineId) !== 1) continue;
    const adExpiry = Date.parse(device.lastSeenAt) + COMPANION_ADVERTISEMENT_TTL_MS;
    const allocation = allocationsByMachine.get(machine.machineId);
    const allocationGeneration = allocation?.allocationGeneration ?? 0;
    const routes: MeshMachineRoute[] = [];
    if (Array.isArray(device.endpoints)) {
      for (const endpoint of device.endpoints) {
        const endpointUrl = endpointUrlFor(endpoint.host, endpoint.port);
        if (endpointUrl === null) continue;
        routes.push({
          kind: 'private',
          url: endpointUrl,
          machineId: machine.machineId,
          endpointGeneration: machine.endpointGeneration,
          reachableUntil: new Date(adExpiry).toISOString(),
        });
      }
    }
    const allocationMatches =
      allocation !== undefined && allocation.endpointGeneration === machine.endpointGeneration;
    const managedEnabled = env.ANVIL_MESH_MANAGED_ENDPOINTS === 'true';
    if (
      managedEnabled &&
      allocationMatches &&
      allocation?.state === 'ready' &&
      allocation.url !== undefined
    ) {
      const reachableAt = allocation.lastReachableAt ?? Date.parse(device.lastSeenAt);
      const reachableUntil = new Date(reachableAt + 7 * 24 * 60 * 60 * 1000).toISOString();
      if (Date.parse(reachableUntil) > now) {
        routes.push({
          kind: 'managed',
          url: allocation.url,
          machineId: machine.machineId,
          endpointGeneration: machine.endpointGeneration,
          reachableUntil,
          allocationGeneration: String(allocationGeneration),
        });
      }
    }
    hosts.push({
      enrollmentId: device.enrollmentId,
      machineId: machine.machineId,
      endpointGeneration: machine.endpointGeneration,
      protocolVersion: MESH_MACHINE_PROTOCOL_VERSION,
      capabilities: [...machine.capabilities],
      operations: [...machine.operations],
      online: device.online,
      lastSeenAt: device.lastSeenAt,
      reachableUntil: new Date(adExpiry).toISOString(),
      routes,
      allocationState: managedEnabled ? (allocationMatches ? allocation?.state ?? 'unallocated' : 'unallocated') : 'disabled',
    });
  }
  return { v: MESH_MACHINE_PROTOCOL_VERSION, hosts };
}

async function listMachineHosts(env: Env, accountId: string, enrollmentId: string): Promise<Response> {
  const result = await listMachineHostsForAccount(env, accountId, enrollmentId);
  return result === null ? apiError(503, 'unavailable') : Response.json(result, {
    headers: { 'cache-control': 'no-store' },
  });
}

/** Website path uses a signed identity route and selects only an active/trusted account enrollment. */
export async function listHostedMachineHosts(
  env: Env,
  accountId: string,
): Promise<MeshMachineHostsResponse | null> {
  const response = await env.SESSIONS.get(env.SESSIONS.idFromName('sessions')).fetch(
    'https://internal.anvil/internal/device-list-for-account',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ accountId }),
    },
  );
  const payload = (await response.json().catch(() => null)) as {
    devices?: Array<{ enrollmentId?: unknown; revoked?: unknown; trustState?: unknown; enrollmentClass?: unknown }>;
  } | null;
  if (!response.ok || !Array.isArray(payload?.devices)) return null;
  const trusted = payload.devices.find(
    (device) =>
      typeof device.enrollmentId === 'string' &&
      device.revoked === false &&
      device.trustState === 'trusted' &&
      (device.enrollmentClass === undefined || device.enrollmentClass === 'device'),
  );
  if (typeof trusted?.enrollmentId !== 'string') return { v: MESH_MACHINE_PROTOCOL_VERSION, hosts: [] };
  return listMachineHostsForAccount(env, accountId, trusted.enrollmentId);
}

/** Browser ticket issuer used only after the hosted HMAC route resolves WorkOS → linked active account. */
export async function issueHostedMachineAdmission(
  env: Env,
  accountId: string,
  input: {
    machineId: string;
    endpointGeneration: string;
    clientPublicKey: string;
    bootstrapChallenge: string;
    grantId: string;
    origin: string;
    requestId: string;
  },
): Promise<Response> {
  const hosts = await listHostedMachineHosts(env, accountId);
  const target = hosts?.hosts.find(
    (host) => host.machineId === input.machineId && host.endpointGeneration === input.endpointGeneration,
  );
  if (target === undefined) return apiError(404, 'host-not-found');
  if (!(await isTrustedEnrollment(env, accountId, target.enrollmentId))) return apiError(403, 'untrusted-enrollment');
  const issue = parseDashboardAdmission(input);
  if (issue === null) return apiError(400, 'malformed-request');
  return callMachineEndpoints(env, '/internal/admission-issue', {
    accountId,
    hostEnrollmentId: target.enrollmentId,
    hostMachineId: input.machineId,
    endpointGeneration: input.endpointGeneration,
    clientPublicKey: input.clientPublicKey,
    bootstrapChallenge: input.bootstrapChallenge,
    requestId: input.requestId,
    principal: { kind: 'dashboard', grantId: input.grantId, origin: input.origin },
  });
}

async function readPresence(env: Env, auth: VerifiedAuth): Promise<DevicePresenceResult | null> {
  try {
    const response = await env.ACCOUNT.get(env.ACCOUNT.idFromName(auth.accountId)).fetch(
      'https://internal.anvil/v1/rpc',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-anvil-account': auth.accountId,
          'x-anvil-enrollment': auth.enrollmentId,
          'x-anvil-enrollment-class': auth.enrollmentClass ?? 'device',
          ...(auth.environmentId === undefined ? {} : { 'x-anvil-environment-id': auth.environmentId }),
        },
        body: JSON.stringify({
          protocol: PROTOCOL,
          requestId: crypto.randomUUID(),
          operation: 'device.presence',
          params: {},
        }),
      },
    );
    const payload = (await response.json().catch(() => null)) as { result?: { devices?: unknown } } | null;
    if (!response.ok || !Array.isArray(payload?.result?.devices)) return null;
    return { devices: payload.result.devices as DevicePresenceEntry[] };
  } catch {
    return null;
  }
}

async function isTrustedEnrollment(env: Env, accountId: string, enrollmentId: string): Promise<boolean> {
  try {
    const response = await env.SESSIONS.get(env.SESSIONS.idFromName('sessions')).fetch(
      'https://internal.anvil/internal/device-active-for-account',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ accountId, enrollmentId }),
      },
    );
    const payload = (await response.json().catch(() => null)) as { active?: unknown } | null;
    return response.ok && payload?.active === true;
  } catch {
    return false;
  }
}

async function callMachineEndpoints(env: Env, path: string, body: unknown): Promise<Response> {
  try {
    const response = await machineEndpointStub(env).fetch(`https://internal.anvil${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const text = await response.text();
    return new Response(text, {
      status: response.status,
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    });
  } catch {
    return apiError(503, 'unavailable');
  }
}

async function readJson(request: Request): Promise<unknown> {
  const declared = Number(request.headers.get('content-length') ?? '0');
  if (Number.isFinite(declared) && declared > MAX_REQUEST_BYTES) return null;
  const bytes = await request.arrayBuffer().catch(() => null);
  if (bytes === null || bytes.byteLength > MAX_REQUEST_BYTES) return null;
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    return null;
  }
}

function parseAdmissionIssue(value: Record<string, unknown>): EnrollmentAdmissionIssue | null {
  if (
    value['kind'] !== 'enrollment' ||
    typeof value['endpointGeneration'] !== 'string' ||
    typeof value['clientPublicKey'] !== 'string' ||
    !Array.isArray(value['requestedCapabilities']) ||
    !Array.isArray(value['operations']) ||
    !Array.isArray(value['scopes']) ||
    typeof value['bootstrapChallenge'] !== 'string' ||
    typeof value['requestId'] !== 'string' ||
    !GENERATION.test(value['endpointGeneration']) ||
    !MACHINE_ID.test(value['requestId']) ||
    !/^[A-Za-z0-9+/]{43}=$/.test(value['clientPublicKey']) ||
    !/^[A-Za-z0-9_-]{32,128}$/.test(value['bootstrapChallenge'])
  ) return null;
  const request = value as unknown as EnrollmentAdmissionIssue;
  if (
    !validStringSet(request.requestedCapabilities, new Set<string>(MESH_MACHINE_CAPABILITIES), 16) ||
    !validStringSet(request.operations, new Set<string>(MESH_MACHINE_OPERATIONS), 64) ||
    !validStringSet(request.scopes, null, 64)
  ) return null;
  return request;
}

function parseDashboardAdmission(input: {
  machineId: string;
  endpointGeneration: string;
  clientPublicKey: string;
  bootstrapChallenge: string;
  grantId: string;
  origin: string;
  requestId: string;
}): boolean | null {
  if (
    !MACHINE_ID.test(input.machineId) ||
    !GENERATION.test(input.endpointGeneration) ||
    !/^[A-Za-z0-9+/]{43}=$/.test(input.clientPublicKey) ||
    !/^[A-Za-z0-9_-]{32,128}$/.test(input.bootstrapChallenge) ||
    !MACHINE_ID.test(input.grantId) ||
    !MACHINE_ID.test(input.requestId)
  ) return null;
  try {
    const origin = new URL(input.origin);
    if (origin.protocol !== 'https:' || origin.origin !== input.origin || origin.username || origin.password) return null;
  } catch {
    return null;
  }
  return true;
}

function validStringSet(value: string[], allowed: Set<string> | null, max: number): boolean {
  return value.length <= max && value.every((item, index) =>
    typeof item === 'string' && item.length > 0 && item.length <= 128 &&
    value.indexOf(item) === index &&
    (allowed === null ? /^[A-Za-z0-9][A-Za-z0-9:_./-]{0,127}$/.test(item) : allowed.has(item)),
  );
}

function isSubset(requested: string[], offered: readonly string[]): boolean {
  const offeredSet = new Set(offered);
  return requested.every((item) => offeredSet.has(item));
}

function isMachine(value: unknown): value is MachineMetadata {
  if (!isRecord(value)) return false;
  return (
    typeof value['machineId'] === 'string' && MACHINE_ID.test(value['machineId']) &&
    typeof value['endpointGeneration'] === 'string' && GENERATION.test(value['endpointGeneration']) &&
    value['protocolVersion'] === MESH_MACHINE_PROTOCOL_VERSION &&
    Array.isArray(value['capabilities']) && value['capabilities'].every((item) => MESH_MACHINE_CAPABILITIES.includes(item as never)) &&
    Array.isArray(value['operations']) && value['operations'].every((item) => MESH_MACHINE_OPERATIONS.includes(item as never))
  );
}

function isAllocationView(value: unknown): value is MachineEndpointAllocationView {
  return (
    isRecord(value) &&
    typeof value['machineId'] === 'string' &&
    typeof value['endpointGeneration'] === 'string' &&
    Number.isSafeInteger(value['allocationGeneration']) &&
    typeof value['state'] === 'string' &&
    ['unallocated', 'allocating', 'ready', 'retiring', 'failed'].includes(value['state']) &&
    (value['url'] === undefined || typeof value['url'] === 'string') &&
    (value['lastReachableAt'] === undefined || typeof value['lastReachableAt'] === 'number')
  );
}

function endpointUrlFor(host: string, port: number): string | null {
  if (host.length > 253 || host.includes('://') || host.includes('/') || !Number.isInteger(port) || port < 1 || port > 65535) return null;
  try {
    const url = new URL(`http://${host}:${port}`);
    if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) return null;
    return url.origin;
  } catch {
    return null;
  }
}

function apiError(status: number, code: string): Response {
  return Response.json({ error: { code } }, { status, headers: { 'cache-control': 'no-store' } });
}
