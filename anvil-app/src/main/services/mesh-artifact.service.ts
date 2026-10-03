// MESH-03: artifact upload/download client.
//
// Artifact bytes never travel inside RPC envelopes: `artifact.reserve`
// allocates an id + byte allowance and returns an `uploadPath`; the bytes
// are PUT to that worker route with the device bearer; `artifact.finalize`
// verifies size+sha256+media type server-side and publishes the manifest.
// A failed upload is not a successful artifact — the reserved row sweeps
// out if finalize never lands.
//
// The service never imports sync-runtime: the runtime injects the same
// session context shape the worker/observer use.

import { createHash, randomUUID } from 'node:crypto';
import { rpc as backendRpc } from './sync-backend-client.service.js';
import { sealAccountBytes, unsealAccountBytes } from './sync-keyring.service.js';
import { artifactSealAssociatedData } from '../../../cloud/contract/sealed.js';
import type { SyncScope } from '../../shared/sync-mesh.js';
import type {
  ArtifactDescriptor,
  ArtifactFinalizeResult,
  ArtifactGetResult,
  ArtifactListResult,
  ArtifactManifest,
  ArtifactReserveResult,
} from '../../../cloud/contract/artifacts.js';

interface MeshArtifactContext {
  apiUrl: string;
  accessToken: string;
  /** Sync scope for E2E sealing; absent contexts upload/download plaintext. */
  scope?: SyncScope;
}

let contextProvider: (() => MeshArtifactContext | null) | null = null;

export function configureMeshArtifactContext(provider: () => MeshArtifactContext | null): void {
  contextProvider = provider;
}

function artifactContext(): MeshArtifactContext | null {
  return contextProvider?.() ?? null;
}

async function artifactRpc<T>(operation: string, params: unknown): Promise<T> {
  const ctx = artifactContext();
  if (ctx === null) {
    throw new Error('Mesh artifacts have no active sync session.');
  }
  const { result } = await backendRpc<T>(
    { apiUrl: ctx.apiUrl },
    operation,
    params,
    ctx.accessToken,
  );
  return result;
}

/**
 * Worker-side upload: reserve → PUT bytes → finalize. `attemptId` must be
 * one of this worker's active attempts (the backend fence-checks it).
 * Returns the published manifest; throws if any stage fails — a failed
 * upload never leaves a successful artifact.
 */
export async function uploadAttemptArtifact(input: {
  attemptId: string;
  bytes: Uint8Array;
  mediaType: string;
  retentionDays?: number;
}): Promise<ArtifactManifest> {
  const ctx = artifactContext();
  if (ctx === null) {
    throw new Error('Mesh artifacts have no active sync session.');
  }
  // E2E: when the session carries a sync scope, the uploaded bytes are
  // ADK-sealed ciphertext — the manifest records the seal so the backend
  // stores bytes it cannot read, and download unseals after checksum.
  const aad = artifactSealAssociatedData({ mediaType: input.mediaType });
  const sealed =
    ctx.scope !== undefined ? sealAccountBytes(ctx.scope, aad, Buffer.from(input.bytes)) : null;
  const wireBytes: Uint8Array = sealed !== null ? new Uint8Array(sealed.bytes) : input.bytes;
  const sha256 = createHash('sha256').update(wireBytes).digest('hex');
  const reservation = await artifactRpc<ArtifactReserveResult>('artifact.reserve', {
    attemptId: input.attemptId,
    byteLength: wireBytes.byteLength,
    sha256,
    mediaType: input.mediaType,
    ...(input.retentionDays !== undefined ? { retentionDays: input.retentionDays } : {}),
    ...(sealed !== null
      ? { sealed: true, keyVersion: sealed.keyVersion, plaintextBytes: input.bytes.byteLength }
      : {}),
  });
  const response = await fetch(new URL(reservation.uploadPath, ctx.apiUrl), {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${ctx.accessToken}`,
      'Content-Type': input.mediaType,
    },
    body: new Blob([new Uint8Array(wireBytes)]),
  });
  if (!response.ok) {
    throw new Error(`artifact upload failed: HTTP ${response.status}`);
  }
  const finalized = await artifactRpc<ArtifactFinalizeResult>('artifact.finalize', {
    artifactId: reservation.artifactId,
    byteLength: wireBytes.byteLength,
    sha256,
    ...(sealed !== null
      ? { sealed: true, keyVersion: sealed.keyVersion, plaintextBytes: input.bytes.byteLength }
      : {}),
  });
  return finalized.manifest;
}

/** Lists artifact descriptors for a job or attempt (account-scoped read). */
export async function listMeshArtifacts(scope: {
  jobId?: string;
  attemptId?: string;
  state?: string;
  limit?: number;
}): Promise<ArtifactDescriptor[]> {
  const result = await artifactRpc<ArtifactListResult>('artifact.list', scope);
  return result.artifacts;
}

export async function getMeshArtifact(
  artifactId: string,
): Promise<ArtifactGetResult['artifact'] | null> {
  try {
    const result = await artifactRpc<ArtifactGetResult>('artifact.get', { artifactId });
    return result.artifact;
  } catch {
    return null;
  }
}

/**
 * Downloads a published artifact's bytes via the `downloadPath` the
 * backend returns from `artifact.get` — present only while the manifest
 * is `published` and unexpired. Verifies sha256 against the manifest.
 */
export async function downloadMeshArtifact(artifactId: string): Promise<Uint8Array> {
  const ctx = artifactContext();
  if (ctx === null) {
    throw new Error('Mesh artifacts have no active sync session.');
  }
  const { artifact, downloadPath } = await artifactRpc<ArtifactGetResult>('artifact.get', {
    artifactId,
  });
  if (artifact.state !== 'published' || downloadPath === null) {
    throw new Error('artifact is not published');
  }
  const response = await fetch(new URL(downloadPath, ctx.apiUrl), {
    headers: { Authorization: `Bearer ${ctx.accessToken}` },
  });
  if (!response.ok) {
    throw new Error(`artifact download failed: HTTP ${response.status}`);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  if (sha256 !== artifact.sha256) {
    throw new Error('artifact checksum mismatch on download');
  }
  // E2E: sealed manifests carry ciphertext — open it under the declared
  // ADK version. A missing key or tamper throws UnsealError; plaintext is
  // never returned for a sealed manifest.
  if (artifact.sealed === true) {
    if (ctx.scope === undefined || artifact.keyVersion === undefined) {
      throw new Error('artifact is sealed but this session has no sync scope');
    }
    const plain = unsealAccountBytes(
      ctx.scope,
      artifactSealAssociatedData({ mediaType: artifact.mediaType }),
      artifact.keyVersion,
      Buffer.from(bytes),
    );
    if (artifact.plaintextBytes !== undefined && plain.byteLength !== artifact.plaintextBytes) {
      throw new Error('artifact plaintext length mismatch after unseal');
    }
    return new Uint8Array(plain);
  }
  return bytes;
}

export async function deleteMeshArtifact(artifactId: string): Promise<void> {
  await artifactRpc('artifact.delete', { artifactId });
}

export function resetMeshArtifactForTests(): void {
  contextProvider = null;
}

/** Stable helper for artifact ids generated client-side when needed. */
export function newArtifactRequestId(): string {
  return `art-${randomUUID()}`;
}
