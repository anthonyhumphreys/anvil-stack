import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import { httpStatusForErrorCode, isRpcError } from '../../contract/envelope';
import { DEFAULT_LIMITS } from '../../contract/version';
import type { SyncPushResult } from '../../contract/sync';
import { AccountCoordinator } from '../src/account-coordinator';
import { expectSuccess, hashedChange, postRpc, spikeBearer, uniqueIds } from './helpers';

describe('sync.push', () => {
  it('returns the original receipt for the same enrollmentSequence and hash', async () => {
    const ids = uniqueIds('idempotent');
    const auth = spikeBearer(ids.accountId, ids.enrollmentId);
    const change = await hashedChange({
      enrollmentSequence: 1,
      entityId: 'ws-idem',
      payload: { name: 'Same' },
    });

    const first = await postRpc('sync.push', { changes: [change] }, auth);
    const firstResult = expectSuccess<SyncPushResult>(first);
    expect(firstResult.results).toHaveLength(1);
    const accepted = firstResult.results[0];
    expect(accepted.status).toBe('accepted');

    const second = await postRpc('sync.push', { changes: [change] }, auth);
    const secondResult = expectSuccess<SyncPushResult>(second);
    expect(secondResult.results).toEqual(firstResult.results);

    const stub = env.ACCOUNT.get(env.ACCOUNT.idFromName(ids.accountId));
    await runInDurableObject(stub, async (_instance: AccountCoordinator, state) => {
      const receipts = state.storage.sql
        .exec<{ n: number }>('SELECT COUNT(*) AS n FROM receipts')
        .one();
      const changes = state.storage.sql
        .exec<{ n: number }>('SELECT COUNT(*) AS n FROM changes')
        .one();
      expect(receipts.n).toBe(1);
      expect(changes.n).toBe(1);
    });
  });

  it('rejects the same sequence when the content hash changes', async () => {
    const ids = uniqueIds('changed-hash');
    const auth = spikeBearer(ids.accountId, ids.enrollmentId);
    const original = await hashedChange({
      enrollmentSequence: 1,
      entityId: 'ws-hash',
      payload: { name: 'Original' },
    });
    const first = await postRpc('sync.push', { changes: [original] }, auth);
    expectSuccess<SyncPushResult>(first);

    const mutated = await hashedChange({
      enrollmentSequence: 1,
      entityId: 'ws-hash',
      payload: { name: 'Mutated' },
    });
    mutated.changeId = original.changeId;
    const second = await postRpc('sync.push', { changes: [mutated] }, auth);
    const result = expectSuccess<SyncPushResult>(second);
    expect(result.results[0]).toEqual({
      status: 'rejected',
      changeId: original.changeId,
      reason: 'changed-content',
    });
  });

  it('returns conflict when baseRevision is stale', async () => {
    const ids = uniqueIds('stale-base');
    const auth = spikeBearer(ids.accountId, ids.enrollmentId);
    const created = await hashedChange({
      enrollmentSequence: 1,
      entityId: 'ws-stale',
      payload: { name: 'V1' },
    });
    expectSuccess<SyncPushResult>(await postRpc('sync.push', { changes: [created] }, auth));

    const stale = await hashedChange({
      enrollmentSequence: 2,
      entityId: 'ws-stale',
      operation: 'update',
      baseRevision: 0,
      payload: { name: 'V2' },
    });
    const result = expectSuccess<SyncPushResult>(
      await postRpc('sync.push', { changes: [stale] }, auth),
    );
    expect(result.results[0]).toMatchObject({
      status: 'conflict',
      changeId: stale.changeId,
      remoteRevision: 1,
      remoteContent: { name: 'V1' },
    });
  });

  it('accepts earlier items when a later item conflicts in the same batch', async () => {
    const ids = uniqueIds('mixed-batch');
    const auth = spikeBearer(ids.accountId, ids.enrollmentId);
    const keep = await hashedChange({
      enrollmentSequence: 1,
      entityId: 'ws-keep',
      payload: { name: 'Keep' },
    });
    const conflicted = await hashedChange({
      enrollmentSequence: 2,
      entityId: 'ws-missing',
      operation: 'update',
      baseRevision: 1,
      payload: { name: 'Nope' },
    });
    const result = expectSuccess<SyncPushResult>(
      await postRpc('sync.push', { changes: [keep, conflicted] }, auth),
    );
    expect(result.results[0]?.status).toBe('accepted');
    expect(result.results[1]?.status).toBe('conflict');

    const pulled = expectSuccess<{ changes: Array<{ entityId: string }> }>(
      await postRpc('sync.pull', { cursor: null, maxBytes: DEFAULT_LIMITS.pageBytes }, auth),
    );
    expect(pulled.changes.map((change) => change.entityId)).toEqual(['ws-keep']);
  });

  it('accepts none of a batch when any item is oversize', async () => {
    const ids = uniqueIds('oversize');
    const auth = spikeBearer(ids.accountId, ids.enrollmentId);
    const first = await hashedChange({
      enrollmentSequence: 1,
      entityId: 'ws-ok',
      payload: { name: 'ok' },
    });
    const huge = await hashedChange({
      enrollmentSequence: 2,
      entityId: 'ws-huge',
      payload: { blob: 'x'.repeat(DEFAULT_LIMITS.entityBytes + 1) },
    });
    const { status, body } = await postRpc('sync.push', { changes: [first, huge] }, auth);
    expect(status).toBe(httpStatusForErrorCode('payload-too-large'));
    expect(isRpcError(body)).toBe(true);
    if (isRpcError(body)) {
      expect(body.error.code).toBe('payload-too-large');
    }

    const pulled = expectSuccess<{ changes: unknown[] }>(
      await postRpc('sync.pull', { cursor: null, maxBytes: DEFAULT_LIMITS.pageBytes }, auth),
    );
    expect(pulled.changes).toEqual([]);
  });

  it('accepts none of a batch when any item is malformed', async () => {
    const ids = uniqueIds('malformed');
    const auth = spikeBearer(ids.accountId, ids.enrollmentId);
    const first = await hashedChange({
      enrollmentSequence: 1,
      entityId: 'ws-ok',
      payload: { name: 'ok' },
    });
    const { status, body } = await postRpc(
      'sync.push',
      { changes: [first, { enrollmentSequence: 2, entityId: 'ws-bad' }] },
      auth,
    );
    expect(status).toBe(httpStatusForErrorCode('malformed-request'));
    expect(isRpcError(body)).toBe(true);
    if (isRpcError(body)) {
      expect(body.error.code).toBe('malformed-request');
    }

    const pulled = expectSuccess<{ changes: unknown[] }>(
      await postRpc('sync.pull', { cursor: null, maxBytes: DEFAULT_LIMITS.pageBytes }, auth),
    );
    expect(pulled.changes).toEqual([]);
  });

  it('accepts a well-formed sealed envelope payload and journals it opaque', async () => {
    const ids = uniqueIds('sealed-ok');
    const auth = spikeBearer(ids.accountId, ids.enrollmentId);
    const envelope = {
      enc: 'aes-256-gcm',
      keyVersion: 1,
      // 12-byte nonce and ≥16-byte ciphertext||tag, base64 — the backend
      // validates shape only; it never opens the envelope.
      nonce: Buffer.alloc(12, 1).toString('base64'),
      ct: Buffer.alloc(40, 2).toString('base64'),
    };
    const change = await hashedChange({
      enrollmentSequence: 1,
      entityId: 'ws-sealed',
      payload: envelope,
    });
    const pushed = await postRpc('sync.push', { changes: [change] }, auth);
    const result = expectSuccess<SyncPushResult>(pushed);
    expect(result.results[0].status).toBe('accepted');

    const pulled = expectSuccess<{ changes: Array<{ payload: unknown }> }>(
      await postRpc('sync.pull', { cursor: null, maxBytes: DEFAULT_LIMITS.pageBytes }, auth),
    );
    expect(pulled.changes[0].payload).toEqual(envelope);
  });

  it('accepts a well-formed keyring-pairing payload as a crypto-boundary entity', async () => {
    const ids = uniqueIds('keyring-pairing');
    const auth = spikeBearer(ids.accountId, ids.enrollmentId);
    const pairing = {
      v: 1,
      enc: 'pairing-aes-256-gcm',
      nonce: Buffer.alloc(12, 3).toString('base64'),
      ct: Buffer.alloc(40, 4).toString('base64'),
    };
    const change = await hashedChange({
      enrollmentSequence: 1,
      entityType: 'keyring-pairing',
      entityId: 'pairing-nonce-1',
      payload: pairing,
    });
    const result = expectSuccess<SyncPushResult>(
      await postRpc('sync.push', { changes: [change] }, auth),
    );
    expect(result.results[0]?.status).toBe('accepted');

    const pulled = expectSuccess<{ changes: Array<{ payload: unknown }> }>(
      await postRpc('sync.pull', { cursor: null, maxBytes: DEFAULT_LIMITS.pageBytes }, auth),
    );
    expect(pulled.changes[0]?.payload).toEqual(pairing);
  });

  it('reports dedicated structural validation for malformed keyring-pairing payloads', async () => {
    const ids = uniqueIds('keyring-pairing-bad');
    const auth = spikeBearer(ids.accountId, ids.enrollmentId);
    const malformed = {
      v: 1,
      enc: 'pairing-aes-256-gcm',
      nonce: 'not-base64!!!',
      ct: Buffer.alloc(40, 4).toString('base64'),
    };
    const change = await hashedChange({
      enrollmentSequence: 1,
      entityType: 'keyring-pairing',
      entityId: 'pairing-nonce-bad',
      payload: malformed,
    });
    const { status, body } = await postRpc('sync.push', { changes: [change] }, auth);
    expect(status).toBe(httpStatusForErrorCode('malformed-request'));
    expect(isRpcError(body)).toBe(true);
    if (isRpcError(body)) {
      expect(body.error.details?.['reason']).toBe('crypto-boundary-invalid');
      expect(body.error.details?.['issue']).toBe('keyring-pairing-nonce');
      expect(body.error.details?.['entityType']).toBe('keyring-pairing');
    }
  });

  it('rejects a malformed sealed envelope without journaling anything', async () => {
    const ids = uniqueIds('sealed-bad');
    const auth = spikeBearer(ids.accountId, ids.enrollmentId);
    const malformed = {
      enc: 'aes-256-gcm',
      keyVersion: 1,
      nonce: 'not-base64!!!',
      ct: Buffer.alloc(40, 2).toString('base64'),
    };
    const change = await hashedChange({
      enrollmentSequence: 1,
      entityId: 'ws-sealed-bad',
      payload: malformed,
    });
    const { status, body } = await postRpc('sync.push', { changes: [change] }, auth);
    expect(status).toBe(httpStatusForErrorCode('malformed-request'));
    expect(isRpcError(body)).toBe(true);
    if (isRpcError(body)) {
      expect(body.error.details?.['reason']).toBe('envelope-invalid');
    }

    const pulled = expectSuccess<{ changes: unknown[] }>(
      await postRpc('sync.pull', { cursor: null, maxBytes: DEFAULT_LIMITS.pageBytes }, auth),
    );
    expect(pulled.changes).toEqual([]);
  });
});
