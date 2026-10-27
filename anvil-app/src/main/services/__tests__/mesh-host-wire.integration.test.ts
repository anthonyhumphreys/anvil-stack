import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createRequire } from 'node:module';
import { hkdfSync, randomBytes, randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  MESH_MACHINE_CAPABILITIES,
  MESH_MACHINE_OPERATIONS,
  MESH_MACHINE_ROUTE_PATHS,
  MESH_MACHINE_SOCKET_SUBPROTOCOL,
  meshMachineAdmissionBootstrapProofMessage,
  meshMachineAdmissionProofKeyAssociatedData,
  meshMachineSessionTokenAssociatedData,
  meshMachineSocketProofMessage,
  meshMachineTrafficKeyDerivation,
  type MeshMachineAdmissionIssueRequest,
  type MeshMachineAdmissionIssueResponse,
  type MeshMachineEnrollmentAdmissionClaims,
  type MeshMachineHost,
  type MeshMachineClientPayload,
  type MeshMachineServerPayload,
} from '../../../../cloud/contract/machine.js';

vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(value, 'utf8'),
    decryptString: (value: Buffer) => value.toString('utf8'),
  },
}));

import { MeshHostSessionServer } from '../mesh-host-session-server.service.js';
import {
  MeshHostSessionService,
  MESH_HOST_UNATTACHED_SESSION_TTL_MS,
  type MeshHostSessionBindings,
} from '../mesh-host-session.service.js';
import {
  connectMeshMachineHost,
  createMeshMachineMac,
  newMeshMachineEphemeralIdentity,
  openMeshMachineFrame,
  openMeshSealedBytes,
  sealMeshMachineFrame,
} from '../mesh-host-client.service.js';
import { sealToRecipientPub } from '../sync-keyring.service.js';

const accountId = 'account-wire-test';
const clientEnrollmentId = 'enrollment-client-wire-test';
const hostEnrollmentId = 'enrollment-host-wire-test';
const machineId = 'machine-wire-test';
const endpointGeneration = 'generation-wire-test';
const scope = { backendId: 'backend-wire-test', accountId, datasetEpoch: 'epoch-wire-test' };

interface TestWebSocket {
  readyState: number;
  on(event: string, listener: (...args: unknown[]) => void): void;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  terminate(): void;
}

const NodeWebSocket = createRequire(import.meta.url)('ws') as new (
  url: string,
  protocols: string[],
  options?: { headers: Record<string, string> },
) => TestWebSocket;

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

