// Hosted artifact sharing: durable user content published behind a
// revocable share id (anvilstack.dev/artifacts/{shareId}).
//
// Shares reuse the artifact lifecycle — reserve, upload out of band,
// verify, publish — but are user-actor operations with no job/attempt
// binding. The share id is an unguessable capability; every public read
// resolves through the hosted service channel and enforces state, expiry,
// and revocation at read time, so a share URL never outlives revocation.

export type SharedArtifactState = 'reserved' | 'uploaded' | 'published' | 'revoked' | 'expired';

export interface SharedArtifactDescriptor {
  /** Unguessable public id; the share URL path segment. */
  shareId: string;
  /** Account identity is server-derived; never accepted client-side. */
  title: string;
  mediaType: string;
  /** Stored byte length — ciphertext length when `sealed`. */
  byteLength: number;
  /** sha256 over the stored bytes. */
  sha256: string;
  state: SharedArtifactState;
  createdAt: string;
  publishedAt: string | null;
  /** Share expiry; null until published. */
  expiresAt: string | null;
  revokedAt: string | null;
  /**
   * E2E marker: when true the stored bytes are AES-256-GCM ciphertext and
   * the decryption key travels only in the share URL fragment (`#k=…`),
   * which never reaches the server.
   */
  sealed?: boolean;
  /** Pre-encryption byte length; present when sealed. */
  plaintextBytes?: number;
}

export const SHARED_ARTIFACT_TRANSITIONS: Record<
  SharedArtifactState,
  readonly SharedArtifactState[]
> = {
  reserved: ['uploaded', 'expired'],
  uploaded: ['published', 'expired'],
  published: ['revoked', 'expired'],
  revoked: [],
  expired: [],
};

export function canTransitionSharedArtifact(
  from: SharedArtifactState,
  to: SharedArtifactState,
): boolean {
  return SHARED_ARTIFACT_TRANSITIONS[from].includes(to);
}

/** `share.create` (user actor): allocates the share id + byte allowance. */
export interface ShareCreateParams {
  title: string;
  mediaType: string;
  byteLength: number;
  sha256: string;
  /** Days until the published share expires; backend-bounded. */
  expiresInDays?: number;
  /** True when the uploaded bytes will be client-sealed ciphertext. */
  sealed?: boolean;
  plaintextBytes?: number;
}

export interface ShareCreateResult {
  shareId: string;
  /** API path the bytes are PUT to; resolved against the negotiated base. */
  uploadPath: string;
  expiresAt: string;
}

export interface ShareFinalizeParams {
  shareId: string;
  byteLength: number;
  sha256: string;
}

export interface ShareFinalizeResult {
  share: SharedArtifactDescriptor;
}

export interface ShareListParams {
  state?: SharedArtifactState;
  limit?: number;
}

export interface ShareListResult {
  shares: SharedArtifactDescriptor[];
}

export interface ShareRevokeParams {
  shareId: string;
}

export interface ShareRevokeResult {
  share: SharedArtifactDescriptor;
}
