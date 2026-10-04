import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  rmSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import path from 'node:path';
import { app } from 'electron';
import type { ChatAttachment, ChatAttachmentInput } from '../../shared/types.js';

export const MESH_COMPANION_ATTACHMENT_CHUNK_BYTES = 256 * 1024;
export const MESH_COMPANION_ATTACHMENT_MAX_FILES = 10;
export const MESH_COMPANION_ATTACHMENT_MAX_FILE_BYTES = 25 * 1024 * 1024;
export const MESH_COMPANION_ATTACHMENT_MAX_BATCH_BYTES = 75 * 1024 * 1024;

const MAX_GLOBAL_OPEN_UPLOADS = 64;
const MAX_GLOBAL_OPEN_BYTES = 300 * 1024 * 1024;
const MAX_PRINCIPAL_OPEN_UPLOADS = 10;
const MAX_PRINCIPAL_OPEN_BYTES = MESH_COMPANION_ATTACHMENT_MAX_BATCH_BYTES;
const MAX_GLOBAL_BATCH_RECEIPTS = 512;
const MAX_PRINCIPAL_BATCH_RECEIPTS = 64;
const UPLOAD_TTL_MS = 15 * 60 * 1000;
const PREPARED_SOURCE_MAX_AGE_MS = 2 * 60 * 1000;
const PREPARED_SOURCE_FUTURE_SKEW_MS = 5_000;
const UPLOAD_ROOT_NAME = 'mesh-companion-attachment-uploads';
const CHAT_ATTACHMENT_ROOT_NAME = 'chat-attachments';
const NOFOLLOW_FLAG = constants.O_NOFOLLOW ?? 0;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_PATTERN = /^[0-9a-f]{64}$/i;

const EXTENSION_BY_MIME: Record<string, string> = {
  'application/json': '.json',
  'application/pdf': '.pdf',
  'application/sql': '.sql',
  'application/xml': '.xml',
  'application/yaml': '.yaml',
  'image/avif': '.avif',
  'image/bmp': '.bmp',
  'image/gif': '.gif',
  'image/heic': '.heic',
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/svg+xml': '.svg',
  'image/webp': '.webp',
  'text/csv': '.csv',
  'text/markdown': '.md',
  'text/plain': '.txt',
};

export interface MeshCompanionAttachmentContext {
  sessionId: string;
  principalId: string;
  accountId: string;
  backendId: string;
  datasetEpoch: string;
  hostEnrollmentId: string;
  machineId: string;
  endpointGeneration: string;
}

export interface MeshCompanionAttachmentReference {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  kind: 'image' | 'file';
  createdAt: string;
}

export type MeshCompanionAttachmentUploadErrorCode =
  | 'attachment-upload-invalid'
  | 'attachment-upload-conflict'
  | 'attachment-upload-not-found'
  | 'attachment-upload-quota'
  | 'attachment-upload-offset'
  | 'attachment-upload-checksum'
  | 'attachment-upload-expired'
  | 'attachment-upload-storage';

export class MeshCompanionAttachmentUploadError extends Error {
  constructor(
    readonly code: MeshCompanionAttachmentUploadErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'MeshCompanionAttachmentUploadError';
  }
}

export interface BeginMeshCompanionAttachmentUploadInput {
  batchId: string;
  uploadId: string;
  name: string;
  mimeType: string;
  totalBytes: number;
}

export interface WriteMeshCompanionAttachmentChunkInput {
  uploadId: string;
  offset: number;
  bytesBase64: string;
}

export interface FinishMeshCompanionAttachmentUploadInput {
  uploadId: string;
  sha256: string;
}

export interface ClaimMeshCompanionAttachmentReferencesInput {
  batchId: string;
  attachmentIds: string[];
}

interface BatchRecord {
  key: string;
  contextKey: string;
  principalKey: string;
  batchId: string;
  source: 'chunks' | 'prepared';
  createdAt: number;
  expiresAt: number;
  totalBytes: number;
  uploadKeys: string[];
  referenceIds: string[];
  preparedFingerprint?: string;
  claimed: boolean;
}

interface LastChunk {
  offset: number;
  byteLength: number;
  sha256: string;
}

interface UploadRecord {
  key: string;
  batchKey: string;
  contextKey: string;
  principalKey: string;
  batchId: string;
  uploadId: string;
  totalBytes: number;
  name: string;
  mimeType: string;
  kind: 'image' | 'file';
  createdAt: number;
  expiresAt: number;
  nextOffset: number;
  lastChunk: LastChunk | null;
  status: 'uploading' | 'ready' | 'claimed' | 'failed';
  fileDescriptor: number | null;
  stagingPath: string | null;
  readyPath: string | null;
  sha256: string | null;
  reference: MeshCompanionAttachmentReference;
}

interface StorageLayout {
  userDataDir: string;
  uploadRoot: string;
  stagingDir: string;
  readyDir: string;
  chatAttachmentDir: string;
}

interface PreparedSource {
  attachment: ChatAttachment;
  sourcePath: string;
  name: string;
  mimeType: string;
  kind: 'image' | 'file';
  size: number;
}

const batches = new Map<string, BatchRecord>();
const uploads = new Map<string, UploadRecord>();

