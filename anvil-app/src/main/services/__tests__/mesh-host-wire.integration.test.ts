import { createServer, type AddressInfo, type IncomingMessage, type Server } from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  MESH_MACHINE_CAPABILITIES,
  MESH_MACHINE_OPERATIONS,
  MESH_MACHINE_ROUTE_PATHS,
  meshMachineAdmissionBootstrapProofMessage,
  meshMachineAdmissionProofKeyAssociatedData,
  type MeshMachineAdmissionIssueRequest,
  type MeshMachineAdmissionIssueResponse,
  type MeshMachineEnrollmentAdmissionClaims,
  type MeshMachineHost,
} from '../../../../cloud/contract/machine.js';

vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(value, 'utf8'),
    decryptString: (value: Buffer) => value.toString('utf8'),
  },
}));

import { MeshHostSessionServer } from '../mesh-host-session-server.service.js';
import { MeshHostSessionService } from '../mesh-host-session.service.js';
import {
  connectMeshMachineHost,
  createMeshMachineMac,
  newMeshMachineEphemeralIdentity,
} from '../mesh-host-client.service.js';
import { sealToRecipientPub } from '../sync-keyring.service.js';

const accountId = 'account-wire-test';
const clientEnrollmentId = 'enrollment-client-wire-test';
const hostEnrollmentId = 'enrollment-host-wire-test';
const machineId = 'machine-wire-test';
const endpointGeneration = 'generation-wire-test';
const scope = { backendId: 'backend-wire-test', accountId, datasetEpoch: 'epoch-wire-test' };

interface IssuedTicket {
  claims: MeshMachineEnrollmentAdmissionClaims;
  proofKey: Buffer;
}

function issueTicket(request: MeshMachineAdmissionIssueRequest): {
  response: MeshMachineAdmissionIssueResponse;
  stored: IssuedTicket;
} {
  if (request.kind !== 'enrollment') throw new Error('expected enrollment admission');
  const issuedAt = new Date(Date.now() - 1_000).toISOString();
  const proofKey = randomBytes(32);
  const claims: MeshMachineEnrollmentAdmissionClaims = {
    v: 1,
    accountId,
    hostEnrollmentId,
    hostMachineId: machineId,
    endpointGeneration,
    clientPublicKey: request.clientPublicKey,
    bootstrapChallenge: request.bootstrapChallenge,
    issuedAt,
    expiresAt: new Date(Date.now() + 55_000).toISOString(),
    principal: {
      kind: 'enrollment',
      sourceEnrollmentId: clientEnrollmentId,
      requestedCapabilities: [...request.requestedCapabilities],
      operations: [...request.operations],
      scopes: [...request.scopes],
    },
  };
  const ticket = randomBytes(32).toString('base64url');
  return {
    response: {
      v: 1,
      ticket,
      claims,
      sealedProofKey: {
        enc: 'x25519-aes-256-gcm',
        ...sealToRecipientPub(
          claims.clientPublicKey,
          proofKey,
          meshMachineAdmissionProofKeyAssociatedData(claims),
        ),
      },
    },
    stored: { claims, proofKey },
  };
}

function inputUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  return input instanceof URL ? input.href : input.url;
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

