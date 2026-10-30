import { env } from 'cloudflare:workers';
import { evictDurableObject, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import { DEFAULT_LIMITS } from '../../contract/version';
import type { SyncPullResult, SyncPushResult } from '../../contract/sync';
import { AccountCoordinator } from '../src/account-coordinator';
import { expectSuccess, hashedChange, postRpc, spikeBearer, uniqueIds } from './helpers';

describe('eviction', () => {
  it('reconstructs SQL state after evictDurableObject', async () => {
    const ids = uniqueIds('evict');
    const auth = spikeBearer(ids.accountId, ids.enrollmentId);
    const change = await hashedChange({
      enrollmentSequence: 1,
      entityId: 'ws-evict',
      payload: { name: 'Durable' },
    });
    const pushed = expectSuccess<SyncPushResult>(
      await postRpc('sync.push', { changes: [change] }, auth),
    );
    expect(pushed.results[0]?.status).toBe('accepted');

    const id = env.ACCOUNT.idFromName(ids.accountId);
    const stub = env.ACCOUNT.get(id);
    await runInDurableObject(stub, async (_instance: AccountCoordinator, state) => {
      const entities = state.storage.sql
        .exec<{ n: number }>('SELECT COUNT(*) AS n FROM entities')
        .one();
      expect(entities.n).toBe(1);
    });

    await evictDurableObject(stub);

    const pulled = expectSuccess<SyncPullResult>(
      await postRpc('sync.pull', { cursor: null, maxBytes: DEFAULT_LIMITS.pageBytes }, auth),
    );
    expect(pulled.changes).toHaveLength(1);
    expect(pulled.changes[0]?.entityId).toBe('ws-evict');
    expect(pulled.changes[0]?.payload).toEqual({ name: 'Durable' });

    const replay = expectSuccess<SyncPushResult>(
      await postRpc('sync.push', { changes: [change] }, auth),
    );
    expect(replay.results).toEqual(pushed.results);

    const stubAfter = env.ACCOUNT.get(id);
    await runInDurableObject(stubAfter, async (_instance: AccountCoordinator, state) => {
      const receipts = state.storage.sql
        .exec<{ n: number }>('SELECT COUNT(*) AS n FROM receipts')
        .one();
      const changes = state.storage.sql
        .exec<{ n: number }>('SELECT COUNT(*) AS n FROM changes')
        .one();
      const entities = state.storage.sql
        .exec<{ n: number }>('SELECT COUNT(*) AS n FROM entities')
        .one();
      expect(receipts.n).toBe(1);
      expect(changes.n).toBe(1);
      expect(entities.n).toBe(1);
    });
  });
});
