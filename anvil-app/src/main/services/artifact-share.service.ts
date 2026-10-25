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
  ShareAudience,
  ShareCreateResult,
  ShareFinalizeResult,
  ShareListResult,
  ShareRevokeResult,
  ShareUpdateResult,
  SharedArtifactDescriptor,
} from '../../../cloud/contract/shares.js';

interface ArtifactShareContext {
  apiUrl: string;
  accessToken: string;
  scopeKey?: string;
  features?: string[];
  hosted?: boolean;
}

let contextProvider: (() => ArtifactShareContext | null) | null = null;

export function configureArtifactShareContext(provider: () => ArtifactShareContext | null): void {
  contextProvider = provider;
}

function shareContext(): ArtifactShareContext | null {
  return contextProvider?.() ?? null;
}

/** True when the active backend has a usable viewer — the share UI gate. */
export function isArtifactSharingAvailable(): boolean {
  const ctx = shareContext();
  return (
    ctx !== null &&
    (ctx.hosted !== false || validConfiguredViewer(process.env.ANVIL_SHARE_BASE_URL))
  );
}

/** Bind reviewed bytes and persisted links to the account/backend that owns them. */
export function artifactShareScope(): string | null {
  const ctx = shareContext();
  return ctx ? (ctx.scopeKey ?? ctx.apiUrl) : null;
}

interface ShareOperationContext extends ArtifactShareContext {
  viewerBaseUrl: string | undefined;
}

const SESSION_CHANGED = 'The sync session changed. Preview the share again.';

function captureContext(expectedScope?: string | null): ShareOperationContext {
  const ctx = shareContext();
  if (ctx === null) throw new Error('Artifact sharing requires an active sync session.');
  if (expectedScope !== undefined && expectedScope !== (ctx.scopeKey ?? ctx.apiUrl)) {
    throw new Error(SESSION_CHANGED);
  }
  return {
    ...ctx,
    features: [...(ctx.features ?? [])],
    viewerBaseUrl: process.env.ANVIL_SHARE_BASE_URL,
  };
}

function assertContext(ctx: ShareOperationContext): void {
  const current = shareContext();
  if (
    current === null ||
    current.apiUrl !== ctx.apiUrl ||
    current.accessToken !== ctx.accessToken ||
    current.scopeKey !== ctx.scopeKey ||
    current.hosted !== ctx.hosted ||
    [...(current.features ?? [])].sort().join('\n') !==
      [...(ctx.features ?? [])].sort().join('\n') ||
    process.env.ANVIL_SHARE_BASE_URL !== ctx.viewerBaseUrl
  ) {
    throw new Error(SESSION_CHANGED);
  }
}

function validConfiguredViewer(value: string | undefined): boolean {
  try {
    if (!value) return false;
    const viewer = new URL(value);
    return (
      viewer.protocol === 'https:' &&
      !viewer.username &&
      !viewer.password &&
      !viewer.search &&
      !viewer.hash
    );
  } catch {
    return false;
  }
}

function viewerAvailable(ctx: ShareOperationContext): boolean {
  // Runtime contexts always supply hosted. Retain compatibility with older
  // injected contexts whose existing guest sharing did not specify it.
  return ctx.hosted !== false || validConfiguredViewer(ctx.viewerBaseUrl);
}

function supportsOrganizationSharing(ctx: ShareOperationContext): boolean {
  if (!ctx.features?.includes('share-audiences/1')) return false;
  return ctx.hosted === true || validConfiguredViewer(ctx.viewerBaseUrl);
}

async function accessOptions(ctx: ShareOperationContext) {
  if (!viewerAvailable(ctx)) {
    return { available: false, organizationSharing: false, organizations: [] };
  }
  const organizationSharing = supportsOrganizationSharing(ctx);
  if (!organizationSharing) {
    return { available: true, organizationSharing: false, organizations: [] };
  }
  const { organizations } = await shareRpc<{
    organizations: Array<{ id: string; name: string }>;
  }>(ctx, 'share.audiences', {});
  if (
    !Array.isArray(organizations) ||
    !organizations.every((org) => typeof org?.id === 'string' && typeof org.name === 'string')
  ) {
    throw new Error('The backend returned invalid organisation access options.');
  }
  return { available: true, organizationSharing: true, organizations };
}