async function createStreamHarness(dispatchOperation?: MeshHostSessionBindings['dispatchOperation']) {
  const tickets = new Map<string, IssuedTicket>();
  const sessions = new MeshHostSessionService({
    identity: () => ({ hostEnrollmentId, machineId, endpointGeneration }),
    activeScope: () => scope,
    consumeAdmissionTicket: async (ticket) => {
      const issued = tickets.get(ticket);
      if (issued === undefined) throw new Error('ticket-already-consumed');
      tickets.delete(ticket);
      return { v: 1, claims: issued.claims, proofKey: issued.proofKey.toString('base64url') };
    },
    authorizeAdmission: async (claims) => ({
      state: 'authorized',
      principal: {
        kind: 'enrollment', accountId, sourceEnrollmentId: claims.principal.sourceEnrollmentId,
        tier: 'steer',
      },
    }),
    revalidateAdmission: async () => ({ authorized: true, validUntil: new Date(Date.now() + 60_000).toISOString() }),
    dispatchOperation: dispatchOperation ?? (async () => ({ ok: true })),
  });
  const listeners: Array<{ server: Server; adapter: MeshHostSessionServer; port: number; managed: boolean }> = [];
  const sockets: TestWebSocket[] = [];
  try {
    for (const managed of [false, true]) {
      const adapter = new MeshHostSessionServer({
        sessions,
        enabled: () => true,
        ingress: managed ? { kind: 'managed', allowedHost: 'mesh.example.test' } : { kind: 'private' },
        isOriginApproved: () => false,
      });
      const server = createServer((request, response) => {
        void adapter.handleRequest(request, response).then((handled) => {
          if (!handled && !response.headersSent) response.writeHead(404).end();
        });
      });
      server.on('upgrade', (request, socket, head) => {
        if (!adapter.handleUpgrade(request, socket, head)) socket.destroy();
      });
      listeners.push({ server, adapter, port: 0, managed });
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
      });
      listeners[listeners.length - 1]!.port = (server.address() as AddressInfo).port;
    }
  } catch (error) {
    for (const listener of listeners) listener.adapter.dispose();
    sessions.shutdown();
    await Promise.all(listeners.map(({ server }) => closeServer(server)));
    throw error;
  }

  async function bootstrap() {
    const ephemeral = newMeshMachineEphemeralIdentity();
    const issued = issueTicket({
      kind: 'enrollment', endpointGeneration, clientPublicKey: ephemeral.clientPublicKey,
      requestedCapabilities: [...MESH_MACHINE_CAPABILITIES], operations: [...MESH_MACHINE_OPERATIONS],
      scopes: [], bootstrapChallenge: randomBytes(32).toString('base64url'), requestId: randomUUID(),
    });
    tickets.set(issued.response.ticket, issued.stored);
    const challenge = await sessions.createChallenge({
      v: 1, mode: 'admission', ticket: issued.response.ticket, clientPublicKey: ephemeral.clientPublicKey,
    });
    const response = await sessions.bootstrap({
      v: 1, challengeId: challenge.challengeId,
      proof: createMeshMachineMac(issued.stored.proofKey, meshMachineAdmissionBootstrapProofMessage({
        claims: issued.stored.claims, challengeId: challenge.challengeId, nonce: challenge.nonce,
      })),
    });
    const token = openMeshSealedBytes(ephemeral.privateKey, ephemeral.clientPublicRaw, response.sessionToken,
      meshMachineSessionTokenAssociatedData(response.sessionClaims));
    return { response, token };
  }

  async function connect(session: Awaited<ReturnType<typeof bootstrap>>, managed = false) {
    const listener = listeners.find((item) => item.managed === managed)!;
    const socket = new NodeWebSocket(`ws://127.0.0.1:${listener.port}${MESH_MACHINE_ROUTE_PATHS.socket}`,
      [MESH_MACHINE_SOCKET_SUBPROTOCOL], managed ? { headers: { host: 'mesh.example.test' } } : undefined);
    sockets.push(socket);
    const payloads: MeshMachineServerPayload[] = [];
    const frameSequences: number[] = [];
    let error: unknown;
    let closeResult: { code: number; reason: string } | null = null;
    let nextClientSequence = 1;
    const keyFor = (direction: 'client-to-host' | 'host-to-client'): Buffer => {
      const derivation = meshMachineTrafficKeyDerivation({
        sessionId: session.response.sessionId, machineId, endpointGeneration, direction,
      });
      return Buffer.from(hkdfSync('sha256', session.token, derivation.salt, derivation.info, 32));
    };
    const clientKey = keyFor('client-to-host');
    const serverKey = keyFor('host-to-client');
    socket.on('error', (cause) => { error = cause; });
    socket.on('close', (code, reason) => {
      closeResult = { code: Number(code), reason: Buffer.isBuffer(reason) ? reason.toString('utf8') : String(reason ?? '') };
      clientKey.fill(0);
      serverKey.fill(0);
    });
    socket.on('message', (raw) => {
      try {
        const frame = JSON.parse(Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw)) as {
          type: string; nonce: string; sequence: number; requestId?: string;
          envelope: { enc: 'aes-256-gcm'; nonce: string; ct: string };
        };
        if (frame.type === 'auth-challenge') {
          socket.send(JSON.stringify({
            type: 'auth', sessionId: session.response.sessionId,
            proof: createMeshMachineMac(session.token, meshMachineSocketProofMessage({
              sessionId: session.response.sessionId, nonce: frame.nonce, machineId, endpointGeneration,
            })),
          }));
          return;
        }
        const payload = openMeshMachineFrame({
          key: serverKey, sessionId: session.response.sessionId, machineId, endpointGeneration,
          epoch: session.response.stream.epoch, direction: 'host-to-client',
          requestId: frame.requestId, sequence: frame.sequence, envelope: frame.envelope,
        }) as MeshMachineServerPayload;
        frameSequences.push(frame.sequence);
        payloads.push(payload);
        if (payload.kind === 'ready') nextClientSequence = payload.nextClientSequence;
      } catch (cause) {
        error = cause;
        socket.terminate();
      }
    });
    await waitUntil(() => {
      if (error !== undefined) throw error;
      return payloads.some((payload) => payload.kind === 'ready');
    }, 'authenticated raw socket');

    const waitFor = async (predicate: (payload: MeshMachineServerPayload) => boolean) => {
      await waitUntil(() => {
        if (error !== undefined) throw error;
        return payloads.some(predicate);
      }, 'encrypted response');
      return payloads.find(predicate)!;
    };
    return {
      socket, payloads, frameSequences,
      ready: payloads.find((payload): payload is Extract<MeshMachineServerPayload, { kind: 'ready' }> => payload.kind === 'ready')!,
      send(payload: MeshMachineClientPayload) {
        const sequence = nextClientSequence++;
        const envelope = sealMeshMachineFrame({
          key: clientKey, sessionId: session.response.sessionId, machineId, endpointGeneration,
          epoch: session.response.stream.epoch, direction: 'client-to-host',
          requestId: payload.requestId, sequence, payload,
        });
        socket.send(JSON.stringify({ type: 'data', sessionId: session.response.sessionId,
          requestId: payload.requestId, sequence, envelope }));
      },
      waitFor,
      async closed() {
        await waitUntil(() => closeResult !== null, 'socket retirement');
        return closeResult!;
      },
      async close() {
        socket.close();
        await waitUntil(() => closeResult !== null, 'socket close');
      },
    };
  }

  return {
    sessions, bootstrap, connect,
    async dispose() {
      for (const socket of sockets) socket.terminate();
      for (const listener of listeners) listener.adapter.dispose();
      sessions.shutdown();
      await Promise.all(listeners.map(({ server }) => closeServer(server)));
    },
  };
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
      // Remote selection excludes loopback; map this advertised test LAN route to the fixture.
      const advertisedOrigin = `http://192.168.50.20:${address.port}`;
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
            url: advertisedOrigin,
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
        if (url.origin === advertisedOrigin) return fetch(inputUrl(input).replace(advertisedOrigin, hostUrl), init);
        return fetch(input, init);
      };
      const context = {
        apiUrl: 'https://broker.example/v1/',
        accessToken: 'test-broker-token',
        accountId,
        enrollmentId: clientEnrollmentId,
        fetchFn,
        socketFactory: (url: string, protocols: string[]) =>
          new NodeWebSocket(url.replace('192.168.50.20', '127.0.0.1'), protocols),
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

      const reconnected = await connectMeshMachineHost(host, {
        ...context,
        resumeCursor: { epoch: firstEvent!.epoch, sequence: firstEvent!.sequence },
        requireReplayComplete: true,
      });
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

      expect(sessions.revoke(() => true)).toHaveLength(1);
      await expect(reconnected.request('read.snapshot', {})).rejects.toThrow();
      expect(sessions.activeSessionCount()).toBe(0);
    } finally {
      for (const connection of activeConnections) connection.close();
      adapter.dispose();
      sessions.shutdown();
      if (serverListening) await closeServer(server);
    }
  });

  it('sends replay, the completion barrier, then live events without broadcasting before subscribe', async () => {
    const harness = await createStreamHarness();
    try {
      const session = await harness.bootstrap();
      const client = await harness.connect(session);
      harness.sessions.publishEvent({ workspaceId: 'workspace-1', eventKind: 'replay', payload: 1 });
      harness.sessions.publishEvent({ workspaceId: 'workspace-2', eventKind: 'filtered', payload: 2 });
      client.send({ kind: 'ping', requestId: 'before-subscribe-ping' });
      await client.waitFor((payload) => payload.kind === 'response' && payload.requestId === 'before-subscribe-ping');
      expect(client.payloads.some((payload) => payload.kind === 'event')).toBe(false);

      const subscribe = harness.sessions.processSubscription.bind(harness.sessions);
      vi.spyOn(harness.sessions, 'processSubscription').mockImplementationOnce((sessionId, payload) => {
        const replay = subscribe(sessionId, payload);
        // This is the precise replay-capture/output boundary where live delivery used to overtake replay.
        harness.sessions.publishEvent({ workspaceId: 'workspace-1', eventKind: 'live', payload: 3 });
        return replay;
      });
      client.send({ kind: 'subscribe', requestId: 'ordered-subscribe-0001',
        cursor: { epoch: session.response.stream.epoch, sequence: 0 }, workspaceIds: ['workspace-1'] });
      await client.waitFor((payload) => payload.kind === 'event' && payload.sequence === 3);
      expect(client.payloads.filter((payload) => payload.kind === 'event' ||
        (payload.kind === 'response' && payload.requestId === 'ordered-subscribe-0001'))).toMatchObject([
        { kind: 'event', sequence: 1, eventKind: 'replay' },
        { kind: 'response', result: { cursor: { sequence: 2 }, replayComplete: true } },
        { kind: 'event', sequence: 3, eventKind: 'live' },
      ]);
      expect(client.frameSequences).toEqual(client.frameSequences.map((_, index) => index + 1));
      await client.close();
      expect(harness.sessions.activeSessionCount()).toBe(0);
    } finally {
      await harness.dispose();
    }
  });

  it('keeps stream preparation and control responses live while an old-session mutation drains', async () => {
    let completeCommand!: (result: unknown) => void;
    const dispatch = vi.fn(async () => new Promise<unknown>((resolve) => { completeCommand = resolve; }));
    const harness = await createStreamHarness(dispatch);
    try {
      const oldSession = await harness.bootstrap();
      const oldClient = await harness.connect(oldSession);
      oldClient.send({ kind: 'subscribe', requestId: 'old-subscribe-0001' });
      await oldClient.waitFor((payload) => payload.kind === 'response' && payload.requestId === 'old-subscribe-0001');
      oldClient.send({ kind: 'request', requestId: 'draining-command-0001', operation: 'command.submit', payload: { message: 'once' } });
      await waitUntil(() => dispatch.mock.calls.length === 1, 'pending old command');

      const candidateSession = await harness.bootstrap();
      const candidate = await harness.connect(candidateSession, true);
      candidate.send({ kind: 'subscribe', requestId: 'candidate-subscribe-0001',
        cursor: { epoch: oldSession.response.stream.epoch, sequence: 0 } });
      await candidate.waitFor((payload) => payload.kind === 'response' && payload.requestId === 'candidate-subscribe-0001');
      oldClient.send({ kind: 'ping', requestId: 'concurrent-ping-0001' });
      await oldClient.waitFor((payload) => payload.kind === 'response' && payload.requestId === 'concurrent-ping-0001');
      expect(oldClient.payloads.some((payload) => payload.kind === 'response' && payload.requestId === 'draining-command-0001')).toBe(false);
      harness.sessions.publishEvent({ workspaceId: 'workspace-1', eventKind: 'during-drain', payload: 1 });
      await Promise.all([oldClient, candidate].map((client) =>
        client.waitFor((payload) => payload.kind === 'event' && payload.eventKind === 'during-drain')));
      completeCommand({ accepted: true });
      await oldClient.waitFor((payload) => payload.kind === 'response' && payload.requestId === 'draining-command-0001');
      expect(dispatch).toHaveBeenCalledTimes(1);
      await oldClient.close();
      expect(harness.sessions.activeSessionCount()).toBe(1);
      candidate.send({ kind: 'ping', requestId: 'promoted-ping-0001' });
      await candidate.waitFor((payload) => payload.kind === 'response' && payload.requestId === 'promoted-ping-0001');
      for (const client of [oldClient, candidate]) {
        expect(client.frameSequences).toEqual(client.frameSequences.map((_, index) => index + 1));
      }
    } finally {
      completeCommand?.({ accepted: true });
      await harness.dispose();
    }
  });

  it('preserves the replacement owner when the old socket closes on another ingress listener', async () => {
    const harness = await createStreamHarness();
    try {
      const session = await harness.bootstrap();
      const privateClient = await harness.connect(session);
      privateClient.send({ kind: 'subscribe', requestId: 'private-subscribe-0001' });
      await privateClient.waitFor((payload) => payload.kind === 'response' && payload.requestId === 'private-subscribe-0001');
      const managedClient = await harness.connect(session, true);
      expect(await privateClient.closed()).toEqual({ code: 4001, reason: 'session-reconnected' });
      expect(harness.sessions.activeSessionCount()).toBe(1);
      expect(harness.sessions.isSessionSubscribedToWorkspace(session.response.sessionId, 'workspace-1')).toBe(false);
      managedClient.send({ kind: 'subscribe', requestId: 'managed-subscribe-0001' });
      await managedClient.waitFor((payload) => payload.kind === 'response' && payload.requestId === 'managed-subscribe-0001');
      harness.sessions.publishEvent({ workspaceId: 'workspace-1', eventKind: 'replacement-live', payload: 1 });
      await managedClient.waitFor((payload) => payload.kind === 'event' && payload.eventKind === 'replacement-live');
      expect(managedClient.frameSequences[0]).toBe(privateClient.frameSequences.at(-1)! + 1);
      expect(managedClient.frameSequences).toEqual(managedClient.frameSequences.map((_, index) => managedClient.frameSequences[0]! + index));
      await managedClient.close();
      expect(harness.sessions.activeSessionCount()).toBe(0);
    } finally {
      await harness.dispose();
    }
  });

  it.each([
    { label: 'event count', count: 513, payload: 'small' },
    { label: 'event bytes', count: 5, payload: 'x'.repeat(450_000) },
  ])('closes an overflowing $label queue instead of silently dropping stream data', async ({ count, payload }) => {
    const harness = await createStreamHarness();
    try {
      const session = await harness.bootstrap();
      const client = await harness.connect(session);
      client.send({ kind: 'subscribe', requestId: 'overflow-subscribe-0001' });
      await client.waitFor((item) => item.kind === 'response' && item.requestId === 'overflow-subscribe-0001');
      // One synchronous producer burst keeps writes pending until the event loop services the socket.
      for (let index = 0; index < count; index += 1) {
        harness.sessions.publishEvent({ workspaceId: 'workspace-1', eventKind: 'burst', payload });
      }
      expect(await client.closed()).toEqual({ code: 1009, reason: 'stream-buffer-overflow' });
      expect(harness.sessions.activeSessionCount()).toBe(0);
    } finally {
      await harness.dispose();
    }
  });

  it('reclaims capacity across more than 64 authenticated and abandoned preparation cycles', async () => {
    const harness = await createStreamHarness();
    const now = performance.now.bind(performance);
    let elapsed = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => now() + elapsed);
    try {
      for (let index = 0; index < 70; index += 1) {
        const session = await harness.bootstrap();
        if (index % 2 === 0) {
          const client = await harness.connect(session, index % 4 === 0);
          client.send({ kind: 'subscribe', requestId: `capacity-subscribe-${index}` });
          await client.waitFor((payload) => payload.kind === 'response' && payload.requestId === `capacity-subscribe-${index}`);
          await client.close();
        } else {
          elapsed += MESH_HOST_UNATTACHED_SESSION_TTL_MS + 1;
        }
        expect(harness.sessions.activeSessionCount()).toBe(0);
        session.token.fill(0);
      }
    } finally {
      await harness.dispose();
    }
  });
});
