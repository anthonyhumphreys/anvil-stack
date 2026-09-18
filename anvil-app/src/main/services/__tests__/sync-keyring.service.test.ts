import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SCHEMA_SQL } from '../../db/schema';
import type { SyncScope } from '../../../shared/sync-mesh';
import {
  CRYPTO_ENTITY_DEVICE_IDENTITY,
  CRYPTO_ENTITY_KEYRING_PAIRING,
  CRYPTO_ENTITY_KEYRING_WRAP,
  decodePairingPayload,
  type KeyringWrapPayload,
  type PairingKeyringPayload,
} from '../../../../cloud/contract/sealed';

const db = new Database(':memory:');
db.exec(SCHEMA_SQL);
vi.mock('../../db/database.js', () => ({ getDb: () => db }));
vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(`enc:${value}`, 'utf-8'),
    decryptString: (encrypted: Buffer) => {
      const text = encrypted.toString('utf-8');
      if (!text.startsWith('enc:')) throw new Error('Error while decrypting the ciphertext.');
      return text.slice('enc:'.length);
    },
  },
}));
vi.mock('../persona.service.js', () => ({
  getPersonaById: (id: string) => (id === 'coder' ? { id } : null),
  buildSystemPrompt: () => '',
}));
const applyRemoteEntityPayload = vi.hoisted(() => vi.fn());
vi.mock('../sync-entity-domain.js', () => ({ applyRemoteEntityPayload }));

import {
  AccountKeyUnavailableError,
  accountKeyFor,
  canProvisionAccountKey,
  currentAccountKey,
  deriveSas,
  ensureDeviceIdentity,
  handleCryptoBoundaryEntity,
  hasAccountKey,
  installAccountKey,
  listDeviceIdentities,
  mintPairingPayload,
  provisionAccountKey,
  publishDeviceIdentity,
  registerPairingRedemption,
  rotateAccountKey,
  sealAccountBytes,
  sealBytesWithKey,
  sealCredentialGrant,
  sealEntityPayload,
  sealScopedJson,
  UnsealError,
  unsealAccountBytes,
  unsealBytesWithKey,
  unsealCredentialGrant,
  unsealEntityPayload,
  unsealScopedJson,
  wrapAccountKeyFor,
} from '../sync-keyring.service';
import { updateSyncState, upsertEnrollment } from '../sync-persistence.service';

const SCOPE: SyncScope = { backendId: 'backend-1', accountId: 'account-1', datasetEpoch: '1' };
const ENROLLMENT = 'enr-own';

function activateEnrollment(id = ENROLLMENT): void {
  upsertEnrollment({
    displayName: 'Test device',
    id,
    installationId: 'installation-1',
    scope: SCOPE,
    state: 'active',
  });
}

/** Marks the first pull as completed — lazy ADK minting is gated on it. */
function markPullCompleted(): void {
  updateSyncState(SCOPE, { lastPullAt: new Date().toISOString() });
}

function pairingRows(): Array<{ nonce: string; role: string }> {
  return db.prepare('SELECT nonce, role FROM sync_pairing').all() as Array<{
    nonce: string;
    role: string;
  }>;
}

function outboxPayloads(entityType: string): unknown[] {
  const rows = db
    .prepare('SELECT payload_json FROM sync_outbox WHERE entity_type = ? ORDER BY created_at')
    .all(entityType) as Array<{ payload_json: string | null }>;
  return rows.map((r) => (r.payload_json === null ? null : JSON.parse(r.payload_json)));
}

beforeEach(() => {
  db.exec(
    `DELETE FROM sync_keyring; DELETE FROM sync_device_keys; DELETE FROM sync_pairing;
     DELETE FROM sync_keyring_deliveries; DELETE FROM sync_outbox; DELETE FROM sync_bindings;
     DELETE FROM sync_conflicts; DELETE FROM sync_state; DELETE FROM device_enrollments;
     DELETE FROM sync_scan_runs; DELETE FROM sync_scan_staging;`,
  );
  applyRemoteEntityPayload.mockClear();
});

