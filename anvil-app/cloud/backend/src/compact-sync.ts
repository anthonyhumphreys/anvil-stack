import type {
  SyncCursor,
  SyncSnapshotBeginParams,
  SyncSnapshotChunkGetParams,
  SyncSnapshotChunkPutParams,
  SyncSnapshotCommitParams,
  SyncSnapshotVerifyParams,
} from '../../contract/sync';
import { SYNC_SNAPSHOT_SCHEMA_VERSION } from '../../contract/sync';
import { isRecord, RpcFailure } from './rpc';

export const SYNC_SNAPSHOT_CHUNK_MAX_BYTES = 256 * 1024;
export const SYNC_SNAPSHOT_CHUNK_MAX_COUNT = 1_024;
export const SYNC_SNAPSHOT_MAX_BYTES =
  SYNC_SNAPSHOT_CHUNK_MAX_BYTES * SYNC_SNAPSHOT_CHUNK_MAX_COUNT;
export const SYNC_SNAPSHOT_MAX_ENTITY_COUNT = 1_000_000;
export const SYNC_SNAPSHOT_UPLOAD_TTL_MS = 30 * 60 * 1000;
export const SYNC_SNAPSHOT_MAX_OPEN_UPLOADS = 2;

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

export function parseSyncSnapshotBeginParams(value: unknown): SyncSnapshotBeginParams {
  if (!isRecord(value)) throw new RpcFailure('malformed-request', { reason: 'snapshot-begin' });
  const publicationId = value['publicationId'];
  const scanId = value['scanId'];
  const expectedGeneration = value['expectedGeneration'];
  const datasetEpoch = value['datasetEpoch'];
  const keyVersion = value['keyVersion'];
  const schemaVersion = value['schemaVersion'];
  const cursor = parseSnapshotCursor(value['committedCursor']);
  const entityCount = value['entityCount'];
  const tombstoneCount = value['tombstoneCount'];
  const manifestSha256 = value['manifestSha256'];
  const chunksValue = value['chunks'];
  if (typeof publicationId !== 'string' || !UUID_PATTERN.test(publicationId)) {
    throw new RpcFailure('malformed-request', { reason: 'publicationId' });
  }
  if (typeof scanId !== 'string' || !UUID_PATTERN.test(scanId)) {
    throw new RpcFailure('malformed-request', { reason: 'scanId' });
  }
  if (!isNonNegativeInteger(expectedGeneration)) {
    throw new RpcFailure('malformed-request', { reason: 'expectedGeneration' });
  }
  if (typeof datasetEpoch !== 'string' || datasetEpoch.length < 1 || datasetEpoch.length > 128) {
    throw new RpcFailure('malformed-request', { reason: 'datasetEpoch' });
  }
  if (!isPositiveInteger(keyVersion) || keyVersion > 2 ** 31 - 1) {
    throw new RpcFailure('malformed-request', { reason: 'keyVersion' });
  }
  if (schemaVersion !== SYNC_SNAPSHOT_SCHEMA_VERSION) {
    throw new RpcFailure('malformed-request', { reason: 'schemaVersion' });
  }
  if (
    !isNonNegativeInteger(entityCount) ||
    !isNonNegativeInteger(tombstoneCount) ||
    entityCount > SYNC_SNAPSHOT_MAX_ENTITY_COUNT ||
    tombstoneCount > SYNC_SNAPSHOT_MAX_ENTITY_COUNT ||
    entityCount + tombstoneCount > SYNC_SNAPSHOT_MAX_ENTITY_COUNT
  ) {
    throw new RpcFailure('malformed-request', { reason: 'coverage-count' });
  }
  if (typeof manifestSha256 !== 'string' || !SHA256_PATTERN.test(manifestSha256)) {
    throw new RpcFailure('malformed-request', { reason: 'manifestSha256' });
  }
  if (
    !Array.isArray(chunksValue) ||
    chunksValue.length < 1 ||
    chunksValue.length > SYNC_SNAPSHOT_CHUNK_MAX_COUNT
  ) {
    throw new RpcFailure('payload-too-large', {
      reason: 'snapshot-chunk-count',
      limit: SYNC_SNAPSHOT_CHUNK_MAX_COUNT,
    });
  }
  const chunks = chunksValue.map((chunk, index) => parseChunkDescriptor(chunk, index));
  const totalBytes = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
  if (totalBytes > SYNC_SNAPSHOT_MAX_BYTES) {
    throw new RpcFailure('payload-too-large', {
      reason: 'snapshot-size',
      limitBytes: SYNC_SNAPSHOT_MAX_BYTES,
      actualBytes: totalBytes,
    });
  }
  return {
    publicationId,
    scanId,
    expectedGeneration,
    datasetEpoch,
    keyVersion,
    schemaVersion,
    committedCursor: cursor.value,
    entityCount,
    tombstoneCount,
    manifestSha256,
    chunks,
  };
}

export function parseSnapshotCursor(value: unknown): { value: SyncCursor; sequence: number } {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new RpcFailure('malformed-request', { reason: 'committedCursor' });
  }
  const sequence = Number(value);
  if (!Number.isSafeInteger(sequence)) {
    throw new RpcFailure('malformed-request', { reason: 'committedCursor' });
  }
  return { value: value as SyncCursor, sequence };
}

