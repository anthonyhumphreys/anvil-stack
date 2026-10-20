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
  /**
   * Content version: 1 at publish, incremented by every completed
   * `share.update`. The share id (and so the URL) never changes.
   */
  version?: number;
  /** When the published bytes were last replaced by `share.update`; null if never. */
  updatedAt?: string | null;
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

/**
 * Finalizes either a fresh reservation (publishes it) or a pending
 * `share.update` on a published share (swaps the bytes in place).
 */
export interface ShareFinalizeParams {
  shareId: string;
  byteLength: number;
  sha256: string;
  sealed?: boolean;
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

/**
 * `share.update` (user actor): reserves replacement bytes for a
 * `published` share so its link stays stable. The bytes are PUT to the
 * returned `uploadPath` (the same route as the original upload) and a
 * following `share.finalize` swaps them in atomically after size + sha256
 * verification. Until then — and if verification fails — readers keep
 * getting the current bytes. The share keeps its id, `published` state,
 * expiry and media type; `sealed` must match the original reservation.
 */
export interface ShareUpdateParams {
  shareId: string;
  byteLength: number;
  sha256: string;
  sealed?: boolean;
  plaintextBytes?: number;
}

export interface ShareUpdateResult {
  /** API path the replacement bytes are PUT to. */
  uploadPath: string;
  /** Deadline for the replacement upload + finalize. */
  expiresAt: string;
}
