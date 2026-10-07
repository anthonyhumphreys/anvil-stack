import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { httpStatusForErrorCode } from '../../contract/envelope';
import {
  canonicalSyncSnapshotManifestHashInput,
  SYNC_SNAPSHOT_SCHEMA_VERSION,
  type SyncCursor,
  type SyncPushResult,
  type SyncScanBeginResult,
  type SyncScanFinishResult,
  type SyncScanPageResult,
  type SyncSnapshotBeginParams,
  type SyncSnapshotBeginResult,
  type SyncSnapshotChunkGetResult,
  type SyncSnapshotCommitResult,
  type SyncSnapshotGetResult,
  type SyncSnapshotVerifyResult,
} from '../../contract/sync';
import { sha256Hex } from '../src/hash';
import { SYNC_SNAPSHOT_MAX_KEY_VERSION } from '../src/compact-sync';
import { AccountCoordinator } from '../src/account-coordinator';
import { expectSuccess, hashedChange, postRpc, spikeBearer, uniqueIds } from './helpers';

interface PreparedPublication {
  params: SyncSnapshotBeginParams;
  bytesBase64: string;
}

async function digestBytes(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function preparePublication(input: {
  publicationId: string;
  scanId: string;
  expectedGeneration: number;
  datasetEpoch: string;
  committedCursor: number;
  keyVersion?: number;
  text: string;
}): Promise<PreparedPublication> {
  const bytes = new TextEncoder().encode(input.text);
  const bytesBase64 = btoa(String.fromCharCode(...bytes));
  const fields: Omit<SyncSnapshotBeginParams, 'publicationId' | 'manifestSha256'> = {
    scanId: input.scanId,
    expectedGeneration: input.expectedGeneration,
    datasetEpoch: input.datasetEpoch,
    keyVersion: input.keyVersion ?? 1,
    schemaVersion: SYNC_SNAPSHOT_SCHEMA_VERSION,
    committedCursor: String(input.committedCursor) as SyncCursor,
    entityCount: 1,
    tombstoneCount: 0,
    chunks: [{ index: 0, byteLength: bytes.byteLength, sha256: await digestBytes(bytes) }],
  };
  return {
    params: {
      publicationId: input.publicationId,
      ...fields,
      manifestSha256: await sha256Hex(canonicalSyncSnapshotManifestHashInput(fields)),
    },
    bytesBase64,
  };
}

function accountStub(accountId: string) {
  return env.ACCOUNT.get(env.ACCOUNT.idFromName(accountId));
}

async function completeScan(auth: string): Promise<{
  begin: SyncScanBeginResult;
  finish: SyncScanFinishResult;
}> {
  const begin = expectSuccess<SyncScanBeginResult>(await postRpc('sync.scan.begin', {}, auth));
  const page = expectSuccess<SyncScanPageResult>(
    await postRpc(
      'sync.scan.page',
      { scanId: begin.scanId, cursor: null, maxBytes: 262_144 },
      auth,
    ),
  );
  expect(page.done).toBe(true);
  const finish = expectSuccess<SyncScanFinishResult>(
    await postRpc('sync.scan.finish', { scanId: begin.scanId }, auth),
  );
  return { begin, finish };
}

async function uploadAndVerify(auth: string, publication: PreparedPublication): Promise<void> {
  expectSuccess<SyncSnapshotBeginResult>(
    await postRpc('sync.snapshot.begin', publication.params, auth),
  );
  expectSuccess(
    await postRpc(
      'sync.snapshot.chunk.put',
      {
        publicationId: publication.params.publicationId,
        index: 0,
        bytesBase64: publication.bytesBase64,
      },
      auth,
    ),
  );
  expectSuccess<SyncSnapshotVerifyResult>(
    await postRpc(
      'sync.snapshot.verify',
      {
        publicationId: publication.params.publicationId,
        manifestSha256: publication.params.manifestSha256,
      },
      auth,
    ),
  );
}

describe('sync compact snapshots', () => {
  afterEach(() => vi.restoreAllMocks());

  it('requires completed scan proof, verifies staged readback, and fences competing publication', async () => {
    const ids = uniqueIds('snapshot-publish');
    const publisher = spikeBearer(ids.accountId, ids.enrollmentId);
    const secondDevice = spikeBearer(ids.accountId, `${ids.enrollmentId}-second`);
    const original = await hashedChange({
      enrollmentSequence: 1,
      entityId: 'workspace-1',
      payload: { name: 'Before', keyVersion: 1 },
    });
    expectSuccess<SyncPushResult>(await postRpc('sync.push', { changes: [original] }, publisher));

    const firstScan = await completeScan(publisher);
    const concurrentEdit = await hashedChange({
      enrollmentSequence: 2,
      entityId: 'workspace-1',
      operation: 'update',
      baseRevision: 1,
      payload: { name: 'After', keyVersion: 1 },
    });
    expectSuccess<SyncPushResult>(
      await postRpc('sync.push', { changes: [concurrentEdit] }, publisher),
    );
    const first = await preparePublication({
      publicationId: crypto.randomUUID(),
      scanId: firstScan.begin.scanId,
      expectedGeneration: 0,
      datasetEpoch: firstScan.begin.epoch,
      committedCursor: firstScan.finish.watermarkEnd,
      text: 'opaque encrypted snapshot bytes at cursor one',
    });
    await uploadAndVerify(publisher, first);

    const pendingChunk = await postRpc(
      'sync.snapshot.chunk.get',
      { snapshotId: first.params.publicationId, index: 0 },
      secondDevice,
    );
    expect(pendingChunk.status).toBe(404);
    const publisherReadback = expectSuccess<SyncSnapshotChunkGetResult>(
      await postRpc(
        'sync.snapshot.chunk.get',
        { snapshotId: first.params.publicationId, index: 0 },
        publisher,
      ),
    );
    expect(publisherReadback.bytesBase64).toBe(first.bytesBase64);
    expect(publisherReadback.sha256).toBe(first.params.chunks[0]?.sha256);

    const firstCommit = expectSuccess<SyncSnapshotCommitResult>(
      await postRpc(
        'sync.snapshot.commit',
        { publicationId: first.params.publicationId },
        publisher,
      ),
    );
    expect(firstCommit.manifest.committedCursor).toBe(String(firstScan.finish.watermarkEnd));
    const postSnapshot = expectSuccess<{ changes: Array<{ entityId: string; sequence: number }> }>(
      await postRpc(
        'sync.pull',
        { cursor: firstCommit.manifest.committedCursor, maxBytes: 262_144 },
        publisher,
      ),
    );
    expect(postSnapshot.changes).toEqual([
      expect.objectContaining({ entityId: 'workspace-1', sequence: 2 }),
    ]);

    const secondScan = await completeScan(publisher);
    const competingA = await preparePublication({
      publicationId: crypto.randomUUID(),
      scanId: secondScan.begin.scanId,
      expectedGeneration: 1,
      datasetEpoch: secondScan.begin.epoch,
      committedCursor: secondScan.finish.watermarkEnd,
      text: 'next state A',
    });
    const competingB = await preparePublication({
      publicationId: crypto.randomUUID(),
      scanId: secondScan.begin.scanId,
      expectedGeneration: 1,
      datasetEpoch: secondScan.begin.epoch,
      committedCursor: secondScan.finish.watermarkEnd,
      text: 'next state B',
    });
    await uploadAndVerify(publisher, competingA);
    await uploadAndVerify(publisher, competingB);
    expectSuccess<SyncSnapshotCommitResult>(
      await postRpc(
        'sync.snapshot.commit',
        { publicationId: competingA.params.publicationId },
        publisher,
      ),
    );
    const staleCommit = await postRpc(
      'sync.snapshot.commit',
      { publicationId: competingB.params.publicationId },
      publisher,
    );
    expect(staleCommit.status).toBe(409);

    const visibleToAccountDevice = expectSuccess<SyncSnapshotGetResult>(
      await postRpc('sync.snapshot.get', {}, secondDevice),
    );
    expect(visibleToAccountDevice.manifest?.generation).toBe(2);
    expect(visibleToAccountDevice.previousManifest?.generation).toBe(1);
    const publishedChunk = expectSuccess<SyncSnapshotChunkGetResult>(
      await postRpc(
        'sync.snapshot.chunk.get',
        { snapshotId: first.params.publicationId, index: 0 },
        secondDevice,
      ),
    );
    expect(publishedChunk.bytesBase64).toBe(first.bytesBase64);
  });

  it('fences a verified publication when the dataset encryption key rotates', async () => {
    const ids = uniqueIds('snapshot-key-rotation');
    const publisher = spikeBearer(ids.accountId, ids.enrollmentId);
    const firstChange = await hashedChange({
      enrollmentSequence: 1,
      entityId: 'workspace-key',
      payload: { name: 'V1', keyVersion: 1 },
    });
    expectSuccess<SyncPushResult>(
      await postRpc('sync.push', { changes: [firstChange] }, publisher),
    );
    const scan = await completeScan(publisher);
    const publication = await preparePublication({
      publicationId: crypto.randomUUID(),
      scanId: scan.begin.scanId,
      expectedGeneration: 0,
      datasetEpoch: scan.begin.epoch,
      committedCursor: scan.finish.watermarkEnd,
      text: 'snapshot sealed under key version one',
    });
    await uploadAndVerify(publisher, publication);

    const rotated = await hashedChange({
      enrollmentSequence: 2,
      entityId: 'workspace-key',
      operation: 'update',
      baseRevision: 1,
      payload: { name: 'V2', keyVersion: 2 },
    });
    expectSuccess<SyncPushResult>(await postRpc('sync.push', { changes: [rotated] }, publisher));
    const staleCommit = await postRpc(
      'sync.snapshot.commit',
      { publicationId: publication.params.publicationId },
      publisher,
    );
    expect(staleCommit.status).toBe(409);
    const state = expectSuccess<SyncSnapshotGetResult>(
      await postRpc('sync.snapshot.get', {}, publisher),
    );
    expect(state.keyVersion).toBe(2);
    expect(state.manifest).toBeNull();
  });

  it('bounds observed and snapshot key versions to the supported signed 32-bit range', async () => {
    const ids = uniqueIds('snapshot-key-version-bound');
    const publisher = spikeBearer(ids.accountId, ids.enrollmentId);
    const invalid = await hashedChange({
      enrollmentSequence: 1,
      entityId: 'workspace-invalid-key-version',
      payload: { name: 'ignored version', keyVersion: SYNC_SNAPSHOT_MAX_KEY_VERSION + 1 },
    });
    expectSuccess<SyncPushResult>(await postRpc('sync.push', { changes: [invalid] }, publisher));
    let state = expectSuccess<SyncSnapshotGetResult>(
      await postRpc('sync.snapshot.get', {}, publisher),
    );
    expect(state.keyVersion).toBe(0);

    const maximum = await hashedChange({
      enrollmentSequence: 2,
      entityId: 'workspace-maximum-key-version',
      payload: { name: 'maximum version', keyVersion: SYNC_SNAPSHOT_MAX_KEY_VERSION },
    });
    expectSuccess<SyncPushResult>(await postRpc('sync.push', { changes: [maximum] }, publisher));
    state = expectSuccess<SyncSnapshotGetResult>(await postRpc('sync.snapshot.get', {}, publisher));
    expect(state.keyVersion).toBe(SYNC_SNAPSHOT_MAX_KEY_VERSION);

    const scan = await completeScan(publisher);
    const publication = await preparePublication({
      publicationId: crypto.randomUUID(),
      scanId: scan.begin.scanId,
      expectedGeneration: 0,
      datasetEpoch: scan.begin.epoch,
      committedCursor: scan.finish.watermarkEnd,
      keyVersion: SYNC_SNAPSHOT_MAX_KEY_VERSION + 1,
      text: 'invalid key version must not begin',
    });
    const invalidBegin = await postRpc('sync.snapshot.begin', publication.params, publisher);
    expect(invalidBegin.status).toBe(httpStatusForErrorCode('malformed-request'));
    expect(invalidBegin.body).toMatchObject({ error: { code: 'malformed-request' } });
  });

  it('retries expired uncommitted chunk cleanup without pruning verified snapshots or live uploads', async () => {
    const ids = uniqueIds('snapshot-expired-upload');
    const publisher = spikeBearer(ids.accountId, ids.enrollmentId);
    const change = await hashedChange({
      enrollmentSequence: 1,
      entityId: 'workspace-expiry',
      payload: { name: 'Snapshot cleanup', keyVersion: 1 },
    });
    expectSuccess<SyncPushResult>(await postRpc('sync.push', { changes: [change] }, publisher));

    const firstScan = await completeScan(publisher);
    const first = await preparePublication({
      publicationId: crypto.randomUUID(),
      scanId: firstScan.begin.scanId,
      expectedGeneration: 0,
      datasetEpoch: firstScan.begin.epoch,
      committedCursor: firstScan.finish.watermarkEnd,
      text: 'prior verified snapshot remains retained',
    });
    await uploadAndVerify(publisher, first);
    expectSuccess<SyncSnapshotCommitResult>(
      await postRpc(
        'sync.snapshot.commit',
        { publicationId: first.params.publicationId },
        publisher,
      ),
    );

    const secondScan = await completeScan(publisher);
    const second = await preparePublication({
      publicationId: crypto.randomUUID(),
      scanId: secondScan.begin.scanId,
      expectedGeneration: 1,
      datasetEpoch: secondScan.begin.epoch,
      committedCursor: secondScan.finish.watermarkEnd,
      text: 'active verified snapshot remains active',
    });
    await uploadAndVerify(publisher, second);
    expectSuccess<SyncSnapshotCommitResult>(
      await postRpc(
        'sync.snapshot.commit',
        { publicationId: second.params.publicationId },
        publisher,
      ),
    );

    const openScan = await completeScan(publisher);
    const liveUpload = await preparePublication({
      publicationId: crypto.randomUUID(),
      scanId: openScan.begin.scanId,
      expectedGeneration: 2,
      datasetEpoch: openScan.begin.epoch,
      committedCursor: openScan.finish.watermarkEnd,
      text: 'valid open upload',
    });
    expectSuccess<SyncSnapshotBeginResult>(
      await postRpc('sync.snapshot.begin', liveUpload.params, publisher),
    );
    expectSuccess(
      await postRpc(
        'sync.snapshot.chunk.put',
        {
          publicationId: liveUpload.params.publicationId,
          index: 0,
          bytesBase64: liveUpload.bytesBase64,
        },
        publisher,
      ),
    );
    const abandoned = await preparePublication({
      publicationId: crypto.randomUUID(),
      scanId: openScan.begin.scanId,
      expectedGeneration: 2,
      datasetEpoch: openScan.begin.epoch,
      committedCursor: openScan.finish.watermarkEnd,
      text: 'expired uncommitted upload',
    });
    expectSuccess<SyncSnapshotBeginResult>(
      await postRpc('sync.snapshot.begin', abandoned.params, publisher),
    );
    expectSuccess(
      await postRpc(
        'sync.snapshot.chunk.put',
        {
          publicationId: abandoned.params.publicationId,
          index: 0,
          bytesBase64: abandoned.bytesBase64,
        },
        publisher,
      ),
    );

    const abandonedKey = `sync-snapshots/${ids.accountId}/${abandoned.params.publicationId}/0-${abandoned.params.chunks[0]?.sha256}`;
    const liveKey = `sync-snapshots/${ids.accountId}/${liveUpload.params.publicationId}/0-${liveUpload.params.chunks[0]?.sha256}`;
    const firstKey = `sync-snapshots/${ids.accountId}/${first.params.publicationId}/0-${first.params.chunks[0]?.sha256}`;
    const secondKey = `sync-snapshots/${ids.accountId}/${second.params.publicationId}/0-${second.params.chunks[0]?.sha256}`;
    expect(await env.ARTIFACTS.head(abandonedKey)).not.toBeNull();
    expect(await env.ARTIFACTS.head(liveKey)).not.toBeNull();
    await runInDurableObject(accountStub(ids.accountId), (_instance: AccountCoordinator, state) => {
      state.storage.sql.exec(
        `UPDATE sync_snapshot_publications SET upload_expires_at = ? WHERE publication_id = ?`,
        Date.now() - 1,
        abandoned.params.publicationId,
      );
    });

    const originalDelete = env.ARTIFACTS.delete.bind(env.ARTIFACTS);
    let failFirstAttempt = true;
    vi.spyOn(env.ARTIFACTS, 'delete').mockImplementation(async (key) => {
      if (key === abandonedKey && failFirstAttempt) {
        failFirstAttempt = false;
        throw new Error('transient R2 timeout');
      }
      await originalDelete(key);
    });

    await runInDurableObject(accountStub(ids.accountId), async (instance: AccountCoordinator) => {
      await instance.alarm();
    });
    await runInDurableObject(accountStub(ids.accountId), (_instance: AccountCoordinator, state) => {
      expect(
        state.storage.sql
          .exec<{
            state: string;
          }>(
            'SELECT state FROM sync_snapshot_publications WHERE publication_id = ?',
            abandoned.params.publicationId,
          )
          .one().state,
      ).toBe('expired');
      expect(
        state.storage.sql
          .exec<{
            state: string;
          }>(
            'SELECT state FROM sync_snapshot_chunks WHERE publication_id = ?',
            abandoned.params.publicationId,
          )
          .one().state,
      ).toBe('deleting');
      expect(
        state.storage.sql
          .exec<{
            state: string;
          }>(
            'SELECT state FROM sync_snapshot_publications WHERE publication_id = ?',
            liveUpload.params.publicationId,
          )
          .one().state,
      ).toBe('uploading');
    });
    expect(await env.ARTIFACTS.head(abandonedKey)).not.toBeNull();

    await runInDurableObject(accountStub(ids.accountId), async (instance: AccountCoordinator) => {
      await instance.alarm();
    });
    await runInDurableObject(accountStub(ids.accountId), (_instance: AccountCoordinator, state) => {
      expect(
        state.storage.sql
          .exec<{
            n: number;
          }>(
            'SELECT COUNT(*) AS n FROM sync_snapshot_chunks WHERE publication_id = ?',
            abandoned.params.publicationId,
          )
          .one().n,
      ).toBe(0);
      expect(
        state.storage.sql
          .exec<{
            n: number;
          }>(
            'SELECT COUNT(*) AS n FROM sync_snapshot_publications WHERE publication_id = ?',
            abandoned.params.publicationId,
          )
          .one().n,
      ).toBe(0);
      expect(
        state.storage.sql
          .exec<{
            state: string;
          }>(
            'SELECT state FROM sync_snapshot_publications WHERE publication_id = ?',
            liveUpload.params.publicationId,
          )
          .one().state,
      ).toBe('uploading');
    });
    expect(await env.ARTIFACTS.head(abandonedKey)).toBeNull();
    expect(await env.ARTIFACTS.head(liveKey)).not.toBeNull();
    expect(await env.ARTIFACTS.head(firstKey)).not.toBeNull();
    expect(await env.ARTIFACTS.head(secondKey)).not.toBeNull();
    const snapshots = expectSuccess<SyncSnapshotGetResult>(
      await postRpc('sync.snapshot.get', {}, publisher),
    );
    expect(snapshots.manifest?.generation).toBe(2);
    expect(snapshots.manifest?.snapshotId).toBe(second.params.publicationId);
    expect(snapshots.previousManifest?.generation).toBe(1);
    expect(snapshots.previousManifest?.snapshotId).toBe(first.params.publicationId);
  });

  it('purges a staged snapshot and its immutable R2 chunks during account deletion', async () => {
    const ids = uniqueIds('snapshot-delete');
    const publisher = spikeBearer(ids.accountId, ids.enrollmentId);
    const change = await hashedChange({
      enrollmentSequence: 1,
      entityId: 'workspace-delete',
      payload: { name: 'Delete me', keyVersion: 1 },
    });
    expectSuccess<SyncPushResult>(await postRpc('sync.push', { changes: [change] }, publisher));
    const scan = await completeScan(publisher);
    const publication = await preparePublication({
      publicationId: crypto.randomUUID(),
      scanId: scan.begin.scanId,
      expectedGeneration: 0,
      datasetEpoch: scan.begin.epoch,
      committedCursor: scan.finish.watermarkEnd,
      text: 'staged snapshot removed with account data',
    });
    await uploadAndVerify(publisher, publication);
    const key = `sync-snapshots/${ids.accountId}/${publication.params.publicationId}/0-${publication.params.chunks[0]?.sha256}`;
    expect(await env.ARTIFACTS.head(key)).not.toBeNull();

    const account = env.ACCOUNT.get(env.ACCOUNT.idFromName(ids.accountId));
    const deleted = await account.fetch(
      new Request('https://internal.anvil/internal/delete-account', { method: 'POST' }),
    );
    expect(deleted.status).toBe(200);
    expect(await env.ARTIFACTS.head(key)).toBeNull();
    const deletionStatus = await account.fetch(
      new Request('https://internal.anvil/internal/deletion-status', { method: 'POST' }),
    );
    expect(await deletionStatus.json()).toMatchObject({ state: 'deleted' });
  });
});
