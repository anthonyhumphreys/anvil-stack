// Recovery-code cryptography lives in the privileged main process. The
// renderer never receives an account key bundle or a retained recovery secret.

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createPrivateKey,
  createPublicKey,
  hkdfSync,
  randomBytes,
  randomUUID,
  sign,
  verify,
  type KeyObject,
} from 'node:crypto';
import {
  isRecoveryEnvelope,
  isRecoveryKeyBundle,
  normalizeRecoveryCode,
  RECOVERY_CODE_PREFIX,
  recoveryEnvelopeAssociatedData,
  recoveryRequestBindingBytes,
  type RecoveryEnvelope,
  type RecoveryKeyBundle,
  type RecoveryRequestBinding,
} from '../../../cloud/contract/device-security.js';
import type { SyncScope } from '../../shared/sync-mesh.js';
import {
  commitRecoveryBundle,
  canStoreRecoverySecret,
  currentAccountKeyBundleMatches,
  currentRecoveryId,
  exportAccountKeyBundle,
  recoverySecretFor,
  recoverySecretForRefresh,
  retryQuarantinedEntities,
  storeRecoverySecret,
} from './sync-keyring.service.js';
import { canonicalizeJson } from '../../../cloud/contract/sync.js';

const RECOVERY_SECRET_BYTES = 32;
const RECOVERY_NONCE_BYTES = 12;
const RECOVERY_ENCRYPTION_INFO = Buffer.from(
  'anvil/device-security/recovery-encryption-key/v1',
  'utf8',
);
const RECOVERY_SIGNING_INFO = Buffer.from('anvil/device-security/recovery-signing-seed/v1', 'utf8');
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const ED25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

export class RecoveryUnlockError extends Error {
  constructor(message = 'Recovery code could not unlock this envelope') {
    super(message);
    this.name = 'RecoveryUnlockError';
  }
}

export class RecoverySecretMissingError extends Error {
  constructor() {
    super('The retained recovery secret is unavailable on this device');
    this.name = 'RecoverySecretMissingError';
  }
}

export interface RecoverySetup {
  code: string;
  envelope: RecoveryEnvelope;
  recoveryId: string;
  publicKey: string;
}

export interface RecoverySetupOptions {
  /** Keep the previous retained secret until the server accepts configuration. */
  persist?: boolean;
}

export interface RecoveryUnlock {
  recoveryId: string;
  publicKey: string;
  bundle: RecoveryKeyBundle;
  alreadyHadMatchingBundle: boolean;
}

/**
 * Decrypted, proof-capable recovery state held only in the main process.
 * `commit` is the only path that installs keys or replaces local custody.
 */
export interface PreparedRecoveryUnlock {
  recoveryId: string;
  publicKey: string;
  bundle: RecoveryKeyBundle;
  alreadyHadMatchingBundle: boolean;
  signRecoveryRequest(binding: RecoveryRequestBinding): string;
  commit(): RecoveryUnlock;
}

function decodeBase64(value: string, bytes?: number): Buffer | null {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    return null;
  }
  const decoded = Buffer.from(value, 'base64');
  if (bytes !== undefined && decoded.byteLength !== bytes) return null;
  if (decoded.toString('base64') !== value) return null;
  return decoded;
}

function decodePublicKey(value: string): Buffer | null {
  if (/^[A-Za-z0-9_-]+$/.test(value)) {
    const decoded = Buffer.from(value, 'base64url');
    return decoded.byteLength === 32 && decoded.toString('base64url') === value ? decoded : null;
  }
  return decodeBase64(value, 32);
}

function assertSecret(secret: Buffer): void {
  if (secret.byteLength !== RECOVERY_SECRET_BYTES) {
    throw new Error('Recovery secret must be 32 bytes');
  }
}

function recoverySecretFromCode(code: string): Buffer {
  const normalized = normalizeRecoveryCode(code);
  if (normalized === null) throw new RecoveryUnlockError();
  const encoded = normalized.slice(RECOVERY_CODE_PREFIX.length);
  const secret = Buffer.from(encoded, 'base64url');
  if (secret.byteLength !== RECOVERY_SECRET_BYTES || secret.toString('base64url') !== encoded) {
    throw new RecoveryUnlockError();
  }
  return secret;
}

export function formatRecoveryCode(secret: Buffer): string {
  assertSecret(secret);
  return `${RECOVERY_CODE_PREFIX}${secret.toString('base64url')}`;
}

/** Generates a fresh high-entropy code secret. */
export function generateRecoverySecret(): Buffer {
  return randomBytes(RECOVERY_SECRET_BYTES);
}

