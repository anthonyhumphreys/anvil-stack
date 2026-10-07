import { randomUUID, createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatAttachment } from '../../../shared/types.js';

const state = vi.hoisted(() => ({ userDataDir: '' }));
vi.mock('electron', () => ({ app: { getPath: () => state.userDataDir } }));

import { prepareChatAttachments } from '../chat-attachment.service.js';
import {
  beginMeshCompanionAttachmentUpload,
  claimMeshCompanionAttachmentReferences,
  cleanupMeshCompanionAttachmentUploads,
  expireMeshCompanionAttachmentUploads,
  finishMeshCompanionAttachmentUpload,
  MESH_COMPANION_ATTACHMENT_CHUNK_BYTES,
  MESH_COMPANION_ATTACHMENT_MAX_FILE_BYTES,
  MeshCompanionAttachmentUploadError,
  registerMeshCompanionPreparedAttachments,
  writeMeshCompanionAttachmentChunk,
  type MeshCompanionAttachmentContext,
} from '../mesh-companion-attachment-upload.service.js';

const context: MeshCompanionAttachmentContext = {
  sessionId: 'session-a',
  principalId: 'principal-a',
  accountId: 'account-a',
  backendId: 'backend-a',
  datasetEpoch: 'epoch-a',
  hostEnrollmentId: 'enrollment-a',
  machineId: 'machine-a',
  endpointGeneration: 'generation-a',
};

beforeEach(() => {
  if (state.userDataDir) cleanupMeshCompanionAttachmentUploads(state.userDataDir);
  if (state.userDataDir) rmSync(state.userDataDir, { recursive: true, force: true });
  state.userDataDir = mkdtempSync(path.join(tmpdir(), 'anvil-mesh-attachments-'));
});

afterEach(() => cleanupMeshCompanionAttachmentUploads(state.userDataDir));

