/**
 * Server side primitives for account security operations.
 *
 * The client owns the recovery secret, HKDF derivation, and bundle
 * encryption. The coordinator only receives a public Ed25519 verifier and a
 * detached signature over a short lived, account scoped challenge. Keeping
 * this module independent from the contract package makes the persistence
 * boundary explicit and avoids accidentally putting plaintext recovery
 * material in the worker.
 */

import { isRecord } from './rpc';
import { recoveryRequestBindingBytes } from '../../contract/device-security';

export const SECURITY_CHALLENGE_TTL_MS = 2 * 60 * 1000;
export const SECURITY_AUDIT_RETENTION = 200;

export type SecurityAction =
  | 'configure'
  | 'recover'
  | 'setPolicy'
  | 'updateRecovery'
  | 'reset';

export interface SecurityChallengeProof {
  challengeId: string;
  /** X25519 device identity public key (raw 32 bytes, standard base64). */
  identityPub: string;
  signature: string;
  /** Digest of the exact requested security mutation. */
  payloadHash: string;
}

export interface SecurityChallengeEnvelope {
  challengeId: string;
  challenge: string;
  accountId: string;
  enrollmentId: string;
  action: SecurityAction;
  accountRevision: number;
  recoveryRevision: number;
  recoveryId: string;
  backendId: string;
  identityPub: string;
  payloadHash: string;
  expiresAt: string;
}

export interface SecurityChallengeRow {
  challenge_id: string;
  account_id: string;
  enrollment_id: string;
  action: SecurityAction;
  account_revision: number;
  recovery_revision: number;
  challenge: string;
  expected_public_key: string;
  recovery_id: string;
  backend_id: string;
  identity_pub: string;
  payload_hash: string;
  expires_at: number;
  used_at: number | null;
  created_at: number;
}

const BASE64URL = /^[A-Za-z0-9_-]+$/;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/** Decode a strict, unpadded base64url value without Buffer. */
export function decodeBase64Url(value: string): Uint8Array | null {
  if (value.length === 0 || (!BASE64URL.test(value) && !BASE64.test(value))) return null;
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
  try {
    const binary = atob(padded);
    const result = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) result[i] = binary.charCodeAt(i);
    return result;
  } catch {
    return null;
  }
}

/** Encode bytes as unpadded base64url. */
export function encodeBase64Url(bytes: Uint8Array): string {
  let output = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const first = bytes[i] ?? 0;
    const second = bytes[i + 1] ?? 0;
    const third = bytes[i + 2] ?? 0;
    const remaining = bytes.length - i;
    const triplet = (first << 16) | (second << 8) | third;
    output += 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'.charAt(
      (triplet >> 18) & 63,
    );
    output += 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'.charAt(
      (triplet >> 12) & 63,
    );
    if (remaining > 1) {
      output += 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'.charAt(
        (triplet >> 6) & 63,
      );
    }
    if (remaining > 2) {
      output += 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'.charAt(
        triplet & 63,
      );
    }
  }
  return output;
}

export function randomChallenge(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return encodeBase64Url(bytes);
}

export function parseSecurityProof(value: unknown): SecurityChallengeProof | null {
  if (!isRecord(value)) return null;
  if (value['publicKey'] !== undefined) return null;
  const challengeId = value['challengeId'];
  const identityPub = value['identityPub'];
  const signature = value['signature'];
  const payloadHash = value['payloadHash'];
  if (
    typeof challengeId !== 'string' ||
    challengeId.length < 8 ||
    challengeId.length > 128 ||
    typeof signature !== 'string' ||
    signature.length > 256 ||
    typeof identityPub !== 'string' ||
    typeof payloadHash !== 'string' ||
    !/^[a-f0-9]{64}$/.test(payloadHash)
  ) {
    return null;
  }
  const signatureBytes = decodeBase64Url(signature);
  if (signatureBytes === null || signatureBytes.byteLength !== 64) return null;
  const identityBytes = decodeBase64Url(identityPub);
  if (identityBytes === null || identityBytes.byteLength !== 32) return null;
  return {
    challengeId,
    signature,
    identityPub,
    payloadHash,
  };
}

/** Validate the detached Ed25519 proof. WebCrypto does the actual verify. */
export async function verifySecurityProof(
  row: SecurityChallengeRow,
  proof: SecurityChallengeProof,
  now = Date.now(),
): Promise<boolean> {
  if (row.used_at !== null || row.expires_at <= now) return false;
  if (proof.challengeId !== row.challenge_id) return false;
  if (proof.identityPub !== row.identity_pub || proof.payloadHash !== row.payload_hash) {
    return false;
  }
  const publicKey = decodeBase64Url(row.expected_public_key);
  const signature = decodeBase64Url(proof.signature);
  if (publicKey === null || publicKey.byteLength !== 32) return false;
  if (signature === null || signature.byteLength !== 64) return false;
  try {
    const key = await crypto.subtle.importKey(
      'raw',
      publicKey,
      { name: 'Ed25519' },
      false,
      ['verify'],
    );
    return await crypto.subtle.verify(
      { name: 'Ed25519' },
      key,
      signature,
      recoveryRequestBindingBytes({
        action: row.action,
        accountId: row.account_id,
        backendId: row.backend_id,
        enrollmentId: row.enrollment_id,
        identityPub: row.identity_pub,
        recoveryId: row.recovery_id,
        revision: row.account_revision,
        challenge: row.challenge,
        payloadHash: row.payload_hash,
      }),
    );
  } catch {
    return false;
  }
}