export function beginMeshCompanionAttachmentUpload(
  context: MeshCompanionAttachmentContext,
  input: BeginMeshCompanionAttachmentUploadInput,
): { batchId: string; uploadId: string; nextOffset: number; chunkBytes: number } {
  const now = Date.now();
  expireMeshCompanionAttachmentUploads(now);
  const contextKey = contextIdentityKey(context);
  assertIdentifier(input.batchId, 'batch id');
  assertIdentifier(input.uploadId, 'upload id');
  const name = ensureFileExtension(sanitizeName(input.name), normalizeMimeType(input.mimeType));
  const mimeType = normalizeMimeType(input.mimeType);
  assertByteCount(input.totalBytes, 0, MESH_COMPANION_ATTACHMENT_MAX_FILE_BYTES, 'file size');

  const key = uploadIdentityKey(contextKey, input.uploadId);
  const prior = uploads.get(key);
  if (prior !== undefined) {
    assertBatchActive(prior.batchKey);
    if (
      prior.batchId !== input.batchId ||
      prior.name !== name ||
      prior.mimeType !== mimeType ||
      prior.totalBytes !== input.totalBytes ||
      prior.status === 'failed' ||
      prior.status === 'claimed'
    ) {
      throw uploadError(
        'attachment-upload-conflict',
        'Upload id is already bound to another upload.',
      );
    }
    return {
      batchId: prior.batchId,
      uploadId: prior.uploadId,
      nextOffset: prior.nextOffset,
      chunkBytes: MESH_COMPANION_ATTACHMENT_CHUNK_BYTES,
    };
  }

  const batchKey = batchIdentityKey(contextKey, input.batchId);
  const { batch, created } = getOrCreateBatch(context, input.batchId, 'chunks', now);
  let reservedBytes = false;
  let stagingPath: string | null = null;
  let fileDescriptor: number | null = null;
  try {
    reserveBatchFile(batch, input.totalBytes);
    reservedBytes = true;
    assertOpenUploadQuota(principalIdentityKey(context), 1, input.totalBytes);
    const layout = ensureStorageLayout();
    stagingPath = generatedUploadPath(layout.stagingDir, '.part');
    fileDescriptor = openNewFile(stagingPath);
    const reference: MeshCompanionAttachmentReference = {
      id: randomUUID(),
      name,
      mimeType,
      size: input.totalBytes,
      kind: kindFromMime(mimeType),
      createdAt: new Date(now).toISOString(),
    };
    const upload: UploadRecord = {
      key,
      batchKey,
      contextKey,
      principalKey: principalIdentityKey(context),
      batchId: input.batchId,
      uploadId: input.uploadId,
      totalBytes: input.totalBytes,
      name,
      mimeType,
      kind: reference.kind,
      createdAt: now,
      expiresAt: batch.expiresAt,
      nextOffset: 0,
      lastChunk: null,
      status: 'uploading',
      fileDescriptor,
      stagingPath,
      readyPath: null,
      sha256: null,
      reference,
    };
    uploads.set(key, upload);
    batch.uploadKeys.push(key);
    batch.referenceIds.push(reference.id);
    return {
      batchId: batch.batchId,
      uploadId: upload.uploadId,
      nextOffset: upload.nextOffset,
      chunkBytes: MESH_COMPANION_ATTACHMENT_CHUNK_BYTES,
    };
  } catch (error) {
    closeIfOpen(fileDescriptor);
    removeOwnedFile(stagingPath);
    if (reservedBytes) batch.totalBytes -= input.totalBytes;
    if (created && batch.uploadKeys.length === 0) batches.delete(batchKey);
    if (error instanceof MeshCompanionAttachmentUploadError) throw error;
    throw uploadError('attachment-upload-storage', 'Could not begin attachment upload.', error);
  }
}

export function writeMeshCompanionAttachmentChunk(
  context: MeshCompanionAttachmentContext,
  input: WriteMeshCompanionAttachmentChunkInput,
): { uploadId: string; nextOffset: number } {
  expireMeshCompanionAttachmentUploads(Date.now());
  const contextKey = contextIdentityKey(context);
  assertIdentifier(input.uploadId, 'upload id');
  if (!Number.isSafeInteger(input.offset) || input.offset < 0) {
    throw uploadError('attachment-upload-invalid', 'Chunk offset is invalid.');
  }
  const chunk = decodeChunk(input.bytesBase64);
  const chunkHash = createHash('sha256').update(chunk).digest('hex');
  const upload = getUpload(contextKey, input.uploadId);
  assertBatchActive(upload.batchKey);

  if (upload.lastChunk !== null && input.offset === upload.lastChunk.offset) {
    if (upload.lastChunk.byteLength !== chunk.byteLength || upload.lastChunk.sha256 !== chunkHash) {
      throw uploadError(
        'attachment-upload-conflict',
        'Repeated chunk differs from the last accepted chunk.',
      );
    }
    return { uploadId: upload.uploadId, nextOffset: upload.nextOffset };
  }
  if (upload.status !== 'uploading' || upload.fileDescriptor === null) {
    throw uploadError('attachment-upload-conflict', 'Upload no longer accepts chunks.');
  }
  if (input.offset !== upload.nextOffset) {
    throw uploadError(
      'attachment-upload-offset',
      'Chunk offset does not match the next expected byte.',
    );
  }
  if (upload.nextOffset + chunk.byteLength > upload.totalBytes) {
    throw uploadError('attachment-upload-invalid', 'Chunk exceeds the declared file size.');
  }

  try {
    writeAllAt(upload.fileDescriptor, chunk, input.offset);
    upload.lastChunk = {
      offset: input.offset,
      byteLength: chunk.byteLength,
      sha256: chunkHash,
    };
    upload.nextOffset += chunk.byteLength;
    return { uploadId: upload.uploadId, nextOffset: upload.nextOffset };
  } catch (cause) {
    failUpload(upload);
    throw uploadError('attachment-upload-storage', 'Could not store attachment chunk.', cause);
  }
}

