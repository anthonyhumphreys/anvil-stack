import { hkdfSync } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  connectMeshMachineHost,
  createMeshMachineMac,
  meshMachineRouteCandidates,
  meshMachineRouteUrl,
  newMeshMachineEphemeralIdentity,
  openMeshMachineFrame,
  safeMeshRouteBase,
  sealMeshMachineFrame,
} from '../mesh-host-client.service.js';
import { sealToRecipientPub } from '../sync-keyring.service.js';
import {
  meshMachineAdmissionBootstrapProofMessage,
  meshMachineAdmissionProofKeyAssociatedData,
  meshMachineBootstrapHostProofMessage,
  meshMachineSessionTokenAssociatedData,
  meshMachineTrafficKeyDerivation,
  type MeshMachineAdmissionIssueRequest,
  type MeshMachineAdmissionClaims,
  type MeshMachineBootstrapChallenge,
  type MeshMachineBootstrapResponse,
  type MeshMachineEndpointInfo,
  type MeshMachineHost,
} from '../../../../cloud/contract/machine.js';

const now = Date.parse('2026-10-04T10:00:00.000Z');

function host(at = now): MeshMachineHost {
  return {
    enrollmentId: 'device-target',
    machineId: 'machine-target',
    endpointGeneration: 'generation-1',
    protocolVersion: 1,
    capabilities: ['machine.session/1', 'machine.stream/1', 'dashboard.command.wake/1'],
    operations: ['read.job', 'read.events', 'read.snapshot', 'command.submit'],
    online: true,
    lastSeenAt: new Date(at).toISOString(),
    reachableUntil: new Date(at + 60_000).toISOString(),
    allocationState: 'ready',
    routes: [
      {
        kind: 'managed',
        url: 'https://managed.example.test',
        machineId: 'machine-target',
        endpointGeneration: 'generation-1',
        reachableUntil: new Date(at + 60_000).toISOString(),
      },
      {
        kind: 'private',
        url: 'https://private.example.test',
        machineId: 'machine-target',
        endpointGeneration: 'generation-1',
        reachableUntil: new Date(at + 60_000).toISOString(),
      },
      {
        kind: 'https',
        url: 'https://custom.example.test',
        machineId: 'machine-target',
        endpointGeneration: 'generation-1',
        reachableUntil: new Date(at + 60_000).toISOString(),
      },
      {
        kind: 'private',
        url: 'https://stale.example.test',
        machineId: 'machine-target',
        endpointGeneration: 'old-generation',
        reachableUntil: new Date(at + 60_000).toISOString(),
      },
    ],
  };
}

