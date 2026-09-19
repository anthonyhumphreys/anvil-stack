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
export function base64ByteLength(value: string): number | null {
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
export const CRYPTO_ENTITY_KEYRING_ROTATION = 'keyring-rotation';
export const CRYPTO_ENTITY_KEYRING_PAIRED = 'keyring-paired';

export function isCryptoBoundaryEntityType(entityType: string): boolean {
  return (
    entityType === CRYPTO_ENTITY_DEVICE_IDENTITY ||
    entityType === CRYPTO_ENTITY_KEYRING_WRAP ||
    entityType === CRYPTO_ENTITY_KEYRING_PAIRING ||
    entityType === CRYPTO_ENTITY_KEYRING_ROTATION ||
    entityType === CRYPTO_ENTITY_KEYRING_PAIRED
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
 * bundle is sealed to the recipient's X25519 identity via an ephemeral
 * sender key.
 */
export interface KeyringWrapPayload {
  v: 1;
  enc: 'x25519-aes-256-gcm';
  /** Highest ADK version contained inside (bundle ceiling). */
  keyVersion: number;
  /** base64 ephemeral X25519 public key. */
  ephPub: string;
  /** base64 12-byte GCM nonce. */
  nonce: string;
  /** base64 sealed KeyringWrapInner JSON (or a bare 32-byte ADK on v1 writers). */
  ct: string;
}

/**
 * Plaintext sealed inside a keyring-wrap: the full ADK version bundle the
 * sender holds. Delivering every held version makes missed-rotation
 * recovery the same path as first delivery. v1 writers sealed the bare
 * 32-byte ADK instead of JSON — readers accept both.
 */
export interface KeyringWrapInner {
  v: 1;
  keys: Array<{ keyVersion: number; /** base64 ADK bytes. */ adk: string }>;
  /** Issuing device's X25519 public key, for SAS verification. */
  issuerPub?: string;
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

/**
 * Plaintext carried inside a pairing keyring blob. v1 carries a single
 * `{keyVersion, adk}`; v2 writers also carry `keys` (the full bundle) and
 * `proofNonce` — a fresh random value the redeemer echoes in its
 * keyring-paired entity so the issuer can promote the new enrollment to
 * trusted membership. Readers accept either shape.
 */
export interface PairingKeyringInner {
  v: 1;
  keyVersion?: number;
  /** base64 ADK bytes (v1 single-key form). */
  adk?: string;
  /** Full ADK version bundle (v2). */
  keys?: Array<{ keyVersion: number; /** base64 ADK bytes. */ adk: string }>;
  /** Issuing device's X25519 public key, for SAS verification. */
  issuerPub: string;
  /** Random redemption proof the new device echoes in `keyring-paired`. */
  proofNonce?: string;
}

/**
 * keyring-paired payload: entityId is the new device's enrollment id.
 * Plaintext attestation a freshly paired device publishes after
 * installing its keyring bundle — the issuer compares `proofNonce`
 * against the secret it minted and promotes the enrollment to trusted.
 */
export interface KeyringPairedPayload {
  v: 1;
  enrollmentId: string;
  /** base64 raw X25519 public key of the new device. */
  pub: string;
  /** Echo of `PairingKeyringInner.proofNonce`. */
  proofNonce: string;
}

/**
 * keyring-rotation payload: entityId is the rotation id. Published by the
 * device that minted `toVersion`; concurrent rotations on the same
 * version resolve deterministically (lowest rotationId wins, loser
 * supersedes) and the revoked set is durable evidence of intent.
 */
export interface KeyringRotationPayload {
  v: 1;
  rotationId: string;
  rotorEnrollmentId: string;
  fromVersion: number;
  toVersion: number;
  revokedEnrollmentIds: string[];
  rotatedAt: string;
}

// ---- Per-attempt credential grants (ENV-06) --------------------------------
// Model/provider credentials delivered to a cloud environment AFTER it
// claims a job: sealed to the environment's X25519 device identity, bound
// to exactly one (job, attempt, fence), and TTL'd. Grants are stored on the
// account object until the target pulls them or they expire — they are
// never journaled, never sync entities, and never readable by the backend.

/** Plaintext sealed inside a credential-grant envelope. */
export interface CredentialGrantInner {
  v: 1;
  /**
   * Grant kind from the `grant:` capability vocabulary — v1 is
   * `credential-name` (env-var injection); `provider-subscription`
   * device-login flows ride the same envelope later.
   */
  kind: string;
  /** Environment variables to inject for the attempt (name → value). */
  env: Record<string, string>;
}

/**
 * credential-grant envelope: the fence-binding fields are plaintext so the
 * backend can enforce stale-fence rejection without opening the seal; the
 * secrets live exclusively in `ct`.
 */
export interface CredentialGrantPayload {
  v: 1;
  enc: 'x25519-aes-256-gcm';
  jobId: string;
  attemptId: string;
  /** Attempt fence at claim time — a re-fenced attempt rejects the grant. */
  fence: number;
  targetEnrollmentId: string;
  /** ISO-8601; the backend drops undelivered grants past this instant. */
  expiresAt: string;
  /** base64 ephemeral X25519 public key. */
  ephPub: string;
  /** base64 12-byte GCM nonce. */
  nonce: string;
  /** base64 sealed CredentialGrantInner JSON. */
  ct: string;
}

/**
 * `credential.deliver` (user role): the source device deposits a grant
 * bound to a claimed attempt. The backend verifies the attempt is live,
 * owned by `targetEnrollmentId`, and still on `fence` — a stale fence is a
 * `conflict`, never a silent rebind.
 */
export interface CredentialDeliverParams {
  grant: CredentialGrantPayload;
}

export interface CredentialDeliverResult {
  delivered: boolean;
}

/**
 * `credential.pull` (worker role): the executing worker fetches grants
 * addressed to it for an attempt it owns (attempt + fence must match the
 * caller's live claim). Returned grants are marked delivered; re-pulls of
 * the same attempt return them again until expiry (a worker crash may
 * need them twice), but never after the attempt goes terminal.
 */
export interface CredentialPullParams {
  attemptId: string;
  fence: number;
}

export interface CredentialPullResult {
  grants: CredentialGrantPayload[];
}

// ---- Per-task content keys ---------------------------------------------------
// A job's sensitive inputs travel as `sealedInputs`: an AES-256-GCM
// envelope under a random 256-bit task content key (TCK) minted by the
// source (a trusted device or an approved dashboard client). The TCK is
// delivered to the resolved target — and to designated result recipients —
// as a job-scoped wrap sealed to the recipient's X25519 identity. Unlike
// credential grants, task wraps are NOT fence-bound: retries of the same
// immutable job reuse the same key, and result recipients never hold a
// claim fence. Ephemeral workers receive TCKs; they never receive ADKs.

/** Plaintext sealed inside a task-key wrap. */
export interface TaskKeyInner {
  v: 1;
  kind: 'task-key';
  /** base64 32-byte task content key. */
  key: string;
}

/**
 * task-key wrap: `{jobId, targetEnrollmentId}` is plaintext so the backend
 * can index deliveries and compute `keyDelivery` state; the key itself
 * lives exclusively in `ct`.
 */
export interface TaskKeyWrapPayload {
  v: 1;
  enc: 'x25519-aes-256-gcm';
  jobId: string;
  targetEnrollmentId: string;
  /** base64 ephemeral X25519 public key. */
  ephPub: string;
  /** base64 12-byte GCM nonce. */
  nonce: string;
  /** base64 sealed TaskKeyInner JSON. */
  ct: string;
}

/**
 * `taskkey.deliver` (user role): the job source deposits wraps addressed
 * to the resolved target and each declared result recipient. Idempotent
 * per (job, target); a wrap for a target that is not the job's resolved
 * target and not a declared result recipient is rejected.
 */
export interface TaskKeyDeliverParams {
  jobId: string;
  wraps: TaskKeyWrapPayload[];
}

export interface TaskKeyDeliverResult {
  delivered: number;
}

/**
 * `taskkey.pull` (either role): the calling enrollment fetches wraps
 * addressed to it for one job. Workers pull after claim; result
 * recipients pull any time. Pulls are repeatable (crash recovery may need
 * the key twice) and never deleted by pulling.
 */
export interface TaskKeyPullParams {
  jobId: string;
}

export interface TaskKeyPullResult {
  wraps: TaskKeyWrapPayload[];
}

/**
 * A sealed task payload — AES-256-GCM under a TCK. Distinct from
 * SealedEntityPayload: there is no ADK `keyVersion` because the key is
 * job-scoped and delivered by wrap, not versioned on the account.
 */
export interface SealedTaskPayload {
  enc: typeof SEALED_ENTITY_ALG;
  /** base64, exactly SEALED_NONCE_BYTES when decoded. */
  nonce: string;
  /** base64 ciphertext || GCM tag. */
  ct: string;
}

export function isSealedTaskPayload(value: unknown): value is SealedTaskPayload {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return record.enc === SEALED_ENTITY_ALG;
}

/**
 * Structural validation for a sealed task payload (no keyVersion field).
 * Returns null when valid, else a machine-readable rejection reason.
 */
export function sealedTaskEnvelopeIssue(value: unknown): string | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return 'envelope-not-object';
  }
  const record = value as Record<string, unknown>;
  if (record.enc !== SEALED_ENTITY_ALG) return 'envelope-unknown-alg';
  if (typeof record.nonce !== 'string') return 'envelope-bad-nonce';
  if (base64ByteLength(record.nonce) !== SEALED_NONCE_BYTES) return 'envelope-bad-nonce';
  if (typeof record.ct !== 'string' || record.ct.length === 0) return 'envelope-bad-ct';
  const ctLength = base64ByteLength(record.ct);
  if (ctLength === null || ctLength < 16) return 'envelope-bad-ct';
  return null;
}

// ---- Dashboard grant/snapshot envelopes --------------------------------------
// The browser's dashboard session key (DSK) is minted by the approving
// trusted device and sealed to the browser's ephemeral X25519 public key
// exactly like a task key — but the wrap rides the dashboard grant
// channel, not sync entities. Snapshots are sealed under the DSK.

/** Plaintext sealed inside a dashboard grant wrap. */
export interface DashboardGrantInner {
  v: 1;
  /** base64 32-byte dashboard session key. */
  dsk: string;
  /** Scopes the approving device granted (subset of requested). */
  scopes: string[];
  /** ISO-8601 grant expiry — the snapshot stream dies with it. */
  expiresAt: string;
}

/**
 * Dashboard grant envelope: binds the sealed DSK to the exact browser
 * identity (pub), request id, and expiry. The coordinator stores and
 * relays it but cannot open it.
 */
export interface DashboardGrantPayload {
  v: 1;
  enc: 'x25519-aes-256-gcm';
  requestId: string;
  browserPub: string;
  expiresAt: string;
  /** base64 ephemeral X25519 public key. */
  ephPub: string;
  /** base64 12-byte GCM nonce. */
  nonce: string;
  /** base64 sealed DashboardGrantInner JSON. */
  ct: string;
}

/** A sealed dashboard snapshot — AES-256-GCM under the DSK. */
export interface SealedDashboardSnapshot {
  enc: typeof SEALED_ENTITY_ALG;
  /** Monotonic per-request sequence; stale snapshots are rejected. */
  seq: number;
  /** base64 12-byte GCM nonce. */
  nonce: string;
  /** base64 ciphertext || GCM tag. */
  ct: string;
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
 * AD bound into per-attempt credential-grant seals (ENV-06). The grant is
 * unusable outside exactly one fenced attempt on one target enrollment —
 * job, attempt, fence, target, and expiry are all authenticated.
 */
export function credentialGrantAssociatedData(input: {
  jobId: string;
  attemptId: string;
  fence: number;
  targetEnrollmentId: string;
  expiresAt: string;
}): string {
  return [
    'anvil/credential-grant/v1',
    input.jobId,
    input.attemptId,
    String(input.fence),
    input.targetEnrollmentId,
    input.expiresAt,
  ].join('|');
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

/**
 * AD bound into task-key wraps. Job, target, and account are all
 * authenticated — a wrap transplanted to a different job or recipient
 * fails to open.
 */
export function taskKeyWrapAssociatedData(input: {
  backendId: string;
  accountId: string;
  jobId: string;
  targetEnrollmentId: string;
}): string {
  return [
    'anvil/task-key/v1',
    input.backendId,
    input.accountId,
    input.jobId,
    input.targetEnrollmentId,
  ].join('|');
}

/**
 * AD bound into `sealedInputs`. The job id does not exist at seal time —
 * `requestId` is the stable pre-allocation identity — so the seal is
 * bound to backend, account, and request id.
 */
export function taskInputsAssociatedData(input: {
  backendId: string;
  accountId: string;
  requestId: string;
}): string {
  return [
    'anvil/task-inputs/v1',
    input.backendId,
    input.accountId,
    input.requestId,
  ].join('|');
}

/**
 * AD bound into sealed attempt results (the rich result manifest sealed
 * under the TCK into the evidence artifact / `attempt.report.sealedResult`).
 */
export function taskResultAssociatedData(input: {
  backendId: string;
  accountId: string;
  jobId: string;
  attemptId: string;
}): string {
  return [
    'anvil/task-result/v1',
    input.backendId,
    input.accountId,
    input.jobId,
    input.attemptId,
  ].join('|');
}

/**
 * AD bound into dashboard grant wraps — the sealed DSK authenticates to
 * exactly one (account, request, browser pubkey, expiry).
 */
export function dashboardGrantAssociatedData(input: {
  backendId: string;
  accountId: string;
  requestId: string;
  browserPub: string;
  expiresAt: string;
}): string {
  return [
    'anvil/dashboard-grant/v1',
    input.backendId,
    input.accountId,
    input.requestId,
    input.browserPub,
    input.expiresAt,
  ].join('|');
}

/**
 * AD bound into dashboard snapshots — the sequence number is
 * authenticated, so a stale or reordered snapshot fails to open rather
 * than silently reverting state.
 */
export function dashboardSnapshotAssociatedData(input: {
  backendId: string;
  accountId: string;
  requestId: string;
  seq: number;
}): string {
  return [
    'anvil/dashboard/v1',
    input.backendId,
    input.accountId,
    input.requestId,
    String(input.seq),
  ].join('|');
}