export function finishMeshCompanionAttachmentUpload(
  context: MeshCompanionAttachmentContext,
  input: FinishMeshCompanionAttachmentUploadInput,
): MeshCompanionAttachmentReference {
  expireMeshCompanionAttachmentUploads(Date.now());
  const contextKey = contextIdentityKey(context);
  assertIdentifier(input.uploadId, 'upload id');
  if (!SHA256_PATTERN.test(input.sha256)) {
    throw uploadError('attachment-upload-invalid', 'SHA-256 checksum is invalid.');
  }
  const upload = getUpload(contextKey, input.uploadId);
  assertBatchActive(upload.batchKey);
  const expectedHash = input.sha256.toLowerCase();
  if (upload.status === 'ready') {
    if (upload.sha256 !== expectedHash) {
      throw uploadError(
        'attachment-upload-conflict',
        'Upload was finalized with a different checksum.',
      );
    }
    return { ...upload.reference };
  }
  if (
    upload.status !== 'uploading' ||
    upload.fileDescriptor === null ||
    upload.stagingPath === null
  ) {
    throw uploadError('attachment-upload-conflict', 'Upload cannot be finalized.');
  }
  if (upload.nextOffset !== upload.totalBytes) {
    throw uploadError('attachment-upload-offset', 'Upload is incomplete.');
  }

  try {
    fsyncSync(upload.fileDescriptor);
    const actualHash = hashFile(upload.fileDescriptor, upload.totalBytes);
    if (!timingSafeEqual(Buffer.from(actualHash, 'hex'), Buffer.from(expectedHash, 'hex'))) {
      throw uploadError(
        'attachment-upload-checksum',
        'Attachment checksum does not match its bytes.',
      );
    }
    const fileInfo = fstatSync(upload.fileDescriptor);
    if (!fileInfo.isFile() || fileInfo.size !== upload.totalBytes) {
      throw uploadError(
        'attachment-upload-storage',
        'Stored attachment size differs from its declaration.',
      );
    }
    const layout = ensureStorageLayout();
    assertOwnedStagingPath(upload.stagingPath, upload.fileDescriptor, layout);
    closeSync(upload.fileDescriptor);
    upload.fileDescriptor = null;
    const readyPath = generatedUploadPath(layout.readyDir, '.ready');
    moveOwnedFileNoReplace(upload.stagingPath, readyPath);
    upload.stagingPath = null;
    upload.readyPath = readyPath;
    upload.sha256 = actualHash;
    upload.status = 'ready';
    return { ...upload.reference };
  } catch (cause) {
    if (cause instanceof MeshCompanionAttachmentUploadError) throw cause;
    failUpload(upload);
    throw uploadError('attachment-upload-storage', 'Could not finalize attachment.', cause);
  }
}

/**
 * Register files created by the host's validated `prepareChatAttachments` call.
 * Source files are copied into this service's private root and are never removed here.
 */
export function registerMeshCompanionPreparedAttachments(
  context: MeshCompanionAttachmentContext,
  input: { batchId: string; attachments: ChatAttachment[] },
): MeshCompanionAttachmentReference[] {
  const now = Date.now();
  expireMeshCompanionAttachmentUploads(now);
  const contextKey = contextIdentityKey(context);
  assertIdentifier(input.batchId, 'batch id');
  if (!Array.isArray(input.attachments) || input.attachments.length < 1) {
    throw uploadError(
      'attachment-upload-invalid',
      'Prepared attachment batch is empty or invalid.',
    );
  }
  if (input.attachments.length > MESH_COMPANION_ATTACHMENT_MAX_FILES) {
    throw uploadError('attachment-upload-quota', 'A batch can contain at most 10 files.');
  }
  if (
    input.attachments.some(
      (attachment) =>
        typeof attachment !== 'object' ||
        attachment === null ||
        typeof attachment.id !== 'string' ||
        typeof attachment.name !== 'string' ||
        typeof attachment.mimeType !== 'string' ||
        typeof attachment.path !== 'string' ||
        attachment.path.length > 4_096 ||
        typeof attachment.createdAt !== 'string',
    )
  ) {
    throw uploadError('attachment-upload-invalid', 'Prepared attachment metadata is invalid.');
  }

  const fingerprint = preparedFingerprint(input.attachments);
  const batchKey = batchIdentityKey(contextKey, input.batchId);
  const priorBatch = batches.get(batchKey);
  if (priorBatch !== undefined) {
    assertBatchActive(batchKey);
    if (priorBatch.source !== 'prepared' || priorBatch.preparedFingerprint !== fingerprint) {
      throw uploadError(
        'attachment-upload-conflict',
        'Batch id is already bound to another upload batch.',
      );
    }
    return batchReferences(priorBatch);
  }

  const prepared = input.attachments.map((attachment) => validatePreparedSource(attachment, now));
  const totalBytes = prepared.reduce((total, source) => total + source.size, 0);
  if (totalBytes > MESH_COMPANION_ATTACHMENT_MAX_BATCH_BYTES) {
    throw uploadError('attachment-upload-quota', 'Attachment batch exceeds the 75 MiB limit.');
  }
  assertOpenUploadQuota(principalIdentityKey(context), prepared.length, totalBytes);
  const batch: BatchRecord = {
    key: batchKey,
    contextKey,
    principalKey: principalIdentityKey(context),
    batchId: input.batchId,
    source: 'prepared',
    createdAt: now,
    expiresAt: now + UPLOAD_TTL_MS,
    totalBytes: 0,
    uploadKeys: [],
    referenceIds: [],
    preparedFingerprint: fingerprint,
    claimed: false,
  };
  assertBatchReceiptQuota(batch.principalKey);
  batches.set(batchKey, batch);
  const createdUploadKeys: string[] = [];
  try {
    const layout = ensureStorageLayout();
    for (const source of prepared) {
      reserveBatchFile(batch, source.size);
      const uploadId = randomUUID();
      const key = uploadIdentityKey(contextKey, uploadId);
      const stagingPath = generatedUploadPath(layout.stagingDir, '.part');
      const fileDescriptor = openNewFile(stagingPath);
      try {
        const sourceDescriptor = openPreparedSource(source);
        try {
          copyFileDescriptor(sourceDescriptor, fileDescriptor, source.size);
        } finally {
          closeSync(sourceDescriptor);
        }
        fsyncSync(fileDescriptor);
        const sha256 = hashFile(fileDescriptor, source.size);
        closeSync(fileDescriptor);
        const readyPath = generatedUploadPath(layout.readyDir, '.ready');
        moveOwnedFileNoReplace(stagingPath, readyPath);
        const reference: MeshCompanionAttachmentReference = {
          id: randomUUID(),
          name: source.name,
          mimeType: source.mimeType,
          size: source.size,
          kind: source.kind,
          createdAt: new Date(now).toISOString(),
        };
        const upload: UploadRecord = {
          key,
          batchKey,
          contextKey,
          principalKey: batch.principalKey,
          batchId: input.batchId,
          uploadId,
          totalBytes: source.size,
          name: source.name,
          mimeType: source.mimeType,
          kind: source.kind,
          createdAt: now,
          expiresAt: batch.expiresAt,
          nextOffset: source.size,
          lastChunk: null,
          status: 'ready',
          fileDescriptor: null,
          stagingPath: null,
          readyPath,
          sha256,
          reference,
        };
        uploads.set(key, upload);
        createdUploadKeys.push(key);
        batch.uploadKeys.push(key);
        batch.referenceIds.push(reference.id);
      } catch (cause) {
        closeIfOpen(fileDescriptor);
        removeOwnedFile(stagingPath);
        throw cause;
      }
    }
    return batchReferences(batch);
  } catch (cause) {
    for (const key of createdUploadKeys) {
      const upload = uploads.get(key);
      if (upload !== undefined) disposeUpload(upload);
      uploads.delete(key);
    }
    batches.delete(batchKey);
    if (cause instanceof MeshCompanionAttachmentUploadError) throw cause;
    throw uploadError(
      'attachment-upload-storage',
      'Could not register prepared attachments.',
      cause,
    );
  }
}

