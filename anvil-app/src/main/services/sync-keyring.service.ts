// E2E keyring: account data key (ADK) custody, X25519 device identity,
// key distribution (pairing secrets + per-device wraps), rotation on
// revoke, and the seal/unseal primitives the sync engine calls at its
// wire boundary.
//
// Trust model: the backend stores sealed envelopes and wrap blobs it
// cannot open. The ADK never leaves a device unwrapped — it moves either
// sealed to a recipient's X25519 identity (keyring-wrap entity) or under
// a one-time pairing secret carried out of band (keyring-pairing entity).
// Local key material is persisted safeStorage-wrapped in SQLite.
//
// Primitives are Node crypto only — AES-256-GCM, X25519, HKDF-SHA256,
// SHA-256. No hand-rolled constructions.

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  randomUUID,
  type KeyObject,
} from 'node:crypto';
import {
  CRYPTO_ENTITY_DEVICE_IDENTITY,
  CRYPTO_ENTITY_KEYRING_PAIRED,
  CRYPTO_ENTITY_KEYRING_PAIRING,
  CRYPTO_ENTITY_KEYRING_ROTATION,
  CRYPTO_ENTITY_KEYRING_WRAP,
  SEALED_ENTITY_ALG,
  credentialGrantAssociatedData,
  encodePairingPayload,
  entitySealAssociatedData,
  isSealedEntityPayload,
  isSealedTaskPayload,
  keyringWrapAssociatedData,
  pairingSealAssociatedData,
  sealedEnvelopeIssue,
  sealedTaskEnvelopeIssue,
  taskInputsAssociatedData,
  taskKeyWrapAssociatedData,
  taskResultAssociatedData,
  type CredentialGrantInner,
  type CredentialGrantPayload,
  type DeviceIdentityPayload,
  type KeyringPairedPayload,
  type KeyringRotationPayload,
  type KeyringWrapInner,
  type KeyringWrapPayload,
  type PairingKeyringInner,
  type PairingKeyringPayload,
  type SealedEntityPayload,
  type SealedTaskPayload,
  type TaskKeyInner,
  type TaskKeyWrapPayload,
} from '../../../cloud/contract/sealed.js';
import type { SyncOperation, SyncScope } from '../../shared/sync-mesh.js';
import { getDb } from '../db/database.js';
import { canonicalJson, recordLocalChange } from './sync-persistence.service.js';
import { applyRemoteEntityPayload } from './sync-entity-domain.js';
import { encryptSecret, decryptSecret } from './auth.service.js';

const X25519_SPKI_PREFIX = Buffer.from('302a300506032b656e032100', 'hex');
const X25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b656e04220420', 'hex');

export type UnsealFailure =
  | 'malformed-envelope'
  | 'unknown-key-version'
  | 'auth-failed'
  | 'malformed-plaintext';

export class UnsealError extends Error {
  readonly reason: UnsealFailure;
  constructor(reason: UnsealFailure, message: string) {
    super(message);
    this.name = 'UnsealError';
    this.reason = reason;
  }
}

/** Raised when a seal is requested but no usable ADK exists locally. */
export class AccountKeyUnavailableError extends Error {
  constructor() {
    super('No account data key available on this device');
    this.name = 'AccountKeyUnavailableError';
  }
}

function nowIso(): string {
  return new Date().toISOString();
}

export function wrapSecretBytes(plain: Buffer): Buffer {
  return encryptSecret(plain.toString('base64'));
}

export function unwrapSecretBytes(stored: Buffer): Buffer | null {
  const decoded = decryptSecret(stored, 'sync key material');
  if (decoded === undefined) return null;
  return Buffer.from(decoded, 'base64');
}

// ---- ADK storage -------------------------------------------------------------

/**
 * Where an ADK version came from. 'minted' is a provisional self-mint —
 * v1 created before this device could rule out other enrolled devices;
 * it is the only source a peer-delivered key may displace. 'wrap' and
 * 'pairing' are account-authoritative deliveries, 'rotation' is this
 * device's own authoritative mint on revoke.
 */
export type AccountKeySource = 'minted' | 'wrap' | 'pairing' | 'rotation';

interface KeyringRow {
  key_version: number;
  key_wrapped: Buffer;
  source: string;
}

function keyringRows(scope: SyncScope): KeyringRow[] {
  return getDb()
    .prepare(
      `SELECT key_version, key_wrapped, source FROM sync_keyring
       WHERE backend_id = ? AND account_id = ? ORDER BY key_version ASC`,
    )
    .all(scope.backendId, scope.accountId) as KeyringRow[];
}

/** Highest ADK version this device holds, with the key bytes. */
export function currentAccountKey(scope: SyncScope): { version: number; key: Buffer } | null {
  const rows = keyringRows(scope);
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const key = unwrapSecretBytes(rows[i].key_wrapped);
    if (key !== null) return { version: rows[i].key_version, key };
  }
  return null;
}

export function accountKeyFor(scope: SyncScope, version: number): Buffer | null {
  const row = getDb()
    .prepare(
      `SELECT key_wrapped FROM sync_keyring
       WHERE backend_id = ? AND account_id = ? AND key_version = ?`,
    )
    .get(scope.backendId, scope.accountId, version) as { key_wrapped: Buffer } | undefined;
  return row === undefined ? null : unwrapSecretBytes(row.key_wrapped);
}

export function hasAccountKey(scope: SyncScope): boolean {
  return currentAccountKey(scope) !== null;
}

/**
 * Installs an ADK version. Idempotent for identical bytes. On a
 * same-version/different-bytes conflict the incoming key wins only when
 * the stored key is a provisional 'minted' row and the incoming key was
 * peer-delivered ('wrap' | 'pairing') — that heals a v1 minted before
 * this device learned the account's real key. Every other conflict keeps
 * the stored row: delivered and rotated keys are never displaced.
 */
