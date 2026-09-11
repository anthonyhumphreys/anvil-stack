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

async function pushNamedEntities(
  auth: string,
  names: readonly string[],
): Promise<void> {
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

    const begin = expectSuccess<SyncScanBeginResult>(
      await postRpc('sync.scan.begin', {}, auth),
    );
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
        schemaVersion: 1,
        payload: { name: 'ws-a' },
      },
      {
        entityType: 'workspace',
        entityId: 'ws-b',
        revision: 1,
        schemaVersion: 1,
        payload: { name: 'ws-b' },
      },
      {
        entityType: 'workspace',
        entityId: 'ws-c',
        revision: 1,
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

    const begin = expectSuccess<SyncScanBeginResult>(
      await postRpc('sync.scan.begin', {}, auth),
    );

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

    const begin = expectSuccess<SyncScanBeginResult>(
      await postRpc('sync.scan.begin', {}, auth),
    );
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
});
