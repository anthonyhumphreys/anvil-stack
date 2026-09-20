/**
 * Account trust-policy and recovery-code orchestration.
 *
 * This module deliberately sits between the sync runtime and the two smaller
 * primitives: the backend security RPCs and the local recovery/keyring
 * service.  The backend can authorize a device, but it never receives an
 * account key or a recovery secret.  In particular, a backend `trusted`
 * response is not sufficient to make this process wrap or release local key
 * material; recovery unlock commits only after a client-side code decrypts
 * the opaque envelope.
 */

import type {
  RecoveryEnvelope,
  RecoveryRequestBinding,
} from '../../../cloud/contract/device-security.js';
import { parseRecoveryEnvelope } from '../../../cloud/contract/device-security.js';
import type { SyncScope } from '../../shared/sync-mesh.js';
import type {
  SyncDeviceRecoveryResult,
  SyncDeviceSecurityEvent,
  SyncDeviceSecurityStatus,
  SyncDeviceTrustPolicy,
  SyncDeviceTrustSource,
  SyncDeviceTrustState,
} from '../../shared/sync-device-security.js';
import {
  buildRecoveryRequestSignature,
  commitRecoverySetup,
  commitRecoveryUnlock,
  createRecoverySetup,
  formatRecoveryCode,
  prepareRecoveryUnlock,
  recoveryPayloadHash,
  refreshRecoveryEnvelope,
  RecoverySecretMissingError,
  type PreparedRecoveryUnlock,
} from './sync-recovery.service.js';
import {
  currentRecoveryId,
  ensureDeviceIdentity,
  exportAccountKeyBundle,
  hasAccountKey as localHasAccountKey,
  importAccountKeyBundle,
  recoverySecretFor,
  recoverySecretForRefresh,
} from './sync-keyring.service.js';

export interface SyncDeviceSecurityContext {
  scope: SyncScope;
  enrollmentId: string;
  rpc<R>(operation: string, params: unknown): Promise<R>;
  /** Throws when the sign-in/session generation or backend binding changed. */
  assertCurrent(): void;
}

interface RecoveryView {
  envelope: RecoveryEnvelope | null;
  recoveryId: string | null;
  verifierPublicKey: string | null;
  revision: number;
}

interface SecurityView {
  accountId?: unknown;
  policy?: unknown;
  revision?: unknown;
  recoveryRevision?: unknown;
  recovery?: unknown;
  trustState?: unknown;
  trustSource?: unknown;
  canConfigure?: unknown;
  requiresRecovery?: unknown;
  recentEvents?: unknown;
  recoveryInvalidated?: unknown;
  requiresRecoveryReplacement?: unknown;
  recoveryValid?: unknown;
}

interface SecurityChallenge {
  challengeId: string;
  challenge: string;
  accountId: string;
  enrollmentId: string;
  action: string;
  accountRevision: number;
  recoveryRevision: number;
  recoveryId: string | null;
  backendId: string;
  identityPub: string;
  payloadHash: string;
}

interface SecurityProof {
  challengeId: string;
  signature: string;
  identityPub: string;
  payloadHash: string;
}

const scopeLocks = new Map<string, Promise<void>>();

function scopeKey(scope: SyncScope): string {
  return `${scope.backendId}\u0000${scope.accountId}\u0000${scope.datasetEpoch}`;
}

