// Provider-neutral device trust and recovery-code contract.
// Keep this module pure: it is shared by the desktop client and backend and
// must not depend on Node, Electron, or a provider runtime.

import { canonicalizeJson } from './sync';

export const DEVICE_SECURITY_SCHEMA_VERSION = 1 as const;
export const RECOVERY_ENVELOPE_ALGORITHM = 'aes-256-gcm' as const;
export const RECOVERY_CODE_PREFIX = 'anvil-recovery-' as const;
export const RECOVERY_ENVELOPE_MAX_CIPHERTEXT_LENGTH = 512 * 1024;
export const RECOVERY_BUNDLE_MAX_KEYS = 256;
export const RECOVERY_BUNDLE_MAX_KEY_VERSION = 2 ** 31 - 1;

export type DeviceTrustPolicy = 'require-approval' | 'auto-trust-authenticated';
export type RecoveryPolicy = DeviceTrustPolicy;

export type DeviceTrustSource =
  | 'first-device'
  | 'manual-approval'
  | 'pairing'
  | 'recovery'
  | 'automatic-auth';
export type TrustSource = DeviceTrustSource;

export interface RecoveryEnvelope {
  v: typeof DEVICE_SECURITY_SCHEMA_VERSION;
  algorithm: typeof RECOVERY_ENVELOPE_ALGORITHM;
  recoveryId: string;
  /** Unpadded base64url encoded raw Ed25519 public key (32 bytes). */
  publicKey: string;
  /** Standard base64 encoded 96-bit AES-GCM nonce. */
  nonce: string;
  /** Standard base64 encoded AES-GCM ciphertext with its 128-bit tag appended. */
  ct: string;
}
export type RecoveryCodeEnvelope = RecoveryEnvelope;

export interface RecoveryKeyBundleEntry {
  keyVersion: number;
  /** Standard base64 encoded 32-byte account data key. */
  adk: string;
}

export interface RecoveryKeyBundle {
  v: typeof DEVICE_SECURITY_SCHEMA_VERSION;
  keys: RecoveryKeyBundleEntry[];
}
export type RecoveryBundle = RecoveryKeyBundle;

export interface RecoveryRequestBinding {
  action: string;
  accountId: string;
  backendId: string;
  enrollmentId: string;
  /** Device identity public key, normally an unpadded base64url encoded raw X25519 key. */
  identityPub: string;
  recoveryId: string;
  revision: number;
  challenge: string;
  /** SHA-256 hex of the canonical mutable RPC body, excluding its proof. */
  payloadHash: string;
}

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const BASE64URL = /^[A-Za-z0-9_-]+$/;
const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const BASE64URL_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isCanonicalBase64(value: unknown, byteLength?: number): value is string {
  if (typeof value !== 'string' || !BASE64.test(value)) return false;
  if (byteLength !== undefined && value.length !== Math.ceil(byteLength / 3) * 4) return false;
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  if (padding === 0) return true;
  const significant = value.slice(0, value.length - padding);
  const last = BASE64_ALPHABET.indexOf(significant.at(-1) ?? '');
  const mask = padding === 2 ? 0x0f : 0x03;
  return last >= 0 && (last & mask) === 0;
}

function isCanonicalBase64Url(value: unknown, byteLength?: number): value is string {
  if (typeof value !== 'string' || !BASE64URL.test(value)) return false;
  if (byteLength === undefined) return true;
  if (value.length !== Math.ceil((byteLength * 8) / 6)) return false;
  const remainder = byteLength % 3;
  if (remainder === 0) return true;
  const last = BASE64URL_ALPHABET.indexOf(value.at(-1) ?? '');
  const mask = remainder === 1 ? 0x0f : 0x03;
  return last >= 0 && (last & mask) === 0;
}

/** Normalizes display whitespace while preserving the case-sensitive secret. */
export function normalizeRecoveryCode(value: string): string | null {
  if (typeof value !== 'string') return null;
  const compact = value.trim().replace(/[\t\n\r ]+/g, '');
  if (!compact.toLowerCase().startsWith(RECOVERY_CODE_PREFIX)) return null;
  const secret = compact.slice(RECOVERY_CODE_PREFIX.length);
  if (!isCanonicalBase64Url(secret, 32)) return null;
  return `${RECOVERY_CODE_PREFIX}${secret}`;
}