describe('mesh host route and frame helpers', () => {
  it('orders fresh, generation-matched private routes before managed routes', () => {
    expect(meshMachineRouteCandidates(host(), now).map((route) => route.kind)).toEqual([
      'private',
      'https',
      'managed',
    ]);
    expect(meshMachineRouteCandidates(host(), now + 60_000)).toEqual([]);
  });

  it('only builds host URLs from credential-free HTTPS or approved private routes', () => {
    expect(safeMeshRouteBase({ kind: 'managed', url: 'http://managed.example.test' })).toBeNull();
    expect(safeMeshRouteBase({ kind: 'private', url: 'http://192.168.1.4' })?.origin).toBe(
      'http://192.168.1.4',
    );
    expect(safeMeshRouteBase({ kind: 'private', url: 'http://127.0.0.1:4312' })?.origin).toBe(
      'http://127.0.0.1:4312',
    );
    expect(safeMeshRouteBase({ kind: 'private', url: 'http://100.64.0.1:4312' })?.origin).toBe(
      'http://100.64.0.1:4312',
    );
    expect(safeMeshRouteBase({ kind: 'private', url: 'http://100.127.255.254:4312' })).not.toBeNull();
    expect(safeMeshRouteBase({ kind: 'private', url: 'http://100.63.255.255:4312' })).toBeNull();
    expect(safeMeshRouteBase({ kind: 'private', url: 'http://100.128.0.1:4312' })).toBeNull();
    expect(safeMeshRouteBase({ kind: 'private', url: 'http://[fd7a:115c:a1e0::1]:4312' })).not.toBeNull();
    expect(safeMeshRouteBase({ kind: 'private', url: 'http://8.8.8.8:4312' })).toBeNull();
    expect(safeMeshRouteBase({ kind: 'https', url: 'https://user:secret@host.test' })).toBeNull();
    expect(safeMeshRouteBase({ kind: 'private', url: 'https://host.test/path' })).toBeNull();

    const route = meshMachineRouteCandidates(host(), now)[0]!;
    expect(meshMachineRouteUrl(route, '/api/machine/v1/info')).toBe(
      'https://private.example.test/api/machine/v1/info',
    );
    expect(meshMachineRouteUrl(route, '/api/machine/v1/sessions/socket', true)).toBe(
      'wss://private.example.test/api/machine/v1/sessions/socket',
    );
  });

  it('authenticates frame contents and binds the event cursor and direction', () => {
    const key = Buffer.alloc(32, 19);
    const fields = {
      key,
      sessionId: 'session-1',
      machineId: 'machine-target',
      endpointGeneration: 'generation-1',
      epoch: 'stream-epoch',
      direction: 'host-to-client' as const,
      requestId: 'event-1',
      sequence: 4,
      payload: { kind: 'event', eventKind: 'activity', payload: { text: 'hello' } },
    };
    const envelope = sealMeshMachineFrame(fields);
    expect(
      openMeshMachineFrame({
        ...fields,
        envelope,
      }),
    ).toEqual(fields.payload);
    expect(() =>
      openMeshMachineFrame({
        ...fields,
        sequence: 5,
        envelope,
      }),
    ).toThrow();
    expect(() =>
      openMeshMachineFrame({
        ...fields,
        direction: 'client-to-host',
        envelope,
      }),
    ).toThrow();
  });

  it('creates a fresh raw X25519 public key for sealed ticket material', () => {
    const first = newMeshMachineEphemeralIdentity();
    const second = newMeshMachineEphemeralIdentity();
    expect(Buffer.from(first.clientPublicKey, 'base64')).toEqual(first.clientPublicRaw);
    expect(first.clientPublicRaw).toHaveLength(32);
    expect(first.clientPublicKey).not.toBe(second.clientPublicKey);
  });

  it('keeps the account bearer on HTTPS broker calls and proves the host before dialing', async () => {
    const setup = makeAdmissionHandshake();
    const onEvent = vi.fn();
    const connection = await connectMeshMachineHost(host(Date.now()), {
      apiUrl: 'https://account.example.test/v1/',
      accessToken: 'source-device-secret',
      accountId: 'account-1',
      enrollmentId: 'source-device',
      fetchFn: setup.fetchFn,
      socketFactory: setup.socketFactory,
      onEvent,
    });

    const broker = setup.calls.find((call) =>
      new URL(call.url).pathname === '/v1/mesh/hosts/machine-target/admission-tickets',
    );
    expect(broker?.headers.get('authorization')).toBe('Bearer source-device-secret');
    expect(new URL(broker!.url).protocol).toBe('https:');
    expect(broker?.init.redirect).toBe('error');
    const hostCalls = setup.calls.filter((call) =>
      new URL(call.url).hostname === 'private.example.test',
    );
    expect(hostCalls.length).toBeGreaterThanOrEqual(3);
    for (const call of hostCalls) {
      expect(call.headers.has('authorization')).toBe(false);
      expect(call.init.redirect).toBe('error');
    }
    expect(setup.socketURLs).toEqual([
      'wss://private.example.test/api/machine/v1/sessions/socket',
    ]);
    setup.sockets[0]?.emitServerPayload({
      kind: 'event',
      epoch: 'stream-epoch',
      sequence: 1,
      workspaceId: 'workspace-1',
      jobId: 'job-1',
      eventKind: 'activity',
      payload: { attemptId: 'attempt-1', streamId: 'attempt:attempt-1', sequence: 1 },
    }, 2);
    await vi.waitFor(() => expect(onEvent).toHaveBeenCalledTimes(1));
    expect(onEvent).toHaveBeenCalledWith(expect.objectContaining({
      eventKind: 'activity',
      workspaceId: 'workspace-1',
      jobId: 'job-1',
    }));
    connection.close();
  });

  it('rejects an attacker-selected sealed token without host possession proof before socket creation', async () => {
    const setup = makeAdmissionHandshake({ forgeHostProof: true });
    await expect(
      connectMeshMachineHost(host(Date.now()), {
        apiUrl: 'https://account.example.test/v1/',
        accessToken: 'source-device-secret',
        accountId: 'account-1',
        enrollmentId: 'source-device',
        fetchFn: setup.fetchFn,
        socketFactory: setup.socketFactory,
      }),
    ).rejects.toThrow('authorization-unavailable');
    expect(setup.socketURLs).toEqual([]);
  });
});

interface CapturedFetch {
  url: string;
  init: RequestInit;
  headers: Headers;
}

