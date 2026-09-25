import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_LIMITS } from '../../../../cloud/contract/version';
import type { BackendDescriptor } from '../../../../cloud/contract/discovery';
import { SCHEMA_SQL } from '../../db/schema';
import {
  BackendRpcError,
  computeReconnectDelayMs,
  discover,
  negotiateLimits,
  normalizeBaseUrl,
  openSocket,
  rpc,
  toPublicDescriptor,
} from '../sync-backend-client.service';

const TEST_APP_VERSION = '0.6.27-test';
const db = new Database(':memory:');
db.exec(SCHEMA_SQL);
vi.mock('../../db/database.js', () => ({ getDb: () => db }));
vi.mock('electron', () => ({
  app: { getVersion: () => TEST_APP_VERSION },
}));

import {
  activateBackend,
  disconnectBackend,
  getBackendStatus,
  getIntegrationPrompt,
  pinBackend,
} from '../sync-backend.service';

function loadFixture<T>(name: string): T {
  const path = fileURLToPath(
    new URL(`../../../../cloud/contract/fixtures/${name}`, import.meta.url),
  );
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

const invalidDescriptor = loadFixture<unknown>('invalid-descriptor.json');
const validDescriptor = loadFixture<BackendDescriptor>('valid-descriptor.json');

function jsonStub(payload: unknown, status = 200): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(payload), {
      status,
      headers: { 'Content-Type': 'application/json' },
    })) as typeof fetch;
}

async function startFakeServer(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      ),
  };
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

class FakeSocket {
  public closedWith: { code?: number; reason?: string } | null = null;
  public sent: string[] = [];
  private listeners = new Map<string, Array<(...args: Array<unknown>) => void>>();

  on(event: string, listener: (...args: Array<unknown>) => void): void {
    const list = this.listeners.get(event) ?? [];
    list.push(listener);
    this.listeners.set(event, list);
  }

  emit(event: string, payload?: unknown): void {
    for (const listener of this.listeners.get(event) ?? []) {
      listener(payload);
    }
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(code?: number, reason?: string): void {
    this.closedWith = { code, reason };
  }
}

describe('normalizeBaseUrl', () => {
  it('adds a trailing slash and trims whitespace', () => {
    expect(normalizeBaseUrl('https://example.com/base')).toBe('https://example.com/base/');
    expect(normalizeBaseUrl('  https://example.com/base/  ')).toBe('https://example.com/base/');
  });

  it('rejects relative URLs and embedded credentials', () => {
    expect(() => normalizeBaseUrl('not-a-url')).toThrow('absolute URL');
    expect(() => normalizeBaseUrl('https://user:pass@example.com/')).toThrow('credentials');
  });

  it('rejects plain HTTP except for explicit loopback opt-in', () => {
    expect(() => normalizeBaseUrl('http://example.com/')).toThrow('https');
    expect(() => normalizeBaseUrl('http://127.0.0.1:1/')).toThrow('https');
    expect(normalizeBaseUrl('http://127.0.0.1:1/', { allowLoopbackHttp: true })).toBe(
      'http://127.0.0.1:1/',
    );
  });
});

describe('discover validation', () => {
  it('rejects the invalid descriptor fixture', async () => {
    await expect(
      discover('https://example.com/', { fetchFn: jsonStub(invalidDescriptor) }),
    ).rejects.toThrow('invalid backend descriptor');
  });

  it('strips unknown token-like keys from a valid discovery document', async () => {
    const dirty = {
      ...validDescriptor,
      accessToken: 'secret-token',
      refresh: 'secret-refresh',
    };
    const connection = await discover('https://example.com/', { fetchFn: jsonStub(dirty) });
    expect(connection.descriptor).toEqual(toPublicDescriptor(validDescriptor));
    expect(JSON.stringify(connection)).not.toMatch(/secret-token|secret-refresh/);
    expect(Object.keys(connection.descriptor)).not.toEqual(
      expect.arrayContaining(['accessToken', 'refresh']),
    );
  });

  it('rejects non-JSON discovery bodies', async () => {
    const fetchFn = (async () => new Response('not json', { status: 200 })) as typeof fetch;
    await expect(discover('https://example.com/', { fetchFn })).rejects.toThrow('not valid JSON');
  });

  it('rejects HTTP failures', async () => {
    await expect(discover('https://example.com/', { fetchFn: jsonStub({}, 404) })).rejects.toThrow(
      'HTTP 404',
    );
  });

  it('negotiates the stricter of client and server limits', () => {
    expect(negotiateLimits(validDescriptor.limits)).toEqual(DEFAULT_LIMITS);
    expect(
      negotiateLimits({ entityBytes: 1, pageBytes: 2, batchChanges: 3, liveFrameBytes: 4 }),
    ).toEqual({ entityBytes: 1, pageBytes: 2, batchChanges: 3, liveFrameBytes: 4 });
    expect(
      negotiateLimits({
        entityBytes: 1_000_000,
        pageBytes: 2,
        batchChanges: 1_000,
        liveFrameBytes: 4,
      }),
    ).toEqual({
      entityBytes: DEFAULT_LIMITS.entityBytes,
      pageBytes: 2,
      batchChanges: DEFAULT_LIMITS.batchChanges,
      liveFrameBytes: 4,
    });
  });
});

describe('discover over HTTP (127.0.0.1 fake server)', () => {
  it('resolves a valid discovery document', async () => {
    const server = await startFakeServer((req, res) => {
      if (req.url === '/.well-known/anvil-backend') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(validDescriptor));
        return;
      }
      res.writeHead(404);
      res.end();
    });
    try {
      const connection = await discover(server.baseUrl, { allowLoopbackHttp: true });
      expect(connection.baseUrl.endsWith('/')).toBe(true);
      expect(connection.apiUrl).toContain('/v1');
      expect(connection.socketUrl.startsWith('ws://')).toBe(true);
      expect(connection.descriptor.deploymentId).toBe(validDescriptor.deploymentId);
      expect(connection.limits).toEqual(DEFAULT_LIMITS);
    } finally {
      await server.close();
    }
  });