export async function getShareAccessOptions() {
  if (shareContext() === null) {
    return { available: false, organizationSharing: false, organizations: [] };
  }
  return accessOptions(captureContext());
}

async function assertAudience(ctx: ShareOperationContext, audience: ShareAudience): Promise<void> {
  assertContext(ctx);
  if (!viewerAvailable(ctx)) {
    throw new Error(
      'Artifact sharing is unavailable: custom backends require a valid HTTPS share viewer configured in ANVIL_SHARE_BASE_URL.',
    );
  }
  if (audience.kind === 'link') return;
  const access = await accessOptions(ctx);
  if (
    !access.organizationSharing ||
    !access.organizations.some((org) => org.id === audience.organizationId)
  ) {
    throw new Error(
      'Organisation sharing is unavailable for this account or backend. No link was published.',
    );
  }
}

function assertConfirmedAudience(expected: ShareAudience, actual: ShareAudience | undefined): void {
  // Older backends omit policy, and still support the existing anonymous link mode.
  if (actual === undefined && expected.kind === 'link') return;
  if (
    actual?.kind !== expected.kind ||
    (expected.kind === 'organization' &&
      (actual.kind !== 'organization' || actual.organizationId !== expected.organizationId))
  ) {
    throw new Error(
      'The backend did not confirm the requested share access. No link was returned.',
    );
  }
}

async function shareRpc<T>(
  ctx: ShareOperationContext,
  operation: string,
  params: unknown,
): Promise<T> {
  assertContext(ctx);
  try {
    const { result } = await backendRpc<T>(
      { apiUrl: ctx.apiUrl },
      operation,
      params,
      ctx.accessToken,
    );
    return result;
  } finally {
    // Check rejected requests too: a stale not-found must not be mistaken
    // for a completed revocation in the newly active account.
    assertContext(ctx);
  }
}