function makeAdmissionHandshake(options: { forgeHostProof?: boolean } = {}): {
  calls: CapturedFetch[];
  socketURLs: string[];
  sockets: TestMachineSocket[];
  fetchFn: typeof fetch;
  socketFactory: (url: string, protocols: string[]) => TestMachineSocket;
} {
  const proofKey = Buffer.alloc(32, 0x63);
  const sessionToken = Buffer.alloc(32, 0x21);
  const handshakeNow = Date.now();
  const calls: CapturedFetch[] = [];
  const socketURLs: string[] = [];
  const sockets: TestMachineSocket[] = [];
  let claims: MeshMachineAdmissionClaims | null = null;
  let challenge: MeshMachineBootstrapChallenge | null = null;
  let bootstrapRequestSeen = false;

  const fetchFn: typeof fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    const headers = new Headers(init.headers);
    calls.push({ url: url.href, init, headers });
    if (url.pathname === '/api/machine/v1/info') {
      const info: MeshMachineEndpointInfo = {
        hostEnrollmentId: 'device-target',
        machineId: 'machine-target',
        endpointGeneration: 'generation-1',
        protocolVersion: 1,
        capabilities: ['machine.session/1', 'machine.stream/1'],
        operations: ['read.job', 'read.events', 'read.snapshot', 'command.submit'],
        transport: {
          socketPath: '/api/machine/v1/sessions/socket',
          maxFrameBytes: 512 * 1024,
          replayEvents: 512,
          replayBytes: 2 * 1024 * 1024,
          sessionRefreshIntervalMs: 30_000,
          sessionAuthorizationMaxAgeMs: 60_000,
        },
      };
      return jsonResponse(info);
    }
    if (url.pathname === '/v1/mesh/hosts/machine-target/admission-tickets') {
      const body = JSON.parse(String(init.body)) as MeshMachineAdmissionIssueRequest;
      if (body.kind !== 'enrollment') throw new Error('Expected enrollment ticket request.');
      claims = {
        v: 1,
        accountId: 'account-1',
        hostEnrollmentId: 'device-target',
        hostMachineId: 'machine-target',
        endpointGeneration: 'generation-1',
        clientPublicKey: body.clientPublicKey,
        bootstrapChallenge: body.bootstrapChallenge,
        issuedAt: new Date(handshakeNow).toISOString(),
        expiresAt: new Date(handshakeNow + 120_000).toISOString(),
        principal: {
          kind: 'enrollment',
          sourceEnrollmentId: 'source-device',
          requestedCapabilities: body.requestedCapabilities,
          operations: body.operations,
          scopes: body.scopes,
        },
      };
      const wrappedProofKey = sealToRecipientPub(
        body.clientPublicKey,
        proofKey,
        meshMachineAdmissionProofKeyAssociatedData(claims),
      );
      return jsonResponse({
        v: 1,
        ticket: 'opaque-admission-ticket-with-enough-entropy',
        claims,
        sealedProofKey: { enc: 'x25519-aes-256-gcm', ...wrappedProofKey },
      });
    }
    if (url.pathname === '/api/machine/v1/sessions/challenge') {
      if (claims === null) throw new Error('Broker ticket should precede challenge.');
      challenge = {
        v: 1,
        mode: 'admission',
        challengeId: 'challenge-1',
        nonce: claims.bootstrapChallenge,
        epoch: 'stream-epoch',
        machineId: 'machine-target',
        endpointGeneration: 'generation-1',
        clientPublicKey: claims.clientPublicKey,
        expiresAt: new Date(handshakeNow + 60_000).toISOString(),
        claims,
      };
      return jsonResponse(challenge);
    }
    if (url.pathname === '/api/machine/v1/sessions/bootstrap') {
      if (claims === null || challenge === null) throw new Error('Challenge should precede bootstrap.');
      bootstrapRequestSeen = true;
      const request = JSON.parse(String(init.body)) as { proof: string };
      expect(request.proof).toBe(
        createMeshMachineMac(
          proofKey,
          meshMachineAdmissionBootstrapProofMessage({
            claims,
            challengeId: challenge.challengeId,
            nonce: challenge.nonce,
          }),
        ),
      );
      const sessionClaims: MeshMachineBootstrapResponse['sessionClaims'] = {
        accountId: 'account-1',
        principal: { kind: 'enrollment', accountId: 'account-1', sourceEnrollmentId: 'source-device', tier: 'steer' },
        machineId: 'machine-target',
        endpointGeneration: 'generation-1',
        sessionId: 'session-1',
      };
      const tokenSeal = sealToRecipientPub(
        claims.clientPublicKey,
        sessionToken,
        meshMachineSessionTokenAssociatedData(sessionClaims),
      );
      const responseWithoutHostProof: Omit<MeshMachineBootstrapResponse, 'hostProof'> = {
        v: 1,
        sessionId: 'session-1',
        sessionToken: { enc: 'x25519-aes-256-gcm', ...tokenSeal },
        sessionClaims,
        machineId: 'machine-target',
        endpointGeneration: 'generation-1',
        sessionExpiresAt: new Date(handshakeNow + 60_000).toISOString(),
        authorizationValidUntil: new Date(handshakeNow + 60_000).toISOString(),
        stream: { epoch: 'stream-epoch', nextSequence: 1, oldestSequence: 1 },
      };
      const hostProof = options.forgeHostProof
        ? createMeshMachineMac(proofKey, 'attacker-signed-response')
        : createMeshMachineMac(
            proofKey,
            meshMachineBootstrapHostProofMessage({
              challengeId: challenge.challengeId,
              nonce: challenge.nonce,
              response: responseWithoutHostProof,
            }),
          );
      return jsonResponse({ ...responseWithoutHostProof, hostProof });
    }
    throw new Error(`Unexpected test fetch: ${url.href}`);
  };

  const socketFactory = (url: string): TestMachineSocket => {
    socketURLs.push(url);
    if (!bootstrapRequestSeen) throw new Error('Socket opened before bootstrap completed.');
    const socket = new TestMachineSocket(sessionToken);
    sockets.push(socket);
    return socket;
  };
  return { calls, socketURLs, sockets, fetchFn, socketFactory };
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

