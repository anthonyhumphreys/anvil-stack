// BYOB-02 gate evidence: the unmodified desktop network stack —
// `discover`, `postAuthRoute`, `rpc`, and the contract's `hashChange` —
// connects to a NON-Cloudflare implementation of `sync/1` (the in-memory
// Node fixture) with zero code changes. The fixture independently
// recomputes every payload hash, so canonicalization agreement is proven
// over the wire rather than assumed.

import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { DeviceSession } from '../../../../cloud/contract/auth';
import { SCHEMA_SQL } from '../../db/schema';
import { discover, postAuthRoute, rpc } from '../sync-backend-client.service';
import { computePayloadHash } from '../sync-persistence.service';

const db = new Database(':memory:');
db.exec(SCHEMA_SQL);
vi.mock('../../db/database.js', () => ({ getDb: () => db }));

const ADMIN_TOKEN = 'byob-test-admin';
const FIXTURE_PATH = fileURLToPath(
  new URL('../../../../cloud/backend/conformance/fixture-server.mjs', import.meta.url),
);

let fixture: ChildProcess | null = null;
let fixtureBaseUrl = '';

function startFixture(): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [FIXTURE_PATH, '--port', '0', '--admin-token', ADMIN_TOKEN],
      { stdio: ['ignore', 'pipe', 'inherit'] },
    );
    fixture = child;
    const timer = setTimeout(() => reject(new Error('fixture did not report a port')), 10_000);
    child.stdout?.on('data', (chunk: Buffer) => {
      const match = /http:\/\/127\.0\.0\.1:(\d+)/.exec(String(chunk));
      if (match !== null) {
        clearTimeout(timer);
        resolve(`http://127.0.0.1:${match[1]}`);
      }
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`fixture exited early (${code})`));
    });
  });
}

beforeAll(async () => {
  fixtureBaseUrl = await startFixture();
}, 15_000);

afterAll(() => {
  fixture?.kill();
});

describe('BYOB-02: unmodified desktop client against the non-Cloudflare fixture', () => {
  it('discovers, enrolls, pushes, and pulls over the frozen wire contract', async () => {
    // Discovery: the real client negotiates against the fixture descriptor.
    const connection = await discover(fixtureBaseUrl, { allowLoopbackHttp: true });
    expect(connection.descriptor.protocols).toContain('anvil-backend/1');
    expect(connection.descriptor.profiles).toContain('sync/1');
    expect(connection.descriptor.authModes).toContain('enrollment-code');

    // Enrollment: admin issues a code, the desktop client redeems it.
    const accountId = `byob-${randomUUID()}`;
    const issued = await postAuthRoute<{ code: string }>(
      connection,
      'enrollment-codes',
      { accountId },
      { accessToken: ADMIN_TOKEN },
    );
    const session = await postAuthRoute<DeviceSession>(connection, 'enroll', {
      proof: { method: 'enrollment-code', code: issued.code },
      installationId: 'byob-desktop-install',
      displayName: 'BYOB desktop',
    });
    expect(session.accountId).toBe(accountId);
    expect(session.accessToken.startsWith('anvil_at_')).toBe(true);

    // Identity: the envelope + bearer round-trip works end to end.
    const described = await rpc<{ accountId: string; enrollmentId: string }>(
      connection,
      'session.describe',
      {},
      session.accessToken,
    );
    expect(described.result.accountId).toBe(accountId);
    expect(described.result.enrollmentId).toBe(session.enrollmentId);

    // Durable sync: the desktop's real hash computation is verified by the
    // fixture's independent canonicalization — a disagreement would reject.
    const change = {
      changeId: randomUUID(),
      enrollmentSequence: 1,
      entityType: 'workspace',
      entityId: 'byob-entity',
      schemaVersion: 1,
      baseRevision: null,
      operation: 'create' as const,
      payload: { name: 'Pushed from the desktop stack' },
      payloadHash: '',
    };
    change.payloadHash = computePayloadHash(change);
    const pushed = await rpc<{ results: Array<{ status: string; revision?: number }> }>(
      connection,
      'sync.push',
      { changes: [change] },
      session.accessToken,
    );
    expect(pushed.result.results[0]?.status).toBe('accepted');

    const pulled = await rpc<{
      changes: Array<{ entityId: string; payload?: { name: string } }>;
    }>(connection, 'sync.pull', { cursor: null, maxBytes: 65536 }, session.accessToken);
    expect(pulled.result.changes[0]?.entityId).toBe('byob-entity');
    expect(pulled.result.changes[0]?.payload?.name).toBe('Pushed from the desktop stack');

    // Device inventory + refresh rotation complete the session lifecycle.
    const devices = await rpc<{ devices: Array<{ self: boolean }> }>(
      connection,
      'device.list',
      {},
      session.accessToken,
    );
    expect(devices.result.devices.some((d) => d.self)).toBe(true);

    const rotated = await postAuthRoute<DeviceSession>(connection, 'session/refresh', {
      refreshToken: session.refreshToken,
      enrollmentId: session.enrollmentId,
    });
    expect(rotated.accessToken).not.toBe(session.accessToken);
    const stillGood = await rpc(connection, 'session.describe', {}, rotated.accessToken);
    expect(stillGood.result).toMatchObject({ accountId });
  }, 30_000);
});