export function parseSyncSnapshotChunkPutParams(value: unknown): SyncSnapshotChunkPutParams {
  if (!isRecord(value) || typeof value['publicationId'] !== 'string') {
    throw new RpcFailure('malformed-request', { reason: 'snapshot-chunk-put' });
  }
  const publicationId = value['publicationId'];
  if (!UUID_PATTERN.test(publicationId)) {
    throw new RpcFailure('malformed-request', { reason: 'publicationId' });
  }
  const index = value['index'];
  if (!isNonNegativeInteger(index) || index >= SYNC_SNAPSHOT_CHUNK_MAX_COUNT) {
    throw new RpcFailure('malformed-request', { reason: 'chunk-index' });
  }
  const bytesBase64 = value['bytesBase64'];
  if (typeof bytesBase64 !== 'string' || !BASE64_PATTERN.test(bytesBase64)) {
    throw new RpcFailure('malformed-request', { reason: 'chunk-base64' });
  }
  const byteLength = canonicalBase64ByteLength(bytesBase64);
  if (byteLength === null || byteLength < 1 || byteLength > SYNC_SNAPSHOT_CHUNK_MAX_BYTES) {
    throw new RpcFailure('payload-too-large', {
      reason: 'snapshot-chunk-size',
      limitBytes: SYNC_SNAPSHOT_CHUNK_MAX_BYTES,
    });
  }
  return { publicationId, index, bytesBase64 };
}

export function parseSyncSnapshotVerifyParams(value: unknown): SyncSnapshotVerifyParams {
  if (!isRecord(value) || typeof value['publicationId'] !== 'string') {
    throw new RpcFailure('malformed-request', { reason: 'snapshot-verify' });
  }
  const publicationId = value['publicationId'];
  const manifestSha256 = value['manifestSha256'];
  if (!UUID_PATTERN.test(publicationId)) {
    throw new RpcFailure('malformed-request', { reason: 'publicationId' });
  }
  if (typeof manifestSha256 !== 'string' || !SHA256_PATTERN.test(manifestSha256)) {
    throw new RpcFailure('malformed-request', { reason: 'manifestSha256' });
  }
  return { publicationId, manifestSha256 };
}

export function parseSyncSnapshotCommitParams(value: unknown): SyncSnapshotCommitParams {
  if (!isRecord(value) || typeof value['publicationId'] !== 'string') {
    throw new RpcFailure('malformed-request', { reason: 'snapshot-commit' });
  }
  const publicationId = value['publicationId'];
  if (!UUID_PATTERN.test(publicationId)) {
    throw new RpcFailure('malformed-request', { reason: 'publicationId' });
  }
  return { publicationId };
}

export function parseSyncSnapshotChunkGetParams(value: unknown): SyncSnapshotChunkGetParams {
  if (!isRecord(value) || typeof value['snapshotId'] !== 'string') {
    throw new RpcFailure('malformed-request', { reason: 'snapshot-chunk-get' });
  }
  const snapshotId = value['snapshotId'];
  const index = value['index'];
  if (!UUID_PATTERN.test(snapshotId) || !isNonNegativeInteger(index)) {
    throw new RpcFailure('malformed-request', { reason: 'snapshot-chunk-ref' });
  }
  return { snapshotId, index };
}

export function decodeCanonicalBase64(value: string): Uint8Array {
  if (!BASE64_PATTERN.test(value)) throw new RpcFailure('malformed-request', { reason: 'base64' });
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  if (encodeBase64(bytes) !== value) {
    throw new RpcFailure('malformed-request', { reason: 'base64-canonical' });
  }
  return bytes;
}

export function encodeBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary);
}

export function syncSnapshotObjectKey(
  accountId: string,
  publicationId: string,
  index: number,
  sha256: string,
): string {
  return `sync-snapshots/${accountId}/${publicationId}/${index}-${sha256}`;
}

function parseChunkDescriptor(
  value: unknown,
  expectedIndex: number,
): SyncSnapshotBeginParams['chunks'][number] {
  if (!isRecord(value)) throw new RpcFailure('malformed-request', { reason: 'chunk-descriptor' });
  const index = value['index'];
  const byteLength = value['byteLength'];
  const sha256 = value['sha256'];
  if (index !== expectedIndex || !isNonNegativeInteger(index)) {
    throw new RpcFailure('malformed-request', { reason: 'chunk-order' });
  }
  if (!isPositiveInteger(byteLength) || byteLength > SYNC_SNAPSHOT_CHUNK_MAX_BYTES) {
    throw new RpcFailure('payload-too-large', {
      reason: 'snapshot-chunk-size',
      limitBytes: SYNC_SNAPSHOT_CHUNK_MAX_BYTES,
    });
  }
  if (typeof sha256 !== 'string' || !SHA256_PATTERN.test(sha256)) {
    throw new RpcFailure('malformed-request', { reason: 'chunk-sha256' });
  }
  return { index, byteLength, sha256 };
}

function canonicalBase64ByteLength(value: string): number | null {
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  if (padding > 0) {
    const tail = value.charCodeAt(value.length - padding - 1);
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    const sextet = alphabet.indexOf(String.fromCharCode(tail));
    if (sextet < 0 || (padding === 2 ? sextet & 0x0f : sextet & 0x03) !== 0) return null;
  }
  return (value.length / 4) * 3 - padding;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}