export function deriveRecoveryEncryptionKey(secret: Buffer, recoveryId: string): Buffer {
  assertSecret(secret);
  return Buffer.from(
    hkdfSync('sha256', secret, Buffer.from(recoveryId, 'utf8'), RECOVERY_ENCRYPTION_INFO, 32),
  );
}

export function deriveRecoverySigningSeed(secret: Buffer, recoveryId: string): Buffer {
  assertSecret(secret);
  return Buffer.from(
    hkdfSync('sha256', secret, Buffer.from(recoveryId, 'utf8'), RECOVERY_SIGNING_INFO, 32),
  );
}

/** Returns the raw Ed25519 public key derived from a recovery secret and ID. */
export function recoveryPublicKey(secret: Buffer, recoveryId: string): string {
  assertSecret(secret);
  return publicKeyFromSeed(deriveRecoverySigningSeed(secret, recoveryId)).toString('base64url');
}

function privateKeyFromSeed(seed: Buffer): KeyObject {
  return createPrivateKey({
    key: Buffer.concat([ED25519_PKCS8_PREFIX, seed]),
    format: 'der',
    type: 'pkcs8',
  });
}

function publicKeyFromSeed(seed: Buffer): Buffer {
  const der = createPublicKey(privateKeyFromSeed(seed)).export({ format: 'der', type: 'spki' });
  return der.subarray(der.length - 32);
}

function publicKeyObject(raw: Buffer): KeyObject {
  return createPublicKey({
    key: Buffer.concat([ED25519_SPKI_PREFIX, raw]),
    format: 'der',
    type: 'spki',
  });
}

