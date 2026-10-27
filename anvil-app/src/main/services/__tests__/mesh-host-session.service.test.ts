import { hkdfSync, randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  meshMachineAdmissionBootstrapProofMessage,
  meshMachineBootstrapHostProofMessage,
  meshMachineSessionTokenAssociatedData,
  meshMachineTrafficKeyDerivation,
  type MeshMachineEnrollmentAdmissionClaims,
  type MeshMachineSessionPrincipal,
} from '../../../../cloud/contract/machine';
import {
  createMeshMachineMac,
  newMeshMachineEphemeralIdentity,
  openMeshMachineFrame,
  openMeshSealedBytes,
  sealMeshMachineFrame,
} from '../mesh-host-client.service.js';
import {
  MeshHostAdmissionError,
  MeshHostSessionService,
  MESH_HOST_UNATTACHED_SESSION_TTL_MS,
  type MeshHostDashboardContext,
} from '../mesh-host-session.service.js';

const identity = {
  hostEnrollmentId: 'enr-host',
  machineId: 'machine-host',
  endpointGeneration: 'generation-host',
};

const testServices = new Set<MeshHostSessionService>();

afterEach(() => {
  for (const service of testServices) service.shutdown();
  testServices.clear();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function makeEnrollmentClaims(
  clientPublicKey: string,
  overrides: Partial<Omit<MeshMachineEnrollmentAdmissionClaims, 'principal'>> = {},
): MeshMachineEnrollmentAdmissionClaims {
  const issuedAt = new Date().toISOString();
  return {
    v: 1,
    accountId: 'account-1',
    hostEnrollmentId: identity.hostEnrollmentId,
    hostMachineId: identity.machineId,
    endpointGeneration: identity.endpointGeneration,
    clientPublicKey,
    bootstrapChallenge: randomBytes(32).toString('base64url'),
    issuedAt,
    expiresAt: new Date(Date.now() + 55_000).toISOString(),
    principal: {
      kind: 'enrollment',
      sourceEnrollmentId: 'enr-client',
      requestedCapabilities: ['machine.session/1', 'machine.stream/1'],
      operations: ['read.snapshot', 'read.job', 'read.events'],
      scopes: [],
    },
    ...overrides,
  };
}

function createEnrollmentService(input: {
  claims?: MeshMachineEnrollmentAdmissionClaims;
  ephemeral?: ReturnType<typeof newMeshMachineEphemeralIdentity>;
  authorization?: 'authorized' | 'approval-required' | 'denied' | 'unavailable';
  activeScope?: { backendId: string; accountId: string; datasetEpoch: string } | null;
} = {}) {
  const ephemeral = input.ephemeral ?? newMeshMachineEphemeralIdentity();
  const claims = input.claims ?? makeEnrollmentClaims(ephemeral.clientPublicKey);
  const proofKey = randomBytes(32);
  let activeScope = input.activeScope ?? {
    backendId: 'backend-1',
    accountId: 'account-1',
    datasetEpoch: 'epoch-1',
  };
  const principal: Extract<MeshMachineSessionPrincipal, { kind: 'enrollment' }> = {
    kind: 'enrollment',
    accountId: claims.accountId,
    sourceEnrollmentId: claims.principal.sourceEnrollmentId,
    tier: 'observe',
  };
  const consumeAdmissionTicket = vi.fn(async (ticket: string) => {
    expect(ticket).toBe('one-use-ticket');
    return { v: 1 as const, claims, proofKey: proofKey.toString('base64url') };
  });
  const authorizeAdmission = vi.fn(async () => {
    const state = input.authorization ?? 'authorized';
    return state === 'authorized'
      ? { state, principal }
      : { state };
  });
  const revalidateAdmission = vi.fn(async () => ({
    authorized: true,
    validUntil: new Date(Date.now() + 60_000).toISOString(),
  }));
  const dispatchOperation = vi.fn(async ({ operation }: { operation: string }) => ({
    operation,
    ok: true,
  }));
  const service = new MeshHostSessionService({
    identity: () => identity,
    activeScope: () => activeScope,
    consumeAdmissionTicket,
    authorizeAdmission,
    revalidateAdmission,
    dispatchOperation,
  });
  testServices.add(service);
  return {
    service,
    claims,
    ephemeral,
    proofKey,
    principal,
    consumeAdmissionTicket,
    authorizeAdmission,
    revalidateAdmission,
    dispatchOperation,
    setScope(scope: typeof activeScope) { activeScope = scope; },
  };
}

async function openEnrollmentSession(
  fixture: ReturnType<typeof createEnrollmentService>,
  ephemeral = fixture.ephemeral,
) {
  const challenge = await fixture.service.createChallenge({
    v: 1,
    mode: 'admission',
    ticket: 'one-use-ticket',
    clientPublicKey: ephemeral.clientPublicKey,
  });
  const proof = createMeshMachineMac(
    fixture.proofKey,
    meshMachineAdmissionBootstrapProofMessage({
      claims: fixture.claims,
      challengeId: challenge.challengeId,
      nonce: challenge.nonce,
    }),
  );
  const response = await fixture.service.bootstrap(
    { v: 1, challengeId: challenge.challengeId, proof },
  );
  const token = openMeshSealedBytes(
    ephemeral.privateKey,
    ephemeral.clientPublicRaw,
    response.sessionToken,
    meshMachineSessionTokenAssociatedData(response.sessionClaims),
  );
  return { challenge, response, token, ephemeral };
}

function clientTrafficKey(session: Awaited<ReturnType<typeof openEnrollmentSession>>): Buffer {
  const derivation = meshMachineTrafficKeyDerivation({
    sessionId: session.response.sessionId,
    machineId: identity.machineId,
    endpointGeneration: identity.endpointGeneration,
    direction: 'client-to-host',
  });
  return Buffer.from(
    hkdfSync(
      'sha256',
      session.token,
      Buffer.from(derivation.salt, 'utf8'),
      Buffer.from(derivation.info, 'utf8'),
      32,
    ),
  );
}

describe('Mesh host sessions', () => {
  it('binds ticket admission to account, host enrollment, machine, generation and one-use challenge', async () => {
    const fixture = createEnrollmentService();
    const ephemeral = fixture.ephemeral;
    const challenge = await fixture.service.createChallenge({
      v: 1,
      mode: 'admission',
      ticket: 'one-use-ticket',
      clientPublicKey: ephemeral.clientPublicKey,
    });
    expect(fixture.consumeAdmissionTicket).toHaveBeenCalledExactlyOnceWith('one-use-ticket');

    const proof = createMeshMachineMac(
      fixture.proofKey,
      meshMachineAdmissionBootstrapProofMessage({
        claims: fixture.claims,
        challengeId: challenge.challengeId,
        nonce: challenge.nonce,
      }),
    );
    const request = { v: 1 as const, challengeId: challenge.challengeId, proof };
    const response = await fixture.service.bootstrap(request);
    expect(response).toMatchObject({
      machineId: identity.machineId,
      endpointGeneration: identity.endpointGeneration,
    });
    const { hostProof, ...responseWithoutHostProof } = response;
    expect(hostProof).toBe(
      createMeshMachineMac(
        fixture.proofKey,
        meshMachineBootstrapHostProofMessage({
          challengeId: challenge.challengeId,
          nonce: challenge.nonce,
          response: responseWithoutHostProof,
        }),
      ),
    );
    expect(hostProof).not.toBe(
      createMeshMachineMac(
        fixture.proofKey,
        meshMachineBootstrapHostProofMessage({
          challengeId: challenge.challengeId,
          nonce: challenge.nonce,
          response: { ...responseWithoutHostProof, sessionExpiresAt: '2030-01-01T00:00:00.000Z' },
        }),
      ),
    );
    await expect(fixture.service.bootstrap(request)).rejects.toThrow('bootstrap-expired');
  });

  it('rejects a ticket from another account before authorizing its principal', async () => {
    const ephemeral = newMeshMachineEphemeralIdentity();
    const claims = makeEnrollmentClaims(ephemeral.clientPublicKey, { accountId: 'other-account' });
    const fixture = createEnrollmentService({ claims, ephemeral });
    await expect(
      fixture.service.createChallenge({
        v: 1,
        mode: 'admission',
        ticket: 'one-use-ticket',
        clientPublicKey: ephemeral.clientPublicKey,
      }),
    ).rejects.toThrow('admission-invalid');
    expect(fixture.authorizeAdmission).not.toHaveBeenCalled();
  });

  it.each([
    ['approval-required', 'approval-required'],
    ['denied', 'device-denied'],
  ] as const)('returns a stable %s outcome for a blocked first contact', async (state, code) => {
    const fixture = createEnrollmentService({ authorization: state });
    const ephemeral = fixture.ephemeral;
    await expect(
      fixture.service.createChallenge({
        v: 1,
        mode: 'admission',
        ticket: 'one-use-ticket',
        clientPublicKey: ephemeral.clientPublicKey,
      }),
    ).rejects.toMatchObject({
      code,
    } satisfies Partial<MeshHostAdmissionError>);
  });

  it('rejects wrong dashboard Origin and dashboard claims outside the local grant scope', async () => {
    const scope = { backendId: 'backend-1', accountId: 'account-1', datasetEpoch: 'epoch-1' };
    const dashboardContext: MeshHostDashboardContext = {
      accountId: 'account-1',
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
    const dashboardDsk = randomBytes(32);
    const service = new MeshHostSessionService({
      identity: () => identity,
      activeScope: () => scope,
      getDashboardContext: (_scope, grantId) => grantId === 'grant-1' ? dashboardContext : null,
      verifyDashboardProof: (_scope, claims, proof) =>
        proof === 'local-dsk-proof' &&
        claims.scope.workspaceIds.length === 1 &&
        claims.scope.workspaceIds[0] === 'workspace-1',
      createDashboardHostProof: (_scope, _claims, challengeId, nonce, response) =>
        createMeshMachineMac(
          dashboardDsk,
          meshMachineBootstrapHostProofMessage({ challengeId, nonce, response }),
        ),
      refreshDashboard: async () => true,
      dispatchOperation: async () => ({ ok: true }),
    });
    testServices.add(service);
    const ephemeral = newMeshMachineEphemeralIdentity();
    const request = {
      v: 1 as const,
      mode: 'dashboard' as const,
      grantId: 'grant-1',
      clientPublicKey: ephemeral.clientPublicKey,
    };
    await expect(service.createChallenge(request, 'https://attacker.example')).rejects.toThrow(
      'dashboard-grant-unavailable',
    );
    const challenge = await service.createChallenge(request, 'https://anvil.dev');
    await expect(
      service.bootstrap(
        { v: 1, challengeId: challenge.challengeId, proof: 'local-dsk-proof' },
        'https://attacker.example',
      ),
    ).rejects.toThrow('bootstrap-origin-invalid');
    const response = await service.bootstrap(
      { v: 1, challengeId: challenge.challengeId, proof: 'local-dsk-proof' },
      'https://anvil.dev',
    );
    expect(response).toMatchObject({ machineId: identity.machineId });
    expect(response.hostProof).toBe(
      createMeshMachineMac(
        dashboardDsk,
        meshMachineBootstrapHostProofMessage({
          challengeId: challenge.challengeId,
          nonce: challenge.nonce,
          response: (({ hostProof: _hostProof, ...rest }) => rest)(response),
        }),
      ),
    );
  });

  it('rejects mutated AAD/ciphertext and replays across socket reconnects', async () => {
    const fixture = createEnrollmentService();
    const session = await openEnrollmentSession(fixture);
    const requestId = 'request-0001';
    const payload = {
      kind: 'request' as const,
      requestId,
      operation: 'read.snapshot' as const,
      payload: {},
    };
    const envelope = sealMeshMachineFrame({
      key: clientTrafficKey(session),
      sessionId: session.response.sessionId,
      machineId: identity.machineId,
      endpointGeneration: identity.endpointGeneration,
      epoch: session.response.stream.epoch,
      direction: 'client-to-host',
      requestId,
      sequence: 1,
      payload,
    });
    const frame = {
      type: 'data' as const,
      sessionId: session.response.sessionId,
      requestId,
      sequence: 1,
      envelope,
    };
    expect(() =>
      fixture.service.decryptClientFrame({ ...frame, requestId: 'request-0002' }),
    ).toThrow();
    const modifiedCiphertext = Buffer.from(envelope.ct, 'base64');
    modifiedCiphertext[0] ^= 1;
    expect(() =>
      fixture.service.decryptClientFrame({
        ...frame,
        envelope: { ...envelope, ct: modifiedCiphertext.toString('base64') },
      }),
    ).toThrow();

    expect(fixture.service.decryptClientFrame(frame).payload).toEqual(payload);
    const nextSocketNonce = randomBytes(32).toString('base64url');
    const socketProof = createMeshMachineMac(
      session.token,
      JSON.stringify({
        v: 1,
        purpose: 'anvil/mesh-machine-socket/1',
        sessionId: session.response.sessionId,
        nonce: nextSocketNonce,
        machineId: identity.machineId,
        endpointGeneration: identity.endpointGeneration,
      }),
    );
    expect(fixture.service.authenticateSocket(session.response.sessionId, nextSocketNonce, socketProof)).toBe(true);
    expect(() => fixture.service.decryptClientFrame(frame)).toThrow('sequence-invalid');
    const serverPayload = { kind: 'response' as const, requestId: 'request-0003', result: { ok: true } };
    const serverFrame = fixture.service.encryptServerPayload(session.response.sessionId, serverPayload);
    if (serverFrame.type !== 'data') throw new Error('Expected an encrypted server frame.');
    const serverKeyDerivation = meshMachineTrafficKeyDerivation({
      sessionId: session.response.sessionId,
      machineId: identity.machineId,
      endpointGeneration: identity.endpointGeneration,
      direction: 'host-to-client',
    });
    const serverTrafficKey = Buffer.from(
      hkdfSync(
        'sha256',
        session.token,
        Buffer.from(serverKeyDerivation.salt, 'utf8'),
        Buffer.from(serverKeyDerivation.info, 'utf8'),
        32,
      ),
    );
    expect(serverFrame.envelope.nonce).not.toBe('AAAAAAAAAAAAAAAA');
    expect(openMeshMachineFrame({
      key: serverTrafficKey,
      sessionId: session.response.sessionId,
      machineId: identity.machineId,
      endpointGeneration: identity.endpointGeneration,
      epoch: session.response.stream.epoch,
      direction: 'host-to-client',
      requestId: serverPayload.requestId,
      sequence: serverFrame.sequence,
      envelope: serverFrame.envelope,
    })).toEqual(serverPayload);
    serverTrafficKey.fill(0);
    fixture.service.publishEvent({ workspaceId: 'workspace-1', eventKind: 'output', payload: { text: 'ok' } });
    expect(fixture.service.readyPayload(session.response.sessionId)).toMatchObject({
      kind: 'ready',
      nextClientSequence: 2,
      nextSequence: 2,
    });
  });

  it('revokes after backend/account/dataset scope changes and revalidates before refresh', async () => {
    const fixture = createEnrollmentService();
    const session = await openEnrollmentSession(fixture);
    fixture.setScope({ backendId: 'backend-1', accountId: 'account-2', datasetEpoch: 'epoch-1' });
    expect(fixture.service.isSessionActive(session.response.sessionId)).toBe(false);
    expect(fixture.service.activeSessionCount()).toBe(0);
  });

  it('keeps proof-key material out of the host-facing ticket request contract', () => {
    const ticketClaims = makeEnrollmentClaims(newMeshMachineEphemeralIdentity().clientPublicKey);
    expect(JSON.stringify(ticketClaims)).not.toContain('accessToken');
    expect(Object.keys(ticketClaims)).not.toContain('proofKey');
  });

  it('installs subscriptions explicitly and places the replay barrier after filtered events', async () => {
    const fixture = createEnrollmentService();
    const { response } = await openEnrollmentSession(fixture);
    const sessionId = response.sessionId;
    expect(fixture.service.isSessionSubscribedToWorkspace(sessionId, 'workspace-1')).toBe(false);
    for (const workspaceId of ['workspace-1', 'workspace-2', 'workspace-1', 'workspace-2']) {
      fixture.service.publishEvent({ workspaceId, eventKind: 'output', payload: { workspaceId } });
    }
    const result = fixture.service.processSubscription(sessionId, {
      kind: 'subscribe',
      requestId: 'subscribe-0001',
      cursor: { epoch: response.stream.epoch, sequence: 0 },
      workspaceIds: ['workspace-1'],
    });
    expect(result.map((payload) => payload.kind)).toEqual(['event', 'event', 'response']);
    expect(result.slice(0, 2)).toMatchObject([{ sequence: 1 }, { sequence: 3 }]);
    expect(result[2]).toEqual({
      kind: 'response',
      requestId: 'subscribe-0001',
      result: { cursor: { epoch: response.stream.epoch, sequence: 4 }, replayComplete: true },
    });
    expect(fixture.service.isSessionSubscribedToWorkspace(sessionId, 'workspace-1')).toBe(true);
    expect(fixture.service.isSessionSubscribedToWorkspace(sessionId, 'workspace-2')).toBe(false);
  });

  it('does not claim replay continuity for an expired cursor or accept a future cursor', async () => {
    const fixture = createEnrollmentService();
    const { response } = await openEnrollmentSession(fixture);
    const future = fixture.service.processSubscription(response.sessionId, {
      kind: 'subscribe', requestId: 'future-cursor-0001',
      cursor: { epoch: response.stream.epoch, sequence: 1 },
    });
    expect(future).toMatchObject([{ kind: 'error', code: 'cursor-invalid' }]);
    expect(fixture.service.isSessionSubscribedToWorkspace(response.sessionId, 'workspace-1')).toBe(false);
    for (let index = 0; index < 513; index += 1) {
      fixture.service.publishEvent({ workspaceId: 'workspace-1', eventKind: 'output', payload: index });
    }
    expect(fixture.service.processSubscription(response.sessionId, {
      kind: 'subscribe', requestId: 'expired-cursor-0001',
      cursor: { epoch: response.stream.epoch, sequence: 0 },
    })).toMatchObject([
      { kind: 'resnapshot-required', reason: 'cursor-expired' },
      { kind: 'response', result: { cursor: { sequence: 513 }, replayComplete: true } },
    ]);
  });

  it('fences socket replacement across listeners and zeroes keys only when the current owner retires', async () => {
    const fixture = createEnrollmentService();
    const { response } = await openEnrollmentSession(fixture);
    const record = (fixture.service as unknown as {
      sessions: Map<string, { sessionToken: Buffer }>;
    }).sessions.get(response.sessionId)!;
    const first = Symbol('private-listener');
    const second = Symbol('managed-listener');
    const closeFirst = vi.fn(() => fixture.service.detachSocket(response.sessionId, first));
    const closeSecond = vi.fn();
    expect(fixture.service.attachSocket(response.sessionId, first, closeFirst)).toBe(true);
    fixture.service.processSubscription(response.sessionId, {
      kind: 'subscribe', requestId: 'subscribe-0001',
    });
    expect(fixture.service.attachSocket(response.sessionId, second, closeSecond)).toBe(true);
    expect(closeFirst).toHaveBeenCalledExactlyOnceWith('replaced');
    fixture.service.detachSocket(response.sessionId, first);
    expect(fixture.service.ownsSocket(response.sessionId, second)).toBe(true);
    expect(fixture.service.isSessionSubscribedToWorkspace(response.sessionId, 'workspace-1')).toBe(false);
    expect(record.sessionToken.equals(Buffer.alloc(32))).toBe(false);
    expect(fixture.service.activeSessionCount()).toBe(1);
    fixture.service.detachSocket(response.sessionId, second);
    expect(fixture.service.activeSessionCount()).toBe(0);
    expect(record.sessionToken).toEqual(Buffer.alloc(32));
    expect(closeSecond).not.toHaveBeenCalled();
  });

  it('expires abandoned bootstrap sessions promptly and cancels expiry after attachment', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] });
    const fixture = createEnrollmentService();
    const abandoned = await openEnrollmentSession(fixture);
    const attached = await openEnrollmentSession(fixture);
    const records = (fixture.service as unknown as {
      sessions: Map<string, { sessionToken: Buffer }>;
    }).sessions;
    const abandonedKey = records.get(abandoned.response.sessionId)!.sessionToken;
    const owner = Symbol('attached');
    expect(fixture.service.attachSocket(attached.response.sessionId, owner, vi.fn())).toBe(true);
    await vi.advanceTimersByTimeAsync(MESH_HOST_UNATTACHED_SESSION_TTL_MS + 1);
    expect(fixture.service.activeSessionCount()).toBe(1);
    expect(abandonedKey).toEqual(Buffer.alloc(32));
    expect(fixture.service.ownsSocket(attached.response.sessionId, owner)).toBe(true);
  });

  it('reclaims more than the session capacity across sequential authenticated retirements', async () => {
    const fixture = createEnrollmentService();
    for (let index = 0; index < 70; index += 1) {
      const { response } = await openEnrollmentSession(fixture);
      const owner = Symbol('socket');
      expect(fixture.service.attachSocket(response.sessionId, owner, vi.fn())).toBe(true);
      fixture.service.detachSocket(response.sessionId, owner);
      expect(fixture.service.activeSessionCount()).toBe(0);
    }
  });
});