describe('entity seal/unseal', () => {
  it('round-trips a domain payload through the envelope', () => {
    activateEnrollment();
    markPullCompleted();
    const envelope = sealEntityPayload(
      SCOPE,
      { entityType: 'workflow-template', entityId: 'w1', operation: 'create', schemaVersion: 1 },
      { name: 'demo', nodes: 3 },
    );
    expect(envelope.enc).toBe('aes-256-gcm');
    expect(envelope.keyVersion).toBe(1);
    const opened = unsealEntityPayload(
      SCOPE,
      { entityType: 'workflow-template', entityId: 'w1' },
      envelope,
    );
    expect(opened).toEqual({ name: 'demo', nodes: 3 });
  });

  it('provisions ADK v1 lazily on the first seal for a first device', () => {
    activateEnrollment();
    markPullCompleted();
    expect(hasAccountKey(SCOPE)).toBe(false);
    sealEntityPayload(
      SCOPE,
      { entityType: 't', entityId: 'e', operation: 'create', schemaVersion: 1 },
      { x: 1 },
    );
    expect(currentAccountKey(SCOPE)?.version).toBe(1);
  });

  it('rejects an unknown key version', () => {
    activateEnrollment();
    markPullCompleted();
    const envelope = sealEntityPayload(
      SCOPE,
      { entityType: 't', entityId: 'e', operation: 'create', schemaVersion: 1 },
      { x: 1 },
    );
    expect(() =>
      unsealEntityPayload(
        SCOPE,
        { entityType: 't', entityId: 'e' },
        { ...envelope, keyVersion: 9 },
      ),
    ).toThrowError(UnsealError);
    try {
      unsealEntityPayload(
        SCOPE,
        { entityType: 't', entityId: 'e' },
        { ...envelope, keyVersion: 9 },
      );
    } catch (error) {
      expect((error as UnsealError).reason).toBe('unknown-key-version');
    }
  });

  it('rejects tampered ciphertext', () => {
    activateEnrollment();
    markPullCompleted();
    const envelope = sealEntityPayload(
      SCOPE,
      { entityType: 't', entityId: 'e', operation: 'create', schemaVersion: 1 },
      { x: 1 },
    );
    const ct = Buffer.from(envelope.ct, 'base64');
    ct[0] ^= 0xff;
    try {
      unsealEntityPayload(
        SCOPE,
        { entityType: 't', entityId: 'e' },
        { ...envelope, ct: ct.toString('base64') },
      );
      expect.unreachable();
    } catch (error) {
      expect((error as UnsealError).reason).toBe('auth-failed');
    }
  });

  it('binds the envelope to the entity identity', () => {
    activateEnrollment();
    markPullCompleted();
    const envelope = sealEntityPayload(
      SCOPE,
      { entityType: 't', entityId: 'e', operation: 'create', schemaVersion: 1 },
      { x: 1 },
    );
    try {
      unsealEntityPayload(SCOPE, { entityType: 't', entityId: 'other' }, envelope);
      expect.unreachable();
    } catch (error) {
      expect((error as UnsealError).reason).toBe('auth-failed');
    }
  });
});

describe('provisioning gate', () => {
  it('lets a lone first device mint ADK v1', () => {
    activateEnrollment();
    markPullCompleted();
    expect(canProvisionAccountKey(SCOPE, ENROLLMENT)).toBe(true);
  });

  it('blocks minting before the first pull completes', () => {
    activateEnrollment();
    expect(canProvisionAccountKey(SCOPE, ENROLLMENT)).toBe(false);
    expect(() =>
      sealEntityPayload(
        SCOPE,
        { entityType: 't', entityId: 'e', operation: 'create', schemaVersion: 1 },
        { x: 1 },
      ),
    ).toThrowError(AccountKeyUnavailableError);
    expect(hasAccountKey(SCOPE)).toBe(false);
  });

  it('blocks a second device that has seen another device identity', () => {
    activateEnrollment();
    markPullCompleted();
    ensureDeviceIdentity(SCOPE, 'enr-other');
    expect(canProvisionAccountKey(SCOPE, ENROLLMENT)).toBe(false);
    expect(() =>
      sealEntityPayload(
        SCOPE,
        { entityType: 't', entityId: 'e', operation: 'create', schemaVersion: 1 },
        { x: 1 },
      ),
    ).toThrowError(AccountKeyUnavailableError);
  });

  it('blocks a device with a pending pairing redemption', () => {
    activateEnrollment();
    markPullCompleted();
    registerPairingRedemption(SCOPE, 'abc123', '00'.repeat(32));
    expect(canProvisionAccountKey(SCOPE, ENROLLMENT)).toBe(false);
  });
});