  it('rejects oversized discovery bodies', async () => {
    const server = await startFakeServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('x'.repeat(70_000));
    });
    try {
      await expect(discover(server.baseUrl, { allowLoopbackHttp: true })).rejects.toThrow(
        'exceeds',
      );
    } finally {
      await server.close();
    }
  });

  it('rejects redirects instead of following them', async () => {
    const server = await startFakeServer((req, res) => {
      if (req.url === '/.well-known/anvil-backend') {
        res.writeHead(302, { Location: '/elsewhere' });
        res.end();
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(validDescriptor));
    });
    try {
      await expect(discover(server.baseUrl, { allowLoopbackHttp: true })).rejects.toThrow();
    } finally {
      await server.close();
    }
  });

  it('posts RPC envelopes with bearer auth and parses both outcomes', async () => {
    const seenAuth: string[] = [];
    const server = await startFakeServer(async (req, res) => {
      if (req.url === '/.well-known/anvil-backend') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(validDescriptor));
        return;
      }
      if (req.url !== '/v1/rpc' || req.method !== 'POST') {
        res.writeHead(404);
        res.end();
        return;
      }
      seenAuth.push(String(req.headers['authorization'] ?? ''));
      const body = JSON.parse(await readBody(req)) as { requestId: string; operation: string };
      if (body.operation === 'session.describe') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            requestId: body.requestId,
            result: { ok: true },
            serverTime: '2026-09-11T00:00:00.000Z',
          }),
        );
        return;
      }
      res.writeHead(429, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          requestId: body.requestId,
          error: {
            code: 'throttled',
            retryable: true,
            retryAfterMs: 100,
            details: { reason: 'subscription-required' },
          },
        }),
      );
    });
    try {
      const connection = await discover(server.baseUrl, { allowLoopbackHttp: true });
      const ok = await rpc<{ ok: boolean }>(connection, 'session.describe', {}, 'device-token');
      expect(ok.result).toEqual({ ok: true });
      expect(seenAuth).toEqual(['Bearer device-token']);
      const failure = await rpc(connection, 'boom', {}, 'device-token').catch(
        (error: unknown) => error,
      );
      expect(seenAuth).toEqual(['Bearer device-token', 'Bearer device-token']);
      expect(failure).toBeInstanceOf(BackendRpcError);
      const rpcError = failure as BackendRpcError;
      expect(rpcError.code).toBe('throttled');
      expect(rpcError.retryable).toBe(true);
      expect(rpcError.retryAfterMs).toBe(100);
      // BILL-05: hosted-refusal detail survives for the runtime to classify.
      expect(rpcError.details).toEqual({ reason: 'subscription-required' });
    } finally {
      await server.close();
    }
  });
});

