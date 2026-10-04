import { describe, expect, it } from 'vitest';

import { DEFAULT_LIMITS } from '../../contract/version';
import { SPIKE_INITIAL_EPOCH } from '../src/schema';
import type {
  PendingChange,
  SyncPullResult,
  SyncPushResult,
  SyncScanBeginResult,
  SyncScanFinishResult,
  SyncScanPageResult,
} from '../../contract/sync';
import { expectSuccess, hashedChange, postRpc, spikeBearer, uniqueIds } from './helpers';

async function pushNamedEntities(auth: string, names: readonly string[]): Promise<void> {
  const changes: PendingChange[] = [];
  for (let index = 0; index < names.length; index += 1) {
    const name = names[index];
    changes.push(
      await hashedChange({
        enrollmentSequence: index + 1,
        entityId: name,
        payload: { name },
      }),
    );
  }
  expectSuccess<SyncPushResult>(await postRpc('sync.push', { changes }, auth));
}

describe('sync.scan', () => {
  it('begin/page/finish after pushes returns every current entity', async () => {
    const ids = uniqueIds('scan-all');
    const auth = spikeBearer(ids.accountId, ids.enrollmentId);
    await pushNamedEntities(auth, ['ws-a', 'ws-b', 'ws-c']);

    const begin = expectSuccess<SyncScanBeginResult>(await postRpc('sync.scan.begin', {}, auth));
    expect(begin.scanId.length).toBeGreaterThan(0);
    expect(begin.watermarkStart).toBe(3);
    expect(begin.epoch).toBe(SPIKE_INITIAL_EPOCH);

    const page = expectSuccess<SyncScanPageResult>(
      await postRpc(
        'sync.scan.page',
        { scanId: begin.scanId, cursor: null, maxBytes: DEFAULT_LIMITS.pageBytes },
        auth,
      ),
    );
    expect(page.done).toBe(true);
    expect(page.nextCursor).toBeNull();
    expect(page.entities).toEqual([
      {
        entityType: 'workspace',
        entityId: 'ws-a',
        revision: 1,
        operation: 'create',
        schemaVersion: 1,
        payload: { name: 'ws-a' },
      },
      {
        entityType: 'workspace',
        entityId: 'ws-b',
        revision: 1,
        operation: 'create',
        schemaVersion: 1,
        payload: { name: 'ws-b' },
      },
      {
        entityType: 'workspace',
        entityId: 'ws-c',
        revision: 1,
        operation: 'create',
        schemaVersion: 1,
        payload: { name: 'ws-c' },
      },
    ]);

    const finish = expectSuccess<SyncScanFinishResult>(
      await postRpc(
        'sync.scan.finish',
        { scanId: begin.scanId, watermarkEnd: begin.watermarkStart },
        auth,
      ),
    );
    expect(finish.scanId).toBe(begin.scanId);
    expect(finish.complete).toBe(true);
    expect(finish.nextCursor).toBe(String(begin.watermarkStart));
  });

  it('paginates snapshot entities when maxBytes is tiny', async () => {
    const ids = uniqueIds('scan-page');
    const auth = spikeBearer(ids.accountId, ids.enrollmentId);
    await pushNamedEntities(auth, ['ws-a', 'ws-b', 'ws-c']);

    const begin = expectSuccess<SyncScanBeginResult>(await postRpc('sync.scan.begin', {}, auth));

    const collected: string[] = [];
    let cursor: string | null = null;
    let done = false;
    for (let round = 0; round < 8; round += 1) {
      const response = await postRpc(
        'sync.scan.page',
        { scanId: begin.scanId, cursor, maxBytes: 1 },
        auth,
      );
      const page: SyncScanPageResult = expectSuccess(response);
      expect(page.entities.length).toBeGreaterThan(0);
      expect(page.entities.length).toBeLessThanOrEqual(1);
      collected.push(...page.entities.map((entity) => entity.entityId));
      if (page.done) {
        expect(page.nextCursor).toBeNull();
        done = true;
        break;
      }
      expect(page.nextCursor).not.toBeNull();
      cursor = page.nextCursor;
    }
    expect(done).toBe(true);
    expect(collected).toEqual(['ws-a', 'ws-b', 'ws-c']);
  });

  it('finish nextCursor pulls an empty catch-up page with hasMore false', async () => {
    const ids = uniqueIds('scan-catchup');
    const auth = spikeBearer(ids.accountId, ids.enrollmentId);
    await pushNamedEntities(auth, ['ws-a', 'ws-b']);

    const begin = expectSuccess<SyncScanBeginResult>(await postRpc('sync.scan.begin', {}, auth));
    expectSuccess<SyncScanPageResult>(
      await postRpc(
        'sync.scan.page',
        { scanId: begin.scanId, cursor: null, maxBytes: DEFAULT_LIMITS.pageBytes },
        auth,
      ),
    );
    const finish = expectSuccess<SyncScanFinishResult>(
      await postRpc(
        'sync.scan.finish',
        { scanId: begin.scanId, watermarkEnd: begin.watermarkStart },
        auth,
      ),
    );

    const pulled = expectSuccess<SyncPullResult>(
      await postRpc(
        'sync.pull',
        { cursor: finish.nextCursor, maxBytes: DEFAULT_LIMITS.pageBytes },
        auth,
      ),
    );
    expect(pulled.changes).toEqual([]);
    expect(pulled.hasMore).toBe(false);
    expect(pulled.nextCursor).toBe(finish.nextCursor);
  });

  it('returns tombstones and fences a moving scan with a replay watermark', async () => {
    const ids = uniqueIds('scan-tombstone-proof');
    const auth = spikeBearer(ids.accountId, ids.enrollmentId);
    const initialA = await hashedChange({
      enrollmentSequence: 1,
      entityId: 'ws-a',
      payload: { name: 'A1' },
    });
    const initialB = await hashedChange({
      enrollmentSequence: 2,
      entityId: 'ws-b',
      payload: { name: 'B1' },
    });
    expectSuccess<SyncPushResult>(
      await postRpc('sync.push', { changes: [initialA, initialB] }, auth),
    );
    const deletedB = await hashedChange({
      enrollmentSequence: 3,
      entityId: 'ws-b',
      operation: 'delete',
      baseRevision: 1,
    });
    expectSuccess<SyncPushResult>(await postRpc('sync.push', { changes: [deletedB] }, auth));

    const begin = expectSuccess<SyncScanBeginResult>(await postRpc('sync.scan.begin', {}, auth));
    const updatedA = await hashedChange({
      enrollmentSequence: 4,
      entityId: 'ws-a',
      operation: 'update',
      baseRevision: 1,
      payload: { name: 'A2' },
    });
    const createdC = await hashedChange({
      enrollmentSequence: 5,
      entityId: 'ws-c',
      payload: { name: 'C1' },
    });
    expectSuccess<SyncPushResult>(
      await postRpc('sync.push', { changes: [updatedA, createdC] }, auth),
    );

    const page = expectSuccess<SyncScanPageResult>(
      await postRpc(
        'sync.scan.page',
        { scanId: begin.scanId, cursor: null, maxBytes: DEFAULT_LIMITS.pageBytes },
        auth,
      ),
    );
    expect(page.entities).toContainEqual({
      entityType: 'workspace',
      entityId: 'ws-b',
      revision: 2,
      operation: 'delete',
      schemaVersion: 1,
    });
    expect(page.entities.map((entity) => entity.entityId)).toEqual(['ws-a', 'ws-b', 'ws-c']);
    expect(page.entities.find((entity) => entity.entityId === 'ws-a')).toMatchObject({
      revision: 2,
      payload: { name: 'A2' },
    });

    const finish = expectSuccess<SyncScanFinishResult>(
      await postRpc('sync.scan.finish', { scanId: begin.scanId }, auth),
    );
    expect(finish.watermarkEnd).toBe(5);
    const catchup = expectSuccess<SyncPullResult>(
      await postRpc(
        'sync.pull',
        { cursor: begin.resumeCursor, maxBytes: DEFAULT_LIMITS.pageBytes },
        auth,
      ),
    );
    expect(catchup.changes.map((change) => [change.entityId, change.operation])).toEqual([
      ['ws-a', 'update'],
      ['ws-c', 'create'],
    ]);
    expect(catchup.nextCursor).toBe(finish.nextCursor);
  });
});