export function installAccountKey(
  scope: SyncScope,
  version: number,
  key: Buffer,
  source: AccountKeySource,
): void {
  if (key.byteLength !== 32) {
    throw new Error('ADK must be 32 bytes');
  }
  const db = getDb();
  const existing = db
    .prepare(
      `SELECT key_wrapped, source FROM sync_keyring
       WHERE backend_id = ? AND account_id = ? AND key_version = ?`,
    )
    .get(scope.backendId, scope.accountId, version) as
    | { key_wrapped: Buffer; source: string }
    | undefined;
  if (existing === undefined) {
    db.prepare(
      `INSERT INTO sync_keyring
         (backend_id, account_id, key_version, key_wrapped, source, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(scope.backendId, scope.accountId, version, wrapSecretBytes(key), source, nowIso());
    return;
  }
  const existingKey = unwrapSecretBytes(existing.key_wrapped);
  if (existingKey !== null && existingKey.equals(key)) return;
  if (existing.source === 'minted' && (source === 'wrap' || source === 'pairing')) {
    db.prepare(
      `UPDATE sync_keyring SET key_wrapped = ?, source = ?
       WHERE backend_id = ? AND account_id = ? AND key_version = ?`,
    ).run(wrapSecretBytes(key), source, scope.backendId, scope.accountId, version);
  }
}

/**
 * Creates ADK v1 when this device holds no key at all. Only safe to call
 * when no other enrolled devices exist on the account — a second device
 * must wait for a wrap or pairing blob instead of minting a divergent key.
 */
export function provisionAccountKey(scope: SyncScope): number {
  const existing = currentAccountKey(scope);
  if (existing !== null) return existing.version;
  installAccountKey(scope, 1, randomBytes(32), 'minted');
  return 1;
}

/**
 * Lazy first-device provisioning gate. It is safe to mint ADK v1 only when
 * there is no evidence the account is already keyed elsewhere: the device
 * has completed a pull (so peer identities and wraps have had a chance to
 * arrive), no other device identities have been seen, no pairing
 * redemption is pending, and no quarantined sealed envelopes are waiting
 * on a key. A second device that enrolled via OIDC without pairing sees
 * the issuer's device-identity on its first pull and fails this gate
 * until the wrap arrives.
 */
export function canProvisionAccountKey(scope: SyncScope, ownEnrollmentId: string): boolean {
  const db = getDb();
  // A device that has never pulled cannot know whether the account is
  // already keyed elsewhere — minting now risks a divergent v1.
  const pulled = db
    .prepare(
      `SELECT last_pull_at FROM sync_state
       WHERE backend_id = ? AND account_id = ? AND dataset_epoch = ?`,
    )
    .get(scope.backendId, scope.accountId, scope.datasetEpoch) as
    | { last_pull_at: string | null }
    | undefined;
  if (pulled?.last_pull_at == null) return false;
  const otherIdentities = listDeviceIdentities(scope).some(
    (device) => device.enrollmentId !== ownEnrollmentId,
  );
  if (otherIdentities) return false;
  const pendingRedeemer = db
    .prepare(
      `SELECT COUNT(*) AS n FROM sync_pairing
       WHERE backend_id = ? AND account_id = ? AND role = 'redeemer'`,
    )
    .get(scope.backendId, scope.accountId) as { n: number };
  if (pendingRedeemer.n > 0) return false;
  const sealedQuarantine = db
    .prepare(
      `SELECT COUNT(*) AS n FROM sync_bindings
       WHERE backend_id = ? AND account_id = ? AND dataset_epoch = ?
         AND quarantine_json LIKE '%"enc":"aes-256-gcm"%'`,
    )
    .get(scope.backendId, scope.accountId, scope.datasetEpoch) as { n: number };
  return sealedQuarantine.n === 0;
}

// ---- Device identity (X25519) -------------------------------------------------

function x25519PublicFromRaw(raw: Buffer): KeyObject {
  return createPublicKey({
    key: Buffer.concat([X25519_SPKI_PREFIX, raw]),
    format: 'der',
    type: 'spki',
  });
}

function x25519PrivateFromRaw(raw: Buffer): KeyObject {
  return createPrivateKey({
    key: Buffer.concat([X25519_PKCS8_PREFIX, raw]),
    format: 'der',
    type: 'pkcs8',
  });
}

function rawPublic(key: KeyObject): Buffer {
  const der = key.export({ format: 'der', type: 'spki' });
  return der.subarray(der.length - 32);
}

function rawPrivate(key: KeyObject): Buffer {
  const der = key.export({ format: 'der', type: 'pkcs8' });
  return der.subarray(der.length - 32);
}

interface DeviceKeyRow {
  enrollment_id: string;
  identity_pub: string;
  identity_priv_wrapped: Buffer | null;
}

/**
 * This device's X25519 identity for the given enrollment, creating it on
 * first use. The private half stays safeStorage-wrapped at rest.
 */
export function ensureDeviceIdentity(scope: SyncScope, enrollmentId: string): { pub: string } {
  const db = getDb();
  const existing = db
    .prepare(
      `SELECT identity_pub FROM sync_device_keys
       WHERE backend_id = ? AND account_id = ? AND enrollment_id = ?`,
    )
    .get(scope.backendId, scope.accountId, enrollmentId) as { identity_pub: string } | undefined;
  if (existing !== undefined) return { pub: existing.identity_pub };

  const pair = generateKeyPairSync('x25519');
  const pub = rawPublic(pair.publicKey).toString('base64');
  const priv = rawPrivate(pair.privateKey);
  db.prepare(
    `INSERT INTO sync_device_keys
       (backend_id, account_id, enrollment_id, identity_pub, identity_priv_wrapped, seen_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(scope.backendId, scope.accountId, enrollmentId, pub, wrapSecretBytes(priv), nowIso());
  return { pub };
}

function ownDevicePrivateKey(scope: SyncScope, enrollmentId: string): Buffer | null {
  const row = getDb()
    .prepare(
      `SELECT identity_priv_wrapped FROM sync_device_keys
       WHERE backend_id = ? AND account_id = ? AND enrollment_id = ?`,
    )
    .get(scope.backendId, scope.accountId, enrollmentId) as
    | { identity_priv_wrapped: Buffer | null }
    | undefined;
  if (row?.identity_priv_wrapped == null) return null;
  return unwrapSecretBytes(row.identity_priv_wrapped);
}

function ownPubRaw(scope: SyncScope, enrollmentId: string): Buffer | null {
  const row = getDb()
    .prepare(
      `SELECT identity_pub FROM sync_device_keys
       WHERE backend_id = ? AND account_id = ? AND enrollment_id = ?`,
    )
    .get(scope.backendId, scope.accountId, enrollmentId) as { identity_pub: string } | undefined;
  return row === undefined ? null : Buffer.from(row.identity_pub, 'base64');
}

/** All known device identities in the account, including this device's. */
export function listDeviceIdentities(
  scope: SyncScope,
): Array<{ enrollmentId: string; pub: string }> {
  const rows = getDb()
    .prepare(
      `SELECT enrollment_id, identity_pub FROM sync_device_keys
       WHERE backend_id = ? AND account_id = ?`,
    )
    .all(scope.backendId, scope.accountId) as DeviceKeyRow[];
  return rows.map((row) => ({ enrollmentId: row.enrollment_id, pub: row.identity_pub }));
}

/** Queues this device's identity as a (plaintext) device-identity entity. */
export function publishDeviceIdentity(scope: SyncScope, enrollmentId: string): void {
  const { pub } = ensureDeviceIdentity(scope, enrollmentId);
  // This device's own enrollment is inherently trusted — the membership
  // gate governs deliveries TO other devices.
  setDeviceTrust(scope, enrollmentId, 'trusted');
  const payload: DeviceIdentityPayload = { v: 1, enrollmentId, pub };
  recordLocalChange(scope, {
    entityType: CRYPTO_ENTITY_DEVICE_IDENTITY,
    entityId: enrollmentId,
    operation: 'create',
    payload,
    schemaVersion: 1,
  });
}

// ---- Trusted membership -------------------------------------------------------
// Enrollment is authentication only — 'trusted' marks permission to
// receive ADK deliveries. Peers arrive 'pending' (no wraps, no pairing
// redemption until proof); the user promotes them after SAS verification
// or they promote themselves via a pairing redemption proof. 'revoked' is
// sticky: it survives identity re-announcement and blocks every delivery
// path — wraps, rotation fan-out, pairing, repair.

export type DeviceTrustState = 'pending' | 'trusted' | 'revoked';

export function deviceTrustState(
  scope: SyncScope,
  enrollmentId: string,
): DeviceTrustState | null {
  const row = getDb()
    .prepare(
      `SELECT state FROM sync_device_trust
       WHERE backend_id = ? AND account_id = ? AND enrollment_id = ?`,
    )
    .get(scope.backendId, scope.accountId, enrollmentId) as { state: string } | undefined;
  return (row?.state as DeviceTrustState | undefined) ?? null;
}

/**
 * Sets the trust state for an enrollment. 'revoked' is a floor — it can
 * never transition back to pending/trusted by anything but an explicit
 * new approval decision (callers pass `force` only from user-confirmed
 * approval paths).
 */
export function setDeviceTrust(
  scope: SyncScope,
  enrollmentId: string,
  state: DeviceTrustState,
  opts?: { force?: boolean },
): void {
  const db = getDb();
  const existing = deviceTrustState(scope, enrollmentId);
  if (existing === 'revoked' && state !== 'revoked' && opts?.force !== true) {
    return; // sticky revocation — re-announcement never reopens delivery
  }
  if (existing === state) return;
  db.prepare(
    `INSERT INTO sync_device_trust (backend_id, account_id, enrollment_id, state, decided_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (backend_id, account_id, enrollment_id)
     DO UPDATE SET state = excluded.state, decided_at = excluded.decided_at`,
  ).run(scope.backendId, scope.accountId, enrollmentId, state, nowIso());
}

/** True when the enrollment may receive ADK key material. */
export function isKeyDeliverable(scope: SyncScope, enrollmentId: string): boolean {
  return deviceTrustState(scope, enrollmentId) === 'trusted';
}

/** All enrollments with their trust state, for settings/dashboard display. */
export function listDeviceTrust(
  scope: SyncScope,
): Array<{ enrollmentId: string; state: DeviceTrustState; decidedAt: string | null }> {
  const rows = getDb()
    .prepare(
      `SELECT enrollment_id, state, decided_at FROM sync_device_trust
       WHERE backend_id = ? AND account_id = ?`,
    )
    .all(scope.backendId, scope.accountId) as Array<{
    enrollment_id: string;
    state: string;
    decided_at: string | null;
  }>;
  return rows.map((row) => ({
    enrollmentId: row.enrollment_id,
    state: row.state as DeviceTrustState,
    decidedAt: row.decided_at,
  }));
}

// ---- AES-256-GCM helpers -------------------------------------------------------

function gcmSeal(key: Buffer, aad: string, plaintext: Buffer): { nonce: string; ct: string } {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
  return { nonce: nonce.toString('base64'), ct: ct.toString('base64') };
}

function gcmOpen(key: Buffer, aad: string, nonceB64: string, ctB64: string): Buffer {
  const nonce = Buffer.from(nonceB64, 'base64');
  const ct = Buffer.from(ctB64, 'base64');
  const tag = ct.subarray(ct.length - 16);
  const body = ct.subarray(0, ct.length - 16);
  const decipher = createDecipheriv('aes-256-gcm', key, nonce);
  decipher.setAAD(Buffer.from(aad, 'utf8'));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body), decipher.final()]);
}