describe('openSocket', () => {
  it('uses the mesh subprotocol with header auth and validates frames', () => {
    const captured: Array<{
      url: string;
      protocols: string[];
      headers: Record<string, string>;
    }> = [];
    const sockets: FakeSocket[] = [];
    const socket = openSocket({ socketUrl: 'wss://example.com/base/v1/connect' }, 'device-token', {
      liveFrameBytes: 256,
      createSocket: (url, protocols, options) => {
        captured.push({ url, protocols, headers: options.headers });
        const fake = new FakeSocket();
        sockets.push(fake);
        return fake;
      },
    });
    expect(captured).toEqual([
      {
        url: 'wss://example.com/base/v1/connect',
        protocols: ['anvil.mesh.v1'],
        headers: { Authorization: 'Bearer device-token' },
      },
    ]);

    const frames: unknown[] = [];
    const protocolErrors: Error[] = [];
    socket.onFrame((frame) => frames.push(frame));
    socket.onProtocolError((error) => protocolErrors.push(error));
    const fake = sockets[0];
    if (!fake) {
      throw new Error('expected a socket');
    }
    fake.emit(
      'message',
      JSON.stringify({ type: 'hello', version: 1, id: 'a', enrollmentId: 'e', profiles: [] }),
    );
    expect(frames).toHaveLength(1);
    fake.emit('message', 'x'.repeat(300));
    expect(protocolErrors).toHaveLength(1);
    expect(fake.closedWith?.code).toBe(1008);
    fake.emit('message', JSON.stringify({ type: 'nope' }));
    expect(protocolErrors).toHaveLength(2);
  });

  it('refuses socket URLs carrying credentials', () => {
    expect(() =>
      openSocket({ socketUrl: 'wss://example.com/v1/connect?access_token=abc' }, 'token'),
    ).toThrow('credentials');
  });

  it('computes jittered reconnect delays inside the cap', () => {
    expect(computeReconnectDelayMs(0, { random: () => 0.5 })).toBe(500);
    expect(computeReconnectDelayMs(2, { random: () => 0.5 })).toBe(2000);
    expect(computeReconnectDelayMs(100, { random: () => 0.5 })).toBe(15000);
    expect(computeReconnectDelayMs(-1, { random: () => 1 })).toBeGreaterThan(0);
  });
});