describe('device identity + key wrap', () => {
  it('publishes a plaintext device-identity entity', () => {
    activateEnrollment();
    publishDeviceIdentity(SCOPE, ENROLLMENT);
    const payloads = outboxPayloads(CRYPTO_ENTITY_DEVICE_IDENTITY);
    expect(payloads).toHaveLength(1);
    const payload = payloads[0] as { v: number; enrollmentId: string; pub: string };
    expect(payload.v).toBe(1);
    expect(payload.enrollmentId).toBe(ENROLLMENT);
    expect(Buffer.from(payload.pub, 'base64')).toHaveLength(32);
  });

  it('wraps the ADK to a recipient identity and the recipient unwraps it', () => {
    activateEnrollment();
    provisionAccountKey(SCOPE);
    const adk = currentAccountKey(SCOPE);
    expect(adk).not.toBeNull();
    // Simulate the recipient's identity arriving via sync, then a wrap
    // landing for this device's own enrollment — the local private key
    // opens it.
    const recipient = ensureDeviceIdentity(SCOPE, 'enr-recipient');
    wrapAccountKeyFor(SCOPE, 'enr-recipient', recipient.pub, adk!.version);
    const wrap = outboxPayloads(CRYPTO_ENTITY_KEYRING_WRAP)[0] as KeyringWrapPayload;
    expect(wrap.enc).toBe('x25519-aes-256-gcm');
    // This device is itself the recipient (own enrollment) → unwraps.
    wrapAccountKeyFor(SCOPE, ENROLLMENT, ensureDeviceIdentity(SCOPE, ENROLLMENT).pub, adk!.version);
    const ownWrap = outboxPayloads(CRYPTO_ENTITY_KEYRING_WRAP)[1] as KeyringWrapPayload;
    // Remove the key, then recover it via the wrap entity.
    db.prepare('DELETE FROM sync_keyring').run();
    expect(hasAccountKey(SCOPE)).toBe(false);
    const consumed = handleCryptoBoundaryEntity(
      SCOPE,
      ENROLLMENT,
      CRYPTO_ENTITY_KEYRING_WRAP,
      ENROLLMENT,
      ownWrap,
    );
    expect(consumed).toBe(true);
    expect(accountKeyFor(SCOPE, adk!.version)).toEqual(adk!.key);
  });

  it('ignores a wrap addressed to a different enrollment', () => {
    activateEnrollment();
    provisionAccountKey(SCOPE);
    const adk = currentAccountKey(SCOPE)!;
    wrapAccountKeyFor(SCOPE, ENROLLMENT, ensureDeviceIdentity(SCOPE, ENROLLMENT).pub, adk.version);
    const wrap = outboxPayloads(CRYPTO_ENTITY_KEYRING_WRAP)[0] as KeyringWrapPayload;
    db.prepare('DELETE FROM sync_keyring').run();
    handleCryptoBoundaryEntity(SCOPE, ENROLLMENT, CRYPTO_ENTITY_KEYRING_WRAP, 'enr-other', wrap);
    expect(hasAccountKey(SCOPE)).toBe(false);
  });
});