export function isRecoveryCode(value: unknown): value is string {
  return typeof value === 'string' && normalizeRecoveryCode(value) !== null;
}

export function isRecoveryEnvelope(value: unknown): value is RecoveryEnvelope {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const fields = Object.keys(record).sort();
  if (fields.join(',') !== 'algorithm,ct,nonce,publicKey,recoveryId,v') return false;
  return (
    record.v === DEVICE_SECURITY_SCHEMA_VERSION &&
    record.algorithm === RECOVERY_ENVELOPE_ALGORITHM &&
    isNonEmptyString(record.recoveryId) &&
    UUID_V4.test(record.recoveryId) &&
    (isCanonicalBase64(record.publicKey, 32) || isCanonicalBase64Url(record.publicKey, 32)) &&
    isCanonicalBase64(record.nonce, 12) &&
    isCanonicalBase64(record.ct) &&
    record.ct.length >= 24 &&
    record.ct.length <= Math.ceil(RECOVERY_ENVELOPE_MAX_CIPHERTEXT_LENGTH / 3) * 4
  );
}

/** Stable wire representation for an opaque backend recovery snapshot. */
export function serializeRecoveryEnvelope(envelope: RecoveryEnvelope): string {
  if (!isRecoveryEnvelope(envelope)) throw new Error('Malformed recovery envelope');
  return canonicalizeJson(envelope);
}

export function parseRecoveryEnvelope(value: unknown): RecoveryEnvelope | null {
  let parsed: unknown = value;
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value) as unknown;
    } catch {
      return null;
    }
  }
  return isRecoveryEnvelope(parsed) ? parsed : null;
}

export function isRecoveryKeyBundle(value: unknown): value is RecoveryKeyBundle {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (
    record.v !== DEVICE_SECURITY_SCHEMA_VERSION ||
    !Array.isArray(record.keys) ||
    record.keys.length === 0 ||
    record.keys.length > RECOVERY_BUNDLE_MAX_KEYS
  ) {
    return false;
  }
  let previousVersion = 0;
  for (const entry of record.keys) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return false;
    const item = entry as Record<string, unknown>;
    const keyVersion = item.keyVersion;
    if (
      typeof keyVersion !== 'number' ||
      !Number.isSafeInteger(keyVersion) ||
      keyVersion < 1 ||
      keyVersion > RECOVERY_BUNDLE_MAX_KEY_VERSION ||
      keyVersion <= previousVersion ||
      !isCanonicalBase64(item.adk, 32)
    ) {
      return false;
    }
    previousVersion = keyVersion;
  }
  return true;
}

/** Versioned AES-GCM AAD. Every field is authenticated by the envelope. */
export function recoveryEnvelopeAssociatedData(input: {
  accountId: string;
  backendId: string;
  recoveryId: string;
}): string {
  return [
    'anvil/device-security/recovery-envelope/v1',
    input.backendId,
    input.accountId,
    input.recoveryId,
    String(DEVICE_SECURITY_SCHEMA_VERSION),
  ].join('|');
}

/** Alias used by callers that treat the envelope as a recovery seal. */
export const recoverySealAssociatedData = recoveryEnvelopeAssociatedData;

/** Canonical, domain-separated bytes-to-sign input for recovery requests. */
export function recoveryRequestBinding(input: RecoveryRequestBinding): string {
  return [
    'anvil/device-security/recovery-request/v1',
    canonicalizeJson({
      action: input.action,
      accountId: input.accountId,
      backendId: input.backendId,
      enrollmentId: input.enrollmentId,
      identityPub: input.identityPub,
      recoveryId: input.recoveryId,
      revision: input.revision,
      challenge: input.challenge,
      payloadHash: input.payloadHash,
    }),
  ].join('|');
}

/** Alias emphasizing that this string is the signature's associated input. */
export const recoveryRequestAssociatedData = recoveryRequestBinding;
export const recoveryRequestMessage = recoveryRequestBinding;

export function recoveryRequestBindingBytes(input: RecoveryRequestBinding): Uint8Array {
  return new TextEncoder().encode(recoveryRequestBinding(input));
}
