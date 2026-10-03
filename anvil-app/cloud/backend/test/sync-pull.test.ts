import { describe, expect, it } from 'vitest';

import { DEFAULT_LIMITS } from '../../contract/version';
import type { SyncPullResult, SyncPushResult } from '../../contract/sync';
import { expectSuccess, hashedChange, postRpc, spikeBearer, uniqueIds } from './helpers';

describe('sync.pull', () => {
  it('paginates by maxChanges and reports nextCursor/hasMore', async () => {
    const ids = uniqueIds('pull-page');
    const auth = spikeBearer(ids.accountId, ids.enrollmentId);
    const one = await hashedChange({
      enrollmentSequence: 1,
      entityId: 'ws-a',
      payload: { name: 'A' },
    });
    const two = await hashedChange({
      enrollmentSequence: 2,
      entityId: 'ws-b',
      payload: { name: 'B' },
    });
    const three = await hashedChange({
      enrollmentSequence: 3,
      entityId: 'ws-c',
      payload: { name: 'C' },
    });
    expectSuccess<SyncPushResult>(
      await postRpc('sync.push', { changes: [one, two, three] }, auth),
    );

    const page1 = expectSuccess<SyncPullResult>(
      await postRpc(
        'sync.pull',
        { cursor: null, maxBytes: DEFAULT_LIMITS.pageBytes, maxChanges: 2 },
        auth,
      ),
    );
    expect(page1.changes.map((change) => change.entityId)).toEqual(['ws-a', 'ws-b']);
    expect(page1.hasMore).toBe(true);
    expect(page1.nextCursor).toBe('2');
    expect(page1.changes[0]?.sequence).toBe(1);
    expect(page1.changes[1]?.sequence).toBe(2);

    const page2 = expectSuccess<SyncPullResult>(
      await postRpc(
        'sync.pull',
        { cursor: page1.nextCursor, maxBytes: DEFAULT_LIMITS.pageBytes, maxChanges: 2 },
        auth,
      ),
    );
    expect(page2.changes.map((change) => change.entityId)).toEqual(['ws-c']);
    expect(page2.hasMore).toBe(false);
    expect(page2.nextCursor).toBe('3');
  });
});