describe('pairing', () => {
  it('encodes a pairing payload carrying code + nonce + secret', () => {
    activateEnrollment();
    provisionAccountKey(SCOPE);
    const { pairingPayload, pairingNonce } = mintPairingPayload(
      SCOPE,
      ENROLLMENT,
      'anvil-ec-AAAAA-BBBBB-CCCCC-DDDDD',
    );
    const decoded = decodePairingPayload(pairingPayload);
    expect(decoded).not.toBeNull();
    expect(decoded!.enrollmentCode).toBe('anvil-ec-AAAAA-BBBBB-CCCCC-DDDDD');
    expect(decoded!.pairingNonce).toBe(pairingNonce);
    expect(decoded!.pairingSecret).toHaveLength(64);
  });

  it('delivers the ADK to a redeeming device via the pairing entity', () => {
    activateEnrollment();
    provisionAccountKey(SCOPE);
    const adk = currentAccountKey(SCOPE)!;
    const { pairingPayload, pairingNonce } = mintPairingPayload(
      SCOPE,
      ENROLLMENT,
      'anvil-ec-AAAAA-BBBBB-CCCCC-DDDDD',
    );
    const blob = outboxPayloads(CRYPTO_ENTITY_KEYRING_PAIRING)[0] as PairingKeyringPayload;
    const decoded = decodePairingPayload(pairingPayload)!;

    // Simulate the new device: it registers the typed secret, then the
    // pairing entity arrives on pull.
    db.prepare('DELETE FROM sync_keyring').run();
    db.prepare("DELETE FROM sync_pairing WHERE role = 'issuer'").run();
    registerPairingRedemption(SCOPE, decoded.pairingNonce, decoded.pairingSecret);
    handleCryptoBoundaryEntity(
      SCOPE,
      'enr-new-device',
      CRYPTO_ENTITY_KEYRING_PAIRING,
      pairingNonce,
      blob,
    );
    expect(accountKeyFor(SCOPE, adk.version)).toEqual(adk.key);
    // The pairing row is consumed. The issuer's pending create + the
    // redemption delete coalesce locally — no pending pairing rows remain.
    expect(pairingRows()).toHaveLength(0);
    const pending = db
      .prepare("SELECT COUNT(*) AS n FROM sync_outbox WHERE entity_type = ? AND state = 'pending'")
      .get(CRYPTO_ENTITY_KEYRING_PAIRING) as { n: number };
    expect(pending.n).toBe(0);
  });

  it('does not install the ADK when the pairing secret is wrong', () => {
    activateEnrollment();
    provisionAccountKey(SCOPE);
    const { pairingNonce } = mintPairingPayload(
      SCOPE,
      ENROLLMENT,
      'anvil-ec-AAAAA-BBBBB-CCCCC-DDDDD',
    );
    const blob = outboxPayloads(CRYPTO_ENTITY_KEYRING_PAIRING)[0] as PairingKeyringPayload;
    db.prepare('DELETE FROM sync_keyring').run();
    registerPairingRedemption(SCOPE, pairingNonce, 'ff'.repeat(32));
    handleCryptoBoundaryEntity(SCOPE, 'enr-new', CRYPTO_ENTITY_KEYRING_PAIRING, pairingNonce, blob);
    expect(hasAccountKey(SCOPE)).toBe(false);
  });
});