/** Consume every reference in a batch once and return their new host-local paths. */
export function claimMeshCompanionAttachmentReferences(
  context: MeshCompanionAttachmentContext,
  input: ClaimMeshCompanionAttachmentReferencesInput,
): ChatAttachmentInput[] {
  expireMeshCompanionAttachmentUploads(Date.now());
  const contextKey = contextIdentityKey(context);
  assertIdentifier(input.batchId, 'batch id');
  if (
    !Array.isArray(input.attachmentIds) ||
    input.attachmentIds.length < 1 ||
    input.attachmentIds.length > MESH_COMPANION_ATTACHMENT_MAX_FILES ||
    input.attachmentIds.some((id) => typeof id !== 'string' || !UUID_PATTERN.test(id)) ||
    new Set(input.attachmentIds).size !== input.attachmentIds.length
  ) {
    throw uploadError('attachment-upload-invalid', 'Attachment reference list is invalid.');
  }
  const batchKey = batchIdentityKey(contextKey, input.batchId);
  const batch = batches.get(batchKey);
  if (batch === undefined || batch.contextKey !== contextKey) {
    throw uploadError('attachment-upload-not-found', 'Attachment batch was not found.');
  }
  if (batch.claimed) {
    throw uploadError('attachment-upload-conflict', 'Attachment batch has already been claimed.');
  }
  const expectedIds = new Set(batch.referenceIds);
  if (
    expectedIds.size !== input.attachmentIds.length ||
    input.attachmentIds.some((id) => !expectedIds.has(id))
  ) {
    throw uploadError(
      'attachment-upload-conflict',
      'Claim must include every reference in the batch exactly once.',
    );
  }
  const records = input.attachmentIds.map((id) => {
    const upload = batch.uploadKeys
      .map((key) => uploads.get(key))
      .find((candidate) => candidate?.reference.id === id);
    if (upload === undefined || upload.status !== 'ready' || upload.readyPath === null) {
      throw uploadError(
        'attachment-upload-conflict',
        'Every attachment in the batch must be finalized first.',
      );
    }
    return upload;
  });

  const layout = ensureStorageLayout();
  const dateSegment = new Date().toISOString().slice(0, 10);
  const destinationDir = ensureChatAttachmentDateDirectory(layout, dateSegment);
  const destinations = records.map((upload) =>
    path.join(destinationDir, `${Date.now()}-${randomUUID()}-${upload.name}`),
  );
  const createdDestinations: string[] = [];
  batch.claimed = true;
  try {
    for (let index = 0; index < records.length; index += 1) {
      const upload = records[index];
      const destination = destinations[index];
      if (upload === undefined || destination === undefined || upload.readyPath === null) {
        throw new Error('Attachment claim changed during preparation.');
      }
      assertOwnedReadyPath(upload.readyPath, layout);
      const readyStat = lstatSync(upload.readyPath);
      if (!readyStat.isFile() || readyStat.size !== upload.totalBytes) {
        throw uploadError('attachment-upload-storage', 'Finalized attachment is unavailable.');
      }
      linkSync(upload.readyPath, destination);
      createdDestinations.push(destination);
    }
  } catch (cause) {
    batch.claimed = false;
    for (const destination of createdDestinations) unlinkIfFile(destination);
    if (cause instanceof MeshCompanionAttachmentUploadError) throw cause;
    throw uploadError(
      'attachment-upload-storage',
      'Could not materialize claimed attachments.',
      cause,
    );
  }

  const result = records.map((upload, index): ChatAttachmentInput => {
    const destination = destinations[index];
    if (destination === undefined) throw new Error('Attachment claim result is incomplete.');
    return {
      id: upload.reference.id,
      name: upload.reference.name,
      mimeType: upload.reference.mimeType,
      size: upload.reference.size,
      path: destination,
    };
  });
  batch.claimed = true;
  for (const upload of records) {
    upload.status = 'claimed';
    if (upload.readyPath !== null) unlinkIfFile(upload.readyPath);
    upload.readyPath = null;
  }
  return result;
}