describe('Mesh companion attachment uploads', () => {
  it('writes bounded chunks, replays the duplicate last chunk, verifies SHA-256, and claims once', () => {
    const bytes = Buffer.from('mesh upload bytes');
    const input = {
      batchId: 'batch-a',
      uploadId: 'upload-a',
      name: 'notes.txt',
      mimeType: 'text/plain',
      totalBytes: bytes.byteLength,
    };
    const begun = beginMeshCompanionAttachmentUpload(context, input);
    expect(begun).toEqual({
      batchId: 'batch-a',
      uploadId: 'upload-a',
      nextOffset: 0,
      chunkBytes: MESH_COMPANION_ATTACHMENT_CHUNK_BYTES,
    });
    expect(beginMeshCompanionAttachmentUpload(context, input)).toEqual(begun);
    expect(() =>
      beginMeshCompanionAttachmentUpload(context, { ...input, totalBytes: input.totalBytes + 1 }),
    ).toThrow(expect.objectContaining({ code: 'attachment-upload-conflict' }));

    const chunk = bytes.toString('base64');
    expect(
      writeMeshCompanionAttachmentChunk(context, {
        uploadId: 'upload-a',
        offset: 0,
        bytesBase64: chunk,
      }),
    ).toEqual({ uploadId: 'upload-a', nextOffset: bytes.byteLength });
    expect(
      writeMeshCompanionAttachmentChunk(context, {
        uploadId: 'upload-a',
        offset: 0,
        bytesBase64: chunk,
      }),
    ).toEqual({ uploadId: 'upload-a', nextOffset: bytes.byteLength });
    expect(() =>
      writeMeshCompanionAttachmentChunk(context, {
        uploadId: 'upload-a',
        offset: 0,
        bytesBase64: Buffer.from('tampered').toString('base64'),
      }),
    ).toThrow(MeshCompanionAttachmentUploadError);
    expect(() =>
      finishMeshCompanionAttachmentUpload(context, {
        uploadId: 'upload-a',
        sha256: '0'.repeat(64),
      }),
    ).toThrow(expect.objectContaining({ code: 'attachment-upload-checksum' }));

    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const reference = finishMeshCompanionAttachmentUpload(context, {
      uploadId: 'upload-a',
      sha256,
    });
    expect('path' in reference).toBe(false);
    expect(finishMeshCompanionAttachmentUpload(context, { uploadId: 'upload-a', sha256 })).toEqual(
      reference,
    );

    const [attachment] = claimMeshCompanionAttachmentReferences(context, {
      batchId: 'batch-a',
      attachmentIds: [reference.id],
    });
    expect(attachment).toMatchObject({
      id: reference.id,
      name: 'notes.txt',
      mimeType: 'text/plain',
      size: bytes.byteLength,
    });
    expect(attachment?.path).toContain(path.join(state.userDataDir, 'chat-attachments'));
    expect(readFileSync(attachment?.path ?? '')).toEqual(bytes);
    expect(() =>
      claimMeshCompanionAttachmentReferences(context, {
        batchId: 'batch-a',
        attachmentIds: [reference.id],
      }),
    ).toThrow(expect.objectContaining({ code: 'attachment-upload-conflict' }));
  });

  it('fences every session and host identity field', () => {
    const alteredContexts: MeshCompanionAttachmentContext[] = [
      { ...context, sessionId: 'session-b' },
      { ...context, principalId: 'principal-b' },
      { ...context, accountId: 'account-b' },
      { ...context, backendId: 'backend-b' },
      { ...context, datasetEpoch: 'epoch-b' },
      { ...context, hostEnrollmentId: 'enrollment-b' },
      { ...context, machineId: 'machine-b' },
      { ...context, endpointGeneration: 'generation-b' },
    ];
    beginMeshCompanionAttachmentUpload(context, {
      batchId: 'batch-a',
      uploadId: 'upload-a',
      name: 'notes.txt',
      mimeType: 'text/plain',
      totalBytes: 1,
    });

    for (const altered of alteredContexts) {
      expect(() =>
        writeMeshCompanionAttachmentChunk(altered, {
          uploadId: 'upload-a',
          offset: 0,
          bytesBase64: Buffer.from('x').toString('base64'),
        }),
      ).toThrow(expect.objectContaining({ code: 'attachment-upload-not-found' }));
    }
  });

  it('enforces batch, per-principal, and global open-upload quotas', () => {
    for (let index = 0; index < 10; index += 1) {
      beginMeshCompanionAttachmentUpload(context, {
        batchId: 'batch-files',
        uploadId: `upload-${index}`,
        name: `empty-${index}.txt`,
        mimeType: 'text/plain',
        totalBytes: 0,
      });
    }
    expect(() =>
      beginMeshCompanionAttachmentUpload(context, {
        batchId: 'batch-files',
        uploadId: 'upload-over-limit',
        name: 'too-many.txt',
        mimeType: 'text/plain',
        totalBytes: 0,
      }),
    ).toThrow(expect.objectContaining({ code: 'attachment-upload-quota' }));

    cleanupMeshCompanionAttachmentUploads(state.userDataDir);
    for (let index = 0; index < 3; index += 1) {
      beginMeshCompanionAttachmentUpload(context, {
        batchId: `batch-bytes-${index}`,
        uploadId: `upload-bytes-${index}`,
        name: 'reserved.bin',
        mimeType: 'application/octet-stream',
        totalBytes: MESH_COMPANION_ATTACHMENT_MAX_FILE_BYTES,
      });
    }
    expect(() =>
      beginMeshCompanionAttachmentUpload(context, {
        batchId: 'batch-principal-over-limit',
        uploadId: 'upload-principal-over-limit',
        name: 'reserved.bin',
        mimeType: 'application/octet-stream',
        totalBytes: 1,
      }),
    ).toThrow(expect.objectContaining({ code: 'attachment-upload-quota' }));

    cleanupMeshCompanionAttachmentUploads(state.userDataDir);
    for (let index = 0; index < 12; index += 1) {
      beginMeshCompanionAttachmentUpload(
        { ...context, principalId: `principal-${index}` },
        {
          batchId: `batch-global-${index}`,
          uploadId: `upload-global-${index}`,
          name: 'reserved.bin',
          mimeType: 'application/octet-stream',
          totalBytes: MESH_COMPANION_ATTACHMENT_MAX_FILE_BYTES,
        },
      );
    }
    expect(() =>
      beginMeshCompanionAttachmentUpload(
        { ...context, principalId: 'principal-global-over-limit' },
        {
          batchId: 'batch-global-over-limit',
          uploadId: 'upload-global-over-limit',
          name: 'reserved.bin',
          mimeType: 'application/octet-stream',
          totalBytes: 1,
        },
      ),
    ).toThrow(expect.objectContaining({ code: 'attachment-upload-quota' }));

    cleanupMeshCompanionAttachmentUploads(state.userDataDir);
    for (let index = 0; index < 10; index += 1) {
      beginMeshCompanionAttachmentUpload(context, {
        batchId: `batch-count-${index}`,
        uploadId: `upload-count-${index}`,
        name: 'empty.txt',
        mimeType: 'text/plain',
        totalBytes: 0,
      });
    }
    expect(() =>
      beginMeshCompanionAttachmentUpload(context, {
        batchId: 'batch-count-over-limit',
        uploadId: 'upload-count-over-limit',
        name: 'empty.txt',
        mimeType: 'text/plain',
        totalBytes: 0,
      }),
    ).toThrow(expect.objectContaining({ code: 'attachment-upload-quota' }));

    cleanupMeshCompanionAttachmentUploads(state.userDataDir);
    for (let index = 0; index < 64; index += 1) {
      beginMeshCompanionAttachmentUpload(
        { ...context, principalId: `principal-count-${index}` },
        {
          batchId: `batch-global-count-${index}`,
          uploadId: `upload-global-count-${index}`,
          name: 'empty.txt',
          mimeType: 'text/plain',
          totalBytes: 0,
        },
      );
    }
    expect(() =>
      beginMeshCompanionAttachmentUpload(
        { ...context, principalId: 'principal-global-count-over-limit' },
        {
          batchId: 'batch-global-count-over-limit',
          uploadId: 'upload-global-count-over-limit',
          name: 'empty.txt',
          mimeType: 'text/plain',
          totalBytes: 0,
        },
      ),
    ).toThrow(expect.objectContaining({ code: 'attachment-upload-quota' }));
  });

  it('expires incomplete uploads and removes only its private staging root on restart', () => {
    beginMeshCompanionAttachmentUpload(context, {
      batchId: 'batch-expire',
      uploadId: 'upload-expire',
      name: 'partial.txt',
      mimeType: 'text/plain',
      totalBytes: 1,
    });
    const privateRoot = path.join(state.userDataDir, 'mesh-companion-attachment-uploads');
    expect(existsSync(privateRoot)).toBe(true);
    expireMeshCompanionAttachmentUploads(Date.now() + 16 * 60 * 1000);
    expect(() =>
      writeMeshCompanionAttachmentChunk(context, {
        uploadId: 'upload-expire',
        offset: 0,
        bytesBase64: Buffer.from('x').toString('base64'),
      }),
    ).toThrow(expect.objectContaining({ code: 'attachment-upload-not-found' }));

    const expiredReady = createReadyUpload(
      Buffer.from('expired ready'),
      'batch-ready-expire',
      'upload-ready-expire',
    );
    expireMeshCompanionAttachmentUploads(Date.now() + 16 * 60 * 1000);
    expect(() =>
      claimMeshCompanionAttachmentReferences(context, {
        batchId: 'batch-ready-expire',
        attachmentIds: [expiredReady.reference.id],
      }),
    ).toThrow(expect.objectContaining({ code: 'attachment-upload-not-found' }));

    const ready = createReadyUpload(Buffer.from('ready'), 'batch-restart', 'upload-restart');
    const managedDir = path.join(state.userDataDir, 'chat-attachments');
    mkdirSync(managedDir, { recursive: true });
    const unclaimedDir = path.join(managedDir, '.mesh-companion-unclaimed');
    expect(existsSync(unclaimedDir)).toBe(true);
    const existingManagedFile = path.join(managedDir, 'keep-existing');
    writeFileSync(existingManagedFile, 'existing chat attachment');
    expect(ready.reference.id).toBeTruthy();

    cleanupMeshCompanionAttachmentUploads(state.userDataDir);
    expect(existsSync(privateRoot)).toBe(false);
    expect(existsSync(unclaimedDir)).toBe(false);
    expect(readFileSync(existingManagedFile, 'utf8')).toBe('existing chat attachment');
    expect(() =>
      claimMeshCompanionAttachmentReferences(context, {
        batchId: 'batch-restart',
        attachmentIds: [ready.reference.id],
      }),
    ).toThrow(expect.objectContaining({ code: 'attachment-upload-not-found' }));
  });

  it('registers freshly prepared host attachments by copying into owned storage', () => {
    const source = prepareChatAttachments([
      {
        id: randomUUID(),
        name: 'prepared.txt',
        mimeType: 'text/plain',
        dataUrl: `data:text/plain;base64,${Buffer.from('from desktop').toString('base64')}`,
      },
    ])[0] as ChatAttachment;
    const references = registerMeshCompanionPreparedAttachments(context, {
      batchId: 'batch-prepared',
      attachments: [source],
    });
    expect(references).toHaveLength(1);
    expect(existsSync(source.path)).toBe(true);
    expect(
      registerMeshCompanionPreparedAttachments(context, {
        batchId: 'batch-prepared',
        attachments: [source],
      }),
    ).toEqual(references);

    // The host wrapper owns its short-lived inline source and can remove it after registration.
    rmSync(source.path);
    const [claimed] = claimMeshCompanionAttachmentReferences(context, {
      batchId: 'batch-prepared',
      attachmentIds: [references[0]?.id ?? ''],
    });
    expect(readFileSync(claimed?.path ?? '', 'utf8')).toBe('from desktop');
  });

  it('rejects host paths outside freshly generated managed attachments', () => {
    const outsidePath = path.join(state.userDataDir, 'secret.txt');
    writeFileSync(outsidePath, 'secret');
    const invalid = {
      id: randomUUID(),
      name: 'secret.txt',
      mimeType: 'text/plain',
      size: 6,
      kind: 'file',
      path: outsidePath,
      createdAt: new Date().toISOString(),
    } satisfies ChatAttachment;

    expect(() =>
      registerMeshCompanionPreparedAttachments(context, {
        batchId: 'batch-invalid',
        attachments: [invalid],
      }),
    ).toThrow(expect.objectContaining({ code: 'attachment-upload-invalid' }));
  });
});

function createReadyUpload(bytes: Buffer, batchId: string, uploadId: string) {
  beginMeshCompanionAttachmentUpload(context, {
    batchId,
    uploadId,
    name: 'ready.txt',
    mimeType: 'text/plain',
    totalBytes: bytes.byteLength,
  });
  if (bytes.byteLength > 0) {
    writeMeshCompanionAttachmentChunk(context, {
      uploadId,
      offset: 0,
      bytesBase64: bytes.toString('base64'),
    });
  }
  const reference = finishMeshCompanionAttachmentUpload(context, {
    uploadId,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  });
  return { reference };
}