describe('rotation on revoke', () => {
  it('mints a new ADK version and wraps it for surviving devices only', () => {
    activateEnrollment();
    provisionAccountKey(SCOPE);
    ensureDeviceIdentity(SCOPE, 'enr-peer-1');
    ensureDeviceIdentity(SCOPE, 'enr-peer-revoked');
    const next = rotateAccountKey(SCOPE, ['enr-peer-revoked']);
    expect(next).toBe(2);
    expect(accountKeyFor(SCOPE, 2)).not.toBeNull();
    const delivered = db
      .prepare('SELECT enrollment_id FROM sync_keyring_deliveries WHERE key_version = 2')
      .all() as Array<{ enrollment_id: string }>;
    const targets = delivered.map((r) => r.enrollment_id).sort();
    expect(targets).toEqual(['enr-peer-1']);
  });

  it('keeps prior versions locally so pre-rotation history still opens', () => {
    activateEnrollment();
    provisionAccountKey(SCOPE);
    const envelopeV1 = sealEntityPayload(
      SCOPE,
      { entityType: 't', entityId: 'e', operation: 'create', schemaVersion: 1 },
      { era: 'old' },
    );
    rotateAccountKey(SCOPE, []);
    const envelopeV2 = sealEntityPayload(
      SCOPE,
      { entityType: 't', entityId: 'e2', operation: 'create', schemaVersion: 1 },
      { era: 'new' },
    );
    expect(envelopeV1.keyVersion).toBe(1);
    expect(envelopeV2.keyVersion).toBe(2);
    expect(unsealEntityPayload(SCOPE, { entityType: 't', entityId: 'e' }, envelopeV1)).toEqual({
      era: 'old',
    });
  });
});

describe('scoped JSON + byte sealing', () => {
  it('round-trips sealScopedJson', () => {
    activateEnrollment();
    provisionAccountKey(SCOPE);
    const envelope = sealScopedJson(SCOPE, 'anvil/checkpoint/v1:h1', { summary: 's' });
    expect(unsealScopedJson(SCOPE, 'anvil/checkpoint/v1:h1', envelope)).toEqual({ summary: 's' });
  });

  it('binds scoped JSON to its aad context', () => {
    activateEnrollment();
    provisionAccountKey(SCOPE);
    const envelope = sealScopedJson(SCOPE, 'anvil/checkpoint/v1:h1', { summary: 's' });
    expect(() => unsealScopedJson(SCOPE, 'anvil/checkpoint/v1:h2', envelope)).toThrowError(
      UnsealError,
    );
  });

  it('round-trips and authenticates sealed account bytes', () => {
    activateEnrollment();
    provisionAccountKey(SCOPE);
    const { keyVersion, bytes } = sealAccountBytes(
      SCOPE,
      'anvil/artifact-seal/v1|text/plain',
      Buffer.from('hello artifact'),
    );
    const opened = unsealAccountBytes(
      SCOPE,
      'anvil/artifact-seal/v1|text/plain',
      keyVersion,
      bytes,
    );
    expect(opened.toString('utf8')).toBe('hello artifact');
    const tampered = Buffer.from(bytes);
    tampered[tampered.length - 1] ^= 0xff;
    expect(() =>
      unsealAccountBytes(SCOPE, 'anvil/artifact-seal/v1|text/plain', keyVersion, tampered),
    ).toThrowError(UnsealError);
  });

  it('round-trips share blobs under a one-off key', () => {
    const key = Buffer.alloc(32, 7);
    const blob = sealBytesWithKey('anvil/share-seal/v1|text/markdown', key, Buffer.from('# hi'));
    expect(
      unsealBytesWithKey('anvil/share-seal/v1|text/markdown', key, blob)?.toString('utf8'),
    ).toBe('# hi');
    expect(
      unsealBytesWithKey('anvil/share-seal/v1|text/markdown', Buffer.alloc(32, 9), blob),
    ).toBeNull();
    expect(unsealBytesWithKey('anvil/share-seal/v1|text/plain', key, blob)).toBeNull();
  });
});