// ---- Entity payload sealing -----------------------------------------------------

export interface SealContext {
  entityType: string;
  entityId: string;
  operation: SyncOperation;
  schemaVersion: number;
}

/**
 * Seals a domain payload for the wire under the current ADK. Throws
 * AccountKeyUnavailableError when no key exists — the caller must skip the
 * change rather than ever send plaintext.
 */
export function sealEntityPayload(
  scope: SyncScope,
  context: SealContext,
  payload: unknown,
): SealedEntityPayload {
  let accountKey = currentAccountKey(scope);
  if (accountKey === null) {
    // First device on a fresh account mints ADK v1 on first seal; a device
    // awaiting a wrap/pairing blob fails the gate and defers the change.
    const own = getActiveEnrollmentId(scope);
    if (own !== null && canProvisionAccountKey(scope, own)) {
      provisionAccountKey(scope);
      accountKey = currentAccountKey(scope);
    }
  }
  if (accountKey === null) throw new AccountKeyUnavailableError();
  const aad = entitySealAssociatedData({
    backendId: scope.backendId,
    accountId: scope.accountId,
    entityType: context.entityType,
    entityId: context.entityId,
    keyVersion: accountKey.version,
  });
  const { nonce, ct } = gcmSeal(accountKey.key, aad, Buffer.from(canonicalJson(payload), 'utf8'));
  return { enc: SEALED_ENTITY_ALG, keyVersion: accountKey.version, nonce, ct };
}

/**
 * Opens a sealed wire payload back to the domain object. Throws
 * UnsealError with a machine-readable reason on any failure.
 */
export function unsealEntityPayload(
  scope: SyncScope,
  context: Pick<SealContext, 'entityType' | 'entityId'>,
  envelope: unknown,
): unknown {
  if (!isSealedEntityPayload(envelope) || sealedEnvelopeIssue(envelope) !== null) {
    throw new UnsealError('malformed-envelope', 'payload is not a well-formed sealed envelope');
  }
  const key = accountKeyFor(scope, envelope.keyVersion);
  if (key === null) {
    throw new UnsealError(
      'unknown-key-version',
      `no local ADK for key version ${envelope.keyVersion}`,
    );
  }
  const aad = entitySealAssociatedData({
    backendId: scope.backendId,
    accountId: scope.accountId,
    entityType: context.entityType,
    entityId: context.entityId,
    keyVersion: envelope.keyVersion,
  });
  let plaintext: Buffer;
  try {
    plaintext = gcmOpen(key, aad, envelope.nonce, envelope.ct);
  } catch {
    throw new UnsealError('auth-failed', 'sealed payload failed authentication');
  }
  try {
    return JSON.parse(plaintext.toString('utf8')) as unknown;
  } catch {
    throw new UnsealError('malformed-plaintext', 'sealed payload did not contain JSON');
  }
}

// ---- Raw byte sealing (artifacts, checkpoints, share payloads) -------------------

/**
 * Seals raw bytes under the current ADK. The stored blob is
 * `nonce(12)‖ct‖tag` — self-contained, so the manifest only needs the
 * keyVersion. `aadContext` binds the ciphertext to its purpose (for
 * example `anvil/artifact/v1:{artifactId}`).
 */
