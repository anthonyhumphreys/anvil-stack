import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import { build } from 'esbuild';

// Bundle the production client with only native platform adapters substituted. The
// client framing, cryptography, queue, subscription barrier and route checks run intact.
const result = await build({
  entryPoints: [new URL('../mesh-session.ts', import.meta.url).pathname],
  bundle: true,
  write: false,
  platform: 'node',
  format: 'esm',
  packages: 'bundle',
  plugins: [
    {
      name: 'native-test-adapters',
      setup(api) {
        api.onResolve({ filter: /^(expo\/fetch|expo-crypto)$/ }, ({ path }) => ({
          path,
          namespace: 'native-test',
        }));
        api.onResolve({ filter: /^\.\/mezair-account$/ }, () => ({
          path: 'account',
          namespace: 'native-test',
        }));
        api.onLoad({ filter: /.*/, namespace: 'native-test' }, ({ path }) => ({
          loader: 'js',
          contents:
            path === 'expo/fetch'
              ? 'export const fetch = globalThis.fetch;'
              : path === 'account'
                ? 'export const getAccountConnection = async () => null; export const listMeshMachineHosts = async () => [];'
                : `
      import { randomBytes, randomUUID, createCipheriv, createDecipheriv } from 'node:crypto';
      export { randomUUID };
      export const getRandomBytesAsync = async (count) => new Uint8Array(randomBytes(count));
      export const AESEncryptionKey = { import: async (bytes) => bytes };
      export const AESSealedData = { fromParts: (nonce, ciphertext) => ({ nonce, ciphertext }) };
      export async function aesEncryptAsync(bytes, key, options) {
        await globalThis.__meshEncryptDelay?.();
        const nonce = options.nonce.bytes; const cipher = createCipheriv('aes-256-gcm', key, nonce);
        cipher.setAAD(options.additionalData);
        const sealed = Buffer.concat([cipher.update(bytes), cipher.final(), cipher.getAuthTag()]);
        return { iv: async () => nonce, ciphertext: async () => new Uint8Array(sealed) };
      }
      export async function aesDecryptAsync(sealed, key, options) {
        // Deliberately asynchronous to exercise production receive serialization.
        await new Promise((resolve) => setTimeout(resolve, 1));
        const decipher = createDecipheriv('aes-256-gcm', key, sealed.nonce);
        decipher.setAAD(options.additionalData);
        const bytes = Buffer.from(sealed.ciphertext);
        decipher.setAuthTag(bytes.subarray(-16));
        return new Uint8Array(Buffer.concat([decipher.update(bytes.subarray(0, -16)), decipher.final()]));
      }`,
        }));
      },
    },
  ],
});
const { MeshMachineSessionConnection, isUsableMeshMachineRoute } = await import(
  `data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`
);

const contract = await build({
  entryPoints: [new URL('../../../cloud/contract/machine.ts', import.meta.url).pathname],
  bundle: true,
  write: false,
  platform: 'node',
  format: 'esm',
});
const { meshMachineFrameAssociatedData, meshMachineTrafficKeyDerivation } = await import(
  `data:text/javascript;base64,${Buffer.from(contract.outputFiles[0].text).toString('base64')}`
);
const host = {
  enrollmentId: 'host',
  machineId: 'machine',
  endpointGeneration: 'generation',
  capabilities: ['machine.session/1', 'machine.stream/1', 'machine.stream-handoff/1'],
  operations: ['read.snapshot', 'command.cancel'],
};
const route = {
  kind: 'private',
  networkKind: 'lan',
  url: 'http://192.168.1.2:47631',
  machineId: host.machineId,
  endpointGeneration: host.endpointGeneration,
  reachableUntil: '2099-01-01T00:00:00Z',
};