describe('credential grants (ENV-06)', () => {
  function sealGrant(overrides: Record<string, unknown> = {}) {
    return sealCredentialGrant({
      recipientPubB64: ensureDeviceIdentity(SCOPE, ENROLLMENT).pub,
      jobId: 'job_1',
      attemptId: 'att_1',
      fence: 3,
      targetEnrollmentId: ENROLLMENT,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      kind: 'credential-name',
      env: { OPENAI_API_KEY: 'sk-test', GITHUB_TOKEN: 'ghp_t' },
      ...overrides,
    });
  }

  it('round-trips a sealed grant to the recipient identity', () => {
    activateEnrollment();
    const grant = sealGrant();
    expect(grant.enc).toBe('x25519-aes-256-gcm');
    const inner = unsealCredentialGrant(SCOPE, ENROLLMENT, grant);
    expect(inner?.kind).toBe('credential-name');
    expect(inner?.env).toEqual({ OPENAI_API_KEY: 'sk-test', GITHUB_TOKEN: 'ghp_t' });
  });

  it('rejects the grant when a plaintext binding field is tampered', () => {
    activateEnrollment();
    const grant = sealGrant();
    // The fence rides the AAD — changing it breaks the seal's authentication.
    expect(unsealCredentialGrant(SCOPE, ENROLLMENT, { ...grant, fence: 4 })).toBeNull();
    expect(
      unsealCredentialGrant(SCOPE, ENROLLMENT, { ...grant, jobId: 'job_other' }),
    ).toBeNull();
  });

  it('returns null for a device identity that cannot open the seal', () => {
    activateEnrollment();
    const grant = sealGrant();
    // A different enrollment has no matching private key.
    expect(unsealCredentialGrant(SCOPE, 'enr-stranger', grant)).toBeNull();
  });
});

describe('SAS', () => {
  it('is deterministic, order-independent, and 9 digits', () => {
    const a = deriveSas('account-1', 'pubA', 'pubB');
    const b = deriveSas('account-1', 'pubB', 'pubA');
    expect(a).toBe(b);
    expect(a).toMatch(/^\d{9}$/);
    expect(deriveSas('account-2', 'pubA', 'pubB')).not.toBe(a);
  });
});

describe('device identity listing', () => {
  it('returns all known identities in the account scope', () => {
    activateEnrollment();
    ensureDeviceIdentity(SCOPE, ENROLLMENT);
    ensureDeviceIdentity(SCOPE, 'enr-peer');
    const ids = listDeviceIdentities(SCOPE)
      .map((d) => d.enrollmentId)
      .sort();
    expect(ids).toEqual(['enr-peer', ENROLLMENT].sort());
  });
});

describe('ADK provenance + wrap floor', () => {
  const KEY_A = Buffer.alloc(32, 1);
  const KEY_B = Buffer.alloc(32, 2);
  const KEY_C = Buffer.alloc(32, 3);

  /** Produces a wrap entity (for own enrollment) carrying `key` at `version`. */
  function wrapPayloadFor(version: number, key: Buffer): KeyringWrapPayload {
    db.prepare('DELETE FROM sync_keyring').run();
    installAccountKey(SCOPE, version, key, 'wrap');
    wrapAccountKeyFor(SCOPE, ENROLLMENT, ensureDeviceIdentity(SCOPE, ENROLLMENT).pub, version);
    const wrap = outboxPayloads(CRYPTO_ENTITY_KEYRING_WRAP).at(-1) as KeyringWrapPayload;
    db.prepare('DELETE FROM sync_keyring').run();
    return wrap;
  }

  it('heals a provisional minted v1 when the authoritative wrap arrives', () => {
    activateEnrollment();
    const wrap = wrapPayloadFor(1, KEY_A);
    // Divergent first-use mint: this device sealed before learning the real key.
    installAccountKey(SCOPE, 1, KEY_B, 'minted');
    handleCryptoBoundaryEntity(SCOPE, ENROLLMENT, CRYPTO_ENTITY_KEYRING_WRAP, ENROLLMENT, wrap);
    expect(accountKeyFor(SCOPE, 1)).toEqual(KEY_A);
  });

  it('does not displace a peer-delivered key on a same-version conflict', () => {
    activateEnrollment();
    const fakeWrap = wrapPayloadFor(1, KEY_B);
    installAccountKey(SCOPE, 1, KEY_A, 'wrap');
    handleCryptoBoundaryEntity(
      SCOPE,
      ENROLLMENT,
      CRYPTO_ENTITY_KEYRING_WRAP,
      ENROLLMENT,
      fakeWrap,
    );
    expect(accountKeyFor(SCOPE, 1)).toEqual(KEY_A);
  });

  it('accepts the expected next-version wrap but rejects version jumps', () => {
    activateEnrollment();
    const wrapV2 = wrapPayloadFor(2, KEY_B);
    const wrapV3 = wrapPayloadFor(3, KEY_C);
    installAccountKey(SCOPE, 1, KEY_A, 'wrap');
    // Holding v1, a v3 wrap is a jump — refused even though it unwraps fine.
    handleCryptoBoundaryEntity(SCOPE, ENROLLMENT, CRYPTO_ENTITY_KEYRING_WRAP, ENROLLMENT, wrapV3);
    expect(accountKeyFor(SCOPE, 3)).toBeNull();
    expect(currentAccountKey(SCOPE)?.version).toBe(1);
    // The in-order v2 wrap is the expected next version and installs.
    handleCryptoBoundaryEntity(SCOPE, ENROLLMENT, CRYPTO_ENTITY_KEYRING_WRAP, ENROLLMENT, wrapV2);
    expect(accountKeyFor(SCOPE, 2)).toEqual(KEY_B);
    // Now holding v2, the previously rejected v3 wrap is acceptable.
    handleCryptoBoundaryEntity(SCOPE, ENROLLMENT, CRYPTO_ENTITY_KEYRING_WRAP, ENROLLMENT, wrapV3);
    expect(accountKeyFor(SCOPE, 3)).toEqual(KEY_C);
  });

  it('accepts any first-version wrap on a keyless device', () => {
    activateEnrollment();
    const wrapV3 = wrapPayloadFor(3, KEY_C);
    handleCryptoBoundaryEntity(SCOPE, ENROLLMENT, CRYPTO_ENTITY_KEYRING_WRAP, ENROLLMENT, wrapV3);
    expect(accountKeyFor(SCOPE, 3)).toEqual(KEY_C);
  });
});

