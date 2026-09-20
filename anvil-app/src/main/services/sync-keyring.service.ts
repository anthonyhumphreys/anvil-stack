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
  createHmac,
  createHash,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  randomUUID,
  timingSafeEqual,
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
  keyringWrapAuthenticationData,
  keyringWrapAssociatedData,
  pairingReceiptAuthenticationData,
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
import {
  isRecoveryKeyBundle,
  RECOVERY_BUNDLE_MAX_KEY_VERSION,
  RECOVERY_BUNDLE_MAX_KEYS,
  type RecoveryKeyBundle,
} from '../../../cloud/contract/device-security.js';
import type { SyncOperation, SyncScope } from '../../shared/sync-mesh.js';
import { safeStorage } from 'electron';
import { getDb } from '../db/database.js';
import { canonicalJson, recordLocalChange } from './sync-persistence.service.js';
import { applyRemoteEntityPayload } from './sync-entity-domain.js';
import { encryptSecret, decryptSecret } from './auth.service.js';

const X25519_SPKI_PREFIX = Buffer.from('302a300506032b656e032100', 'hex');
const X25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b656e04220420', 'hex');
const KEYRING_WRAP_MAC_INFO = Buffer.from('anvil/keyring-wrap-auth/v1', 'utf8');
const MAX_PENDING_KEYRING_WRAP_BYTES = 512 * 1024;
const MAX_PENDING_KEYRING_WRAPS = 64;

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

/** Raised when a recovery secret cannot be kept in authenticated OS storage. */
export class RecoverySecretUnavailableError extends Error {
  constructor() {
    super('Recovery secret storage is unavailable on this device');
    this.name = 'RecoverySecretUnavailableError';
  }
}

/** Raised before import when an established ADK version disagrees. */
export class AccountKeyBundleConflictError extends Error {
  constructor(version: number) {
    super(`Recovery bundle conflicts with the established account key at version ${version}`);
    this.name = 'AccountKeyBundleConflictError';
  }
}

function nowIso(): string {
  return new Date().toISOString();
}

function strictBase64Bytes(value: string, byteLength: number): Buffer | null {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    return null;
  }
  const decoded = Buffer.from(value, 'base64');
  return decoded.byteLength === byteLength && decoded.toString('base64') === value ? decoded : null;
}