async function waitUntil(predicate: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${message}.`);
}

function requestJson(input: RequestInfo | URL, init?: RequestInit): Record<string, unknown> {
  const text = init?.body;
  if (typeof text !== 'string')
    throw new Error(`Expected JSON request body for ${inputUrl(input)}.`);
  return JSON.parse(text) as Record<string, unknown>;
}

function closeServer(server: Server): Promise<void> {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve) => server.close(() => resolve()));
}

describe('Mesh host wire integration', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('round-trips encrypted reads, mutations, events and cursor replay over a real loopback socket', async () => {
    const tickets = new Map<string, IssuedTicket>();
    const ticketResponses: MeshMachineAdmissionIssueResponse[] = [];
    const hostOrigins: Array<string | undefined> = [];
    const hostAuthorizationHeaders: Array<string | undefined> = [];
    let socketClosures = 0;
    const events: Array<{
      enrollmentId: string;
      epoch: string;
      sequence: number;
      workspaceId: string;
      eventKind: string;
      payload: unknown;
    }> = [];
    const dispatches: Array<{ operation: string; payload: unknown }> = [];
    let snapshotValue = 'before';

    const sessions = new MeshHostSessionService({
      identity: () => ({ hostEnrollmentId, machineId, endpointGeneration }),
      activeScope: () => scope,
      consumeAdmissionTicket: async (ticket) => {
        const issued = tickets.get(ticket);
        if (issued === undefined) throw new Error('ticket-already-consumed');
        tickets.delete(ticket);
        return {
          v: 1,
          claims: issued.claims,
          proofKey: issued.proofKey.toString('base64url'),
        };
      },
      authorizeAdmission: async (claims) => ({
        state: 'authorized',
        principal: {
          kind: 'enrollment',
          accountId: claims.accountId,
          sourceEnrollmentId: claims.principal.sourceEnrollmentId,
          tier: 'steer',
        },
      }),
      revalidateAdmission: async () => ({
        authorized: true,
        validUntil: new Date(Date.now() + 60_000).toISOString(),
      }),
      dispatchOperation: async ({ operation, payload }) => {
        dispatches.push({ operation, payload });
        if (operation === 'read.snapshot') return { value: snapshotValue };
        if (operation === 'command.submit') {
          const command = payload as { value?: unknown };
          snapshotValue = String(command.value);
          return { accepted: true, value: snapshotValue };
        }
        throw new Error(`Unexpected operation ${operation}`);
      },
    });
    const adapter = new MeshHostSessionServer({
      sessions,
      enabled: () => true,
      ingress: { kind: 'private' },
      isOriginApproved: () => false,
    });

    const server = createServer((request, response) => {
      hostOrigins.push(request.headers.origin);
      hostAuthorizationHeaders.push(request.headers.authorization);
      void adapter
        .handleRequest(request, response)
        .then((handled) => {
          if (!handled && !response.headersSent) response.writeHead(404).end();
        })
        .catch(() => {
          if (!response.headersSent) response.writeHead(500).end();
        });
    });
    server.on('upgrade', (request: IncomingMessage, socket, head) => {
      hostOrigins.push(request.headers.origin);
      hostAuthorizationHeaders.push(request.headers.authorization);
      socket.once('close', () => {
        socketClosures += 1;
      });
      if (!adapter.handleUpgrade(request, socket, head)) socket.destroy();
    });

    const activeConnections: Array<Awaited<ReturnType<typeof connectMeshMachineHost>>> = [];
    let serverListening = false;
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => resolve());
      });
      serverListening = true;
      const address = server.address() as AddressInfo;
      const hostUrl = `http://127.0.0.1:${address.port}`;
      const host: MeshMachineHost = {
        enrollmentId: hostEnrollmentId,
        machineId,
        endpointGeneration,
        protocolVersion: 1,
        capabilities: [...MESH_MACHINE_CAPABILITIES],
        operations: [...MESH_MACHINE_OPERATIONS],
        online: true,
        lastSeenAt: new Date().toISOString(),
        reachableUntil: new Date(Date.now() + 60_000).toISOString(),
        routes: [
          {
            kind: 'private',
            url: hostUrl,
            machineId,
            endpointGeneration,
            reachableUntil: new Date(Date.now() + 60_000).toISOString(),
          },
        ],
        allocationState: 'ready',
      };
      const fetchFn: typeof fetch = async (input, init) => {
        const url = new URL(inputUrl(input));
        if (url.origin === 'https://broker.example') {
          const headers = new Headers(init?.headers);
          expect(headers.get('authorization')).toBe('Bearer test-broker-token');
          const issue = requestJson(input, init) as unknown as MeshMachineAdmissionIssueRequest;
          const minted = issueTicket(issue);
          tickets.set(minted.response.ticket, minted.stored);
          ticketResponses.push(minted.response);
          return jsonResponse(minted.response);
        }
        return fetch(input, init);
      };
      const context = {
        apiUrl: 'https://broker.example/v1/',
        accessToken: 'test-broker-token',
        accountId,
        enrollmentId: clientEnrollmentId,
        fetchFn,
        onEvent: (event: (typeof events)[number]) => events.push(event),
      };

      const authenticateSocket = vi.spyOn(sessions, 'authenticateSocket');
      const firstConnection = await connectMeshMachineHost(host, context);
      activeConnections.push(firstConnection);
      expect(firstConnection.routeKind).toBe('private');
      expect(authenticateSocket).toHaveBeenCalledOnce();
      expect(authenticateSocket.mock.results[0]?.value).toBe(true);

      const initial = await firstConnection.request<{ value: string }>('read.snapshot', {});
      expect(initial).toEqual({ value: 'before' });
      const mutation = await firstConnection.request<{ accepted: boolean; value: string }>(
        'command.submit',
        { value: 'after' },
      );
      expect(mutation).toEqual({ accepted: true, value: 'after' });
      expect(await firstConnection.request('read.snapshot', {})).toEqual({ value: 'after' });

      const firstEvent = sessions.publishEvent(
        {
          workspaceId: 'workspace-wire-test',
          eventKind: 'test.updated',
          payload: { value: 1 },
        },
        scope,
      );
      expect(firstEvent).not.toBeNull();
      await waitUntil(
        () => events.some((event) => event.sequence === firstEvent?.sequence),
        'first encrypted event',
      );
      expect(events.find((event) => event.sequence === firstEvent?.sequence)).toMatchObject({
        enrollmentId: hostEnrollmentId,
        workspaceId: 'workspace-wire-test',
        eventKind: 'test.updated',
        payload: { value: 1 },
      });

      firstConnection.close();
      await waitUntil(() => socketClosures >= 1, 'first WebSocket close');
      const secondEvent = sessions.publishEvent(
        {
          workspaceId: 'workspace-wire-test',
          eventKind: 'test.replayed',
          payload: { value: 2 },
        },
        scope,
      );
      expect(secondEvent).not.toBeNull();

      const reconnected = await connectMeshMachineHost(host, context);
      activeConnections.push(reconnected);
      expect(authenticateSocket).toHaveBeenCalledTimes(2);
      expect(authenticateSocket.mock.results[1]?.value).toBe(true);
      await waitUntil(
        () => events.some((event) => event.sequence === secondEvent?.sequence),
        'replayed event after reconnect',
      );
      expect(events.filter((event) => event.sequence === secondEvent?.sequence)).toHaveLength(1);
      expect(events.find((event) => event.sequence === secondEvent?.sequence)).toMatchObject({
        eventKind: 'test.replayed',
        payload: { value: 2 },
      });

      const consumedTicket = ticketResponses[0];
      const replayedTicket = await fetch(`${hostUrl}${MESH_MACHINE_ROUTE_PATHS.challenge}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          v: 1,
          mode: 'admission',
          ticket: consumedTicket?.ticket,
          clientPublicKey: consumedTicket?.claims.clientPublicKey,
        }),
      });
      expect(replayedTicket.status).toBe(403);

      const ephemeral = newMeshMachineEphemeralIdentity();
      const malformedProofIssue: MeshMachineAdmissionIssueRequest = {
        kind: 'enrollment',
        endpointGeneration,
        clientPublicKey: ephemeral.clientPublicKey,
        requestedCapabilities: ['machine.session/1', 'machine.stream/1'],
        operations: ['read.snapshot'],
        scopes: [],
        bootstrapChallenge: randomBytes(32).toString('base64url'),
        requestId: randomUUID(),
      };
      const minted = issueTicket(malformedProofIssue);
      tickets.set(minted.response.ticket, minted.stored);
      const challengeResponse = await fetch(`${hostUrl}${MESH_MACHINE_ROUTE_PATHS.challenge}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          v: 1,
          mode: 'admission',
          ticket: minted.response.ticket,
          clientPublicKey: ephemeral.clientPublicKey,
        }),
      });
      expect(challengeResponse.status).toBe(200);
      const challenge = (await challengeResponse.json()) as { challengeId: string; nonce: string };
      const badProofResponse = await fetch(`${hostUrl}${MESH_MACHINE_ROUTE_PATHS.bootstrap}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ v: 1, challengeId: challenge.challengeId, proof: 'invalid-proof' }),
      });
      expect(badProofResponse.status).toBe(401);

      const correctProof = createMeshMachineMac(
        minted.stored.proofKey,
        meshMachineAdmissionBootstrapProofMessage({
          claims: minted.stored.claims,
          challengeId: challenge.challengeId,
          nonce: challenge.nonce,
        }),
      );
      const replayedBootstrapResponse = await fetch(
        `${hostUrl}${MESH_MACHINE_ROUTE_PATHS.bootstrap}`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ v: 1, challengeId: challenge.challengeId, proof: correctProof }),
        },
      );
      expect(replayedBootstrapResponse.status).toBe(401);

      expect(dispatches.map(({ operation }) => operation)).toEqual([
        'read.snapshot',
        'command.submit',
        'read.snapshot',
      ]);
      expect(hostOrigins.every((origin) => origin === undefined)).toBe(true);
      expect(hostAuthorizationHeaders.every((authorization) => authorization === undefined)).toBe(
        true,
      );

      expect(sessions.revoke(() => true)).toHaveLength(2);
      await expect(reconnected.request('read.snapshot', {})).rejects.toThrow();
      expect(sessions.activeSessionCount()).toBe(0);
    } finally {
      for (const connection of activeConnections) connection.close();
      adapter.dispose();
      sessions.shutdown();
      if (serverListening) await closeServer(server);
    }
  });
});
