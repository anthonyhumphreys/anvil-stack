// Hosted artifact sharing client: publishes durable user content behind
// a revocable share id the website serves at /artifacts/{shareId}.
//
// Same reserve → PUT bytes → finalize lifecycle as mesh artifacts: bytes
// never travel inside RPC envelopes, `share.create` allocates the share
// id + byte allowance and returns an `uploadPath`, and `share.finalize`
// verifies size+sha256 server-side before the share can resolve.
//
// The service never imports sync-runtime: the runtime injects the same
// session context shape the worker/observer use.

import { createHash, randomBytes } from 'node:crypto';
import { rpc as backendRpc } from './sync-backend-client.service.js';
import { sealBytesWithKey } from './sync-keyring.service.js';
import { shareSealAssociatedData } from '../../../cloud/contract/sealed.js';
import type {
  ShareCreateResult,
  ShareFinalizeResult,
  ShareListResult,
  ShareRevokeResult,
  SharedArtifactDescriptor,
} from '../../../cloud/contract/shares.js';

interface ArtifactShareContext {
  apiUrl: string;
  accessToken: string;
}

let contextProvider: (() => ArtifactShareContext | null) | null = null;

export function configureArtifactShareContext(provider: () => ArtifactShareContext | null): void {
  contextProvider = provider;
}

function shareContext(): ArtifactShareContext | null {
  return contextProvider?.() ?? null;
}

/** True when a backend session exists — the share UI gate. */
export function isArtifactSharingAvailable(): boolean {
  return shareContext() !== null;
}

async function shareRpc<T>(operation: string, params: unknown): Promise<T> {
  const ctx = shareContext();
  if (ctx === null) {
    throw new Error('Artifact sharing requires an active sync session.');
  }
  const { result } = await backendRpc<T>(
    { apiUrl: ctx.apiUrl },
    operation,
    params,
    ctx.accessToken,
  );
  return result;
}

export interface PublishedShare {
  share: SharedArtifactDescriptor;
  /**
   * Base64url decryption key for the share URL fragment (`#k=…`). The
   * stored bytes are ciphertext sealed under this one-off key; the key
   * is never sent to the backend, and URL fragments never reach the
   * server on read either — decryption happens in the reader's browser.
   */
  shareKey: string;
}

/**
 * Publishes bytes as a shared artifact: seal → reserve → PUT → finalize.
 * The uploaded bytes are AES-256-GCM ciphertext under a fresh per-share
 * key; the backend stores bytes it cannot read. Returns the published
 * descriptor plus the fragment key for the share URL. Throws if any
 * stage fails — a failed upload never leaves a resolvable share.
 */
export async function publishSharedArtifact(input: {
  title: string;
  bytes: Uint8Array;
  mediaType: string;
  expiresInDays?: number;
}): Promise<PublishedShare> {
  const ctx = shareContext();
  if (ctx === null) {
    throw new Error('Artifact sharing requires an active sync session.');
  }
  const shareKey = randomBytes(32);
  const ciphertext = sealBytesWithKey(
    shareSealAssociatedData({ mediaType: input.mediaType }),
    shareKey,
    Buffer.from(input.bytes),
  );
  const sha256 = createHash('sha256').update(ciphertext).digest('hex');
  const reservation = await shareRpc<ShareCreateResult>('share.create', {
    title: input.title,
    mediaType: input.mediaType,
    byteLength: ciphertext.byteLength,
    sha256,
    sealed: true,
    plaintextBytes: input.bytes.byteLength,
    ...(input.expiresInDays !== undefined ? { expiresInDays: input.expiresInDays } : {}),
  });
  const response = await fetch(new URL(reservation.uploadPath, ctx.apiUrl), {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${ctx.accessToken}`,
      'Content-Type': input.mediaType,
    },
    body: new Blob([new Uint8Array(ciphertext)]),
  });
  if (!response.ok) {
    throw new Error(`share upload failed: HTTP ${response.status}`);
  }
  const finalized = await shareRpc<ShareFinalizeResult>('share.finalize', {
    shareId: reservation.shareId,
    byteLength: ciphertext.byteLength,
    sha256,
    sealed: true,
  });
  return {
    share: finalized.share,
    shareKey: shareKey.toString('base64url'),
  };
}

export async function listSharedArtifacts(scope?: {
  state?: string;
  limit?: number;
}): Promise<SharedArtifactDescriptor[]> {
  const result = await shareRpc<ShareListResult>('share.list', scope ?? {});
  return result.shares;
}

export async function revokeSharedArtifact(shareId: string): Promise<void> {
  await shareRpc<ShareRevokeResult>('share.revoke', { shareId });
}

export function resetArtifactShareForTests(): void {
  contextProvider = null;
}