function strictBase64UrlBytes(value: string, byteLength: number): Buffer | null {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;
  const decoded = Buffer.from(value, 'base64url');
  return decoded.byteLength === byteLength && decoded.toString('base64url') === value
    ? decoded
    : null;
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
 * it is the only source a peer-delivered key may displace. 'wrap',
 * 'pairing', and 'recovery' are account-authoritative deliveries;
 * 'rotation' is this device's own authoritative mint on revoke.
 */
export type AccountKeySource = 'minted' | 'wrap' | 'pairing' | 'recovery' | 'rotation';

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

export type AccountKeyBundle = RecoveryKeyBundle;

function safeStorageAvailable(): boolean {
  try {
    return safeStorage.isEncryptionAvailable();
  } catch {
    return false;
  }
}

function decodeBundleEntries(
  bundle: RecoveryKeyBundle,
): Array<{ keyVersion: number; key: Buffer }> {
  if (!isRecoveryKeyBundle(bundle) || bundle.keys.length > RECOVERY_BUNDLE_MAX_KEYS) {
    throw new Error('Malformed account key bundle');
  }
  const entries: Array<{ keyVersion: number; key: Buffer }> = [];
  for (const entry of bundle.keys) {
    const key = Buffer.from(entry.adk, 'base64');
    if (
      key.byteLength !== 32 ||
      !Number.isSafeInteger(entry.keyVersion) ||
      entry.keyVersion < 1 ||
      entry.keyVersion > RECOVERY_BUNDLE_MAX_KEY_VERSION
    ) {
      throw new Error('Malformed account key bundle');
    }
    entries.push({ keyVersion: entry.keyVersion, key });
  }
  return entries;
}

/** Exports every locally held ADK version, failing closed on a corrupt row. */
export function exportAccountKeyBundle(scope: SyncScope): AccountKeyBundle | null {
  const rows = keyringRows(scope);
  if (rows.length === 0) return null;
  const keys: AccountKeyBundle['keys'] = [];
  let previousVersion = 0;
  for (const row of rows) {
    if (row.key_version <= previousVersion || row.key_version > RECOVERY_BUNDLE_MAX_KEY_VERSION) {
      throw new Error('Malformed local account key versions');
    }
    const key = unwrapSecretBytes(row.key_wrapped);
    if (key === null || key.byteLength !== 32) {
      throw new AccountKeyUnavailableError();
    }
    keys.push({ keyVersion: row.key_version, adk: key.toString('base64') });
    previousVersion = row.key_version;
  }
  return { v: 1, keys };
}

/** True only when the local bundle has exactly the supplied versions and bytes. */
export function currentAccountKeyBundleMatches(
  scope: SyncScope,
  bundle: RecoveryKeyBundle,
): boolean {
  if (!isRecoveryKeyBundle(bundle)) return false;
  const current = exportAccountKeyBundle(scope);
  if (current === null || current.keys.length !== bundle.keys.length) return false;
  return current.keys.every(
    (entry, index) =>
      entry.keyVersion === bundle.keys[index].keyVersion && entry.adk === bundle.keys[index].adk,
  );
}

function assertBundleHasNoConflicts(
  scope: SyncScope,
  entries: Array<{ keyVersion: number; key: Buffer }>,
): void {
  const db = getDb();
  for (const entry of entries) {
    const existing = db
      .prepare(
        `SELECT key_wrapped FROM sync_keyring
         WHERE backend_id = ? AND account_id = ? AND key_version = ?`,
      )
      .get(scope.backendId, scope.accountId, entry.keyVersion) as
      | { key_wrapped: Buffer }
      | undefined;
    if (existing === undefined) continue;
    const existingKey = unwrapSecretBytes(existing.key_wrapped);
    if (existingKey === null || !existingKey.equals(entry.key)) {
      throw new AccountKeyBundleConflictError(entry.keyVersion);
    }
  }
}

function insertMissingBundleEntries(
  scope: SyncScope,
  entries: Array<{ keyVersion: number; key: Buffer }>,
  source: AccountKeySource,
): void {
  const db = getDb();
  const insert = db.prepare(
    `INSERT INTO sync_keyring
       (backend_id, account_id, key_version, key_wrapped, source, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  for (const entry of entries) {
    const existing = db
      .prepare(
        `SELECT 1 AS present FROM sync_keyring
         WHERE backend_id = ? AND account_id = ? AND key_version = ?`,
      )
      .get(scope.backendId, scope.accountId, entry.keyVersion);
    if (existing !== undefined) continue;
    insert.run(
      scope.backendId,
      scope.accountId,
      entry.keyVersion,
      wrapSecretBytes(entry.key),
      source,
      nowIso(),
    );
  }
}

/**
 * Imports a complete, validated bundle without replacing any established
 * contradictory version. The preflight means a conflict leaves every row
 * untouched, including rows earlier in the bundle.
 */
export function importAccountKeyBundle(
  scope: SyncScope,
  bundle: RecoveryKeyBundle,
  source: 'recovery' | 'pairing' | 'wrap' = 'recovery',
): void {
  const entries = decodeBundleEntries(bundle);
  const db = getDb();
  db.transaction(() => {
    assertBundleHasNoConflicts(scope, entries);
    insertMissingBundleEntries(scope, entries, source);
  })();
}

function recoverySecretWrapped(secret: Buffer): Buffer {
  if (secret.byteLength !== 32 || !safeStorageAvailable()) {
    throw new RecoverySecretUnavailableError();
  }
  const encoded = secret.toString('base64');
  // Use the shared auth custody wrapper, but perform the availability check
  // above so its legacy plaintext fallback can never be selected here.
  const wrapped = encryptSecret(encoded);
  // Guard against a misconfigured test/runtime provider silently returning
  // the plaintext bytes instead of an OS-wrapped value.
  if (wrapped.equals(Buffer.from(encoded, 'utf8'))) {
    throw new RecoverySecretUnavailableError();
  }
  return wrapped;
}

/** Probes authenticated custody before a staged recovery setup is sent away. */
export function canStoreRecoverySecret(secret: Buffer): boolean {
  try {
    const wrapped = recoverySecretWrapped(secret);
    return safeStorage.decryptString(wrapped) === secret.toString('base64');
  } catch {
    return false;
  }
}

/** Persists a recovery secret only under authenticated OS storage. */
export function storeRecoverySecret(scope: SyncScope, recoveryId: string, secret: Buffer): void {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(recoveryId)
  ) {
    throw new Error('Recovery id must be a UUID');
  }
  const wrapped = recoverySecretWrapped(secret);
  const now = nowIso();
  getDb()
    .prepare(
      `INSERT INTO sync_recovery_secrets
       (backend_id, account_id, recovery_id, secret_wrapped, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (backend_id, account_id)
       DO UPDATE SET recovery_id = excluded.recovery_id,
                     secret_wrapped = excluded.secret_wrapped,
                     invalidated_at = NULL,
                     updated_at = excluded.updated_at`,
    )
    .run(scope.backendId, scope.accountId, recoveryId, wrapped, now, now);
}

/**
 * Atomically installs a recovered bundle and replaces retained custody. A
 * contradictory established version aborts before the secret row changes.
 */
export function commitRecoveryBundle(
  scope: SyncScope,
  bundle: RecoveryKeyBundle,
  recoveryId: string,
  secret: Buffer,
): void {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(recoveryId)
  ) {
    throw new Error('Recovery id must be a UUID');
  }
  const entries = decodeBundleEntries(bundle);
  const wrapped = recoverySecretWrapped(secret);
  const now = nowIso();
  const db = getDb();
  db.transaction(() => {
    assertBundleHasNoConflicts(scope, entries);
    insertMissingBundleEntries(scope, entries, 'recovery');
    db.prepare(
      `INSERT INTO sync_recovery_secrets
         (backend_id, account_id, recovery_id, secret_wrapped, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (backend_id, account_id)
       DO UPDATE SET recovery_id = excluded.recovery_id,
                     secret_wrapped = excluded.secret_wrapped,
                     invalidated_at = NULL,
                     updated_at = excluded.updated_at`,
    ).run(scope.backendId, scope.accountId, recoveryId, wrapped, now, now);
  })();
}

/** Returns the retained secret for this scope, or null on any custody failure. */
export function recoverySecretFor(scope: SyncScope, recoveryId?: string): Buffer | null {
  return retainedRecoverySecret(scope, recoveryId, false);
}

/** Returns the retained secret only when it is still valid for refresh. */
export function recoverySecretForRefresh(scope: SyncScope, recoveryId?: string): Buffer | null {
  return retainedRecoverySecret(scope, recoveryId, true);
}

function retainedRecoverySecret(
  scope: SyncScope,
  recoveryId: string | undefined,
  forRefresh: boolean,
): Buffer | null {
  if (!safeStorageAvailable()) return null;
  const row = getDb()
    .prepare(
      `SELECT recovery_id, secret_wrapped, invalidated_at FROM sync_recovery_secrets
       WHERE backend_id = ? AND account_id = ?`,
    )
    .get(scope.backendId, scope.accountId) as
    | { recovery_id: string; secret_wrapped: Buffer; invalidated_at: string | null }
    | undefined;
  if (row === undefined || (recoveryId !== undefined && row.recovery_id !== recoveryId))
    return null;
  if (forRefresh && row.invalidated_at !== null) return null;
  try {
    // `decryptSecret` is the shared auth boundary. Compare it with a direct
    // safeStorage decrypt so its legacy plaintext fallback remains disabled
    // for this high-value secret.
    const directDecoded = safeStorage.decryptString(row.secret_wrapped);
    const decoded = decryptSecret(row.secret_wrapped, 'recovery secret');
    if (decoded === undefined || decoded !== directDecoded) return null;
    const secret = Buffer.from(decoded, 'base64');
    return secret.byteLength === 32 && secret.toString('base64') === decoded ? secret : null;
  } catch {
    return null;
  }
}

/** Fences the retained code from refreshing envelopes after a revocation. */
export function invalidateRecoverySecret(scope: SyncScope): void {
  getDb()
    .prepare(
      `UPDATE sync_recovery_secrets
       SET invalidated_at = COALESCE(invalidated_at, ?), updated_at = ?
       WHERE backend_id = ? AND account_id = ?`,
    )
    .run(nowIso(), nowIso(), scope.backendId, scope.accountId);
}

/**
 * Records the backend's durable first-device decision for a keyless account.
 * The decision is refreshed by security.get; it is never inferred from a
 * local pull or the absence of cached peer identities.
 */
export function setAccountKeyBootstrapEligibility(
  scope: SyncScope,
  enrollmentId: string,
  eligible: boolean,
): void {
  if (enrollmentId.length === 0) throw new Error('Enrollment id is required');
  getDb()
    .prepare(
      `INSERT INTO sync_key_bootstrap_eligibility
         (backend_id, account_id, enrollment_id, eligible, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (backend_id, account_id, enrollment_id)
       DO UPDATE SET eligible = excluded.eligible, updated_at = excluded.updated_at`,
    )
    .run(scope.backendId, scope.accountId, enrollmentId, eligible ? 1 : 0, nowIso());
}

/** Returns the last server-authorized bootstrap decision for this enrollment. */
export function isAccountKeyBootstrapEligible(scope: SyncScope, enrollmentId: string): boolean {
  const row = getDb()
    .prepare(
      `SELECT eligible FROM sync_key_bootstrap_eligibility
       WHERE backend_id = ? AND account_id = ? AND enrollment_id = ?`,
    )
    .get(scope.backendId, scope.accountId, enrollmentId) as { eligible: number } | undefined;
  return row?.eligible === 1;
}

export function currentRecoveryId(scope: SyncScope): string | null {
  const row = getDb()
    .prepare(
      `SELECT recovery_id FROM sync_recovery_secrets
       WHERE backend_id = ? AND account_id = ?`,
    )
    .get(scope.backendId, scope.accountId) as { recovery_id: string } | undefined;
  return row?.recovery_id ?? null;
}

/** Removes retained recovery material when an account reset explicitly fences it. */
export function clearRecoverySecret(scope: SyncScope): void {
  getDb()
    .prepare(
      `DELETE FROM sync_recovery_secrets
       WHERE backend_id = ? AND account_id = ?`,
    )
    .run(scope.backendId, scope.accountId);
}

/**
 * Removes every local account-scoped crypto artifact during an explicit
 * account reset. This is one transaction so a reset cannot leave a usable
 * recovery secret beside an identity, pairing, or ADK row.
 */
export function clearAccountCrypto(scope: SyncScope): void {
  const db = getDb();
  db.transaction(() => {
    for (const table of [
      'sync_keyring',
      'sync_recovery_secrets',
      'sync_device_keys',
      'sync_pairing',
      'sync_device_trust',
      'sync_keyring_rotations',
      'sync_revocation_rotations',
      'sync_keyring_deliveries',
      'sync_keyring_pending_wraps',
      'sync_key_bootstrap_eligibility',
      'mesh_task_keys',
      'mesh_dashboard_grants',
    ]) {
      db.prepare(`DELETE FROM ${table} WHERE backend_id = ? AND account_id = ?`).run(
        scope.backendId,
        scope.accountId,
      );
    }
  })();
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
  if (!isAccountKeyBootstrapEligible(scope, ownEnrollmentId)) return false;
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

export function deviceTrustState(scope: SyncScope, enrollmentId: string): DeviceTrustState | null {
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
 * never transition back to pending/trusted. A new cryptographic enrollment
 * gets a new enrollment ID and starts with its own trust decision.
 */
export function setDeviceTrust(
  scope: SyncScope,
  enrollmentId: string,
  state: DeviceTrustState,
): void {
  const db = getDb();
  const existing = deviceTrustState(scope, enrollmentId);
  if (existing === 'revoked' && state !== 'revoked') {
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

function staticWrapMacKey(
  privateRaw: Buffer,
  peerPubRaw: Buffer,
  senderPubRaw: Buffer,
  recipientPubRaw: Buffer,
): Buffer {
  const shared = diffieHellman({
    privateKey: x25519PrivateFromRaw(privateRaw),
    publicKey: x25519PublicFromRaw(peerPubRaw),
  });
  return Buffer.from(
    hkdfSync(
      'sha256',
      shared,
      Buffer.concat([senderPubRaw, recipientPubRaw]),
      KEYRING_WRAP_MAC_INFO,
      32,
    ),
  );
}

function keyringWrapMac(
  scope: SyncScope,
  recipientEnrollmentId: string,
  wrap: KeyringWrapPayload,
  key: Buffer,
): string {
  const message = keyringWrapAuthenticationData({
    backendId: scope.backendId,
    accountId: scope.accountId,
    recipientEnrollmentId,
    keyVersion: wrap.keyVersion,
    ephPub: wrap.ephPub,
    nonce: wrap.nonce,
    ct: wrap.ct,
    senderEnrollmentId: wrap.senderEnrollmentId,
    senderPub: wrap.senderPub,
  });
  return createHmac('sha256', key).update(message, 'utf8').digest('base64url');
}

function pairingReceiptMac(
  scope: SyncScope,
  pairingNonce: string,
  enrollmentId: string,
  pub: string,
  proofNonce: string,
  secret: Buffer,
): string {
  const message = pairingReceiptAuthenticationData({
    backendId: scope.backendId,
    accountId: scope.accountId,
    pairingNonce,
    enrollmentId,
    pub,
    proofNonce,
  });
  return createHmac('sha256', secret).update(message, 'utf8').digest('base64url');
}

function macMatches(expected: string, actual: string): boolean {
  const expectedBytes = strictBase64UrlBytes(expected, 32);
  const actualBytes = strictBase64UrlBytes(actual, 32);
  return (
    expectedBytes !== null &&
    actualBytes !== null &&
    expectedBytes.byteLength === actualBytes.byteLength &&
    timingSafeEqual(expectedBytes, actualBytes)
  );
}

function keyringWrapPayloadHash(wrap: KeyringWrapPayload): string {
  return createHash('sha256').update(canonicalJson(wrap), 'utf8').digest('hex');
}

/**
 * Keep authenticated wraps whose sender still needs local SAS approval. The
 * cache contains only the sealed wire payload; plaintext key material is
 * never written here. Bounds are deliberate because a server can replay or
 * fan out crypto-boundary entities indefinitely.
 */
function cachePendingKeyringWrap(
  scope: SyncScope,
  recipientEnrollmentId: string,
  wrap: KeyringWrapPayload,
): void {
  const payloadJson = canonicalJson(wrap);
  if (Buffer.byteLength(payloadJson, 'utf8') > MAX_PENDING_KEYRING_WRAP_BYTES) return;
  const db = getDb();
  const count = db
    .prepare(
      `SELECT COUNT(*) AS count FROM sync_keyring_pending_wraps
       WHERE backend_id = ? AND account_id = ? AND recipient_enrollment_id = ?`,
    )
    .get(scope.backendId, scope.accountId, recipientEnrollmentId) as { count: number };
  if (count.count >= MAX_PENDING_KEYRING_WRAPS) return;
  db.prepare(
    `INSERT OR IGNORE INTO sync_keyring_pending_wraps
       (backend_id, account_id, recipient_enrollment_id, sender_enrollment_id,
        payload_hash, payload_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    scope.backendId,
    scope.accountId,
    recipientEnrollmentId,
    wrap.senderEnrollmentId,
    keyringWrapPayloadHash(wrap),
    payloadJson,
    nowIso(),
  );
}

function deletePendingKeyringWrap(
  scope: SyncScope,
  recipientEnrollmentId: string,
  wrap: KeyringWrapPayload,
): void {
  getDb()
    .prepare(
      `DELETE FROM sync_keyring_pending_wraps
       WHERE backend_id = ? AND account_id = ? AND recipient_enrollment_id = ?
         AND payload_hash = ?`,
    )
    .run(scope.backendId, scope.accountId, recipientEnrollmentId, keyringWrapPayloadHash(wrap));
}

function authenticatedWrapMac(
  scope: SyncScope,
  recipientEnrollmentId: string,
  wrap: KeyringWrapPayload,
): boolean {
  const senderPubRaw = strictBase64Bytes(wrap.senderPub, 32);
  const recipientPubRaw = ownPubRaw(scope, recipientEnrollmentId);
  const recipientPrivateRaw = ownDevicePrivateKey(scope, recipientEnrollmentId);
  if (senderPubRaw === null || recipientPubRaw === null || recipientPrivateRaw === null) {
    return false;
  }
  let expected: string;
  try {
    const key = staticWrapMacKey(recipientPrivateRaw, senderPubRaw, senderPubRaw, recipientPubRaw);
    expected = keyringWrapMac(scope, recipientEnrollmentId, wrap, key);
  } catch {
    return false;
  }
  return macMatches(expected, wrap.senderMac);
}

/**
 * An authenticated pairing blob is the one exception to the normal
 * pending->trusted path: the out-of-band secret proves the issuer identity.
 * Pin that identity before any later wrap can be accepted from it.
 */
function pinAuthenticatedIssuer(scope: SyncScope, enrollmentId: string, pub: string): boolean {
  if (enrollmentId.length === 0 || strictBase64Bytes(pub, 32) === null) return false;
  const db = getDb();
  const existing = db
    .prepare(
      `SELECT identity_pub FROM sync_device_keys
       WHERE backend_id = ? AND account_id = ? AND enrollment_id = ?`,
    )
    .get(scope.backendId, scope.accountId, enrollmentId) as { identity_pub: string } | undefined;
  if (existing !== undefined && existing.identity_pub !== pub) return false;
  if (deviceTrustState(scope, enrollmentId) === 'revoked') return false;
  if (existing === undefined) {
    db.prepare(
      `INSERT INTO sync_device_keys
         (backend_id, account_id, enrollment_id, identity_pub, identity_priv_wrapped, seen_at)
       VALUES (?, ?, ?, ?, NULL, ?)`,
    ).run(scope.backendId, scope.accountId, enrollmentId, pub, nowIso());
  } else {
    db.prepare(
      `UPDATE sync_device_keys SET seen_at = ?
       WHERE backend_id = ? AND account_id = ? AND enrollment_id = ?`,
    ).run(nowIso(), scope.backendId, scope.accountId, enrollmentId);
  }
  setDeviceTrust(scope, enrollmentId, 'trusted');
  return deviceTrustState(scope, enrollmentId) === 'trusted';
}

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
  try {
    const privRaw = ownDevicePrivateKey(scope, enrollmentId);
    const pubRaw = ownPubRaw(scope, enrollmentId);
    const ephPubRaw = strictBase64Bytes(wrap.ephPub, 32);
    if (privRaw === null || pubRaw === null || ephPubRaw === null) return null;
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
function accountKeyBundle(scope: SyncScope): Array<{ keyVersion: number; adk: string }> | null {
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
  if (issuerEnrollmentId === null || deviceTrustState(scope, issuerEnrollmentId) === 'revoked') {
    return;
  }
  const issuerPub = ensureDeviceIdentity(scope, issuerEnrollmentId).pub;
  const issuerPubRaw = strictBase64Bytes(issuerPub, 32);
  const recipientPubRaw = strictBase64Bytes(recipientPubB64, 32);
  const issuerPrivateRaw = ownDevicePrivateKey(scope, issuerEnrollmentId);
  if (issuerPubRaw === null || recipientPubRaw === null || issuerPrivateRaw === null) {
    throw new AccountKeyUnavailableError();
  }
  const inner: KeyringWrapInner = {
    v: 1,
    keys: bundle,
    issuerEnrollmentId,
    issuerPub,
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
    senderEnrollmentId: issuerEnrollmentId,
    senderPub: issuerPub,
    senderMac: '',
  };
  const macKey = staticWrapMacKey(issuerPrivateRaw, recipientPubRaw, issuerPubRaw, recipientPubRaw);
  payload.senderMac = keyringWrapMac(scope, targetEnrollmentId, payload, macKey);
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
    issuerEnrollmentId,
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
 * resolution and revocation bookkeeping. Any revocation fences the retained
 * recovery root from refreshing until an explicit replacement is accepted.
 */
function recordRotation(
  scope: SyncScope,
  record: KeyringRotationPayload,
  opts?: { local?: boolean },
): void {
  getDb()
    .prepare(
      `INSERT OR IGNORE INTO sync_keyring_rotations
         (backend_id, account_id, rotation_id, rotor_enrollment_id, from_version, to_version, revoked_json, local_origin, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      scope.backendId,
      scope.accountId,
      record.rotationId,
      record.rotorEnrollmentId,
      record.fromVersion,
      record.toVersion,
      JSON.stringify(record.revokedEnrollmentIds),
      opts?.local === true ? 1 : 0,
      nowIso(),
    );
  if (opts?.local === true) return;
  for (const enrollmentId of record.revokedEnrollmentIds) {
    setDeviceTrust(scope, enrollmentId, 'revoked');
  }
  if (record.revokedEnrollmentIds.length > 0) invalidateRecoverySecret(scope);
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
  const ownRotation = rotations.find(
    (r) => r.rotor_enrollment_id !== '' && isOwnRotation(scope, r),
  );
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

function isOwnRotation(scope: SyncScope, rotation: { rotor_enrollment_id: string }): boolean {
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
        typeof record.enrollmentId !== 'string' ||
        record.enrollmentId !== entityId ||
        strictBase64Bytes(record.pub, 32) === null
      ) {
        return true;
      }
      const db = getDb();
      const existing = db
        .prepare(
          `SELECT identity_pub FROM sync_device_keys
           WHERE backend_id = ? AND account_id = ? AND enrollment_id = ?`,
        )
        .get(scope.backendId, scope.accountId, record.enrollmentId) as
        | { identity_pub: string }
        | undefined;
      // An enrollment identity is pinned on first observation. A changed key
      // is a new enrollment, even if the old enrollment is pending or revoked.
      if (existing !== undefined && existing.identity_pub !== record.pub) return true;
      if (existing === undefined) {
        db.prepare(
          `INSERT INTO sync_device_keys
             (backend_id, account_id, enrollment_id, identity_pub, identity_priv_wrapped, seen_at)
           VALUES (?, ?, ?, ?, NULL, ?)`,
        ).run(scope.backendId, scope.accountId, record.enrollmentId, record.pub, nowIso());
      } else {
        db.prepare(
          `UPDATE sync_device_keys SET seen_at = ?
           WHERE backend_id = ? AND account_id = ? AND enrollment_id = ?`,
        ).run(nowIso(), scope.backendId, scope.accountId, record.enrollmentId);
      }
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
      if (deviceTrustState(scope, ownEnrollmentId) === 'revoked') return true;
      if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return true;
      const wrap = payload as KeyringWrapPayload;
      if (
        wrap.v !== 1 ||
        wrap.enc !== 'x25519-aes-256-gcm' ||
        !Number.isInteger(wrap.keyVersion) ||
        wrap.keyVersion < 1 ||
        wrap.keyVersion > RECOVERY_BUNDLE_MAX_KEY_VERSION ||
        typeof wrap.ephPub !== 'string' ||
        strictBase64Bytes(wrap.ephPub, 32) === null ||
        typeof wrap.nonce !== 'string' ||
        strictBase64Bytes(wrap.nonce, 12) === null ||
        typeof wrap.ct !== 'string' ||
        typeof wrap.senderEnrollmentId !== 'string' ||
        wrap.senderEnrollmentId.length === 0 ||
        typeof wrap.senderPub !== 'string' ||
        strictBase64Bytes(wrap.senderPub, 32) === null ||
        typeof wrap.senderMac !== 'string' ||
        strictBase64UrlBytes(wrap.senderMac, 32) === null
      ) {
        return true;
      }
      // The static sender MAC authenticates the complete public envelope and
      // proves possession of the sender's pinned X25519 private key. A
      // malformed or unsigned legacy wrap is never opened or cached.
      if (!authenticatedWrapMac(scope, ownEnrollmentId, wrap)) return true;
      const sender = getDb()
        .prepare(
          `SELECT identity_pub FROM sync_device_keys
           WHERE backend_id = ? AND account_id = ? AND enrollment_id = ?`,
        )
        .get(scope.backendId, scope.accountId, wrap.senderEnrollmentId) as
        | { identity_pub: string }
        | undefined;
      if (sender !== undefined && sender.identity_pub !== wrap.senderPub) return true;
      const senderTrust = deviceTrustState(scope, wrap.senderEnrollmentId);
      // Backend enrollment/status is not an authorization signal. Until the
      // local SAS flow pins and trusts this exact identity, retain only the
      // authenticated ciphertext for retry.
      if (sender === undefined || senderTrust !== 'trusted') {
        if (senderTrust === 'revoked') deletePendingKeyringWrap(scope, ownEnrollmentId, wrap);
        else cachePendingKeyringWrap(scope, ownEnrollmentId, wrap);
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
      // Only the authenticated, bounded bundle form is accepted. The old
      // bare 32-byte form had no issuer identity or replay binding and is
      // intentionally rejected.
      let installed = false;
      let inner: KeyringWrapInner | null = null;
      try {
        const parsed = JSON.parse(plaintext.toString('utf8')) as KeyringWrapInner;
        if (
          parsed.v === 1 &&
          Array.isArray(parsed.keys) &&
          parsed.keys.length > 0 &&
          parsed.keys.length <= RECOVERY_BUNDLE_MAX_KEYS &&
          parsed.issuerEnrollmentId === wrap.senderEnrollmentId &&
          parsed.issuerPub === wrap.senderPub
        ) {
          inner = parsed;
        }
      } catch {
        inner = null;
      }
      if (inner !== null) {
        for (const entry of inner.keys) {
          if (
            entry === null ||
            typeof entry !== 'object' ||
            !Number.isInteger(entry.keyVersion) ||
            entry.keyVersion < 1 ||
            entry.keyVersion > RECOVERY_BUNDLE_MAX_KEY_VERSION ||
            typeof entry.adk !== 'string'
          ) {
            continue;
          }
          const key = strictBase64Bytes(entry.adk, 32);
          if (key === null) continue;
          installDeliveredKey(scope, entry.keyVersion, key);
          installed = true;
        }
      }
      if (installed) {
        deletePendingKeyringWrap(scope, ownEnrollmentId, wrap);
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
      if (deviceTrustState(scope, ownEnrollmentId) === 'revoked') return true;
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
      if (
        inner.v !== 1 ||
        typeof inner.issuerEnrollmentId !== 'string' ||
        inner.issuerEnrollmentId.length === 0 ||
        typeof inner.issuerPub !== 'string' ||
        strictBase64Bytes(inner.issuerPub, 32) === null ||
        typeof inner.proofNonce !== 'string' ||
        inner.proofNonce.length === 0
      ) {
        return true;
      }
      // Pairing-secret authentication is what establishes the issuer's
      // identity. Pin it before installing or trusting any future wrap.
      if (!pinAuthenticatedIssuer(scope, inner.issuerEnrollmentId, inner.issuerPub)) {
        return true;
      }
      // v2 bundle or v1 single key.
      const entries: Array<{ keyVersion: number; adk: string }> =
        Array.isArray(inner.keys) && inner.keys.length > 0
          ? inner.keys
          : typeof inner.adk === 'string' && typeof inner.keyVersion === 'number'
            ? [{ keyVersion: inner.keyVersion, adk: inner.adk }]
            : [];
      let installed = false;
      for (const entry of entries) {
        if (
          entry === null ||
          typeof entry !== 'object' ||
          !Number.isInteger(entry.keyVersion) ||
          entry.keyVersion < 1 ||
          entry.keyVersion > RECOVERY_BUNDLE_MAX_KEY_VERSION ||
          typeof entry.adk !== 'string'
        ) {
          continue;
        }
        const key = strictBase64Bytes(entry.adk, 32);
        if (key === null) continue;
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
            mac: pairingReceiptMac(
              scope,
              entityId,
              ownEnrollmentId,
              ownPub.toString('base64'),
              inner.proofNonce,
              secret,
            ),
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
        typeof record.mac !== 'string' ||
        record.enrollmentId !== entityId ||
        strictBase64Bytes(record.pub, 32) === null ||
        strictBase64UrlBytes(record.mac, 32) === null ||
        record.proofNonce.length === 0
      ) {
        return true;
      }
      // The proof nonce must match one this device minted inside a sealed
      // pairing blob — the redeemer proves receipt of the secret.
      const pending = getDb()
        .prepare(
          `SELECT nonce, secret_wrapped FROM sync_pairing
           WHERE backend_id = ? AND account_id = ? AND role = 'issuer' AND proof_nonce = ?`,
        )
        .get(scope.backendId, scope.accountId, record.proofNonce) as
        | { nonce: string; secret_wrapped: Buffer }
        | undefined;
      if (pending === undefined) return true;
      const secret = unwrapSecretBytes(pending.secret_wrapped);
      if (secret === null || secret.byteLength !== 32) return true;
      const expectedMac = pairingReceiptMac(
        scope,
        pending.nonce,
        record.enrollmentId,
        record.pub,
        record.proofNonce,
        secret,
      );
      if (!macMatches(expectedMac, record.mac)) return true;
      const existing = getDb()
        .prepare(
          `SELECT identity_pub FROM sync_device_keys
           WHERE backend_id = ? AND account_id = ? AND enrollment_id = ?`,
        )
        .get(scope.backendId, scope.accountId, record.enrollmentId) as
        | { identity_pub: string }
        | undefined;
      if (existing !== undefined && existing.identity_pub !== record.pub) return true;
      // Register the announced identity and promote to trusted — the
      // pairing blob already delivered the key bundle.
      if (existing === undefined) {
        getDb()
          .prepare(
            `INSERT INTO sync_device_keys
               (backend_id, account_id, enrollment_id, identity_pub, identity_priv_wrapped, seen_at)
             VALUES (?, ?, ?, ?, NULL, ?)`,
          )
          .run(scope.backendId, scope.accountId, record.enrollmentId, record.pub, nowIso());
      } else {
        getDb()
          .prepare(
            `UPDATE sync_device_keys SET seen_at = ?
             WHERE backend_id = ? AND account_id = ? AND enrollment_id = ?`,
          )
          .run(nowIso(), scope.backendId, scope.accountId, record.enrollmentId);
      }
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
 * Re-processes authenticated wraps retained while the local SAS flow was
 * pending. Runtime calls this only after it has pinned and trusted the sender
 * identity locally; the handler still repeats every cryptographic check.
 */
export function retryPendingKeyringWraps(scope: SyncScope): void {
  const recipientEnrollmentId = getActiveEnrollmentId(scope);
  if (recipientEnrollmentId === null) return;
  const rows = getDb()
    .prepare(
      `SELECT payload_hash, payload_json FROM sync_keyring_pending_wraps
       WHERE backend_id = ? AND account_id = ? AND recipient_enrollment_id = ?
       ORDER BY created_at ASC`,
    )
    .all(scope.backendId, scope.accountId, recipientEnrollmentId) as Array<{
    payload_hash: string;
    payload_json: string;
  }>;
  for (const row of rows) {
    let payload: unknown;
    try {
      payload = JSON.parse(row.payload_json) as unknown;
    } catch {
      getDb()
        .prepare(
          `DELETE FROM sync_keyring_pending_wraps
           WHERE backend_id = ? AND account_id = ? AND recipient_enrollment_id = ?
             AND payload_hash = ?`,
        )
        .run(scope.backendId, scope.accountId, recipientEnrollmentId, row.payload_hash);
      continue;
    }
    if (
      handleCryptoBoundaryEntity(
        scope,
        recipientEnrollmentId,
        CRYPTO_ENTITY_KEYRING_WRAP,
        recipientEnrollmentId,
        payload,
      ) &&
      (payload === null || typeof payload !== 'object' || Array.isArray(payload))
    ) {
      getDb()
        .prepare(
          `DELETE FROM sync_keyring_pending_wraps
           WHERE backend_id = ? AND account_id = ? AND recipient_enrollment_id = ?
             AND payload_hash = ?`,
        )
        .run(scope.backendId, scope.accountId, recipientEnrollmentId, row.payload_hash);
    }
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
 * Returns revoked enrollments that this device has not durably rotated yet.
 * This consults only the local completion fence; pulled rotation entities are
 * deliberately not treated as proof that this device minted its new ADK.
 */
export function revocationsNeedingRotation(scope: SyncScope, enrollmentIds: string[]): string[] {
  const unique = [...new Set(enrollmentIds.filter((id) => id.length > 0))];
  const query = getDb().prepare(
    `SELECT 1 AS present FROM sync_revocation_rotations
     WHERE backend_id = ? AND account_id = ? AND enrollment_id = ?`,
  );
  return unique.filter(
    (enrollmentId) => query.get(scope.backendId, scope.accountId, enrollmentId) === undefined,
  );
}

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
  // A revoked device can retain its old recovery signer only for an explicit
  // replacement request. Fence refresh before minting the post-revocation ADK
  // so no concurrent refresh can publish those new keys under the old code.
  if (revokedEnrollmentIds.length > 0) invalidateRecoverySecret(scope);
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
    for (const enrollmentId of revokedEnrollmentIds) {
      setDeviceTrust(scope, enrollmentId, 'revoked');
    }
    installAccountKey(scope, nextVersion, randomBytes(32), 'rotation');
    const completedAt = nowIso();
    for (const enrollmentId of revokedEnrollmentIds) {
      if (enrollmentId.length === 0) continue;
      db.prepare(
        `INSERT OR IGNORE INTO sync_revocation_rotations
           (backend_id, account_id, enrollment_id, rotated_at)
         VALUES (?, ?, ?, ?)`,
      ).run(scope.backendId, scope.accountId, enrollmentId, completedAt);
    }
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
  const { nonce, ct } = gcmSeal(taskKey, aad, Buffer.from(canonicalJson(inputs), 'utf8'));
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