class TestMachineSocket {
  private listeners = new Map<string, Array<(...args: unknown[]) => void>>();
  private closed = false;

  constructor(private readonly sessionToken: Buffer) {
    queueMicrotask(() => this.emit('message', JSON.stringify({
      type: 'auth-challenge',
      nonce: 'socket-nonce',
      epoch: 'stream-epoch',
    })));
  }

  on(event: string, listener: (...args: unknown[]) => void): void {
    const listeners = this.listeners.get(event) ?? [];
    listeners.push(listener);
    this.listeners.set(event, listeners);
  }

  send(data: string): void {
    const frame = JSON.parse(data) as { type: string };
    if (frame.type !== 'auth') return;
    const derivation = meshMachineTrafficKeyDerivation({
      sessionId: 'session-1',
      machineId: 'machine-target',
      endpointGeneration: 'generation-1',
      direction: 'host-to-client',
    });
    const key = Buffer.from(hkdfSync(
      'sha256',
      this.sessionToken,
      Buffer.from(derivation.salt, 'utf8'),
      Buffer.from(derivation.info, 'utf8'),
      32,
    ));
    const payload = {
      kind: 'ready',
      sessionId: 'session-1',
      epoch: 'stream-epoch',
      nextClientSequence: 1,
      nextSequence: 1,
      oldestSequence: 1,
      authorizationValidUntil: new Date(Date.now() + 60_000).toISOString(),
    };
    const envelope = sealMeshMachineFrame({
      key,
      sessionId: 'session-1',
      machineId: 'machine-target',
      endpointGeneration: 'generation-1',
      epoch: 'stream-epoch',
      direction: 'host-to-client',
      sequence: 1,
      payload,
    });
    queueMicrotask(() => {
      this.emit('message', JSON.stringify({
        type: 'data',
        sessionId: 'session-1',
        sequence: 1,
        envelope,
      }));
    });
  }

  emitServerPayload(payload: unknown, outerSequence: number): void {
    const derivation = meshMachineTrafficKeyDerivation({
      sessionId: 'session-1',
      machineId: 'machine-target',
      endpointGeneration: 'generation-1',
      direction: 'host-to-client',
    });
    const key = Buffer.from(hkdfSync(
      'sha256',
      this.sessionToken,
      Buffer.from(derivation.salt, 'utf8'),
      Buffer.from(derivation.info, 'utf8'),
      32,
    ));
    const envelope = sealMeshMachineFrame({
      key,
      sessionId: 'session-1',
      machineId: 'machine-target',
      endpointGeneration: 'generation-1',
      epoch: 'stream-epoch',
      direction: 'host-to-client',
      sequence: outerSequence,
      payload,
    });
    queueMicrotask(() => this.emit('message', JSON.stringify({
      type: 'data',
      sessionId: 'session-1',
      sequence: outerSequence,
      envelope,
    })));
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.emit('close');
  }

  private emit(event: string, ...args: unknown[]): void {
    for (const listener of this.listeners.get(event) ?? []) listener(...args);
  }
}