/** Remove in-memory receipts and this helper's entire private staging/reference tree on startup. */
export function cleanupMeshCompanionAttachmentUploads(userDataDir = app.getPath('userData')): void {
  for (const upload of uploads.values()) closeIfOpen(upload.fileDescriptor);
  uploads.clear();
  batches.clear();

  const userData = validateUserDataDirectory(userDataDir);
  removePrivateTree(path.join(userData, UPLOAD_ROOT_NAME));
  const chatAttachmentDir = path.join(userData, CHAT_ATTACHMENT_ROOT_NAME);
  try {
    const info = lstatSync(chatAttachmentDir);
    if (info.isDirectory() && !info.isSymbolicLink()) {
      removePrivateTree(path.join(chatAttachmentDir, '.mesh-companion-unclaimed'));
    }
  } catch (error) {
    if (!isMissingPath(error)) {
      throw uploadError(
        'attachment-upload-storage',
        'Could not clean unclaimed attachment references.',
        error,
      );
    }
  }
}

/** Expire open uploads and unclaimed references. Expiry never removes claimed chat files. */
export function expireMeshCompanionAttachmentUploads(now = Date.now()): void {
  if (!Number.isSafeInteger(now) || now < 0) {
    throw uploadError('attachment-upload-invalid', 'Expiry time is invalid.');
  }
  for (const [key, batch] of batches) {
    if (batch.expiresAt > now) continue;
    for (const uploadKey of batch.uploadKeys) {
      const upload = uploads.get(uploadKey);
      if (upload !== undefined) {
        disposeUpload(upload);
        uploads.delete(uploadKey);
      }
    }
    batches.delete(key);
  }
}

function getOrCreateBatch(
  context: MeshCompanionAttachmentContext,
  batchId: string,
  source: BatchRecord['source'],
  now: number,
): { batch: BatchRecord; created: boolean } {
  const contextKey = contextIdentityKey(context);
  const key = batchIdentityKey(contextKey, batchId);
  const prior = batches.get(key);
  if (prior !== undefined) {
    assertBatchActive(key);
    if (prior.source !== source) {
      throw uploadError(
        'attachment-upload-conflict',
        'Batch id is already bound to another upload type.',
      );
    }
    return { batch: prior, created: false };
  }
  const batch: BatchRecord = {
    key,
    contextKey,
    principalKey: principalIdentityKey(context),
    batchId,
    source,
    createdAt: now,
    expiresAt: now + UPLOAD_TTL_MS,
    totalBytes: 0,
    uploadKeys: [],
    referenceIds: [],
    claimed: false,
  };
  assertBatchReceiptQuota(batch.principalKey);
  batches.set(key, batch);
  return { batch, created: true };
}

function reserveBatchFile(batch: BatchRecord, bytes: number): void {
  if (batch.claimed) {
    throw uploadError('attachment-upload-conflict', 'Attachment batch has already been claimed.');
  }
  if (
    batch.uploadKeys.length >= MESH_COMPANION_ATTACHMENT_MAX_FILES ||
    batch.totalBytes + bytes > MESH_COMPANION_ATTACHMENT_MAX_BATCH_BYTES
  ) {
    throw uploadError(
      'attachment-upload-quota',
      'Attachment batch exceeds its file or byte limit.',
    );
  }
  batch.totalBytes += bytes;
}

function assertBatchReceiptQuota(principalKey: string): void {
  let principalBatches = 0;
  for (const batch of batches.values()) {
    if (batch.principalKey === principalKey) principalBatches += 1;
  }
  if (
    batches.size >= MAX_GLOBAL_BATCH_RECEIPTS ||
    principalBatches >= MAX_PRINCIPAL_BATCH_RECEIPTS
  ) {
    throw uploadError('attachment-upload-quota', 'Attachment batch receipt capacity is full.');
  }
}

function assertOpenUploadQuota(principalKey: string, count: number, bytes: number): void {
  let globalCount = 0;
  let globalBytes = 0;
  let principalCount = 0;
  let principalBytes = 0;
  for (const upload of uploads.values()) {
    if (upload.status === 'claimed' || upload.status === 'failed') continue;
    globalCount += 1;
    globalBytes += upload.totalBytes;
    if (upload.principalKey === principalKey) {
      principalCount += 1;
      principalBytes += upload.totalBytes;
    }
  }
  if (
    globalCount + count > MAX_GLOBAL_OPEN_UPLOADS ||
    globalBytes + bytes > MAX_GLOBAL_OPEN_BYTES ||
    principalCount + count > MAX_PRINCIPAL_OPEN_UPLOADS ||
    principalBytes + bytes > MAX_PRINCIPAL_OPEN_BYTES
  ) {
    throw uploadError('attachment-upload-quota', 'Open attachment upload capacity is full.');
  }
}

function assertBatchActive(batchKey: string): BatchRecord {
  const batch = batches.get(batchKey);
  if (batch === undefined) {
    throw uploadError('attachment-upload-not-found', 'Attachment batch was not found or expired.');
  }
  if (batch.expiresAt <= Date.now()) {
    expireMeshCompanionAttachmentUploads(Date.now());
    throw uploadError('attachment-upload-expired', 'Attachment batch expired.');
  }
  if (batch.claimed) {
    throw uploadError('attachment-upload-conflict', 'Attachment batch has already been claimed.');
  }
  return batch;
}