async function uploadShare(
  ctx: ShareOperationContext,
  uploadPath: string,
  mediaType: string,
  ciphertext: Uint8Array,
): Promise<void> {
  assertContext(ctx);
  if (typeof uploadPath !== 'string' || uploadPath.length === 0) {
    throw new Error(
      'The backend returned an invalid share upload location. No content was uploaded.',
    );
  }
  const url = new URL(uploadPath, ctx.apiUrl);
  if (url.origin !== new URL(ctx.apiUrl).origin || url.username || url.password || url.hash) {
    throw new Error(
      'The backend returned an invalid share upload location. No content was uploaded.',
    );
  }
  try {
    const response = await fetch(url, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${ctx.accessToken}`,
        'Content-Type': mediaType,
      },
      // Never follow an upload redirect with either credentials or shared bytes.
      redirect: 'error',
      body: new Blob([new Uint8Array(ciphertext)]),
    });
    if (!response.ok) throw new Error(`share upload failed: HTTP ${response.status}`);
  } finally {
    assertContext(ctx);
  }
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
  audience?: ShareAudience;
  expectedScope?: string | null;
}): Promise<PublishedShare> {
  const ctx = captureContext(input.expectedScope);
  const audience: ShareAudience = input.audience ? { ...input.audience } : { kind: 'link' };
  await assertAudience(ctx, audience);
  assertContext(ctx);
  const shareKey = randomBytes(32);
  const ciphertext = sealBytesWithKey(
    shareSealAssociatedData({ mediaType: input.mediaType }),
    shareKey,
    Buffer.from(input.bytes),
  );
  const sha256 = createHash('sha256').update(ciphertext).digest('hex');
  const reservation = await shareRpc<ShareCreateResult>(ctx, 'share.create', {
    title: input.title,
    mediaType: input.mediaType,
    byteLength: ciphertext.byteLength,
    sha256,
    sealed: true,
    audience,
    plaintextBytes: input.bytes.byteLength,
    ...(input.expiresInDays !== undefined ? { expiresInDays: input.expiresInDays } : {}),
  });
  if (
    typeof reservation.shareId !== 'string' ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(reservation.shareId)
  ) {
    throw new Error('The backend returned an invalid share reservation. No content was uploaded.');
  }
  assertConfirmedAudience(audience, reservation.audience);
  await uploadShare(ctx, reservation.uploadPath, input.mediaType, ciphertext);
  const finalized = await shareRpc<ShareFinalizeResult>(ctx, 'share.finalize', {
    shareId: reservation.shareId,
    byteLength: ciphertext.byteLength,
    sha256,
    sealed: true,
  });
  assertConfirmedAudience(audience, finalized.share.audience);
  if (finalized.share.shareId !== reservation.shareId) {
    throw new Error('The backend returned a different share. No link was returned.');
  }
  return {
    share: finalized.share,
    shareKey: shareKey.toString('base64url'),
  };
}

/**
 * Replaces a published share's bytes under the same share id, so the
 * link (and its fragment key) stays stable: seal with the EXISTING key →
 * `share.update` reserve → PUT → `share.finalize` (atomic swap after the
 * backend verifies size + sha256). `sealBytesWithKey` draws a fresh random
 * 96-bit GCM nonce on every call, so reusing the key never reuses a
 * nonce. `mediaType` must equal the share's original media type: it is
 * bound into the seal's associated data and the backend keeps it fixed.
 */
export async function updateSharedArtifact(input: {
  shareId: string;
  title?: string;
  shareKey: string;
  bytes: Uint8Array;
  mediaType: string;
  audience?: ShareAudience;
  expectedScope?: string | null;
}): Promise<SharedArtifactDescriptor> {
  const ctx = captureContext(input.expectedScope);
  const audience: ShareAudience = input.audience ? { ...input.audience } : { kind: 'link' };
  await assertAudience(ctx, audience);
  assertContext(ctx);
  const key = Buffer.from(input.shareKey, 'base64url');
  if (key.byteLength !== 32) {
    throw new Error('The stored share key is malformed; share as a new link instead.');
  }
  const ciphertext = sealBytesWithKey(
    shareSealAssociatedData({ mediaType: input.mediaType }),
    key,
    Buffer.from(input.bytes),
  );
  const sha256 = createHash('sha256').update(ciphertext).digest('hex');
  const reservation = await shareRpc<ShareUpdateResult>(ctx, 'share.update', {
    shareId: input.shareId,
    ...(input.title !== undefined ? { title: input.title } : {}),
    byteLength: ciphertext.byteLength,
    sha256,
    sealed: true,
    plaintextBytes: input.bytes.byteLength,
  });
  if (
    input.title !== undefined &&
    (typeof reservation.updateToken !== 'string' ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(reservation.updateToken))
  ) {
    throw new Error(
      'This backend must be upgraded to update shared titles. No content was uploaded.',
    );
  }
  assertConfirmedAudience(audience, reservation.audience);
  await uploadShare(ctx, reservation.uploadPath, input.mediaType, ciphertext);
  const finalized = await shareRpc<ShareFinalizeResult>(ctx, 'share.finalize', {
    shareId: input.shareId,
    ...(reservation.updateToken !== undefined ? { updateToken: reservation.updateToken } : {}),
    byteLength: ciphertext.byteLength,
    sha256,
    sealed: true,
  });
  assertConfirmedAudience(audience, finalized.share.audience);
  if (input.title !== undefined && finalized.share.title !== input.title) {
    throw new Error(
      'The backend did not confirm the replacement share title. No updated link was returned.',
    );
  }
  if (finalized.share.shareId !== input.shareId) {
    throw new Error('The backend returned a different share. No link was returned.');
  }
  return finalized.share;
}

export async function listSharedArtifacts(scope?: {
  state?: string;
  limit?: number;
}): Promise<SharedArtifactDescriptor[]> {
  const ctx = captureContext();
  const result = await shareRpc<ShareListResult>(ctx, 'share.list', scope ?? {});
  return result.shares;
}

export async function revokeSharedArtifact(
  shareId: string,
  options?: { expectedScope?: string | null },
): Promise<void> {
  const ctx = captureContext(options?.expectedScope);
  await shareRpc<ShareRevokeResult>(ctx, 'share.revoke', { shareId });
}

export function resetArtifactShareForTests(): void {
  contextProvider = null;
}
