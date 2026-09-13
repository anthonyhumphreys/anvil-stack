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
import type {
  ArtifactFinalizeResult,
  ArtifactManifest,
  ArtifactReserveResult,
} from '../../../cloud/contract/artifacts.js';

interface MeshArtifactContext {
  apiUrl: string;
  accessToken: string;
}

let contextProvider: (() => MeshArtifactContext | null) | null = null;

export function configureMeshArtifactContext(
  provider: () => MeshArtifactContext | null,
): void {
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
  const sha256 = createHash('sha256').update(input.bytes).digest('hex');
  const reservation = await artifactRpc<ArtifactReserveResult>('artifact.reserve', {
    attemptId: input.attemptId,
    byteLength: input.bytes.byteLength,
    sha256,
    mediaType: input.mediaType,
    ...(input.retentionDays !== undefined ? { retentionDays: input.retentionDays } : {}),
  });
  const response = await fetch(new URL(reservation.uploadPath, ctx.apiUrl), {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${ctx.accessToken}`,
      'Content-Type': input.mediaType,
    },
    body: new Blob([new Uint8Array(input.bytes)]),
  });
  if (!response.ok) {
    throw new Error(`artifact upload failed: HTTP ${response.status}`);
  }
  const finalized = await artifactRpc<ArtifactFinalizeResult>('artifact.finalize', {
    artifactId: reservation.artifactId,
    byteLength: input.bytes.byteLength,
    sha256,
  });
  return finalized.manifest;
}

/** Lists artifact manifests for a job or attempt (account-scoped read). */
export async function listMeshArtifacts(scope: {
  jobId?: string;
  attemptId?: string;
}): Promise<ArtifactManifest[]> {
  const result = await artifactRpc<{ artifacts: ArtifactManifest[] }>('artifact.list', scope);
  return result.artifacts;
}

export async function getMeshArtifact(artifactId: string): Promise<ArtifactManifest | null> {
  const result = await artifactRpc<{ manifest: ArtifactManifest | null }>('artifact.get', {
    artifactId,
  });
  return result.manifest ?? null;
}

/**
 * Downloads a published artifact's bytes via the worker GET route.
 * `downloadPath` comes from the manifest's companion field when present;
 * otherwise the conventional route is used.
 */
export async function downloadMeshArtifact(artifactId: string): Promise<Uint8Array> {
  const ctx = artifactContext();
  if (ctx === null) {
    throw new Error('Mesh artifacts have no active sync session.');
  }
  const manifest = await getMeshArtifact(artifactId);
  if (manifest === null || manifest.state !== 'published') {
    throw new Error('artifact is not published');
  }
  const response = await fetch(new URL(`v1/artifacts/${artifactId}`, ctx.apiUrl), {
    headers: { Authorization: `Bearer ${ctx.accessToken}` },
  });
  if (!response.ok) {
    throw new Error(`artifact download failed: HTTP ${response.status}`);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  if (sha256 !== manifest.sha256) {
    throw new Error('artifact checksum mismatch on download');
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
