import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

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
  text: string;
}): Promise<PreparedPublication> {
  const bytes = new TextEncoder().encode(input.text);
  const bytesBase64 = btoa(String.fromCharCode(...bytes));
  const fields: Omit<SyncSnapshotBeginParams, 'publicationId' | 'manifestSha256'> = {
    scanId: input.scanId,
    expectedGeneration: input.expectedGeneration,
    datasetEpoch: input.datasetEpoch,
    keyVersion: 1,
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
