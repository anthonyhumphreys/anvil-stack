import { describe, expect, it } from 'vitest';

import type {
  DataExportBeginResult,
  DataExportPageResult,
  DataImportCommitResult,
  DataImportPreviewResult,
  DataOperationStatusResult,
  ExportedEntity,
} from '../../contract/data';
import { httpStatusForErrorCode } from '../../contract/envelope';
import type { SyncPullResult, SyncPushResult } from '../../contract/sync';
import { expectSuccess, hashedChange, postRpc, spikeBearer, uniqueIds } from './helpers';

async function pushEntity(
  auth: string,
  entityId: string,
  payload: unknown,
  sequence: number,
  entityType = 'workspace',
): Promise<void> {
  const change = await hashedChange({ enrollmentSequence: sequence, entityId, entityType, payload });
  const res = await postRpc('sync.push', { changes: [change] }, auth);
  const result = expectSuccess<SyncPushResult>(res);
  expect(result.results[0]?.status).toBe('accepted');
}

async function exportAll(auth: string): Promise<ExportedEntity[]> {
  const begin = expectSuccess<DataExportBeginResult>(
    await postRpc('data.export.begin', {}, auth),
  );
  const entities: ExportedEntity[] = [];
  let cursor: string | null = null;
  for (;;) {
    const page: DataExportPageResult = expectSuccess<DataExportPageResult>(
      await postRpc('data.export.page', { operationId: begin.operationId, cursor }, auth),
    );
    entities.push(...page.entities);
    if (page.done) break;
    cursor = page.nextCursor;
    expect(cursor).not.toBeNull();
  }
  return entities;
}

describe('data.export.*', () => {
  it('exports live entities paged by cursor and skips tombstones', async () => {
    const ids = uniqueIds('export');
    const auth = spikeBearer(ids.accountId, ids.enrollmentId);
    await pushEntity(auth, 'ws-a', { name: 'Alpha' }, 1);
    await pushEntity(auth, 'ws-b', { name: 'Beta' }, 2);
    // A delete tombstone must not appear in the export.
    const del = await hashedChange({
      enrollmentSequence: 3,
      entityId: 'ws-dead',
      operation: 'create',
      payload: { name: 'Dead' },
    });
    expectSuccess<SyncPushResult>(await postRpc('sync.push', { changes: [del] }, auth));
    const delTomb = await hashedChange({
      enrollmentSequence: 4,
      entityId: 'ws-dead',
      operation: 'delete',
      baseRevision: 1,
    });
    expectSuccess<SyncPushResult>(await postRpc('sync.push', { changes: [delTomb] }, auth));

    const begin = expectSuccess<DataExportBeginResult>(
      await postRpc('data.export.begin', {}, auth),
    );
    expect(begin.operationId.startsWith('exp_')).toBe(true);
    expect(begin.epoch).toBe('spike-epoch-1');

    // Byte-bound the page so a single entity can't fit with another.
    const first = expectSuccess<DataExportPageResult>(
      await postRpc(
        'data.export.page',
        { operationId: begin.operationId, cursor: null, maxBytes: 1 },
        auth,
      ),
    );
    expect(first.formatVersion).toBe(1);
    expect(first.entities).toHaveLength(1); // one entity always exceeds maxBytes=1 after the first
    expect(first.done).toBe(false);
    expect(first.nextCursor).not.toBeNull();

    const rest: ExportedEntity[] = [];
    let cursor = first.nextCursor;
    let done = false;
    for (let i = 0; i < 10 && !done; i += 1) {
      const page = expectSuccess<DataExportPageResult>(
        await postRpc(
          'data.export.page',
          { operationId: begin.operationId, cursor, maxBytes: 1 },
          auth,
        ),
      );
      rest.push(...page.entities);
      cursor = page.nextCursor;
      done = page.done;
    }
    const all = [...first.entities, ...rest];
    expect(done).toBe(true);
    expect(all.map((e) => e.entityId).sort()).toEqual(['ws-a', 'ws-b']);
    expect(all.find((e) => e.entityId === 'ws-a')?.payload).toEqual({ name: 'Alpha' });

    // Status reports the finished export.
    const status = expectSuccess<DataOperationStatusResult>(
      await postRpc('data.operationStatus', { operationId: begin.operationId }, auth),
    );
    expect(status.kind).toBe('export');
    expect(status.state).toBe('done');
    expect(typeof status.finishedAt).toBe('string');
  });
});