function getUpload(contextKey: string, uploadId: string): UploadRecord {
  const upload = uploads.get(uploadIdentityKey(contextKey, uploadId));
  if (upload === undefined) {
    throw uploadError('attachment-upload-not-found', 'Attachment upload was not found or expired.');
  }
  return upload;
}

function batchReferences(batch: BatchRecord): MeshCompanionAttachmentReference[] {
  return batch.uploadKeys.map((key) => {
    const upload = uploads.get(key);
    if (upload === undefined) throw new Error('Attachment batch registry is inconsistent.');
    return { ...upload.reference };
  });
}

function preparedFingerprint(attachments: ChatAttachment[]): string {
  return JSON.stringify(
    attachments.map((attachment) => ({
      id: attachment.id,
      name: attachment.name,
      mimeType: attachment.mimeType,
      size: attachment.size,
      kind: attachment.kind,
      path: attachment.path,
      createdAt: attachment.createdAt,
    })),
  );
}

function validatePreparedSource(attachment: ChatAttachment, now: number): PreparedSource {
  if (
    typeof attachment !== 'object' ||
    attachment === null ||
    !UUID_PATTERN.test(attachment.id) ||
    typeof attachment.path !== 'string' ||
    !Number.isSafeInteger(attachment.size) ||
    attachment.size < 0 ||
    attachment.size > MESH_COMPANION_ATTACHMENT_MAX_FILE_BYTES
  ) {
    throw uploadError('attachment-upload-invalid', 'Prepared attachment metadata is invalid.');
  }
  const name = sanitizeName(attachment.name);
  const mimeType = normalizeMimeType(attachment.mimeType);
  const kind = kindFromMime(mimeType);
  const createdAt = Date.parse(attachment.createdAt);
  if (
    !Number.isFinite(createdAt) ||
    createdAt < now - PREPARED_SOURCE_MAX_AGE_MS ||
    createdAt > now + PREPARED_SOURCE_FUTURE_SKEW_MS ||
    attachment.kind !== kind ||
    name !== attachment.name
  ) {
    throw uploadError(
      'attachment-upload-invalid',
      'Prepared attachment was not freshly generated by this host.',
    );
  }
  const userDataDir = validateUserDataDirectory(app.getPath('userData'));
  const managedRoot = path.join(userDataDir, CHAT_ATTACHMENT_ROOT_NAME);
  const sourcePath = path.resolve(attachment.path);
  const relative = path.relative(managedRoot, sourcePath);
  const parts = relative.split(path.sep);
  if (
    path.isAbsolute(relative) ||
    relative.startsWith(`..${path.sep}`) ||
    relative === '..' ||
    parts.length !== 2 ||
    !/^\d{4}-\d{2}-\d{2}$/.test(parts[0] ?? '')
  ) {
    throw uploadError(
      'attachment-upload-invalid',
      'Prepared attachment path is outside managed chat storage.',
    );
  }
  const fileName = parts[1] ?? '';
  const generatedName =
    /^(\d{10,13})-([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})-(.+)$/i.exec(
      fileName,
    );
  if (generatedName === null || generatedName[3] !== attachment.name) {
    throw uploadError(
      'attachment-upload-invalid',
      'Prepared attachment path was not generated by this host.',
    );
  }
  const fileTimestamp = Number(generatedName[1]);
  if (
    !Number.isSafeInteger(fileTimestamp) ||
    fileTimestamp < now - PREPARED_SOURCE_MAX_AGE_MS ||
    fileTimestamp > now + PREPARED_SOURCE_FUTURE_SKEW_MS
  ) {
    throw uploadError('attachment-upload-invalid', 'Prepared attachment file is stale.');
  }
  assertExistingDirectory(userDataDir);
  assertExistingDirectory(managedRoot);
  const dateDir = path.join(managedRoot, parts[0] ?? '');
  assertExistingDirectory(dateDir);
  const info = lstatSync(sourcePath);
  if (!info.isFile() || info.size !== attachment.size) {
    throw uploadError(
      'attachment-upload-invalid',
      'Prepared attachment file is missing or changed.',
    );
  }
  return { attachment, sourcePath, name, mimeType, kind, size: info.size };
}

function openPreparedSource(source: PreparedSource): number {
  const sourceDescriptor = openSync(source.sourcePath, constants.O_RDONLY | NOFOLLOW_FLAG);
  try {
    const info = fstatSync(sourceDescriptor);
    if (!info.isFile() || info.size !== source.size) {
      throw uploadError(
        'attachment-upload-invalid',
        'Prepared attachment changed before registration.',
      );
    }
    return sourceDescriptor;
  } catch (cause) {
    closeSync(sourceDescriptor);
    throw cause;
  }
}

function copyFileDescriptor(source: number, destination: number, size: number): void {
  const buffer = Buffer.allocUnsafe(MESH_COMPANION_ATTACHMENT_CHUNK_BYTES);
  let offset = 0;
  while (offset < size) {
    const length = Math.min(buffer.byteLength, size - offset);
    const read = readSync(source, buffer, 0, length, offset);
    if (read <= 0) throw new Error('Prepared attachment ended before its declared size.');
    writeAllAt(destination, buffer.subarray(0, read), offset);
    offset += read;
  }
}