export function sealAccountBytes(
  scope: SyncScope,
  aadContext: string,
  plaintext: Buffer,
): { keyVersion: number; bytes: Buffer } {
  const accountKey = currentAccountKey(scope);
  if (accountKey === null) throw new AccountKeyUnavailableError();
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', accountKey.key, nonce);
  cipher.setAAD(Buffer.from(aadContext, 'utf8'));
  const bytes = Buffer.concat([
    nonce,
    cipher.update(plaintext),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
  return { keyVersion: accountKey.version, bytes };
}

/** Opens a blob produced by `sealAccountBytes`; throws UnsealError on failure. */
export function unsealAccountBytes(
  scope: SyncScope,
  aadContext: string,
  keyVersion: number,
  bytes: Buffer,
): Buffer {
  const key = accountKeyFor(scope, keyVersion);
  if (key === null) {
    throw new UnsealError('unknown-key-version', `no local ADK for key version ${keyVersion}`);
  }
  if (bytes.byteLength < 12 + 16) {
    throw new UnsealError('malformed-envelope', 'sealed blob too short');
  }
  try {
    return gcmOpen(
      key,
      aadContext,
      bytes.subarray(0, 12).toString('base64'),
      bytes.subarray(12).toString('base64'),
    );
  } catch {
    throw new UnsealError('auth-failed', 'sealed bytes failed authentication');
  }
}

/**
 * Seals bytes under a one-off key that is NOT the ADK — used for hosted
 * shares, where the decryption key travels in the share URL fragment and
 * recipients hold no account material. Same blob layout.
 */
export function sealBytesWithKey(aadContext: string, key: Buffer, plaintext: Buffer): Buffer {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(Buffer.from(aadContext, 'utf8'));
  return Buffer.concat([nonce, cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
}

/** Opens a `sealBytesWithKey` blob; returns null on authentication failure. */
export function unsealBytesWithKey(aadContext: string, key: Buffer, bytes: Buffer): Buffer | null {
  if (bytes.byteLength < 12 + 16) return null;
  try {
    return gcmOpen(
      key,
      aadContext,
      bytes.subarray(0, 12).toString('base64'),
      bytes.subarray(12).toString('base64'),
    );
  } catch {
    return null;
  }
}

/**
 * Seals an arbitrary JSON value under the current ADK as an
 * `{enc,keyVersion,nonce,ct}` envelope — used for payloads that travel
 * inside RPC params rather than sync entities (handoff checkpoints).
 * `aadContext` binds the ciphertext to its purpose.
 */
export function sealScopedJson(
  scope: SyncScope,
  aadContext: string,
  value: unknown,
): SealedEntityPayload {
  const accountKey = currentAccountKey(scope);
  if (accountKey === null) throw new AccountKeyUnavailableError();
  const { nonce, ct } = gcmSeal(
    accountKey.key,
    aadContext,
    Buffer.from(canonicalJson(value), 'utf8'),
  );
  return { enc: SEALED_ENTITY_ALG, keyVersion: accountKey.version, nonce, ct };
}

/** Opens a `sealScopedJson` envelope; throws UnsealError on any failure. */
export function unsealScopedJson(scope: SyncScope, aadContext: string, envelope: unknown): unknown {
  if (!isSealedEntityPayload(envelope) || sealedEnvelopeIssue(envelope) !== null) {
    throw new UnsealError('malformed-envelope', 'value is not a well-formed sealed envelope');
  }
  const key = accountKeyFor(scope, envelope.keyVersion);
  if (key === null) {
    throw new UnsealError(
      'unknown-key-version',
      `no local ADK for key version ${envelope.keyVersion}`,
    );
  }
  let plaintext: Buffer;
  try {
    plaintext = gcmOpen(key, aadContext, envelope.nonce, envelope.ct);
  } catch {
    throw new UnsealError('auth-failed', 'sealed value failed authentication');
  }
  try {
    return JSON.parse(plaintext.toString('utf8')) as unknown;
  } catch {
    throw new UnsealError('malformed-plaintext', 'sealed value did not contain JSON');
  }
}

// ---- Per-device ADK wrap --------------------------------------------------------

function wrapKeyMaterial(
  recipientPubRaw: Buffer,
  adk: Buffer,
  aad: string,
): { ephPub: string; nonce: string; ct: string } {
  const eph = generateKeyPairSync('x25519');
  const recipientPub = x25519PublicFromRaw(recipientPubRaw);
  const shared = diffieHellman({ privateKey: eph.privateKey, publicKey: recipientPub });
  const ephPubRaw = rawPublic(eph.publicKey);
  const wrapKey = Buffer.from(
    hkdfSync(
      'sha256',
      shared,
      Buffer.concat([ephPubRaw, recipientPubRaw]),
      Buffer.from('anvil/keyring-wrap/v1', 'utf8'),
      32,
    ),
  );
  const { nonce, ct } = gcmSeal(wrapKey, aad, adk);
  return { ephPub: ephPubRaw.toString('base64'), nonce, ct };
}

/**
 * Generic recipient-seal used by every wrap family (keyring bundles,
 * credential grants, task keys, dashboard grants): X25519 ephemeral DH +
 * HKDF-SHA256 (salt = ephPub‖recipientPub, info = 'anvil/keyring-wrap/v1')
 * + AES-256-GCM under `aad`. The browser-side unwrap in
 * `anvil-website/lib/mesh-crypto.ts` implements the same construction —
 * the HKDF info string is the interop contract, not the AD.
 */
export function sealToRecipientPub(
  recipientPubB64: string,
  plaintext: Buffer,
  aad: string,
): { ephPub: string; nonce: string; ct: string } {
  return wrapKeyMaterial(Buffer.from(recipientPubB64, 'base64'), plaintext, aad);
}

/**
 * Seals a JSON value under an arbitrary key into `{nonce, ct}` — used by
 * dashboard snapshots where the DSK (not the ADK) is the cipher key.
 */
export function sealJsonEnvelope(
  key: Buffer,
  aad: string,
  value: unknown,
): { nonce: string; ct: string } {
  return gcmSeal(key, aad, Buffer.from(canonicalJson(value), 'utf8'));
}

function unwrapKeyMaterial(
  scope: SyncScope,
  enrollmentId: string,
  wrap: { ephPub: string; nonce: string; ct: string },
  aad: string,
): Buffer | null {
  const privRaw = ownDevicePrivateKey(scope, enrollmentId);
  const pubRaw = ownPubRaw(scope, enrollmentId);
  if (privRaw === null || pubRaw === null) return null;
  const ephPubRaw = Buffer.from(wrap.ephPub, 'base64');
  const shared = diffieHellman({
    privateKey: x25519PrivateFromRaw(privRaw),
    publicKey: x25519PublicFromRaw(ephPubRaw),
  });
  const wrapKey = Buffer.from(
    hkdfSync(
      'sha256',
      shared,
      Buffer.concat([ephPubRaw, pubRaw]),
      Buffer.from('anvil/keyring-wrap/v1', 'utf8'),
      32,
    ),
  );
  try {
    return gcmOpen(wrapKey, aad, wrap.nonce, wrap.ct);
  } catch {
    return null;
  }
}

function hasDelivery(scope: SyncScope, enrollmentId: string, keyVersion: number): boolean {
  return (
    getDb()
      .prepare(
        `SELECT 1 AS x FROM sync_keyring_deliveries
         WHERE backend_id = ? AND account_id = ? AND enrollment_id = ? AND key_version = ?`,
      )
      .get(scope.backendId, scope.accountId, enrollmentId, keyVersion) !== undefined
  );
}

function markDelivery(scope: SyncScope, enrollmentId: string, keyVersion: number): void {
  getDb()
    .prepare(
      `INSERT OR IGNORE INTO sync_keyring_deliveries
         (backend_id, account_id, enrollment_id, key_version, delivered_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(scope.backendId, scope.accountId, enrollmentId, keyVersion, nowIso());
}

/**
 * All held ADK versions as a bundle — every trusted delivery carries the
 * full history so a device that was offline through rotations recovers on
 * the same path as first delivery.
 */
function accountKeyBundle(
  scope: SyncScope,
): Array<{ keyVersion: number; adk: string }> | null {
  const rows = keyringRows(scope);
  if (rows.length === 0) return null;
  const bundle: Array<{ keyVersion: number; adk: string }> = [];
  for (const row of rows) {
    const key = unwrapSecretBytes(row.key_wrapped);
    if (key !== null) bundle.push({ keyVersion: row.key_version, adk: key.toString('base64') });
  }
  return bundle.length === 0 ? null : bundle;
}

/**
 * Queues a keyring-wrap entity carrying the full ADK bundle sealed to the
 * target enrollment's registered identity. DELIVERY IS TRUST-GATED: a
 * target that is not 'trusted' (pending, revoked, or unknown) gets
 * nothing — enrollment alone never earns decrypt membership. Idempotent
 * per (target, max-version) via the delivery ledger.
 */
export function wrapAccountKeyFor(
  scope: SyncScope,
  targetEnrollmentId: string,
  recipientPubB64: string,
): void {
  if (!isKeyDeliverable(scope, targetEnrollmentId)) {
    return; // pending/revoked devices receive no key material
  }
  const bundle = accountKeyBundle(scope);
  if (bundle === null) throw new AccountKeyUnavailableError();
  const maxVersion = bundle[bundle.length - 1].keyVersion;
  const issuerEnrollmentId = getActiveEnrollmentId(scope);
  const inner: KeyringWrapInner = {
    v: 1,
    keys: bundle,
    ...(issuerEnrollmentId !== null
      ? { issuerPub: ensureDeviceIdentity(scope, issuerEnrollmentId).pub }
      : {}),
  };
  const aad = keyringWrapAssociatedData({
    backendId: scope.backendId,
    accountId: scope.accountId,
    enrollmentId: targetEnrollmentId,
    keyVersion: maxVersion,
  });
  const sealed = wrapKeyMaterial(
    Buffer.from(recipientPubB64, 'base64'),
    Buffer.from(JSON.stringify(inner), 'utf8'),
    aad,
  );
  const payload: KeyringWrapPayload = {
    v: 1,
    enc: 'x25519-aes-256-gcm',
    keyVersion: maxVersion,
    ephPub: sealed.ephPub,
    nonce: sealed.nonce,
    ct: sealed.ct,
  };
  recordLocalChange(scope, {
    entityType: CRYPTO_ENTITY_KEYRING_WRAP,
    entityId: targetEnrollmentId,
    operation: 'create',
    payload,
    schemaVersion: 1,
  });
  for (const entry of bundle) {
    markDelivery(scope, targetEnrollmentId, entry.keyVersion);
  }
}

// ---- Per-attempt credential grants (ENV-06) --------------------------------------
//
// Grants seal provider credentials to one environment's X25519 device
// identity, bound to exactly one (job, attempt, fence, expiry). The source
// device seals; the executing worker unseals with its own private key.
// The backend stores the envelope but can never open it.

/**
 * Seals grant material for `credential.deliver`. The binding fields ride
 * plaintext on the envelope so the backend can fence; `env` is the only
 * secret and lives exclusively in `ct`.
 */
export function sealCredentialGrant(input: {
  recipientPubB64: string;
  jobId: string;
  attemptId: string;
  fence: number;
  targetEnrollmentId: string;
  expiresAt: string;
  kind: string;
  env: Record<string, string>;
}): CredentialGrantPayload {
  const aad = credentialGrantAssociatedData({
    jobId: input.jobId,
    attemptId: input.attemptId,
    fence: input.fence,
    targetEnrollmentId: input.targetEnrollmentId,
    expiresAt: input.expiresAt,
  });
  const inner: CredentialGrantInner = { v: 1, kind: input.kind, env: input.env };
  const sealed = wrapKeyMaterial(
    Buffer.from(input.recipientPubB64, 'base64'),
    Buffer.from(JSON.stringify(inner), 'utf8'),
    aad,
  );
  return {
    v: 1,
    enc: 'x25519-aes-256-gcm',
    jobId: input.jobId,
    attemptId: input.attemptId,
    fence: input.fence,
    targetEnrollmentId: input.targetEnrollmentId,
    expiresAt: input.expiresAt,
    ephPub: sealed.ephPub,
    nonce: sealed.nonce,
    ct: sealed.ct,
  };
}

/**
 * Opens a pulled grant for `credential.pull`. Returns null when the device
 * key is missing or the seal fails — a grant that cannot authenticate is
 * skipped, never fed to the attempt.
 */
export function unsealCredentialGrant(
  scope: SyncScope,
  enrollmentId: string,
  grant: CredentialGrantPayload,
): CredentialGrantInner | null {
  if (grant.v !== 1 || grant.enc !== 'x25519-aes-256-gcm') return null;
  const aad = credentialGrantAssociatedData({
    jobId: grant.jobId,
    attemptId: grant.attemptId,
    fence: grant.fence,
    targetEnrollmentId: grant.targetEnrollmentId,
    expiresAt: grant.expiresAt,
  });
  const plaintext = unwrapKeyMaterial(scope, enrollmentId, grant, aad);
  if (plaintext === null) return null;
  try {
    const inner = JSON.parse(plaintext.toString('utf8')) as CredentialGrantInner;
    if (inner.v !== 1 || typeof inner.env !== 'object' || inner.env === null) return null;
    return inner;
  } catch {
    return null;
  }
}

// ---- Pairing -------------------------------------------------------------------

export interface PairingIssue {
  /** The full `anvil-pair-…` string to show/scan on the new device. */
  pairingPayload: string;
  pairingNonce: string;
}

function getActiveEnrollmentId(scope: SyncScope): string | null {
  const row = getDb()
    .prepare(
      `SELECT id FROM device_enrollments
       WHERE backend_id = ? AND account_id = ? AND dataset_epoch = ? AND state = 'active'
       ORDER BY updated_at DESC LIMIT 1`,
    )
    .get(scope.backendId, scope.accountId, scope.datasetEpoch) as { id: string } | undefined;
  return row?.id ?? null;
}

/**
 * After minting an enrollment code, seals the current ADK under a fresh
 * pairing secret and queues it as a keyring-pairing entity. The returned
 * payload = enrollment code + nonce + secret; the server only ever sees
 * the code (at redeem) and the sealed blob.
 */
export function mintPairingPayload(
  scope: SyncScope,
  issuerEnrollmentId: string,
  enrollmentCode: string,
): PairingIssue {
  const bundle = accountKeyBundle(scope);
  if (bundle === null) throw new AccountKeyUnavailableError();
  const pairingNonce = randomBytes(8).toString('hex');
  const secret = randomBytes(32);
  const proofNonce = randomBytes(16).toString('hex');
  const issuerPub = ensureDeviceIdentity(scope, issuerEnrollmentId).pub;
  const inner: PairingKeyringInner = {
    v: 1,
    keys: bundle,
    issuerPub,
    proofNonce,
  };
  const { nonce, ct } = gcmSeal(
    secret,
    pairingSealAssociatedData({ pairingNonce }),
    Buffer.from(JSON.stringify(inner), 'utf8'),
  );
  const payload: PairingKeyringPayload = { v: 1, enc: 'pairing-aes-256-gcm', nonce, ct };
  recordLocalChange(scope, {
    entityType: CRYPTO_ENTITY_KEYRING_PAIRING,
    entityId: pairingNonce,
    operation: 'create',
    payload,
    schemaVersion: 1,
  });
  getDb()
    .prepare(
      `INSERT OR REPLACE INTO sync_pairing
         (nonce, backend_id, account_id, secret_wrapped, role, proof_nonce, created_at)
       VALUES (?, ?, ?, ?, 'issuer', ?, ?)`,
    )
    .run(
      pairingNonce,
      scope.backendId,
      scope.accountId,
      wrapSecretBytes(secret),
      proofNonce,
      nowIso(),
    );
  const pairingPayload = encodePairingPayload({
    enrollmentCode,
    pairingNonce,
    pairingSecret: secret.toString('hex'),
  });
  if (pairingPayload === null) {
    throw new Error('Could not encode pairing payload');
  }
  return { pairingPayload, pairingNonce };
}

/**
 * Records the pairing secret a new device typed in so the matching
 * keyring-pairing entity can be unwrapped when it arrives on pull.
 */
export function registerPairingRedemption(
  scope: SyncScope,
  pairingNonce: string,
  pairingSecretHex: string,
): void {
  getDb()
    .prepare(
      `INSERT OR REPLACE INTO sync_pairing
         (nonce, backend_id, account_id, secret_wrapped, role, created_at)
       VALUES (?, ?, ?, ?, 'redeemer', ?)`,
    )
    .run(
      pairingNonce,
      scope.backendId,
      scope.accountId,
      wrapSecretBytes(Buffer.from(pairingSecretHex, 'hex')),
      nowIso(),
    );
}

function pairingSecretFor(scope: SyncScope, nonce: string): Buffer | null {
  const row = getDb()
    .prepare(
      `SELECT secret_wrapped, role FROM sync_pairing
       WHERE backend_id = ? AND account_id = ? AND nonce = ?`,
    )
    .get(scope.backendId, scope.accountId, nonce) as
    | { secret_wrapped: Buffer; role: string }
    | undefined;
  if (row === undefined || row.role !== 'redeemer') return null;
  return unwrapSecretBytes(row.secret_wrapped);
}

// ---- Incoming crypto-boundary entities -----------------------------------------

/**
 * Records a keyring-rotation entity into the local rotation ledger.
 * Rotations minted locally carry `reported_at` NULL until `keyring.report`
 * confirms; remote rotations are evidence for concurrent-rotation
 * resolution and revocation bookkeeping.
 */
function recordRotation(
  scope: SyncScope,
  record: KeyringRotationPayload,
  opts?: { local?: boolean },
): void {
  getDb()
    .prepare(
      `INSERT OR IGNORE INTO sync_keyring_rotations
         (backend_id, account_id, rotation_id, rotor_enrollment_id, from_version, to_version, revoked_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      scope.backendId,
      scope.accountId,
      record.rotationId,
      record.rotorEnrollmentId,
      record.fromVersion,
      record.toVersion,
      JSON.stringify(record.revokedEnrollmentIds),
      nowIso(),
    );
  if (opts?.local === true) return;
  for (const enrollmentId of record.revokedEnrollmentIds) {
    setDeviceTrust(scope, enrollmentId, 'revoked');
  }
}

/**
 * Rotations minting `version`, lowest rotationId first — the deterministic
 * winner of a concurrent-rotation conflict is the first entry.
 */
function rotationsForVersion(
  scope: SyncScope,
  version: number,
): Array<{ rotation_id: string; rotor_enrollment_id: string }> {
  return getDb()
    .prepare(
      `SELECT rotation_id, rotor_enrollment_id FROM sync_keyring_rotations
       WHERE backend_id = ? AND account_id = ? AND to_version = ?
       ORDER BY rotation_id ASC`,
    )
    .all(scope.backendId, scope.accountId, version) as Array<{
    rotation_id: string;
    rotor_enrollment_id: string;
  }>;
}

/**
 * Re-push entities whose remote base is sealed under a superseded ADK:
 * unseal the stored ciphertext with the losing key (still held locally),
 * then record a local change so the outbox re-seals under the winning
 * key and the push overwrites the orphaned ciphertext. Pending outbox
 * rows sealed under the loser are re-sealed in place.
 */
function repushEntitiesUnderSupersededKey(
  scope: SyncScope,
  losingVersion: number,
  losingKey: Buffer,
): void {
  const db = getDb();
  const bindings = db
    .prepare(
      `SELECT entity_type, entity_id, base_payload_json FROM sync_bindings
       WHERE backend_id = ? AND account_id = ? AND dataset_epoch = ?
         AND base_payload_json IS NOT NULL`,
    )
    .all(scope.backendId, scope.accountId, scope.datasetEpoch) as Array<{
    entity_type: string;
    entity_id: string;
    base_payload_json: string;
  }>;
  for (const row of bindings) {
    let envelope: unknown;
    try {
      envelope = JSON.parse(row.base_payload_json);
    } catch {
      continue;
    }
    if (!isSealedEntityPayload(envelope)) continue;
    if (envelope.keyVersion !== losingVersion) continue;
    const aad = entitySealAssociatedData({
      backendId: scope.backendId,
      accountId: scope.accountId,
      entityType: row.entity_type,
      entityId: row.entity_id,
      keyVersion: losingVersion,
    });
    let plaintext: unknown;
    try {
      const plain = gcmOpen(losingKey, aad, envelope.nonce, envelope.ct);
      plaintext = JSON.parse(plain.toString('utf8'));
    } catch {
      continue; // not ours to republish — leave it; the author will reconcile
    }
    recordLocalChange(scope, {
      entityType: row.entity_type,
      entityId: row.entity_id,
      operation: 'update',
      payload: plaintext,
      schemaVersion: 1,
    });
  }
  // Pending outbox rows already carry sealed_json under the losing key —
  // unseal and re-seal so replays emit the winning key's ciphertext.
  const outbox = db
    .prepare(
      `SELECT entity_type, entity_id, sealed_json FROM sync_outbox
       WHERE backend_id = ? AND account_id = ? AND dataset_epoch = ?
         AND sealed_json IS NOT NULL`,
    )
    .all(scope.backendId, scope.accountId, scope.datasetEpoch) as Array<{
    entity_type: string;
    entity_id: string;
    sealed_json: string;
  }>;
  const winner = currentAccountKey(scope);
  if (winner === null) return;
  for (const row of outbox) {
    let envelope: SealedEntityPayload;
    try {
      envelope = JSON.parse(row.sealed_json) as SealedEntityPayload;
    } catch {
      continue;
    }
    if (envelope.keyVersion !== losingVersion) continue;
    const aad = entitySealAssociatedData({
      backendId: scope.backendId,
      accountId: scope.accountId,
      entityType: row.entity_type,
      entityId: row.entity_id,
      keyVersion: losingVersion,
    });
    try {
      const plain = gcmOpen(losingKey, aad, envelope.nonce, envelope.ct);
      const nextAad = entitySealAssociatedData({
        backendId: scope.backendId,
        accountId: scope.accountId,
        entityType: row.entity_type,
        entityId: row.entity_id,
        keyVersion: winner.version,
      });
      const resealed = gcmSeal(winner.key, nextAad, plain);
      const nextEnvelope: SealedEntityPayload = {
        enc: SEALED_ENTITY_ALG,
        keyVersion: winner.version,
        nonce: resealed.nonce,
        ct: resealed.ct,
      };
      db.prepare(
        `UPDATE sync_outbox SET sealed_json = ?
         WHERE backend_id = ? AND account_id = ? AND dataset_epoch = ?
           AND entity_type = ? AND entity_id = ?`,
      ).run(
        JSON.stringify(nextEnvelope),
        scope.backendId,
        scope.accountId,
        scope.datasetEpoch,
        row.entity_type,
        row.entity_id,
      );
    } catch {
      continue;
    }
  }
}

/**
 * Installs an ADK delivered by wrap/pairing with concurrent-rotation
 * resolution. Same-version different-bytes conflicts: if the stored row
 * is 'minted' the peer key wins (v1 heal); if it is 'rotation', the
 * deterministic rotation winner (lowest rotationId) decides — a losing
 * local rotation is superseded: the peer key is installed and entities
 * sealed under the loser are republished under the winner.
 */
function installDeliveredKey(scope: SyncScope, version: number, key: Buffer): void {
  const db = getDb();
  const existing = db
    .prepare(
      `SELECT key_wrapped, source FROM sync_keyring
       WHERE backend_id = ? AND account_id = ? AND key_version = ?`,
    )
    .get(scope.backendId, scope.accountId, version) as
    | { key_wrapped: Buffer; source: string }
    | undefined;
  if (existing === undefined) {
    installAccountKey(scope, version, key, 'wrap');
    return;
  }
  const existingKey = unwrapSecretBytes(existing.key_wrapped);
  if (existingKey !== null && existingKey.equals(key)) return;
  if (existing.source === 'minted') {
    installAccountKey(scope, version, key, 'wrap');
    return;
  }
  if (existing.source !== 'rotation') return; // delivered keys never displace
  const rotations = rotationsForVersion(scope, version);
  if (rotations.length < 2) return; // no concurrent rotation — refuse to displace
  const ownRotation = rotations.find((r) => r.rotor_enrollment_id !== '' && isOwnRotation(scope, r));
  const winner = rotations[0];
  if (ownRotation === undefined || winner.rotation_id === ownRotation.rotation_id) {
    return; // ours won or we can't attribute — keep the local key
  }
  // Our rotation lost: supersede. Republish everything sealed under the
  // losing bytes before overwriting the row.
  if (existingKey !== null) {
    repushEntitiesUnderSupersededKey(scope, version, existingKey);
  }
  db.prepare(
    `UPDATE sync_keyring SET key_wrapped = ?, source = 'wrap'
     WHERE backend_id = ? AND account_id = ? AND key_version = ?`,
  ).run(wrapSecretBytes(key), scope.backendId, scope.accountId, version);
}

function isOwnRotation(
  scope: SyncScope,
  rotation: { rotor_enrollment_id: string },
): boolean {
  const own = getActiveEnrollmentId(scope);
  return own !== null && rotation.rotor_enrollment_id === own;
}

/**
 * Handles a pulled crypto-boundary entity. Returns true when the entity was
 * consumed — the engine must skip domain/binding processing for it.
 */
export function handleCryptoBoundaryEntity(
  scope: SyncScope,
  ownEnrollmentId: string,
  entityType: string,
  entityId: string,
  payload: unknown,
): boolean {
  switch (entityType) {
    case CRYPTO_ENTITY_DEVICE_IDENTITY: {
      if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return true;
      const record = payload as Record<string, unknown>;
      if (
        record.v !== 1 ||
        typeof record.pub !== 'string' ||
        typeof record.enrollmentId !== 'string'
      ) {
        return true;
      }
      const db = getDb();
      db.prepare(
        `INSERT INTO sync_device_keys
           (backend_id, account_id, enrollment_id, identity_pub, identity_priv_wrapped, seen_at)
         VALUES (?, ?, ?, ?, NULL, ?)
         ON CONFLICT (backend_id, account_id, enrollment_id)
         DO UPDATE SET identity_pub = excluded.identity_pub, seen_at = excluded.seen_at`,
      ).run(scope.backendId, scope.accountId, record.enrollmentId, record.pub, nowIso());
      // Enrollment is authentication only — the new device arrives
      // 'pending' (or keeps its existing state; revoked is sticky).
      db.prepare(
        `INSERT OR IGNORE INTO sync_device_trust
           (backend_id, account_id, enrollment_id, state)
         VALUES (?, ?, ?, 'pending')`,
      ).run(scope.backendId, scope.accountId, record.enrollmentId);
      // Deliver only to trusted devices that have not received the
      // current bundle yet.
      if (record.enrollmentId !== ownEnrollmentId && isKeyDeliverable(scope, record.enrollmentId)) {
        const current = currentAccountKey(scope);
        if (current !== null && !hasDelivery(scope, record.enrollmentId, current.version)) {
          wrapAccountKeyFor(scope, record.enrollmentId, record.pub);
        }
      }
      return true;
    }
    case CRYPTO_ENTITY_KEYRING_WRAP: {
      if (entityId !== ownEnrollmentId) return true;
      if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return true;
      const wrap = payload as KeyringWrapPayload;
      if (
        wrap.v !== 1 ||
        wrap.enc !== 'x25519-aes-256-gcm' ||
        !Number.isInteger(wrap.keyVersion) ||
        wrap.keyVersion < 1
      ) {
        return true;
      }
      const aad = keyringWrapAssociatedData({
        backendId: scope.backendId,
        accountId: scope.accountId,
        enrollmentId: ownEnrollmentId,
        keyVersion: wrap.keyVersion,
      });
      const plaintext = unwrapKeyMaterial(scope, ownEnrollmentId, wrap, aad);
      if (plaintext === null) return true;
      // Bundle form (KeyringWrapInner JSON) or legacy single-key bytes.
      let installed = false;
      let inner: KeyringWrapInner | null = null;
      try {
        const parsed = JSON.parse(plaintext.toString('utf8')) as KeyringWrapInner;
        if (parsed.v === 1 && Array.isArray(parsed.keys)) inner = parsed;
      } catch {
        inner = null;
      }
      if (inner !== null) {
        for (const entry of inner.keys) {
          if (!Number.isInteger(entry.keyVersion) || entry.keyVersion < 1) continue;
          if (typeof entry.adk !== 'string') continue;
          const key = Buffer.from(entry.adk, 'base64');
          if (key.byteLength !== 32) continue;
          installDeliveredKey(scope, entry.keyVersion, key);
          installed = true;
        }
      } else if (plaintext.byteLength === 32) {
        installDeliveredKey(scope, wrap.keyVersion, plaintext);
        installed = true;
      }
      if (installed) {
        retryQuarantinedEntities(scope);
        // The wrap has done its job; queue its removal from the account.
        recordLocalChange(scope, {
          entityType: CRYPTO_ENTITY_KEYRING_WRAP,
          entityId: ownEnrollmentId,
          operation: 'delete',
          schemaVersion: 1,
        });
      }
      return true;
    }
    case CRYPTO_ENTITY_KEYRING_PAIRING: {
      if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return true;
      const secret = pairingSecretFor(scope, entityId);
      if (secret === null) return true;
      const blob = payload as PairingKeyringPayload;
      if (blob.v !== 1 || blob.enc !== 'pairing-aes-256-gcm') return true;
      let inner: PairingKeyringInner;
      try {
        const plain = gcmOpen(
          secret,
          pairingSealAssociatedData({ pairingNonce: entityId }),
          blob.nonce,
          blob.ct,
        );
        inner = JSON.parse(plain.toString('utf8')) as PairingKeyringInner;
      } catch {
        // Tampered blob or wrong secret: leave the entity, do not retry.
        return true;
      }
      if (inner.v !== 1) return true;
      // v2 bundle or v1 single key.
      const entries: Array<{ keyVersion: number; adk: string }> =
        Array.isArray(inner.keys) && inner.keys.length > 0
          ? inner.keys
          : typeof inner.adk === 'string' && typeof inner.keyVersion === 'number'
            ? [{ keyVersion: inner.keyVersion, adk: inner.adk }]
            : [];
      let installed = false;
      for (const entry of entries) {
        const key = Buffer.from(entry.adk, 'base64');
        if (key.byteLength !== 32) continue;
        installDeliveredKey(scope, entry.keyVersion, key);
        installed = true;
      }
      if (!installed) return true;
      retryQuarantinedEntities(scope);
      // Prove redemption to the issuer: the proof nonce only exists inside
      // the sealed blob, so echoing it is receipt-of-secret evidence.
      if (typeof inner.proofNonce === 'string' && inner.proofNonce.length > 0) {
        const ownPub = ownPubRaw(scope, ownEnrollmentId);
        if (ownPub !== null) {
          const paired: KeyringPairedPayload = {
            v: 1,
            enrollmentId: ownEnrollmentId,
            pub: ownPub.toString('base64'),
            proofNonce: inner.proofNonce,
          };
          recordLocalChange(scope, {
            entityType: CRYPTO_ENTITY_KEYRING_PAIRED,
            entityId: ownEnrollmentId,
            operation: 'create',
            payload: paired,
            schemaVersion: 1,
          });
        }
      }
      recordLocalChange(scope, {
        entityType: CRYPTO_ENTITY_KEYRING_PAIRING,
        entityId,
        operation: 'delete',
        schemaVersion: 1,
      });
      getDb()
        .prepare(`DELETE FROM sync_pairing WHERE backend_id = ? AND account_id = ? AND nonce = ?`)
        .run(scope.backendId, scope.accountId, entityId);
      return true;
    }
    case CRYPTO_ENTITY_KEYRING_PAIRED: {
      if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return true;
      const record = payload as KeyringPairedPayload;
      if (
        record.v !== 1 ||
        typeof record.enrollmentId !== 'string' ||
        typeof record.pub !== 'string' ||
        typeof record.proofNonce !== 'string' ||
        record.enrollmentId !== entityId
      ) {
        return true;
      }
      // The proof nonce must match one this device minted inside a sealed
      // pairing blob — the redeemer proves receipt of the secret.
      const pending = getDb()
        .prepare(
          `SELECT nonce FROM sync_pairing
           WHERE backend_id = ? AND account_id = ? AND role = 'issuer' AND proof_nonce = ?`,
        )
        .get(scope.backendId, scope.accountId, record.proofNonce) as
        | { nonce: string }
        | undefined;
      if (pending === undefined) return true;
      // Register the announced identity and promote to trusted — the
      // pairing blob already delivered the key bundle.
      getDb()
        .prepare(
          `INSERT INTO sync_device_keys
             (backend_id, account_id, enrollment_id, identity_pub, identity_priv_wrapped, seen_at)
           VALUES (?, ?, ?, ?, NULL, ?)
           ON CONFLICT (backend_id, account_id, enrollment_id)
           DO UPDATE SET identity_pub = excluded.identity_pub, seen_at = excluded.seen_at`,
        )
        .run(scope.backendId, scope.accountId, record.enrollmentId, record.pub, nowIso());
      setDeviceTrust(scope, record.enrollmentId, 'trusted');
      getDb()
        .prepare(`DELETE FROM sync_pairing WHERE backend_id = ? AND account_id = ? AND nonce = ?`)
        .run(scope.backendId, scope.accountId, pending.nonce);
      return true;
    }
    case CRYPTO_ENTITY_KEYRING_ROTATION: {
      if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return true;
      const record = payload as KeyringRotationPayload;
      if (
        record.v !== 1 ||
        typeof record.rotationId !== 'string' ||
        typeof record.rotorEnrollmentId !== 'string' ||
        !Number.isInteger(record.fromVersion) ||
        !Number.isInteger(record.toVersion) ||
        !Array.isArray(record.revokedEnrollmentIds)
      ) {
        return true;
      }
      recordRotation(scope, record);
      return true;
    }
    default:
      return false;
  }
}

/**
 * After a new ADK version lands, re-open every quarantined binding whose
 * stored payload is a sealed envelope — the earlier pull may have failed
 * only because this key was missing. Successful re-opens project the
 * domain payload immediately.
 */
export function retryQuarantinedEntities(scope: SyncScope): void {
  const rows = getDb()
    .prepare(
      `SELECT entity_type, entity_id, quarantine_json FROM sync_bindings
       WHERE backend_id = ? AND account_id = ? AND dataset_epoch = ?
         AND quarantine_json IS NOT NULL`,
    )
    .all(scope.backendId, scope.accountId, scope.datasetEpoch) as Array<{
    entity_type: string;
    entity_id: string;
    quarantine_json: string;
  }>;
  for (const row of rows) {
    let envelope: unknown;
    try {
      envelope = JSON.parse(row.quarantine_json);
    } catch {
      continue;
    }
    if (!isSealedEntityPayload(envelope)) continue;
    try {
      const payload = unsealEntityPayload(
        scope,
        { entityType: row.entity_type, entityId: row.entity_id },
        envelope,
      );
      const domainJson = canonicalJson(payload);
      getDb()
        .prepare(
          `UPDATE sync_bindings SET quarantine_json = NULL, base_payload_json = ?
           WHERE backend_id = ? AND account_id = ? AND dataset_epoch = ?
             AND entity_type = ? AND entity_id = ?`,
        )
        .run(
          domainJson,
          scope.backendId,
          scope.accountId,
          scope.datasetEpoch,
          row.entity_type,
          row.entity_id,
        );
      applyRemoteEntityPayload(row.entity_type, row.entity_id, payload);
    } catch {
      // Still undecryptable — leave it quarantined.
    }
  }
}

// ---- Rotation on revoke ---------------------------------------------------------

/**
 * Mints ADK v(N+1), publishes a `keyring-rotation` entity (durable
 * evidence of the revoked set and the concurrent-rotation tiebreak), and
 * queues a full-bundle wrap to every TRUSTED device except the revoked
 * enrollments. Pending devices get nothing — they must complete approval
 * first. The revoked device can never decrypt post-rotation writes; it
 * does retain everything it already decrypted — rotation bounds the
 * exposure, it does not erase it.
 *
 * Returns the new key version. The caller reports completion via
 * `keyring.report` so the dashboard can show rotation status honestly.
 */
export function rotateAccountKey(scope: SyncScope, revokedEnrollmentIds: string[]): number {
  const db = getDb();
  const current = currentAccountKey(scope);
  const fromVersion = current?.version ?? 0;
  const nextVersion = fromVersion + 1;
  const own = getActiveEnrollmentId(scope);
  for (const enrollmentId of revokedEnrollmentIds) {
    setDeviceTrust(scope, enrollmentId, 'revoked');
  }
  installAccountKey(scope, nextVersion, randomBytes(32), 'rotation');
  const rotation: KeyringRotationPayload = {
    v: 1,
    rotationId: randomUUID(),
    rotorEnrollmentId: own ?? '',
    fromVersion,
    toVersion: nextVersion,
    revokedEnrollmentIds,
    rotatedAt: nowIso(),
  };
  const run = db.transaction(() => {
    recordLocalChange(scope, {
      entityType: CRYPTO_ENTITY_KEYRING_ROTATION,
      entityId: rotation.rotationId,
      operation: 'create',
      payload: rotation,
      schemaVersion: 1,
    });
    recordRotation(scope, rotation, { local: true });
    for (const device of listDeviceIdentities(scope)) {
      if (revokedEnrollmentIds.includes(device.enrollmentId)) continue;
      if (own !== null && device.enrollmentId === own) continue;
      if (!isKeyDeliverable(scope, device.enrollmentId)) continue;
      if (hasDelivery(scope, device.enrollmentId, nextVersion)) continue;
      wrapAccountKeyFor(scope, device.enrollmentId, device.pub);
    }
  });
  run();
  return nextVersion;
}

/** Pending (unreported) rotations this device minted — for `keyring.report`. */
export function pendingRotationReports(
  scope: SyncScope,
): Array<{ rotationId: string; revokedEnrollmentIds: string[]; toVersion: number }> {
  const own = getActiveEnrollmentId(scope);
  if (own === null) return [];
  const rows = getDb()
    .prepare(
      `SELECT rotation_id, revoked_json, to_version FROM sync_keyring_rotations
       WHERE backend_id = ? AND account_id = ? AND rotor_enrollment_id = ? AND reported_at IS NULL`,
    )
    .all(scope.backendId, scope.accountId, own) as Array<{
    rotation_id: string;
    revoked_json: string;
    to_version: number;
  }>;
  return rows.map((row) => ({
    rotationId: row.rotation_id,
    revokedEnrollmentIds: JSON.parse(row.revoked_json) as string[],
    toVersion: row.to_version,
  }));
}

/** Marks a rotation reported after `keyring.report` succeeded. */
export function markRotationReported(scope: SyncScope, rotationId: string): void {
  getDb()
    .prepare(
      `UPDATE sync_keyring_rotations SET reported_at = ?
       WHERE backend_id = ? AND account_id = ? AND rotation_id = ?`,
    )
    .run(nowIso(), scope.backendId, scope.accountId, rotationId);
}

// ---- Task-scoped content keys --------------------------------------------------
// A job's sensitive inputs are sealed under a random per-job task content
// key (TCK). The TCK travels to the resolved target and declared result
// recipients as job-scoped wraps — never the ADK. This device stores TCKs
// it minted or received so dispatch recovery and result reads survive
// restarts.

/** Mints a fresh 32-byte task content key. */
export function mintTaskKey(): Buffer {
  return randomBytes(32);
}

/** Persists a TCK this device holds for `jobId` (safeStorage-wrapped). */
export function storeTaskKey(scope: SyncScope, jobId: string, key: Buffer): void {
  if (key.byteLength !== 32) throw new Error('task key must be 32 bytes');
  getDb()
    .prepare(
      `INSERT OR IGNORE INTO mesh_task_keys
         (backend_id, account_id, job_id, key_wrapped, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(scope.backendId, scope.accountId, jobId, wrapSecretBytes(key), nowIso());
}

/** The TCK this device holds for `jobId`, or null. */
export function taskKeyFor(scope: SyncScope, jobId: string): Buffer | null {
  const row = getDb()
    .prepare(
      `SELECT key_wrapped FROM mesh_task_keys
       WHERE backend_id = ? AND account_id = ? AND job_id = ?`,
    )
    .get(scope.backendId, scope.accountId, jobId) as { key_wrapped: Buffer } | undefined;
  return row === undefined ? null : unwrapSecretBytes(row.key_wrapped);
}

/**
 * Seals a task-key wrap for `taskkey.deliver`: the TCK sealed to the
 * recipient's X25519 identity, bound to (account, job, target).
 */
export function sealTaskKeyWrap(input: {
  scope: SyncScope;
  jobId: string;
  targetEnrollmentId: string;
  recipientPubB64: string;
  taskKey: Buffer;
}): TaskKeyWrapPayload {
  const inner: TaskKeyInner = { v: 1, kind: 'task-key', key: input.taskKey.toString('base64') };
  const aad = taskKeyWrapAssociatedData({
    backendId: input.scope.backendId,
    accountId: input.scope.accountId,
    jobId: input.jobId,
    targetEnrollmentId: input.targetEnrollmentId,
  });
  const sealed = wrapKeyMaterial(
    Buffer.from(input.recipientPubB64, 'base64'),
    Buffer.from(JSON.stringify(inner), 'utf8'),
    aad,
  );
  return {
    v: 1,
    enc: 'x25519-aes-256-gcm',
    jobId: input.jobId,
    targetEnrollmentId: input.targetEnrollmentId,
    ephPub: sealed.ephPub,
    nonce: sealed.nonce,
    ct: sealed.ct,
  };
}

/** Opens a pulled task-key wrap; returns the TCK or null on any failure. */
export function unsealTaskKeyWrap(
  scope: SyncScope,
  enrollmentId: string,
  wrap: TaskKeyWrapPayload,
): Buffer | null {
  if (wrap.v !== 1 || wrap.enc !== 'x25519-aes-256-gcm') return null;
  const aad = taskKeyWrapAssociatedData({
    backendId: scope.backendId,
    accountId: scope.accountId,
    jobId: wrap.jobId,
    targetEnrollmentId: wrap.targetEnrollmentId,
  });
  const plaintext = unwrapKeyMaterial(scope, enrollmentId, wrap, aad);
  if (plaintext === null) return null;
  try {
    const inner = JSON.parse(plaintext.toString('utf8')) as TaskKeyInner;
    if (inner.v !== 1 || inner.kind !== 'task-key' || typeof inner.key !== 'string') return null;
    const key = Buffer.from(inner.key, 'base64');
    return key.byteLength === 32 ? key : null;
  } catch {
    return null;
  }
}

/**
 * Seals a job's sensitive inputs under its TCK. Bound to
 * (backend, account, requestId) — the request id is allocated before
 * sealing, so the envelope cannot be transplanted to another job request.
 */
export function sealTaskInputs(
  scope: SyncScope,
  requestId: string,
  taskKey: Buffer,
  inputs: Record<string, unknown>,
): SealedTaskPayload {
  const aad = taskInputsAssociatedData({
    backendId: scope.backendId,
    accountId: scope.accountId,
    requestId,
  });
  const { nonce, ct } = gcmSeal(
    taskKey,
    aad,
    Buffer.from(canonicalJson(inputs), 'utf8'),
  );
  return { enc: SEALED_ENTITY_ALG, nonce, ct };
}

/** Opens a `sealedInputs` envelope; throws UnsealError on any failure. */
export function unsealTaskInputs(
  scope: SyncScope,
  requestId: string,
  taskKey: Buffer,
  envelope: unknown,
): Record<string, unknown> {
  if (!isSealedTaskPayload(envelope) || sealedTaskEnvelopeIssue(envelope) !== null) {
    throw new UnsealError('malformed-envelope', 'sealed inputs are not well-formed');
  }
  const aad = taskInputsAssociatedData({
    backendId: scope.backendId,
    accountId: scope.accountId,
    requestId,
  });
  let plaintext: Buffer;
  try {
    plaintext = gcmOpen(taskKey, aad, envelope.nonce, envelope.ct);
  } catch {
    throw new UnsealError('auth-failed', 'sealed inputs failed authentication');
  }
  try {
    const value = JSON.parse(plaintext.toString('utf8')) as unknown;
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new Error('not an object');
    }
    return value as Record<string, unknown>;
  } catch {
    throw new UnsealError('malformed-plaintext', 'sealed inputs did not contain a JSON object');
  }
}

/**
 * Seals the rich attempt-result detail under the job's TCK — verification
 * commands, free-text output, diagnostics that must never ride the
 * coordinator-visible `attempt.report.result`.
 */
export function sealTaskResult(
  scope: SyncScope,
  jobId: string,
  attemptId: string,
  taskKey: Buffer,
  value: unknown,
): SealedTaskPayload {
  const aad = taskResultAssociatedData({
    backendId: scope.backendId,
    accountId: scope.accountId,
    jobId,
    attemptId,
  });
  const { nonce, ct } = gcmSeal(taskKey, aad, Buffer.from(canonicalJson(value), 'utf8'));
  return { enc: SEALED_ENTITY_ALG, nonce, ct };
}

/** Opens a sealed attempt result; throws UnsealError on any failure. */
export function unsealTaskResult(
  scope: SyncScope,
  jobId: string,
  attemptId: string,
  taskKey: Buffer,
  envelope: unknown,
): unknown {
  if (!isSealedTaskPayload(envelope) || sealedTaskEnvelopeIssue(envelope) !== null) {
    throw new UnsealError('malformed-envelope', 'sealed result is not well-formed');
  }
  const aad = taskResultAssociatedData({
    backendId: scope.backendId,
    accountId: scope.accountId,
    jobId,
    attemptId,
  });
  try {
    const plaintext = gcmOpen(taskKey, aad, envelope.nonce, envelope.ct);
    return JSON.parse(plaintext.toString('utf8')) as unknown;
  } catch {
    throw new UnsealError('auth-failed', 'sealed result failed authentication');
  }
}

// ---- SAS -----------------------------------------------------------------------

/**
 * Short authentication string for pairing verification: 9 digits derived
 * from the account id and both device public keys (order-independent).
 * Both devices compute it independently; a mismatch means the enrolled
 * identity was substituted (active MITM).
 */
export function deriveSas(accountId: string, pubA: string, pubB: string): string {
  const [first, second] = [pubA, pubB].sort();
  const digest = createHash('sha256')
    .update('anvil/sas/v1')
    .update(accountId)
    .update(first)
    .update(second)
    .digest();
  const value = digest.readUInt32BE(0) % 1_000_000_000;
  return value.toString().padStart(9, '0');
}