function peer({ replayComplete = true } = {}) {
  const token = randomBytes(32);
  const sessionId = 'session';
  const epoch = 'epoch';
  let serverSequence = 1;
  let expectedClientSequence = 1;
  const listeners = new Map();
  const commands = [];
  const derive = (direction) => {
    const { salt, info } = meshMachineTrafficKeyDerivation({
      sessionId,
      machineId: host.machineId,
      endpointGeneration: host.endpointGeneration,
      direction,
    });
    return Buffer.from(hkdfSync('sha256', token, Buffer.from(salt), Buffer.from(info), 32));
  };
  const outboundKey = derive('host-to-client');
  const inboundKey = derive('client-to-host');
  const aad = (direction, sequence, requestId) =>
    Buffer.from(
      meshMachineFrameAssociatedData({
        sessionId,
        machineId: host.machineId,
        endpointGeneration: host.endpointGeneration,
        epoch,
        direction,
        sequence,
        ...(requestId === undefined ? {} : { requestId }),
      }),
    );
  const emit = (kind, value) => {
    for (const listener of listeners.get(kind) ?? []) listener(value);
  };
  const send = (payload) => {
    const sequence = serverSequence++;
    const requestId = payload.requestId;
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', outboundKey, nonce);
    cipher.setAAD(aad('host-to-client', sequence, requestId));
    const ciphertext = Buffer.concat([
      cipher.update(JSON.stringify(payload)),
      cipher.final(),
      cipher.getAuthTag(),
    ]);
    emit('message', {
      data: JSON.stringify({
        type: 'data',
        sessionId,
        sequence,
        ...(requestId ? { requestId } : {}),
        envelope: {
          enc: 'aes-256-gcm',
          nonce: nonce.toString('base64'),
          ct: ciphertext.toString('base64'),
        },
      }),
    });
  };
  const socket = {
    addEventListener(name, listener) {
      const list = listeners.get(name) ?? [];
      list.push(listener);
      listeners.set(name, list);
    },
    close() {
      emit('close');
    },
    send(raw) {
      const frame = JSON.parse(raw);
      if (frame.type === 'auth') {
        send({
          kind: 'ready',
          sessionId,
          epoch,
          nextClientSequence: 1,
          nextSequence: 50,
          oldestSequence: 1,
          authorizationValidUntil: new Date(Date.now() + 60_000).toISOString(),
        });
        return;
      }
      assert.equal(frame.sequence, expectedClientSequence++);
      const decipher = createDecipheriv(
        'aes-256-gcm',
        inboundKey,
        Buffer.from(frame.envelope.nonce, 'base64'),
      );
      const ciphertext = Buffer.from(frame.envelope.ct, 'base64');
      decipher.setAAD(aad('client-to-host', frame.sequence, frame.requestId));
      decipher.setAuthTag(ciphertext.subarray(-16));
      const payload = JSON.parse(
        Buffer.concat([decipher.update(ciphertext.subarray(0, -16)), decipher.final()]).toString(),
      );
      commands.push(payload);
      if (payload.kind === 'subscribe') {
        send({
          kind: 'event',
          epoch,
          sequence: 49,
          workspaceId: 'workspace',
          eventKind: 'chat',
          payload: {},
        });
        send({
          kind: 'response',
          requestId: payload.requestId,
          result: { cursor: { epoch, sequence: 49 }, replayComplete },
        });
      } else send({ kind: 'response', requestId: payload.requestId, result: { ok: true } });
    },
  };
  return {
    input: {
      host,
      route,
      socket,
      sessionId,
      sessionToken: token,
      epoch,
      authorizationValidUntil: new Date(Date.now() + 60_000).toISOString(),
      cursor: { epoch, sequence: 48 },
    },
    commands,
    challenge: () =>
      emit('message', {
        data: JSON.stringify({ type: 'auth-challenge', epoch, nonce: 'test-nonce' }),
      }),
    send,
  };
}

test('wire readiness waits for replay and keeps encrypted frame sequence independent of event cursor', async () => {
  const server = peer();
  const events = [];
  const closes = [];
  const pending = MeshMachineSessionConnection.open({
    ...server.input,
    handlers: {
      onEvent: (event) => events.push(event.sequence),
      onResnapshot() {},
      onClosed: (cause) => closes.push(cause),
    },
  });
  server.challenge();
  const connection = await pending;
  try {
    assert.deepEqual(events, [49]);
    assert.equal(connection.replayComplete, true);
    assert.equal(connection.streamCursor.sequence, 49);
    server.send({
      kind: 'event',
      epoch: 'epoch',
      sequence: 70,
      workspaceId: 'workspace',
      eventKind: 'chat',
      payload: {},
    });
    assert.deepEqual(await connection.request('read.snapshot', {}), { ok: true });
    assert.deepEqual(events, [49, 70]); // Filtered event gaps are legitimate.
    assert.equal(closes.length, 0);
  } finally {
    connection.close();
  }
  assert.deepEqual(closes, ['retired']);
});

test('host advertising handoff must provide the authenticated completion barrier', async () => {
  const server = peer({ replayComplete: false });
  const pending = MeshMachineSessionConnection.open(server.input);
  server.challenge();
  await assert.rejects(pending, /machine-stream-readiness-unavailable/);
});

test('route validation rejects remote loopback and public hostnames resembling private IPv6', () => {
  for (const url of [
    'http://127.0.0.1:47631',
    'http://localhost:47631',
    'http://fd.example.com:47631',
    'http://fe80.example.com:47631',
  ]) {
    assert.equal(isUsableMeshMachineRoute(host, { ...route, url }), false, url);
  }
  assert.equal(isUsableMeshMachineRoute(host, route), true);
});

test('a timeout during async encryption does not consume an unsent frame sequence', async (context) => {
  const server = peer();
  const opening = MeshMachineSessionConnection.open(server.input);
  server.challenge();
  const connection = await opening;
  await connection.request('read.snapshot', {});
  let release;
  const encryption = new Promise((resolve) => {
    release = resolve;
  });
  globalThis.__meshEncryptDelay = () => encryption;
  context.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const request = connection.request('read.snapshot', {});
    for (let index = 0; index < 10; index++) await Promise.resolve();
    const rejected = assert.rejects(request, /machine-request-timeout/);
    context.mock.timers.tick(15_000);
    await rejected;
    delete globalThis.__meshEncryptDelay;
    release();
    context.mock.timers.reset();
    assert.deepEqual(await connection.request('read.snapshot', {}), { ok: true });
    assert.equal(connection.isOpen, true);
  } finally {
    delete globalThis.__meshEncryptDelay;
    release();
    context.mock.timers.reset();
    connection.close();
  }
});