function decodeChunk(bytesBase64: string): Buffer {
  const maxBase64Bytes = Math.ceil(MESH_COMPANION_ATTACHMENT_CHUNK_BYTES / 3) * 4;
  if (
    typeof bytesBase64 !== 'string' ||
    bytesBase64.length < 4 ||
    bytesBase64.length > maxBase64Bytes ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(bytesBase64)
  ) {
    throw uploadError('attachment-upload-invalid', 'Chunk encoding is invalid or exceeds 256 KiB.');
  }
  const bytes = Buffer.from(bytesBase64, 'base64');
  if (
    bytes.byteLength < 1 ||
    bytes.byteLength > MESH_COMPANION_ATTACHMENT_CHUNK_BYTES ||
    bytes.toString('base64') !== bytesBase64
  ) {
    throw uploadError('attachment-upload-invalid', 'Chunk encoding is invalid or exceeds 256 KiB.');
  }
  return bytes;
}

function writeAllAt(fileDescriptor: number, bytes: Buffer, position: number): void {
  let bufferOffset = 0;
  while (bufferOffset < bytes.byteLength) {
    const written = writeSync(
      fileDescriptor,
      bytes,
      bufferOffset,
      bytes.byteLength - bufferOffset,
      position + bufferOffset,
    );
    if (written <= 0) throw new Error('Attachment write did not make progress.');
    bufferOffset += written;
  }
}

function hashFile(fileDescriptor: number, size: number): string {
  const hash = createHash('sha256');
  const buffer = Buffer.allocUnsafe(MESH_COMPANION_ATTACHMENT_CHUNK_BYTES);
  let offset = 0;
  while (offset < size) {
    const length = Math.min(buffer.byteLength, size - offset);
    const read = readSync(fileDescriptor, buffer, 0, length, offset);
    if (read <= 0) throw new Error('Attachment ended before its declared size.');
    hash.update(buffer.subarray(0, read));
    offset += read;
  }
  return hash.digest('hex');
}

function failUpload(upload: UploadRecord): void {
  upload.status = 'failed';
  closeIfOpen(upload.fileDescriptor);
  upload.fileDescriptor = null;
  removeOwnedFile(upload.stagingPath);
  removeOwnedFile(upload.readyPath);
  upload.stagingPath = null;
  upload.readyPath = null;
}

function disposeUpload(upload: UploadRecord): void {
  closeIfOpen(upload.fileDescriptor);
  removeOwnedFile(upload.stagingPath);
  removeOwnedFile(upload.readyPath);
}

function closeIfOpen(fileDescriptor: number | null): void {
  if (fileDescriptor === null) return;
  try {
    closeSync(fileDescriptor);
  } catch {
    // A descriptor may already have been closed after a partial filesystem failure.
  }
}

function ensureStorageLayout(): StorageLayout {
  const userDataDir = validateUserDataDirectory(app.getPath('userData'));
  const uploadRoot = ensureChildDirectory(userDataDir, UPLOAD_ROOT_NAME);
  const stagingDir = ensureChildDirectory(uploadRoot, 'staging');
  const chatAttachmentDir = ensureChildDirectory(userDataDir, CHAT_ATTACHMENT_ROOT_NAME);
  const readyDir = ensureChildDirectory(chatAttachmentDir, '.mesh-companion-unclaimed');
  return { userDataDir, uploadRoot, stagingDir, readyDir, chatAttachmentDir };
}

function ensureChatAttachmentDateDirectory(layout: StorageLayout, dateSegment: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateSegment)) {
    throw uploadError('attachment-upload-storage', 'Attachment date directory is invalid.');
  }
  const root = ensureChildDirectory(layout.userDataDir, CHAT_ATTACHMENT_ROOT_NAME);
  return ensureChildDirectory(root, dateSegment);
}

function ensureChildDirectory(parent: string, childName: string): string {
  assertExistingDirectory(parent);
  const child = path.join(parent, childName);
  try {
    mkdirSync(child, { mode: 0o700 });
  } catch (error) {
    if (!isAlreadyExists(error)) {
      throw uploadError(
        'attachment-upload-storage',
        'Could not create attachment storage directory.',
        error,
      );
    }
  }
  assertExistingDirectory(child);
  return child;
}

function validateUserDataDirectory(userDataDir: string): string {
  if (
    typeof userDataDir !== 'string' ||
    userDataDir.length === 0 ||
    !path.isAbsolute(userDataDir)
  ) {
    throw uploadError('attachment-upload-storage', 'Application data directory is invalid.');
  }
  const resolved = path.resolve(userDataDir);
  assertExistingDirectory(resolved);
  return resolved;
}

function assertExistingDirectory(directory: string): void {
  let info;
  try {
    info = lstatSync(directory);
  } catch (cause) {
    throw uploadError(
      'attachment-upload-storage',
      'Attachment storage directory is unavailable.',
      cause,
    );
  }
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw uploadError(
      'attachment-upload-storage',
      'Attachment storage path must be a real directory.',
    );
  }
}

function generatedUploadPath(directory: string, suffix: '.part' | '.ready'): string {
  return path.join(directory, `${randomUUID()}${suffix}`);
}

function openNewFile(filePath: string): number {
  return openSync(
    filePath,
    constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | NOFOLLOW_FLAG,
    0o600,
  );
}

function moveOwnedFileNoReplace(sourcePath: string, destinationPath: string): void {
  let destinationCreated = false;
  try {
    linkSync(sourcePath, destinationPath);
    destinationCreated = true;
    unlinkSync(sourcePath);
  } catch (cause) {
    if (destinationCreated) unlinkIfFile(destinationPath);
    throw cause;
  }
}

function assertOwnedReadyPath(readyPath: string, layout: StorageLayout): void {
  assertExistingDirectory(layout.uploadRoot);
  assertExistingDirectory(layout.readyDir);
  if (
    path.dirname(readyPath) !== layout.readyDir ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.ready$/i.test(
      path.basename(readyPath),
    )
  ) {
    throw uploadError(
      'attachment-upload-storage',
      'Finalized attachment escaped its private storage root.',
    );
  }
}