function sealBundle(
  scope: SyncScope,
  recoveryId: string,
  secret: Buffer,
  bundle: RecoveryKeyBundle,
): RecoveryEnvelope {
  const key = deriveRecoveryEncryptionKey(secret, recoveryId);
  const nonce = randomBytes(RECOVERY_NONCE_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(Buffer.from(recoveryEnvelopeAssociatedData({ ...scope, recoveryId }), 'utf8'));
  const ct = Buffer.concat([
    cipher.update(Buffer.from(JSON.stringify(bundle), 'utf8')),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
  return {
    v: 1,
    algorithm: 'aes-256-gcm',
    recoveryId,
    publicKey: recoveryPublicKey(secret, recoveryId),
    nonce: nonce.toString('base64'),
    ct: ct.toString('base64'),
  };
}

function openBundle(
  scope: SyncScope,
  code: string,
  envelope: RecoveryEnvelope,
): { secret: Buffer; bundle: RecoveryKeyBundle } {
  if (!isRecoveryEnvelope(envelope)) throw new RecoveryUnlockError('Malformed recovery envelope');
  let secret: Buffer;
  try {
    secret = recoverySecretFromCode(code);
  } catch {
    throw new RecoveryUnlockError();
  }
  const key = deriveRecoveryEncryptionKey(secret, envelope.recoveryId);
  const nonce = decodeBase64(envelope.nonce, RECOVERY_NONCE_BYTES);
  const ciphertext = decodeBase64(envelope.ct);
  if (nonce === null || ciphertext === null || ciphertext.byteLength < 16) {
    throw new RecoveryUnlockError('Malformed recovery envelope');
  }
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, nonce);
    decipher.setAAD(
      Buffer.from(
        recoveryEnvelopeAssociatedData({ ...scope, recoveryId: envelope.recoveryId }),
        'utf8',
      ),
    );
    decipher.setAuthTag(ciphertext.subarray(ciphertext.length - 16));
    const plain = Buffer.concat([
      decipher.update(ciphertext.subarray(0, ciphertext.length - 16)),
      decipher.final(),
    ]);
    const parsed = JSON.parse(plain.toString('utf8')) as unknown;
    if (!isRecoveryKeyBundle(parsed)) throw new RecoveryUnlockError('Malformed recovery bundle');
    const expectedPublic = recoveryPublicKey(secret, envelope.recoveryId);
    if (expectedPublic !== envelope.publicKey) throw new RecoveryUnlockError();
    return { secret, bundle: parsed };
  } catch (error) {
    if (error instanceof RecoveryUnlockError) throw error;
    throw new RecoveryUnlockError();
  }
}

/** Creates and retains recovery material on a device already holding ADKs. */
export function createRecoverySetup(
  scope: SyncScope,
  options: RecoverySetupOptions = {},
): RecoverySetup {
  const bundle = exportAccountKeyBundle(scope);
  if (bundle === null) throw new RecoveryUnlockError('No account key bundle is available');
  const secret = generateRecoverySecret();
  const recoveryId = randomUUID();
  const envelope = sealBundle(scope, recoveryId, secret, bundle);
  if (options.persist === false && !canStoreRecoverySecret(secret)) {
    throw new RecoveryUnlockError('Secure recovery secret storage is unavailable');
  }
  if (options.persist !== false) {
    // Store only after the envelope is fully formed, so an encryption failure
    // cannot return a code whose refresh material was never safely retained.
    storeRecoverySecret(scope, recoveryId, secret);
  }
  return {
    code: formatRecoveryCode(secret),
    envelope,
    recoveryId,
    publicKey: envelope.publicKey,
  };
}

/** Commits a staged setup after the server accepts the exact public envelope. */
export function commitRecoverySetup(scope: SyncScope, code: string, recoveryId: string): void {
  storeRecoverySecret(scope, recoveryId, recoverySecretFromCode(code));
}

/** Re-seals the current full key history under the retained secret and ID. */
export function refreshRecoveryEnvelope(scope: SyncScope): RecoveryEnvelope {
  const recoveryId = currentRecoveryId(scope);
  if (recoveryId === null) throw new RecoverySecretMissingError();
  const secret = recoverySecretForRefresh(scope, recoveryId);
  if (secret === null) throw new RecoverySecretMissingError();
  const bundle = exportAccountKeyBundle(scope);
  if (bundle === null) throw new RecoveryUnlockError('No account key bundle is available');
  return sealBundle(scope, recoveryId, secret, bundle);
}

/**
 * Unlocks a server-provided envelope on this device and imports its complete
 * ADK history. Conflicting established versions abort before any row changes.
 */
export function prepareRecoveryUnlock(
  scope: SyncScope,
  code: string,
  envelope: RecoveryEnvelope,
): PreparedRecoveryUnlock {
  const { secret, bundle } = openBundle(scope, code, envelope);
  const alreadyHadMatchingBundle = currentAccountKeyBundleMatches(scope, bundle);
  let committed = false;
  let result: RecoveryUnlock | null = null;
  return {
    recoveryId: envelope.recoveryId,
    publicKey: envelope.publicKey,
    bundle,
    alreadyHadMatchingBundle,
    signRecoveryRequest: (binding) => signRecoveryRequest(binding, secret),
    commit: () => {
      if (committed && result !== null) return result;
      commitRecoveryBundle(scope, bundle, envelope.recoveryId, secret);
      retryQuarantinedEntities(scope);
      committed = true;
      result = {
        recoveryId: envelope.recoveryId,
        publicKey: envelope.publicKey,
        bundle,
        alreadyHadMatchingBundle,
      };
      return result;
    },
  };
}

/** Commits a staged unlock after the server accepts its signed proof. */
export function commitRecoveryUnlock(prepared: PreparedRecoveryUnlock): RecoveryUnlock {
  return prepared.commit();
}

/** Compatibility helper for callers that have no server proof step. */
export function unlockRecoveryEnvelope(
  scope: SyncScope,
  code: string,
  envelope: RecoveryEnvelope,
): RecoveryUnlock {
  return prepareRecoveryUnlock(scope, code, envelope).commit();
}

/** Signs the canonical recovery request using an explicitly supplied secret. */
export function signRecoveryRequest(binding: RecoveryRequestBinding, secret: Buffer): string {
  assertSecret(secret);
  const seed = deriveRecoverySigningSeed(secret, binding.recoveryId);
  return sign(null, recoveryRequestBindingBytes(binding), privateKeyFromSeed(seed)).toString(
    'base64url',
  );
}

/** SHA-256 over the shared canonical JSON form of a mutable RPC body. */
export function recoveryPayloadHash(payload: unknown): string {
  return createHash('sha256').update(canonicalizeJson(payload), 'utf8').digest('hex');
}

/** Signs using this scope's retained recovery secret. */
export function buildRecoveryRequestSignature(
  scope: SyncScope,
  binding: RecoveryRequestBinding,
): string {
  const secret = recoverySecretFor(scope, binding.recoveryId);
  if (secret === null) throw new RecoverySecretMissingError();
  return signRecoveryRequest(binding, secret);
}

/** Verifies a request signature against the public key in an envelope. */
export function verifyRecoveryRequestSignature(
  binding: RecoveryRequestBinding,
  signature: string,
  publicKey: string,
): boolean {
  const pub = decodePublicKey(publicKey);
  const sig = /^[A-Za-z0-9_-]+$/.test(signature)
    ? Buffer.from(signature, 'base64url')
    : decodeBase64(signature, 64);
  if (pub === null || sig === null || sig.byteLength !== 64) return false;
  try {
    return verify(null, recoveryRequestBindingBytes(binding), publicKeyObject(pub), sig);
  } catch {
    return false;
  }
}

/** Returns whether this device's retained bundle exactly matches a bundle. */
export function hasCurrentRecoveryBundle(scope: SyncScope, bundle: RecoveryKeyBundle): boolean {
  return currentAccountKeyBundleMatches(scope, bundle);
}