describe('pairing scope', () => {
  const OTHER_SCOPE: SyncScope = { ...SCOPE, accountId: 'account-2' };

  it('stores the same nonce under different accounts independently', () => {
    registerPairingRedemption(SCOPE, 'deadbeef', '00'.repeat(32));
    registerPairingRedemption(OTHER_SCOPE, 'deadbeef', '11'.repeat(32));
    const rows = db
      .prepare('SELECT backend_id, account_id, nonce FROM sync_pairing ORDER BY account_id')
      .all() as Array<{ account_id: string }>;
    expect(rows).toHaveLength(2);
    // A same-scope re-register replaces; the other account's row is untouched.
    registerPairingRedemption(SCOPE, 'deadbeef', '22'.repeat(32));
    expect(db.prepare('SELECT COUNT(*) AS n FROM sync_pairing').get()).toEqual({ n: 2 });
  });

  it('does not let another account\'s redeemer block provisioning here', () => {
    activateEnrollment();
    markPullCompleted();
    registerPairingRedemption(OTHER_SCOPE, 'abc123', '00'.repeat(32));
    expect(canProvisionAccountKey(SCOPE, ENROLLMENT)).toBe(true);
  });

  it('does not open a pairing entity without a same-scope redemption', () => {
    activateEnrollment();
    provisionAccountKey(SCOPE);
    const { pairingNonce } = mintPairingPayload(
      SCOPE,
      ENROLLMENT,
      'anvil-ec-AAAAA-BBBBB-CCCCC-DDDDD',
    );
    const blob = outboxPayloads(CRYPTO_ENTITY_KEYRING_PAIRING)[0] as PairingKeyringPayload;
    db.prepare('DELETE FROM sync_keyring').run();
    db.prepare("DELETE FROM sync_pairing WHERE role = 'issuer'").run();
    // The redeemer registered under a different account — same nonce string.
    registerPairingRedemption(OTHER_SCOPE, pairingNonce, '00'.repeat(32));
    handleCryptoBoundaryEntity(SCOPE, 'enr-new', CRYPTO_ENTITY_KEYRING_PAIRING, pairingNonce, blob);
    expect(hasAccountKey(SCOPE)).toBe(false);
  });
});
