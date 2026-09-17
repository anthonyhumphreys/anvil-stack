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
  type KeyObject,
} from 'node:crypto';
import {
  CRYPTO_ENTITY_DEVICE_IDENTITY,
  CRYPTO_ENTITY_KEYRING_PAIRING,
  CRYPTO_ENTITY_KEYRING_WRAP,
  SEALED_ENTITY_ALG,
  encodePairingPayload,
  entitySealAssociatedData,
  isSealedEntityPayload,
  keyringWrapAssociatedData,
  pairingSealAssociatedData,
  sealedEnvelopeIssue,
  type DeviceIdentityPayload,
  type KeyringWrapPayload,
  type PairingKeyringInner,
  type PairingKeyringPayload,
  type SealedEntityPayload,
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

function wrapSecretBytes(plain: Buffer): Buffer {
  return encryptSecret(plain.toString('base64'));
}

function unwrapSecretBytes(stored: Buffer): Buffer | null {
  const decoded = decryptSecret(stored, 'sync key material');
  if (decoded === undefined) return null;
  return Buffer.from(decoded, 'base64');
}

// ---- ADK storage -------------------------------------------------------------

interface KeyringRow {
  key_version: number;
  key_wrapped: Buffer;
}

function keyringRows(scope: SyncScope): KeyringRow[] {
  return getDb()
    .prepare(
      `SELECT key_version, key_wrapped FROM sync_keyring
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

/** Idempotent install of an ADK version; existing rows are never overwritten. */
export function installAccountKey(scope: SyncScope, version: number, key: Buffer): void {
  if (key.byteLength !== 32) {
    throw new Error('ADK must be 32 bytes');
  }
  getDb()
    .prepare(
      `INSERT OR IGNORE INTO sync_keyring
         (backend_id, account_id, key_version, key_wrapped, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(scope.backendId, scope.accountId, version, wrapSecretBytes(key), nowIso());
}

/**
 * Creates ADK v1 when this device holds no key at all. Only safe to call
 * when no other enrolled devices exist on the account — a second device
 * must wait for a wrap or pairing blob instead of minting a divergent key.
 */
export function provisionAccountKey(scope: SyncScope): number {
  const existing = currentAccountKey(scope);
  if (existing !== null) return existing.version;
  installAccountKey(scope, 1, randomBytes(32));
  return 1;
}

/**
 * Lazy first-device provisioning gate. It is safe to mint ADK v1 only when
 * there is no evidence the account is already keyed elsewhere: no other
 * device identities have been seen, no pairing redemption is pending, and
 * no quarantined sealed envelopes are waiting on a key. A second device
 * that enrolled via OIDC without pairing sees the issuer's device-identity
 * on its first pull and fails this gate until the wrap arrives.
 */
export function canProvisionAccountKey(scope: SyncScope, ownEnrollmentId: string): boolean {
  const db = getDb();
  const otherIdentities = listDeviceIdentities(scope).some(
    (device) => device.enrollmentId !== ownEnrollmentId,
  );
  if (otherIdentities) return false;
  const pendingRedeemer = db
    .prepare(`SELECT COUNT(*) AS n FROM sync_pairing WHERE role = 'redeemer'`)
    .get() as { n: number };
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
  const payload: DeviceIdentityPayload = { v: 1, enrollmentId, pub };
  recordLocalChange(scope, {
    entityType: CRYPTO_ENTITY_DEVICE_IDENTITY,
    entityId: enrollmentId,
    operation: 'create',
    payload,
    schemaVersion: 1,
  });
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

function unwrapKeyMaterial(
  scope: SyncScope,
  enrollmentId: string,
  wrap: KeyringWrapPayload,
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
 * Queues a keyring-wrap entity carrying ADK `keyVersion` sealed to the
 * target enrollment's registered identity. Idempotent per (target, version)
 * via the delivery ledger.
 */
export function wrapAccountKeyFor(
  scope: SyncScope,
  targetEnrollmentId: string,
  recipientPubB64: string,
  keyVersion: number,
): void {
  const key = accountKeyFor(scope, keyVersion);
  if (key === null) throw new AccountKeyUnavailableError();
  const aad = keyringWrapAssociatedData({
    backendId: scope.backendId,
    accountId: scope.accountId,
    enrollmentId: targetEnrollmentId,
    keyVersion,
  });
  const sealed = wrapKeyMaterial(Buffer.from(recipientPubB64, 'base64'), key, aad);
  const payload: KeyringWrapPayload = {
    v: 1,
    enc: 'x25519-aes-256-gcm',
    keyVersion,
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
  markDelivery(scope, targetEnrollmentId, keyVersion);
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
  const accountKey = currentAccountKey(scope);
  if (accountKey === null) throw new AccountKeyUnavailableError();
  const pairingNonce = randomBytes(8).toString('hex');
  const secret = randomBytes(32);
  const issuerPub = ensureDeviceIdentity(scope, issuerEnrollmentId).pub;
  const inner: PairingKeyringInner = {
    v: 1,
    keyVersion: accountKey.version,
    adk: accountKey.key.toString('base64'),
    issuerPub,
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
         (nonce, backend_id, account_id, secret_wrapped, role, created_at)
       VALUES (?, ?, ?, ?, 'issuer', ?)`,
    )
    .run(pairingNonce, scope.backendId, scope.accountId, wrapSecretBytes(secret), nowIso());
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

function pairingSecretFor(nonce: string): Buffer | null {
  const row = getDb()
    .prepare(`SELECT secret_wrapped, role FROM sync_pairing WHERE nonce = ?`)
    .get(nonce) as { secret_wrapped: Buffer; role: string } | undefined;
  if (row === undefined || row.role !== 'redeemer') return null;
  return unwrapSecretBytes(row.secret_wrapped);
}

// ---- Incoming crypto-boundary entities -----------------------------------------

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
      getDb()
        .prepare(
          `INSERT INTO sync_device_keys
             (backend_id, account_id, enrollment_id, identity_pub, identity_priv_wrapped, seen_at)
           VALUES (?, ?, ?, ?, NULL, ?)
           ON CONFLICT (backend_id, account_id, enrollment_id)
           DO UPDATE SET identity_pub = excluded.identity_pub, seen_at = excluded.seen_at`,
        )
        .run(scope.backendId, scope.accountId, record.enrollmentId, record.pub, nowIso());
      // If we hold the ADK and this is a different device we have not yet
      // delivered the current version to, wrap it now.
      if (record.enrollmentId !== ownEnrollmentId) {
        const current = currentAccountKey(scope);
        if (current !== null && !hasDelivery(scope, record.enrollmentId, current.version)) {
          wrapAccountKeyFor(scope, record.enrollmentId, record.pub, current.version);
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
        typeof wrap.keyVersion !== 'number'
      ) {
        return true;
      }
      const aad = keyringWrapAssociatedData({
        backendId: scope.backendId,
        accountId: scope.accountId,
        enrollmentId: ownEnrollmentId,
        keyVersion: wrap.keyVersion,
      });
      const adk = unwrapKeyMaterial(scope, ownEnrollmentId, wrap, aad);
      if (adk !== null) {
        installAccountKey(scope, wrap.keyVersion, adk);
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
      const secret = pairingSecretFor(entityId);
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
      if (inner.v !== 1 || typeof inner.adk !== 'string' || typeof inner.keyVersion !== 'number') {
        return true;
      }
      installAccountKey(scope, inner.keyVersion, Buffer.from(inner.adk, 'base64'));
      retryQuarantinedEntities(scope);
      recordLocalChange(scope, {
        entityType: CRYPTO_ENTITY_KEYRING_PAIRING,
        entityId,
        operation: 'delete',
        schemaVersion: 1,
      });
      getDb().prepare(`DELETE FROM sync_pairing WHERE nonce = ?`).run(entityId);
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
 * Mints ADK v(N+1) and queues keyring-wrap deliveries to every known
 * device except the revoked enrollments (and this device, which already
 * holds it). Surviving devices learn the key when their wrap arrives; the
 * revoked device can never decrypt post-rotation writes. It does retain
 * everything it already decrypted — rotation bounds the exposure, it does
 * not erase it.
 */
export function rotateAccountKey(scope: SyncScope, revokedEnrollmentIds: string[]): number {
  const db = getDb();
  const current = currentAccountKey(scope);
  const nextVersion = (current?.version ?? 0) + 1;
  installAccountKey(scope, nextVersion, randomBytes(32));
  const excluded = new Set(revokedEnrollmentIds);
  const own = getActiveEnrollmentId(scope);
  if (own !== null) excluded.add(own);
  const run = db.transaction(() => {
    for (const device of listDeviceIdentities(scope)) {
      if (excluded.has(device.enrollmentId)) continue;
      if (hasDelivery(scope, device.enrollmentId, nextVersion)) continue;
      wrapAccountKeyFor(scope, device.enrollmentId, device.pub, nextVersion);
    }
  });
  run();
  return nextVersion;
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
