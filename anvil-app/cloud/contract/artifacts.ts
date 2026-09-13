// Artifact lifecycle: reserve, upload out of band, verify, publish.
//
// Uploads happen outside any metadata transaction with an upload
// reservation and a final verified manifest. There is intentionally no
// atomic SQL/R2 transaction; recovery reconciles the states below and
// orphan cleanup is idempotent.

export type ArtifactState =
  | 'reserved'
  | 'uploaded'
  | 'published'
  | 'deleting'
  | 'deleted'
  | 'expired';

export interface ArtifactManifest {
  id: string;
  /** Account identity is server-derived; never accepted client-side. */
  attemptId: string;
  byteLength: number;
  sha256: string;
  mediaType: string;
  retentionDays: number;
  state: ArtifactState;
}

export interface ArtifactReserveParams {
  attemptId: string;
  byteLength: number;
  sha256: string;
  mediaType: string;
  retentionDays?: number;
}

export interface ArtifactReserveResult {
  artifactId: string;
  /** API path the bytes are PUT to; resolved against the negotiated base. */
  uploadPath: string;
  expiresAt: string;
}

export interface ArtifactFinalizeParams {
  artifactId: string;
  byteLength: number;
  sha256: string;
}

export interface ArtifactFinalizeResult {
  manifest: ArtifactManifest;
}

/**
 * Allowed artifact transitions. A failed upload never becomes a successful
 * artifact: `reserved` may only move to `uploaded` after verified bytes
 * land, and only `uploaded` may publish. Deletion always passes through
 * `deleting` so recovery can finish interrupted purges.
 */
export const ARTIFACT_TRANSITIONS: Record<ArtifactState, readonly ArtifactState[]> = {
  reserved: ['uploaded', 'deleting', 'expired'],
  uploaded: ['published', 'deleting', 'expired'],
  published: ['deleting', 'expired'],
  deleting: ['deleted'],
  deleted: [],
  expired: [],
};

export function canTransitionArtifact(from: ArtifactState, to: ArtifactState): boolean {
  return ARTIFACT_TRANSITIONS[from].includes(to);
}

// ---- MESH-03 artifact RPC shapes ------------------------------------------
// Manifest reads/deletes ride the RPC envelope; bytes move on the Worker's
// `PUT/GET /v1/artifacts/{artifactId}` routes under the same bearer auth.

/** A manifest plus its backend bookkeeping fields. */
export interface ArtifactDescriptor extends ArtifactManifest {
  jobId: string;
  createdAt: string;
  updatedAt: string;
  publishedAt: string | null;
  /** Retention expiry; null until published. */
  expiresAt: string | null;
}

export interface ArtifactGetParams {
  artifactId: string;
}

export interface ArtifactGetResult {
  artifact: ArtifactDescriptor;
  /**
   * Bounded read route (`GET` under the negotiated base). Present only
   * while the artifact is `published` and unexpired.
   */
  downloadPath: string | null;
}

/** `artifact.list`: at least one of `jobId`/`attemptId` is required. */
export interface ArtifactListParams {
  jobId?: string;
  attemptId?: string;
  state?: ArtifactState;
  /** Page size, bounded by the backend. */
  limit?: number;
}

export interface ArtifactListResult {
  artifacts: ArtifactDescriptor[];
}

export interface ArtifactDeleteParams {
  artifactId: string;
}

export interface ArtifactDeleteResult {
  artifact: ArtifactDescriptor;
}