describe('sync-backend.service association', () => {
  beforeEach(() => {
    db.exec('DELETE FROM sync_backends');
    vi.unstubAllEnvs();
  });

  it('pins a paused association and keeps one active row', () => {
    const first = pinBackend({ baseUrl: 'https://one.example/', descriptor: validDescriptor });
    expect(first.state).toBe('paused');
    expect(first.id).toBe(validDescriptor.deploymentId);

    const second = pinBackend({
      baseUrl: 'https://two.example/',
      descriptor: { ...validDescriptor, deploymentId: 'other-backend', displayName: 'Other' },
    });
    expect(second.state).toBe('paused');

    activateBackend(first.id);
    expect(getBackendStatus()).toMatchObject({ backendId: first.id, state: 'active' });
    activateBackend(second.id);
    expect(getBackendStatus()).toMatchObject({ backendId: second.id, state: 'active' });
    const rows = db.prepare('SELECT id, state FROM sync_backends').all() as Array<{
      id: string;
      state: string;
    }>;
    expect(rows.find((row) => row.id === first.id)?.state).toBe('paused');
  });

  it('disconnect pauses the active backend and preserves the association', () => {
    const pinned = pinBackend({ baseUrl: 'https://one.example/', descriptor: validDescriptor });
    activateBackend(pinned.id);
    disconnectBackend();
    expect(getBackendStatus()).toMatchObject({
      backendId: pinned.id,
      connectionMode: 'local',
      state: 'paused',
    });
  });

  it('reports a known Anvil-hosted association as hosted after activation', () => {
    const pinned = pinBackend({
      baseUrl: 'https://hosted.example.test/',
      descriptor: validDescriptor,
      connectionMode: 'hosted',
    });
    activateBackend(pinned.id);
    expect(getBackendStatus()).toMatchObject({
      backendId: pinned.id,
      connectionMode: 'hosted',
      state: 'active',
      baseUrl: 'https://hosted.example.test/',
    });
  });

  it('reports a local empty status with no token-like keys', () => {
    const status = getBackendStatus();
    expect(status).toEqual({
      connectionMode: 'local',
      backendId: null,
      baseUrl: null,
      deploymentId: null,
      displayName: null,
      profiles: [],
      authModes: [],
      state: null,
      identityReviewRequired: false,
      hostedBackendUrl: null,
    });
    const keys: string[] = [];
    const collect = (value: unknown): void => {
      if (Array.isArray(value)) {
        for (const item of value) {
          collect(item);
        }
        return;
      }
      if (typeof value === 'object' && value !== null) {
        for (const [key, entry] of Object.entries(value)) {
          keys.push(key);
          collect(entry);
        }
      }
    };
    collect(status);
    for (const key of keys) {
      expect(key).not.toMatch(/token|secret|refresh|password|bearer|credential/i);
    }
    expect(JSON.stringify(status)).not.toMatch(/"token"|"secret"|"refresh"|"password"/i);
  });

  it('exposes only the configured public hosted URL', () => {
    vi.stubEnv('ANVIL_HOSTED_BACKEND_URL', 'https://hosted.example.test/base');
    expect(getBackendStatus().hostedBackendUrl).toBe('https://hosted.example.test/base/');

    vi.stubEnv('ANVIL_HOSTED_BACKEND_URL', 'http://localhost:3000');
    expect(getBackendStatus().hostedBackendUrl).toBeNull();
  });

  it('selects the configured endpoint for the deployment environment', () => {
    vi.stubEnv('ANVIL_DEPLOYMENT_ENV', 'production');
    vi.stubEnv('ANVIL_STAGING_HOSTED_BACKEND_URL', 'https://staging.example.test');
    vi.stubEnv('ANVIL_PRODUCTION_HOSTED_BACKEND_URL', 'https://production.example.test');
    vi.stubEnv('ANVIL_HOSTED_BACKEND_URL', 'https://legacy.example.test');

    expect(getBackendStatus().hostedBackendUrl).toBe('https://production.example.test/');
  });

  it('fills the integration prompt with build metadata and a stand-in digest', () => {
    pinBackend({ baseUrl: 'https://one.example/', descriptor: validDescriptor });
    const prompt = getIntegrationPrompt();
    expect(prompt).toContain(TEST_APP_VERSION);
    expect(prompt).toContain('anvil-backend/1');
    expect(prompt).toContain('sync/1');
    expect(prompt).toContain('stand-in');
  });

  it('strips unknown descriptor keys before pin and never copies sync_state cursors', () => {
    db.exec(`
      INSERT INTO sync_state (
        backend_id, account_id, dataset_epoch, cursor, consumed_sequence_high_water,
        reset_required, updated_at
      ) VALUES (
        'existing-backend', 'acct', 'epoch', 'cursor-a', 0, 0, '2026-09-11T00:00:00.000Z'
      )
    `);
    const dirty = {
      ...validDescriptor,
      accessToken: 'secret-token',
      refreshToken: 'secret-refresh',
    };
    const pinned = pinBackend({ baseUrl: 'https://one.example/', descriptor: dirty });
    expect(JSON.stringify(pinned.descriptor)).not.toMatch(/secret-token|secret-refresh/);
    expect(pinned.descriptor).toEqual(toPublicDescriptor(validDescriptor));

    const other = pinBackend({
      baseUrl: 'https://two.example/',
      descriptor: { ...validDescriptor, deploymentId: 'other-backend', displayName: 'Other' },
    });
    activateBackend(pinned.id);
    activateBackend(other.id);
    const states = db.prepare('SELECT backend_id, cursor FROM sync_state').all() as Array<{
      backend_id: string;
      cursor: string;
    }>;
    expect(states).toEqual([{ backend_id: 'existing-backend', cursor: 'cursor-a' }]);
  });
});