describe('data.import.*', () => {
  it('previews creates against an empty account and commits them', async () => {
    const source = uniqueIds('import-src');
    const target = uniqueIds('import-dst');
    const srcAuth = spikeBearer(source.accountId, source.enrollmentId);
    const dstAuth = spikeBearer(target.accountId, target.enrollmentId);
    await pushEntity(srcAuth, 'ws-move', { name: 'Moved', nested: { a: 1 } }, 1);
    const doc = await exportAll(srcAuth);
    expect(doc).toHaveLength(1);

    const preview = expectSuccess<DataImportPreviewResult>(
      await postRpc(
        'data.import.preview',
        { formatVersion: 1, entities: doc },
        dstAuth,
      ),
    );
    expect(preview.summary).toEqual({ creates: 1, identical: 0, conflicts: 0, invalid: 0 });
    expect(preview.entries[0]?.outcome).toBe('create');

    const status = expectSuccess<DataOperationStatusResult>(
      await postRpc('data.operationStatus', { operationId: preview.operationId }, dstAuth),
    );
    expect(status.kind).toBe('import');
    expect(status.state).toBe('previewed');

    const commit = expectSuccess<DataImportCommitResult>(
      await postRpc('data.import.commit', { operationId: preview.operationId }, dstAuth),
    );
    expect(commit).toMatchObject({ applied: 1, conflicts: 0, skipped: 0 });

    // The entity landed as a real synced change — pull sees it.
    const pull = expectSuccess<SyncPullResult>(
      await postRpc('sync.pull', { cursor: null, maxBytes: 65536 }, dstAuth),
    );
    expect(pull.changes).toHaveLength(1);
    expect(pull.changes[0]?.entityId).toBe('ws-move');
    expect(pull.changes[0]?.payload).toEqual({ name: 'Moved', nested: { a: 1 } });
    expect(pull.changes[0]?.revision).toBe(1);

    const committed = expectSuccess<DataOperationStatusResult>(
      await postRpc('data.operationStatus', { operationId: preview.operationId }, dstAuth),
    );
    expect(committed.state).toBe('committed');
  });

  it('preserves conflicts and skips identical entities at commit', async () => {
    const ids = uniqueIds('import-conflict');
    const auth = spikeBearer(ids.accountId, ids.enrollmentId);
    await pushEntity(auth, 'ws-same', { name: 'Same' }, 1);
    await pushEntity(auth, 'ws-diverged', { name: 'Local wins' }, 2);

    const doc: ExportedEntity[] = [
      { entityType: 'workspace', entityId: 'ws-same', revision: 1, schemaVersion: 1, payload: { name: 'Same' } },
      { entityType: 'workspace', entityId: 'ws-diverged', revision: 3, schemaVersion: 1, payload: { name: 'Incoming' } },
      { entityType: 'workspace', entityId: 'ws-new', revision: 1, schemaVersion: 1, payload: { name: 'New' } },
      // Missing entityId → invalid, skipped at commit.
      { entityType: 'workspace', entityId: '', revision: 1, schemaVersion: 1, payload: {} } as ExportedEntity,
    ];
    const preview = expectSuccess<DataImportPreviewResult>(
      await postRpc('data.import.preview', { formatVersion: 1, entities: doc }, auth),
    );
    expect(preview.summary).toEqual({ creates: 1, identical: 1, conflicts: 1, invalid: 1 });
    expect(preview.entries.find((e) => e.entityId === 'ws-diverged')?.reason).toBe(
      'exists-different-content',
    );

    const commit = expectSuccess<DataImportCommitResult>(
      await postRpc('data.import.commit', { operationId: preview.operationId }, auth),
    );
    expect(commit).toMatchObject({ applied: 1, conflicts: 1, skipped: 2 });

    // The local entity was never overwritten.
    const exported = await exportAll(auth);
    expect(exported.find((e) => e.entityId === 'ws-diverged')?.payload).toEqual({
      name: 'Local wins',
    });
    expect(exported.find((e) => e.entityId === 'ws-new')?.payload).toEqual({ name: 'New' });
    expect(exported).toHaveLength(3);
  });

  it('commit is idempotent — a retry returns the stored result without re-applying', async () => {
    const ids = uniqueIds('import-idem');
    const auth = spikeBearer(ids.accountId, ids.enrollmentId);
    const doc: ExportedEntity[] = [
      { entityType: 'workspace', entityId: 'ws-once', revision: 1, schemaVersion: 1, payload: { v: 1 } },
    ];
    const preview = expectSuccess<DataImportPreviewResult>(
      await postRpc('data.import.preview', { formatVersion: 1, entities: doc }, auth),
    );
    const first = expectSuccess<DataImportCommitResult>(
      await postRpc('data.import.commit', { operationId: preview.operationId }, auth),
    );
    const second = expectSuccess<DataImportCommitResult>(
      await postRpc('data.import.commit', { operationId: preview.operationId }, auth),
    );
    expect(second).toEqual(first);

    const pull = expectSuccess<SyncPullResult>(
      await postRpc('sync.pull', { cursor: null, maxBytes: 65536 }, auth),
    );
    expect(pull.changes.filter((c) => c.entityId === 'ws-once')).toHaveLength(1);
  });

  it('rejects a commit for an unknown or export-kind operation', async () => {
    const ids = uniqueIds('import-bad');
    const auth = spikeBearer(ids.accountId, ids.enrollmentId);
    const missing = await postRpc('data.import.commit', { operationId: 'imp_nope' }, auth);
    expect(missing.status).toBe(httpStatusForErrorCode('not-found'));

    const begin = expectSuccess<DataExportBeginResult>(
      await postRpc('data.export.begin', {}, auth),
    );
    const wrongKind = await postRpc(
      'data.import.commit',
      { operationId: begin.operationId },
      auth,
    );
    expect(wrongKind.status).toBe(httpStatusForErrorCode('malformed-request'));

    const badVersion = await postRpc(
      'data.import.preview',
      { formatVersion: 99, entities: [] },
      auth,
    );
    expect(badVersion.status).toBe(httpStatusForErrorCode('malformed-request'));
  });
});