/** Serialize security mutations for one account while allowing other accounts to proceed. */
async function withScopeLock<T>(scope: SyncScope, operation: () => Promise<T>): Promise<T> {
  const key = scopeKey(scope);
  const previous = scopeLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const queued = previous.then(() => current);
  scopeLocks.set(key, queued);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (scopeLocks.get(key) === queued) scopeLocks.delete(key);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringField(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function numberField(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 ? value : fallback;
}

function trustState(value: unknown): SyncDeviceTrustState {
  return value === 'pending' || value === 'trusted' || value === 'revoked' ? value : 'unknown';
}

function trustSource(value: unknown): SyncDeviceTrustSource {
  return value === 'first-device' ||
    value === 'manual-approval' ||
    value === 'pairing' ||
    value === 'automatic-auth' ||
    value === 'recovery' ||
    value === 'recovery-code' ||
    value === 'local-device'
    ? value
    : 'unknown';
}

function policy(value: unknown): SyncDeviceTrustPolicy {
  return value === 'auto-trust-authenticated' ? value : 'require-approval';
}

function parseRecoveryView(raw: SecurityView): RecoveryView {
  const recovery = isRecord(raw.recovery) ? raw.recovery : null;
  const candidate = recovery?.['envelope'];
  const envelope = parseRecoveryEnvelope(candidate);
  if (candidate !== undefined && envelope === null) {
    throw new Error('Backend returned a malformed recovery envelope');
  }
  const recoveryId = stringField(recovery?.['recoveryId']) ?? envelope?.recoveryId ?? null;
  const verifierPublicKey =
    stringField(recovery?.['verifierPublicKey']) ?? envelope?.publicKey ?? null;
  if (
    envelope !== null &&
    (recoveryId !== envelope.recoveryId || verifierPublicKey !== envelope.publicKey)
  ) {
    throw new Error('Backend returned inconsistent recovery metadata');
  }
  return {
    envelope,
    recoveryId,
    verifierPublicKey,
    revision: numberField(recovery?.['revision'] ?? raw['recoveryRevision'], 0),
  };
}

function parseEvent(value: unknown): SyncDeviceSecurityEvent | null {
  if (!isRecord(value)) return null;
  const kind = stringField(value['kind']);
  const occurredAt = stringField(value['occurredAt']);
  const enrollmentId = value['enrollmentId'];
  const rawOutcome = value['outcome'];
  const outcome =
    typeof rawOutcome === 'string' && rawOutcome.length > 0 && rawOutcome.length <= 128
      ? rawOutcome
      : undefined;
  if (
    kind === null ||
    occurredAt === null ||
    (enrollmentId !== null && typeof enrollmentId !== 'string')
  ) {
    return null;
  }
  return {
    kind: kind as SyncDeviceSecurityEvent['kind'],
    occurredAt,
    source: trustSource(value['source']),
    enrollmentId,
    ...(outcome === undefined ? {} : { outcome }),
  };
}

function toStatus(ctx: SyncDeviceSecurityContext, raw: unknown): SyncDeviceSecurityStatus {
  const view = isRecord(raw) ? (raw as SecurityView) : {};
  const remoteRecovery = parseRecoveryView(view);
  const localRecoveryId = currentRecoveryId(ctx.scope);
  const events = Array.isArray(view.recentEvents)
    ? view.recentEvents
        .map(parseEvent)
        .filter((event): event is SyncDeviceSecurityEvent => event !== null)
    : [];
  const hasAccountKey = hasLocalAccountKey(ctx);
  const hasRecoverySecret =
    remoteRecovery.recoveryId !== null &&
    remoteRecovery.recoveryId === localRecoveryId &&
    recoverySecretFor(ctx.scope, remoteRecovery.recoveryId) !== null;
  const serverRequiresRecovery = view.requiresRecovery === true;
  return {
    accountId: stringField(view.accountId) ?? ctx.scope.accountId,
    configured: remoteRecovery.envelope !== null,
    policy: policy(view.policy),
    revision: numberField(view.revision, 1),
    trustState: trustState(view.trustState),
    trustSource: trustSource(view.trustSource),
    hasAccountKey,
    hasRecoverySecret,
    canConfigure: view.canConfigure === true,
    requiresRecovery: serverRequiresRecovery && !hasAccountKey,
    recoveryRevision: numberField(view.recoveryRevision, 0),
    recoveryInvalidated: view.recoveryInvalidated === true,
    requiresRecoveryReplacement:
      view.requiresRecoveryReplacement === true || view.recoveryInvalidated === true,
    recentEvents: events.slice(0, 50),
  };
}

function hasLocalAccountKey(ctx: SyncDeviceSecurityContext): boolean {
  // Keep this import lazy in spirit: the keyring call is synchronous and does
  // not cross the backend boundary.  The dynamic-looking helper is split out
  // so all status construction follows one local-only path.
  return localHasAccountKey(ctx.scope);
}

async function getSecurityView(ctx: SyncDeviceSecurityContext): Promise<SecurityView> {
  ctx.assertCurrent();
  const raw = await ctx.rpc<SecurityView>('security.get', {});
  ctx.assertCurrent();
  if (!isRecord(raw) || raw['accountId'] !== ctx.scope.accountId) {
    throw new Error('Backend returned a security view for a different account');
  }
  return raw as SecurityView;
}

function identityPublicKey(ctx: SyncDeviceSecurityContext): string {
  return ensureDeviceIdentity(ctx.scope, ctx.enrollmentId).pub;
}

function assertChallenge(
  value: unknown,
  ctx: SyncDeviceSecurityContext,
  expectedAction: string,
  expectedHash: string,
): SecurityChallenge {
  if (!isRecord(value)) throw new Error('Backend returned an invalid security challenge');
  const challengeId = stringField(value['challengeId']);
  const challenge = stringField(value['challenge']);
  const accountId = stringField(value['accountId']);
  const enrollmentId = stringField(value['enrollmentId']);
  const action = stringField(value['action']);
  const backendId = stringField(value['backendId']);
  const payloadHash = stringField(value['payloadHash']);
  if (
    challengeId === null ||
    challenge === null ||
    accountId !== ctx.scope.accountId ||
    enrollmentId !== ctx.enrollmentId ||
    action !== expectedAction ||
    backendId !== ctx.scope.backendId ||
    stringField(value['identityPub']) === null ||
    payloadHash !== expectedHash
  ) {
    throw new Error('Backend returned a security challenge for a different request');
  }
  const identityPub = stringField(value['identityPub']);
  if (identityPub !== identityPublicKey(ctx)) {
    throw new Error('Backend returned a security challenge for a different device identity');
  }
  const accountRevision = numberField(value['accountRevision'], 0);
  const recoveryRevision =
    typeof value['recoveryRevision'] === 'number' &&
    Number.isSafeInteger(value['recoveryRevision']) &&
    value['recoveryRevision'] >= 0
      ? value['recoveryRevision']
      : -1;
  if (accountRevision < 1 || recoveryRevision < 0) {
    throw new Error('Backend returned an invalid security challenge revision');
  }
  return {
    challengeId,
    challenge,
    accountId,
    enrollmentId,
    action,
    accountRevision,
    recoveryRevision,
    recoveryId: stringField(value['recoveryId']),
    backendId,
    identityPub,
    payloadHash,
  };
}

async function issueChallenge(
  ctx: SyncDeviceSecurityContext,
  action: string,
  payloadHash: string,
): Promise<SecurityChallenge> {
  const identityPub = identityPublicKey(ctx);
  const params = {
    action,
    backendId: ctx.scope.backendId,
    identityPub,
    payloadHash,
  };
  ctx.assertCurrent();
  const raw = await ctx.rpc<unknown>('security.challenge', params);
  ctx.assertCurrent();
  return assertChallenge(raw, ctx, action, payloadHash);
}

function proofFor(
  ctx: SyncDeviceSecurityContext,
  challenge: SecurityChallenge,
  recoveryId: string,
  signer: (binding: RecoveryRequestBinding) => string,
): SecurityProof {
  const binding: RecoveryRequestBinding = {
    action: challenge.action,
    accountId: ctx.scope.accountId,
    backendId: ctx.scope.backendId,
    enrollmentId: ctx.enrollmentId,
    identityPub: challenge.identityPub,
    recoveryId,
    revision: challenge.accountRevision,
    challenge: challenge.challenge,
    payloadHash: challenge.payloadHash,
  };
  return {
    challengeId: challenge.challengeId,
    signature: signer(binding),
    identityPub: challenge.identityPub,
    payloadHash: challenge.payloadHash,
  };
}

function recoveryFromView(view: SecurityView): RecoveryView {
  return parseRecoveryView(view);
}

function assertAcceptedRecoveryEnvelope(
  ctx: SyncDeviceSecurityContext,
  value: unknown,
  expected: RecoveryEnvelope,
): void {
  if (!isRecord(value) || value['accountId'] !== ctx.scope.accountId) {
    throw new Error('Backend returned an invalid security response');
  }
  const recovery = parseRecoveryView(value as SecurityView);
  if (
    recovery.envelope === null ||
    recovery.envelope.recoveryId !== expected.recoveryId ||
    recovery.envelope.publicKey !== expected.publicKey ||
    recovery.envelope.ct !== expected.ct ||
    recovery.envelope.nonce !== expected.nonce
  ) {
    throw new Error('Backend did not accept the requested recovery envelope');
  }
}

function existingRecoveryId(view: SecurityView, ctx: SyncDeviceSecurityContext): string {
  const remote = recoveryFromView(view);
  const local = currentRecoveryId(ctx.scope);
  if (
    remote.envelope === null ||
    remote.recoveryId === null ||
    local === null ||
    remote.recoveryId !== local ||
    recoverySecretFor(ctx.scope, local) === null
  ) {
    throw new RecoverySecretMissingError();
  }
  return local;
}

function assertMatchingChallengeState(
  challenge: SecurityChallenge,
  recoveryId: string,
  accountRevision: number,
): void {
  if (challenge.recoveryId !== recoveryId || challenge.accountRevision !== accountRevision) {
    throw new Error('Backend returned a stale security challenge');
  }
}

/** True when the opaque server envelope already contains every local key version. */
function remoteEnvelopeMatchesLocalKeys(
  ctx: SyncDeviceSecurityContext,
  envelope: RecoveryEnvelope,
): boolean {
  const recoveryId = currentRecoveryId(ctx.scope);
  const secret = recoveryId === null ? null : recoverySecretFor(ctx.scope, recoveryId);
  if (secret === null) return false;
  const prepared = prepareRecoveryUnlock(ctx.scope, formatRecoveryCode(secret), envelope);
  const local = exportAccountKeyBundle(ctx.scope);
  if (local === null) {
    importAccountKeyBundle(ctx.scope, prepared.bundle, 'recovery');
    return true;
  }
  const remoteVersions = new Map(
    prepared.bundle.keys.map((entry) => [entry.keyVersion, entry.adk]),
  );
  const containsEveryLocalKey = local.keys.every(
    (entry) => remoteVersions.get(entry.keyVersion) === entry.adk,
  );
  // Import any remote-only versions before deciding whether a refresh is
  // needed. A stale local bundle must never replace key history held by the
  // server envelope. Contradictory versions fail closed in commit().
  if (!prepared.alreadyHadMatchingBundle) {
    // Import only the opaque bundle. This deliberately does not replace or
    // clear the retained recovery root; replacement commits a new root only
    // after the backend accepts it.
    importAccountKeyBundle(ctx.scope, prepared.bundle, 'recovery');
  }
  return containsEveryLocalKey;
}

/** Renderer-safe status; no envelope, key bundle, or recovery code is returned. */
export async function getDeviceSecurityStatus(
  ctx: SyncDeviceSecurityContext,
): Promise<SyncDeviceSecurityStatus> {
  const view = await getSecurityView(ctx);
  return toStatus(ctx, view);
}

/**
 * Configure the first account recovery envelope and trust policy. The code is
 * retained only after the backend accepts the exact opaque envelope, so a
 * failed replacement cannot strand the previous local recovery key.
 */
export async function setupDeviceRecovery(
  ctx: SyncDeviceSecurityContext,
  selectedPolicy: SyncDeviceTrustPolicy,
): Promise<SyncDeviceRecoveryResult> {
  return withScopeLock(ctx.scope, async () => {
    if (selectedPolicy !== 'require-approval' && selectedPolicy !== 'auto-trust-authenticated') {
      throw new Error('Unknown device trust policy');
    }
    const view = await getSecurityView(ctx);
    if (view.canConfigure !== true)
      throw new Error('This account is not eligible for initial recovery setup');
    const setup = createRecoverySetup(ctx.scope, { persist: false });
    const body = {
      policy: selectedPolicy,
      backendId: ctx.scope.backendId,
      recovery: { envelope: setup.envelope },
    };
    ctx.assertCurrent();
    const accepted = await ctx.rpc<unknown>('security.configure', body);
    ctx.assertCurrent();
    assertAcceptedRecoveryEnvelope(ctx, accepted, setup.envelope);
    commitRecoverySetup(ctx.scope, setup.code, setup.recoveryId);
    return { recoveryCode: setup.code };
  });
}

/**
 * Unlocks the opaque bundle locally first, proves possession of the code to
 * the backend, then commits key custody. A failed or stale request therefore
 * cannot install either keys or a new retained secret.
 */
export async function unlockDeviceRecovery(
  ctx: SyncDeviceSecurityContext,
  code: string,
): Promise<SyncDeviceSecurityStatus> {
  return withScopeLock(ctx.scope, async () => {
    const view = await getSecurityView(ctx);
    const recovery = recoveryFromView(view);
    if (recovery.envelope === null || recovery.recoveryId === null) {
      throw new Error('Recovery has not been configured for this account');
    }
    if (view.recoveryInvalidated === true || view.requiresRecoveryReplacement === true) {
      throw new Error('Recovery setup must be replaced after device revocation');
    }
    const prepared: PreparedRecoveryUnlock = prepareRecoveryUnlock(
      ctx.scope,
      code,
      recovery.envelope,
    );
    const payloadHash = recoveryPayloadHash({});
    const challenge = await issueChallenge(ctx, 'recover', payloadHash);
    assertMatchingChallengeState(challenge, recovery.recoveryId, numberField(view.revision, 0));
    const proof = proofFor(ctx, challenge, recovery.recoveryId, prepared.signRecoveryRequest);
    ctx.assertCurrent();
    await ctx.rpc('security.recover', { payloadHash, proof });
    ctx.assertCurrent();
    commitRecoveryUnlock(prepared);
    return getDeviceSecurityStatus(ctx);
  });
}

/** Change the account policy using the retained recovery signer. */
export async function setNewDeviceTrustPolicy(
  ctx: SyncDeviceSecurityContext,
  selectedPolicy: SyncDeviceTrustPolicy,
): Promise<SyncDeviceSecurityStatus> {
  return withScopeLock(ctx.scope, async () => {
    if (selectedPolicy !== 'require-approval' && selectedPolicy !== 'auto-trust-authenticated') {
      throw new Error('Unknown device trust policy');
    }
    const view = await getSecurityView(ctx);
    const recoveryId = existingRecoveryId(view, ctx);
    const body = { policy: selectedPolicy, revision: numberField(view.revision, 1) };
    const payloadHash = recoveryPayloadHash(body);
    const challenge = await issueChallenge(ctx, 'setPolicy', payloadHash);
    assertMatchingChallengeState(challenge, recoveryId, numberField(view.revision, 0));
    if (recoveryFromView(view).verifierPublicKey === null) throw new RecoverySecretMissingError();
    const proof = proofFor(ctx, challenge, recoveryId, (binding) =>
      buildRecoveryRequestSignature(ctx.scope, binding),
    );
    ctx.assertCurrent();
    await ctx.rpc('security.setPolicy', { ...body, payloadHash, proof });
    ctx.assertCurrent();
    return getDeviceSecurityStatus(ctx);
  });
}

/**
 * Replace the recovery envelope with a new high-entropy code. The old code
 * remains the signer until the server accepts the replacement; this is also
 * the explicit post-revocation path for establishing a fresh recovery root.
 */
export async function replaceDeviceRecovery(
  ctx: SyncDeviceSecurityContext,
): Promise<SyncDeviceRecoveryResult> {
  return withScopeLock(ctx.scope, async () => {
    const view = await getSecurityView(ctx);
    const recoveryId = existingRecoveryId(view, ctx);
    const oldRecovery = recoveryFromView(view);
    if (oldRecovery.verifierPublicKey === null || oldRecovery.envelope === null) {
      throw new RecoverySecretMissingError();
    }
    // Reconcile the server's opaque history before creating the replacement
    // envelope. A surviving trusted device can retain versions that this
    // process has not pulled yet; dropping them would make the new recovery
    // code appear to work while silently losing historical decryptability.
    remoteEnvelopeMatchesLocalKeys(ctx, oldRecovery.envelope);
    const setup = createRecoverySetup(ctx.scope, { persist: false });
    const body = {
      recovery: { envelope: setup.envelope },
      backendId: ctx.scope.backendId,
      revision: numberField(view.revision, 1),
    };
    const payloadHash = recoveryPayloadHash(body);
    const challenge = await issueChallenge(ctx, 'updateRecovery', payloadHash);
    assertMatchingChallengeState(challenge, recoveryId, numberField(view.revision, 0));
    const proof = proofFor(ctx, challenge, recoveryId, (binding) =>
      buildRecoveryRequestSignature(ctx.scope, binding),
    );
    ctx.assertCurrent();
    const accepted = await ctx.rpc<unknown>('security.updateRecovery', {
      ...body,
      payloadHash,
      proof,
    });
    ctx.assertCurrent();
    assertAcceptedRecoveryEnvelope(ctx, accepted, setup.envelope);
    commitRecoverySetup(ctx.scope, setup.code, setup.recoveryId);
    return { recoveryCode: setup.code };
  });
}

/**
 * Push a new opaque envelope after key rotation. This is intentionally an
 * explicit helper: callers must invoke it only while the current recovery
 * root is valid. A revoked/invalidated root is never silently refreshed.
 */
export async function refreshDeviceRecovery(
  ctx: SyncDeviceSecurityContext,
): Promise<SyncDeviceSecurityStatus> {
  return withScopeLock(ctx.scope, async () => {
    const view = await getSecurityView(ctx);
    if (view.recoveryInvalidated === true || view.recoveryValid === false) {
      throw new Error('Recovery setup must be replaced after device revocation');
    }
    const recoveryId = existingRecoveryId(view, ctx);
    const remote = recoveryFromView(view);
    if (remote.verifierPublicKey === null) throw new RecoverySecretMissingError();
    if (recoverySecretForRefresh(ctx.scope, recoveryId) === null) {
      throw new Error('Recovery setup must be replaced after device revocation');
    }
    if (remote.envelope !== null && remoteEnvelopeMatchesLocalKeys(ctx, remote.envelope)) {
      return toStatus(ctx, view);
    }
    const envelope = refreshRecoveryEnvelope(ctx.scope);
    const body = {
      recovery: { envelope },
      backendId: ctx.scope.backendId,
      revision: numberField(view.revision, 1),
    };
    const payloadHash = recoveryPayloadHash(body);
    const challenge = await issueChallenge(ctx, 'updateRecovery', payloadHash);
    assertMatchingChallengeState(challenge, recoveryId, numberField(view.revision, 0));
    const proof = proofFor(ctx, challenge, recoveryId, (binding) =>
      buildRecoveryRequestSignature(ctx.scope, binding),
    );
    ctx.assertCurrent();
    await ctx.rpc('security.updateRecovery', { ...body, payloadHash, proof });
    ctx.assertCurrent();
    return getDeviceSecurityStatus(ctx);
  });
}

export type { SecurityView, RecoveryView };