function assertOwnedStagingPath(
  stagingPath: string,
  fileDescriptor: number,
  layout: StorageLayout,
): void {
  assertExistingDirectory(layout.uploadRoot);
  assertExistingDirectory(layout.stagingDir);
  if (
    path.dirname(stagingPath) !== layout.stagingDir ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.part$/i.test(
      path.basename(stagingPath),
    )
  ) {
    throw uploadError(
      'attachment-upload-storage',
      'Staging attachment escaped its private storage root.',
    );
  }
  const pathInfo = lstatSync(stagingPath);
  const descriptorInfo = fstatSync(fileDescriptor);
  if (
    !pathInfo.isFile() ||
    pathInfo.isSymbolicLink() ||
    !descriptorInfo.isFile() ||
    pathInfo.dev !== descriptorInfo.dev ||
    pathInfo.ino !== descriptorInfo.ino
  ) {
    throw uploadError(
      'attachment-upload-storage',
      'Staging attachment changed before finalization.',
    );
  }
}

function removeOwnedFile(filePath: string | null): void {
  if (filePath === null) return;
  try {
    const layout = ensureStorageLayout();
    const validStagingPath =
      path.dirname(filePath) === layout.stagingDir &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.part$/i.test(
        path.basename(filePath),
      );
    const validReadyPath =
      path.dirname(filePath) === layout.readyDir &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.ready$/i.test(
        path.basename(filePath),
      );
    if (!validStagingPath && !validReadyPath) return;
    const info = lstatSync(filePath);
    if (info.isDirectory() && !info.isSymbolicLink()) return;
    unlinkSync(filePath);
  } catch {
    // Cleanup is best effort; startup cleanup removes the private root as a whole.
  }
}

function unlinkIfFile(filePath: string): void {
  try {
    const info = lstatSync(filePath);
    if (!info.isDirectory() || info.isSymbolicLink()) unlinkSync(filePath);
  } catch (error) {
    if (!isMissingPath(error)) return;
  }
}

function removePrivateTree(treePath: string): void {
  let info;
  try {
    info = lstatSync(treePath);
  } catch (error) {
    if (isMissingPath(error)) return;
    throw uploadError(
      'attachment-upload-storage',
      'Could not inspect private attachment storage.',
      error,
    );
  }
  try {
    if (info.isSymbolicLink() || !info.isDirectory()) unlinkSync(treePath);
    else rmSync(treePath, { recursive: true, force: true });
  } catch (cause) {
    throw uploadError(
      'attachment-upload-storage',
      'Could not clean private attachment storage.',
      cause,
    );
  }
}

function contextIdentityKey(context: MeshCompanionAttachmentContext): string {
  const fields = [
    context.sessionId,
    context.principalId,
    context.accountId,
    context.backendId,
    context.datasetEpoch,
    context.hostEnrollmentId,
    context.machineId,
    context.endpointGeneration,
  ];
  if (
    fields.some((field) => typeof field !== 'string' || field.length === 0 || field.length > 512)
  ) {
    throw uploadError('attachment-upload-invalid', 'Mesh attachment context is invalid.');
  }
  return JSON.stringify(fields);
}

function principalIdentityKey(context: MeshCompanionAttachmentContext): string {
  return JSON.stringify([context.backendId, context.accountId, context.principalId]);
}

function uploadIdentityKey(contextKey: string, uploadId: string): string {
  return JSON.stringify([contextKey, uploadId]);
}

function batchIdentityKey(contextKey: string, batchId: string): string {
  return JSON.stringify([contextKey, batchId]);
}

function assertIdentifier(value: string, label: string): void {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > 256 ||
    hasControlCharacters(value)
  ) {
    throw uploadError('attachment-upload-invalid', `${label} is invalid.`);
  }
}

function assertByteCount(value: number, min: number, max: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw uploadError('attachment-upload-invalid', `${label} is outside its allowed range.`);
  }
}

function normalizeMimeType(value: string): string {
  if (typeof value !== 'string') {
    throw uploadError('attachment-upload-invalid', 'Attachment MIME type is invalid.');
  }
  const normalized = value.trim().toLowerCase();
  if (normalized.length > 127 || !/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(normalized)) {
    throw uploadError('attachment-upload-invalid', 'Attachment MIME type is invalid.');
  }
  return normalized;
}

function sanitizeName(value: string): string {
  if (typeof value !== 'string') {
    throw uploadError('attachment-upload-invalid', 'Attachment name is invalid.');
  }
  const sanitized = value
    .trim()
    .replace(/[\\/:]/g, '-')
    .replace(/\s+/g, ' ');
  const name = Array.from(sanitized, (character) =>
    isControlCharacter(character) ? '-' : character,
  )
    .slice(0, 160)
    .join('');
  return name || 'attachment';
}

function hasControlCharacters(value: string): boolean {
  return Array.from(value).some(isControlCharacter);
}

function isControlCharacter(value: string): boolean {
  const codePoint = value.codePointAt(0) ?? 0;
  return codePoint <= 0x1f || codePoint === 0x7f;
}

function ensureFileExtension(name: string, mimeType: string): string {
  if (path.extname(name)) return name;
  return `${name}${EXTENSION_BY_MIME[mimeType] ?? '.bin'}`;
}

function kindFromMime(mimeType: string): 'image' | 'file' {
  return mimeType.startsWith('image/') ? 'image' : 'file';
}

function isAlreadyExists(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'EEXIST';
}

function isMissingPath(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

function uploadError(
  code: MeshCompanionAttachmentUploadErrorCode,
  message: string,
  cause?: unknown,
): MeshCompanionAttachmentUploadError {
  return new MeshCompanionAttachmentUploadError(code, message, { cause });
}
