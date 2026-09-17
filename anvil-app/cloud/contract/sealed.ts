// E2E sealing contract: the wire shape of encrypted entity payloads plus
// the crypto-boundary entity types that distribute account key material.
//
// Threat model: the backend is honest-but-curious. Synced entity payloads
// travel as sealed envelopes the server stores and journals but cannot
// open; key material moves only inside device-to-device wraps or
// out-of-band pairing secrets. Entity ids, types, revisions, sizes, and
// the device roster remain server-visible metadata.
//
// Primitives (implemented with vetted library bindings per platform —
// Node crypto / WebCrypto, never hand-rolled):
//   entity payloads: AES-256-GCM under a versioned 256-bit account data
//     key (ADK), random 96-bit nonce, associated data binding the
//     envelope to account/entity/operation/schema/key version.
//   key distribution: X25519 device identity + HKDF-SHA256 + AES-256-GCM
//     wrap, or a one-time pairing secret conveyed out of band.
//   share links: AES-256-GCM under a per-share random key carried in the
//     URL fragment (never sent to the server).

export const SEALED_ENTITY_ALG = 'aes-256-gcm';
export const SEALED_NONCE_BYTES = 12;
export const SEALED_KEY_BYTES = 32;

/** Wire envelope carried in `payload` for sealed synced entities. */
export interface SealedEntityPayload {
  enc: typeof SEALED_ENTITY_ALG;
  /** ADK version the ciphertext was sealed under. */
  keyVersion: number;
  /** base64, exactly SEALED_NONCE_BYTES when decoded. */
  nonce: string;
  /** base64 ciphertext || GCM tag. */
  ct: string;
}

export function isSealedEntityPayload(value: unknown): value is SealedEntityPayload {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return record.enc === SEALED_ENTITY_ALG;
}

/** Decoded byte length of a base64 string, or null when malformed. */
function base64ByteLength(value: string): number | null {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value) || value.length % 4 !== 0) return null;
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  return (value.length / 4) * 3 - padding;
}

/**
 * Structural validation for a sealed envelope. Returns null when valid,
 * else a machine-readable rejection reason. Used by the backend (which
 * never opens the envelope) and by clients before attempting to unseal.
 */
export function sealedEnvelopeIssue(value: unknown): string | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return 'envelope-not-object';
  }
  const record = value as Record<string, unknown>;
  if (record.enc !== SEALED_ENTITY_ALG) return 'envelope-unknown-alg';
  if (
    typeof record.keyVersion !== 'number' ||
    !Number.isInteger(record.keyVersion) ||
    record.keyVersion < 1
  ) {
    return 'envelope-bad-key-version';
  }
  if (typeof record.nonce !== 'string') return 'envelope-bad-nonce';
  if (base64ByteLength(record.nonce) !== SEALED_NONCE_BYTES) return 'envelope-bad-nonce';
  if (typeof record.ct !== 'string' || record.ct.length === 0) return 'envelope-bad-ct';
  // GCM tag overhead: ciphertext must carry at least the 16-byte tag.
  const ctLength = base64ByteLength(record.ct);
  if (ctLength === null || ctLength < 16) return 'envelope-bad-ct';
  return null;
}

// ---- Crypto-boundary entity types -----------------------------------------
// These entities carry key-distribution material. They are intercepted by
// the sync engine before domain handling and are never themselves sealed
// under the ADK: device identities are public keys, wraps are sealed to a
// specific device key, pairing blobs are sealed under an out-of-band secret.

export const CRYPTO_ENTITY_DEVICE_IDENTITY = 'device-identity';
export const CRYPTO_ENTITY_KEYRING_WRAP = 'keyring-wrap';
export const CRYPTO_ENTITY_KEYRING_PAIRING = 'keyring-pairing';

export function isCryptoBoundaryEntityType(entityType: string): boolean {
  return (
    entityType === CRYPTO_ENTITY_DEVICE_IDENTITY ||
    entityType === CRYPTO_ENTITY_KEYRING_WRAP ||
    entityType === CRYPTO_ENTITY_KEYRING_PAIRING
  );
}

/** device-identity payload: entityId is the enrollment id. Plaintext. */
export interface DeviceIdentityPayload {
  v: 1;
  enrollmentId: string;
  /** base64 raw X25519 public key (32 bytes). */
  pub: string;
}

/**
 * keyring-wrap payload: entityId is the *recipient* enrollment id. The ADK
 * is sealed to the recipient's X25519 identity via an ephemeral sender key.
 */
export interface KeyringWrapPayload {
  v: 1;
  enc: 'x25519-aes-256-gcm';
  /** ADK version contained inside. */
  keyVersion: number;
  /** base64 ephemeral X25519 public key. */
  ephPub: string;
  /** base64 12-byte GCM nonce. */
  nonce: string;
  /** base64 sealed ADK bytes. */
  ct: string;
}

/**
 * keyring-pairing payload: entityId is the pairing nonce. Sealed under the
 * pairing secret that travels inside the out-of-band pairing payload
 * (QR / typed string) — the server never sees the secret.
 */
export interface PairingKeyringPayload {
  v: 1;
  enc: 'pairing-aes-256-gcm';
  /** base64 12-byte GCM nonce. */
  nonce: string;
  ct: string;
}

