import { PassThrough } from 'node:stream';
import { randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import type {
  MeshMachineAdmissionConsumeResponse,
  MeshMachineEnrollmentAdmissionClaims,
} from '../../../../cloud/contract/machine';
import { newMeshMachineEphemeralIdentity } from '../mesh-host-client.service.js';
import {
  MeshHostSessionService,
  type MeshHostDashboardContext,
  type MeshHostSessionBindings,
} from '../mesh-host-session.service.js';
import { MeshHostSessionServer } from '../mesh-host-session-server.service.js';

const hostIdentity = {
  hostEnrollmentId: 'host-enrollment',
  machineId: 'host-machine',
  endpointGeneration: 'host-generation',
};
const syncScope = {
  backendId: 'backend-1',
  accountId: 'account-1',
  datasetEpoch: 'dataset-1',
};

class MockResponse {
  statusCode = 200;
  readonly headers = new Map<string, string | number>();
  body = '';

  setHeader(name: string, value: string | number): void {
    this.headers.set(name.toLowerCase(), value);
  }

  end(value?: string): void {
    this.body = value ?? '';
  }
}

function makeRequest(input: {
  method: string;
  url: string;
  host: string;
  origin?: string;
  headers?: Record<string, string>;
}) {
  const request = new PassThrough() as PassThrough & Record<string, unknown>;
  request.method = input.method;
  request.url = input.url;
  request.headers = {
    host: input.host,
    ...(input.origin === undefined ? {} : { origin: input.origin }),
    ...input.headers,
  };
  request.socket = {
    localPort: 43_210,
    localAddress: '127.0.0.1',
    remoteAddress: '127.0.0.1',
  };
  return request as unknown as IncomingMessage;
}

function makeEnrollmentClaims(clientPublicKey: string): MeshMachineEnrollmentAdmissionClaims {
  const issuedAt = new Date().toISOString();
  return {
    v: 1,
    accountId: syncScope.accountId,
    hostEnrollmentId: hostIdentity.hostEnrollmentId,
    hostMachineId: hostIdentity.machineId,
    endpointGeneration: hostIdentity.endpointGeneration,
    clientPublicKey,
    bootstrapChallenge: randomBytes(32).toString('base64url'),
    issuedAt,
    expiresAt: new Date(Date.now() + 55_000).toISOString(),
    principal: {
      kind: 'enrollment',
      sourceEnrollmentId: 'mobile-enrollment',
      requestedCapabilities: ['machine.session/1', 'machine.stream/1'],
      operations: ['read.snapshot'],
      scopes: [],
    },
  };
}

function createService(bindings: Partial<MeshHostSessionBindings> = {}): MeshHostSessionService {
  return new MeshHostSessionService({
    identity: () => hostIdentity,
    activeScope: () => syncScope,
    ...bindings,
  });
}

async function postJson(
  server: MeshHostSessionServer,
  input: Parameters<typeof makeRequest>[0],
  body: unknown,
) {
  const request = makeRequest({
    ...input,
    headers: {
      'content-type': 'application/json',
      'content-length': String(Buffer.byteLength(JSON.stringify(body))),
      ...input.headers,
    },
  });
  const response = new MockResponse();
  const handling = server.handleRequest(request, response as unknown as ServerResponse);
  (request as unknown as PassThrough).end(JSON.stringify(body));
  await handling;
  return response;
}

describe('Mesh host session HTTP adapter', () => {
  it('accepts managed website Origin and native enrollment without Origin on the exact loopback Host', async () => {
    const ephemeral = newMeshMachineEphemeralIdentity();
    const claims = makeEnrollmentClaims(ephemeral.clientPublicKey);
    const consumed: MeshMachineAdmissionConsumeResponse = {
      v: 1,
      claims,
      proofKey: randomBytes(32).toString('base64url'),
    };
    const consumeAdmissionTicket = vi.fn(async (ticket: string) => {
      expect(ticket).toBe('one-use-ticket');
      return consumed;
    });
    const dashboard: MeshHostDashboardContext = {
      accountId: syncScope.accountId,
      sourceBrowserId: 'browser-1',
      grantId: 'grant-1',
      origin: 'https://anvil.dev',
      workspaceIds: ['workspace-1'],
      repositoryIds: ['repo-1'],
      scopes: ['read-dashboard'],
      sessionScope: {
        workspaceIds: ['workspace-1'],
        repositoryIds: ['repo-1'],
        scopes: ['read-dashboard'],
        operations: ['read.snapshot'],
      },
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
    const service = createService({
      consumeAdmissionTicket,
      authorizeAdmission: () => ({
        state: 'authorized',
        principal: {
          kind: 'enrollment',
          accountId: syncScope.accountId,
          sourceEnrollmentId: 'mobile-enrollment',
          tier: 'observe',
        },
      }),
      getDashboardContext: (_scope, grantId) => grantId === dashboard.grantId ? dashboard : null,
    });
    const server = new MeshHostSessionServer({
      sessions: service,
      enabled: () => true,
      ingress: { kind: 'managed', allowedHost: 'mesh.example.net' },
      isOriginApproved: (origin) => origin === dashboard.origin,
    });

    try {
      const browserChallenge = await postJson(server, {
        method: 'POST',
        url: '/api/machine/v1/sessions/challenge',
        host: 'mesh.example.net',
        origin: 'https://anvil.dev',
      }, {
        v: 1,
        mode: 'dashboard',
        grantId: dashboard.grantId,
        clientPublicKey: newMeshMachineEphemeralIdentity().clientPublicKey,
      });
      expect(browserChallenge.statusCode).toBe(200);
      expect(JSON.parse(browserChallenge.body)).toMatchObject({ mode: 'dashboard', machineId: hostIdentity.machineId });
      expect(browserChallenge.headers.get('access-control-allow-origin')).toBe('https://anvil.dev');

      const nativeChallenge = await postJson(server, {
        method: 'POST',
        url: '/api/machine/v1/sessions/challenge',
        host: 'mesh.example.net',
      }, {
        v: 1,
        mode: 'admission',
        ticket: 'one-use-ticket',
        clientPublicKey: ephemeral.clientPublicKey,
      });
      expect(nativeChallenge.statusCode).toBe(200);
      expect(JSON.parse(nativeChallenge.body)).toMatchObject({ mode: 'admission', machineId: hostIdentity.machineId });
      expect(consumeAdmissionTicket).toHaveBeenCalledExactlyOnceWith('one-use-ticket');
    } finally {
      server.dispose();
      service.shutdown();
    }
  });

  it('rejects a managed request unless the tunnel Host is the exact configured hostname', async () => {
    const service = createService();
    const server = new MeshHostSessionServer({
      sessions: service,
      enabled: () => true,
      ingress: { kind: 'managed', allowedHost: 'mesh.example.net' },
      isOriginApproved: () => true,
    });
    try {
      const response = await postJson(server, {
        method: 'POST',
        url: '/api/machine/v1/sessions/challenge',
        host: 'attacker.example',
      }, {});
      expect(response.statusCode).toBe(421);
    } finally {
      server.dispose();
      service.shutdown();
    }
  });
});