/** Plaintext carried inside a pairing keyring blob. */
export interface PairingKeyringInner {
  v: 1;
  keyVersion: number;
  /** base64 ADK bytes. */
  adk: string;
  /** Issuing device's X25519 public key, for SAS verification. */
  issuerPub: string;
}

// ---- Pairing payload format -------------------------------------------------
// `anvil-pair-XXXXX-…`: a single typed/scanned string carrying everything
// the new device needs WITHOUT the server ever seeing the secret.
// Canonical body is 100 alphanumeric chars: enrollment code (20) +
// pairing nonce (16 hex) + pairing secret (64 hex), displayed grouped
// in runs of five.

export const PAIRING_PAYLOAD_PREFIX = 'anvil-pair-';
const PAIRING_CODE_CHARS = 20;
const PAIRING_NONCE_CHARS = 16;
const PAIRING_SECRET_CHARS = 64;
const PAIRING_BODY_CHARS = PAIRING_CODE_CHARS + PAIRING_NONCE_CHARS + PAIRING_SECRET_CHARS;

function alnumOnly(value: string): string {
  return value.replace(/[^A-Za-z0-9]/g, '');
}

/** `anvil-ec-XXXXX-…` (or bare code) → the 20-char normalized code body. */
export function normalizePairingEnrollmentCode(code: string): string | null {
  const body = alnumOnly(code.replace(/^anvil-ec-/i, ''));
  return body.length === PAIRING_CODE_CHARS ? body : null;
}

export function encodePairingPayload(input: {
  enrollmentCode: string;
  pairingNonce: string;
  pairingSecret: string;
}): string | null {
  const code = normalizePairingEnrollmentCode(input.enrollmentCode);
  const nonce = alnumOnly(input.pairingNonce);
  const secret = alnumOnly(input.pairingSecret);
  if (code === null) return null;
  if (nonce.length !== PAIRING_NONCE_CHARS || secret.length !== PAIRING_SECRET_CHARS) {
    return null;
  }
  const body = `${code}${nonce}${secret}`;
  const groups: string[] = [];
  for (let i = 0; i < body.length; i += 5) groups.push(body.slice(i, i + 5));
  return `${PAIRING_PAYLOAD_PREFIX}${groups.join('-')}`;
}

export function decodePairingPayload(value: string): {
  enrollmentCode: string;
  pairingNonce: string;
  pairingSecret: string;
} | null {
  const trimmed = value.trim();
  if (!trimmed.toLowerCase().startsWith(PAIRING_PAYLOAD_PREFIX)) return null;
  const body = alnumOnly(trimmed.slice(PAIRING_PAYLOAD_PREFIX.length));
  if (body.length !== PAIRING_BODY_CHARS) return null;
  const code = body.slice(0, PAIRING_CODE_CHARS);
  return {
    enrollmentCode: `anvil-ec-${code.slice(0, 5)}-${code.slice(5, 10)}-${code.slice(10, 15)}-${code.slice(15, 20)}`,
    pairingNonce: body.slice(PAIRING_CODE_CHARS, PAIRING_CODE_CHARS + PAIRING_NONCE_CHARS),
    pairingSecret: body.slice(PAIRING_CODE_CHARS + PAIRING_NONCE_CHARS),
  };
}

export function isPairingPayloadString(value: string): boolean {
  return value.trim().toLowerCase().startsWith(PAIRING_PAYLOAD_PREFIX);
}

// ---- Associated data --------------------------------------------------------
// Versioned, canonical AD strings bound into every AEAD seal. Changing any
// field (entity id, account, key version, …) fails authentication.

/**
 * AD bound into every entity seal. Operation and schemaVersion are
 * deliberately excluded: they are already integrity-bound by the
 * backend-verified payloadHash, and excluding them lets a quarantined
 * envelope be re-opened without reconstructing the original mutation.
 */
export function entitySealAssociatedData(input: {
  backendId: string;
  accountId: string;
  entityType: string;
  entityId: string;
  keyVersion: number;
}): string {
  return [
    'anvil/entity-seal/v1',
    input.backendId,
    input.accountId,
    input.entityType,
    input.entityId,
    String(input.keyVersion),
  ].join('|');
}

export function keyringWrapAssociatedData(input: {
  backendId: string;
  accountId: string;
  enrollmentId: string;
  keyVersion: number;
}): string {
  return [
    'anvil/keyring-wrap/v1',
    input.backendId,
    input.accountId,
    input.enrollmentId,
    String(input.keyVersion),
  ].join('|');
}

export function pairingSealAssociatedData(input: { pairingNonce: string }): string {
  return `anvil/pairing-seal/v1|${input.pairingNonce}`;
}

/**
 * AD bound into artifact byte seals. The artifact id cannot appear here:
 * `artifact.reserve` requires the ciphertext sha256 *before* it mints the
 * id, so the id does not exist at seal time. The ciphertext→manifest
 * binding is the server-verified sha256 over the stored bytes; this AD
 * provides domain separation and pins the plaintext to the media type it
 * will be interpreted under.
 */
export function artifactSealAssociatedData(input: { mediaType: string }): string {
  return `anvil/artifact-seal/v1|${input.mediaType}`;
}

/**
 * AD bound into share byte seals. Same circularity as artifacts —
 * `share.create` needs the ciphertext hash before the share id exists —
 * so the binding is the stored-bytes sha256 plus this media-type AD.
 */
export function shareSealAssociatedData(input: { mediaType: string }): string {
  return `anvil/share-seal/v1|${input.mediaType}`;
}
