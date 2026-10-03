import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SCHEMA_SQL } from '../../db/schema';
import type { SyncScope } from '../../../shared/sync-mesh';

const db = new Database(':memory:');
db.exec(SCHEMA_SQL);
vi.mock('../../db/database.js', () => ({ getDb: () => db }));
vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) =>
      Buffer.from(`enc:${Buffer.from(value, 'utf8').toString('base64')}`, 'utf8'),
    decryptString: (encrypted: Buffer) => {
      const text = encrypted.toString('utf8');
      if (!text.startsWith('enc:')) throw new Error('invalid wrapped value');
      return Buffer.from(text.slice('enc:'.length), 'base64').toString('utf8');
    },
  },
}));
vi.mock('../sync-entity-domain.js', () => ({ applyRemoteEntityPayload: vi.fn() }));

import {
  AccountKeyBundleConflictError,
  currentAccountKey,
  currentRecoveryId,
  exportAccountKeyBundle,
  installAccountKey,
  provisionAccountKey,
  recoverySecretFor,
} from '../sync-keyring.service';
import {
  buildRecoveryRequestSignature,
  commitRecoverySetup,
  commitRecoveryUnlock,
  createRecoverySetup,
  hasCurrentRecoveryBundle,
  prepareRecoveryUnlock,
  recoveryPayloadHash,
  refreshRecoveryEnvelope,
  unlockRecoveryEnvelope,
  verifyRecoveryRequestSignature,
} from '../sync-recovery.service';
import { rotateAccountKey } from '../sync-keyring.service';

const SCOPE: SyncScope = { backendId: 'backend-1', accountId: 'account-1', datasetEpoch: '1' };

beforeEach(() => {
  db.exec(
    `DELETE FROM sync_keyring;
     DELETE FROM sync_recovery_secrets;
     DELETE FROM sync_keyring_rotations;
     DELETE FROM sync_outbox;
     DELETE FROM sync_state;
     DELETE FROM device_enrollments;`,
  );
});

describe('recovery-code crypto', () => {
  it('creates an opaque envelope and unlocks a full bundle with the code', () => {
    provisionAccountKey(SCOPE);
    const setup = createRecoverySetup(SCOPE);
    expect(setup.code).toMatch(/^anvil-recovery-[A-Za-z0-9_-]{43}$/);
    expect(setup.envelope).toMatchObject({ v: 1, algorithm: 'aes-256-gcm' });
    expect(setup.envelope.publicKey).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(JSON.stringify(setup.envelope)).not.toContain(
      exportAccountKeyBundle(SCOPE)!.keys[0].adk,
    );

    db.prepare('DELETE FROM sync_keyring').run();
    expect(() => currentAccountKey(SCOPE)).not.toThrow();
    const unlocked = unlockRecoveryEnvelope(SCOPE, setup.code, setup.envelope);
    expect(unlocked.recoveryId).toBe(setup.recoveryId);
    expect(exportAccountKeyBundle(SCOPE)).toEqual(unlocked.bundle);
    expect(
      (
        db
          .prepare('SELECT source FROM sync_keyring WHERE backend_id = ? AND account_id = ?')
          .get(SCOPE.backendId, SCOPE.accountId) as { source: string }
      ).source,
    ).toBe('recovery');
    expect(hasCurrentRecoveryBundle(SCOPE, unlocked.bundle)).toBe(true);
  });

  it('normalizes display formatting without changing the case-sensitive secret', () => {
    provisionAccountKey(SCOPE);
    const setup = createRecoverySetup(SCOPE);
    const encoded = setup.code.slice(RECOVERY_PREFIX_LENGTH);
    const displayed = ` ANVIL-RECOVERY-${encoded.slice(0, 17)}\n${encoded.slice(17)} `;
    db.prepare('DELETE FROM sync_keyring').run();
    expect(unlockRecoveryEnvelope(SCOPE, displayed, setup.envelope).recoveryId).toBe(
      setup.recoveryId,
    );
  });

  it('fails closed on a wrong code without installing plaintext or keys', () => {
    provisionAccountKey(SCOPE);
    const setup = createRecoverySetup(SCOPE);
    db.prepare('DELETE FROM sync_keyring').run();
    const wrong = `${setup.code.slice(0, -1)}${setup.code.endsWith('A') ? 'B' : 'A'}`;
    expect(() => unlockRecoveryEnvelope(SCOPE, wrong, setup.envelope)).toThrow();
    expect(currentAccountKey(SCOPE)).toBeNull();
    expect(
      (
        db.prepare('SELECT secret_wrapped FROM sync_recovery_secrets').get() as {
          secret_wrapped: Buffer;
        }
      ).secret_wrapped.toString('utf8'),
    ).not.toContain(setup.code.slice(RECOVERY_PREFIX_LENGTH));
  });

  it('rejects ciphertext tampering and a scope transplant', () => {
    provisionAccountKey(SCOPE);
    const setup = createRecoverySetup(SCOPE);
    const bytes = Buffer.from(setup.envelope.ct, 'base64');
    bytes[0] ^= 0xff;
    expect(() =>
      unlockRecoveryEnvelope(SCOPE, setup.code, {
        ...setup.envelope,
        ct: bytes.toString('base64'),
      }),
    ).toThrow();
    expect(() =>
      unlockRecoveryEnvelope({ ...SCOPE, backendId: 'other-backend' }, setup.code, setup.envelope),
    ).toThrow();
    expect(() =>
      unlockRecoveryEnvelope(SCOPE, setup.code, {
        ...setup.envelope,
        plaintext: 'must-not-be-carried',
      } as typeof setup.envelope),
    ).toThrow();
  });

  it('authenticates account/backend/recovery binding changes', () => {
    provisionAccountKey(SCOPE);
    const setup = createRecoverySetup(SCOPE);
    const binding = {
      action: 'recovery.enroll',
      accountId: SCOPE.accountId,
      backendId: SCOPE.backendId,
      enrollmentId: 'enrollment-1',
      identityPub: 'identity-public-key',
      recoveryId: setup.recoveryId,
      revision: 4,
      challenge: 'server-challenge',
      payloadHash: 'payload-hash-v1',
    } as const;
    const signature = buildRecoveryRequestSignature(SCOPE, binding);
    expect(verifyRecoveryRequestSignature(binding, signature, setup.publicKey)).toBe(true);
    for (const field of Object.keys(binding) as Array<keyof typeof binding>) {
      const changed = {
        ...binding,
        [field]: field === 'revision' ? 5 : `${binding[field]}-changed`,
      };
      expect(verifyRecoveryRequestSignature(changed, signature, setup.publicKey)).toBe(false);
    }
  });

  it('refreshes with the retained secret and same recovery ID after rotation', () => {
    provisionAccountKey(SCOPE);
    const setup = createRecoverySetup(SCOPE);
    rotateAccountKey(SCOPE, []);
    const refreshed = refreshRecoveryEnvelope(SCOPE);
    expect(refreshed.recoveryId).toBe(setup.recoveryId);
    db.prepare('DELETE FROM sync_keyring').run();
    const unlocked = unlockRecoveryEnvelope(SCOPE, setup.code, refreshed);
    expect(unlocked.bundle.keys.map((entry) => entry.keyVersion)).toEqual([1, 2]);
  });

  it('fences refresh after revocation until a replacement recovery code is committed', () => {
    provisionAccountKey(SCOPE);
    const setup = createRecoverySetup(SCOPE);
    rotateAccountKey(SCOPE, ['revoked-enrollment']);
    expect(() => refreshRecoveryEnvelope(SCOPE)).toThrow();

    const replacement = createRecoverySetup(SCOPE, { persist: false });
    commitRecoverySetup(SCOPE, replacement.code, replacement.recoveryId);
    expect(refreshRecoveryEnvelope(SCOPE).recoveryId).toBe(replacement.recoveryId);
    expect(recoverySecretFor(SCOPE, setup.recoveryId)).toBeNull();
  });

  it('does not overwrite an established contradictory key version', () => {
    provisionAccountKey(SCOPE);
    const setup = createRecoverySetup(SCOPE);
    const original = currentAccountKey(SCOPE)!.key;
    db.prepare('DELETE FROM sync_keyring').run();
    installAccountKey(SCOPE, 1, Buffer.alloc(32, 0x7f), 'pairing');
    expect(() => unlockRecoveryEnvelope(SCOPE, setup.code, setup.envelope)).toThrow(
      AccountKeyBundleConflictError,
    );
    expect(currentAccountKey(SCOPE)!.key).not.toEqual(original);
    expect(exportAccountKeyBundle(SCOPE)!.keys).toHaveLength(1);
  });

  it('stages setup until server acceptance so a failed replacement keeps old custody', () => {
    provisionAccountKey(SCOPE);
    const first = createRecoverySetup(SCOPE);
    const staged = createRecoverySetup(SCOPE, { persist: false });

    expect(currentRecoveryId(SCOPE)).toBe(first.recoveryId);
    expect(recoverySecretFor(SCOPE, first.recoveryId)).not.toBeNull();
    expect(recoverySecretFor(SCOPE, staged.recoveryId)).toBeNull();

    commitRecoverySetup(SCOPE, staged.code, staged.recoveryId);
    expect(currentRecoveryId(SCOPE)).toBe(staged.recoveryId);
    expect(recoverySecretFor(SCOPE, staged.recoveryId)).not.toBeNull();
  });

  it('does not install an unlocked bundle until its proof is accepted', () => {
    provisionAccountKey(SCOPE);
    const setup = createRecoverySetup(SCOPE);
    db.prepare('DELETE FROM sync_keyring').run();
    db.prepare('DELETE FROM sync_recovery_secrets').run();

    const prepared = prepareRecoveryUnlock(SCOPE, setup.code, setup.envelope);
    expect(currentAccountKey(SCOPE)).toBeNull();
    expect(currentRecoveryId(SCOPE)).toBeNull();
    expect(
      prepared.signRecoveryRequest({
        action: 'recovery.enroll',
        accountId: SCOPE.accountId,
        backendId: SCOPE.backendId,
        enrollmentId: 'enrollment-1',
        identityPub: 'identity-public-key',
        recoveryId: setup.recoveryId,
        revision: 1,
        challenge: 'challenge',
        payloadHash: 'payload-hash',
      }),
    ).toMatch(/^[A-Za-z0-9_-]{86}$/);

    commitRecoveryUnlock(prepared);
    expect(currentAccountKey(SCOPE)).not.toBeNull();
    expect(currentRecoveryId(SCOPE)).toBe(setup.recoveryId);
  });

  it('leaves custody unchanged when a staged unlock conflicts', () => {
    provisionAccountKey(SCOPE);
    const first = createRecoverySetup(SCOPE);
    const originalSecret = recoverySecretFor(SCOPE, first.recoveryId);
    const originalKey = currentAccountKey(SCOPE)!.key;
    const staged = createRecoverySetup(SCOPE, { persist: false });
    db.prepare('DELETE FROM sync_keyring').run();
    installAccountKey(SCOPE, 1, Buffer.alloc(32, 0x7f), 'pairing');

    const prepared = prepareRecoveryUnlock(SCOPE, staged.code, staged.envelope);
    expect(() => commitRecoveryUnlock(prepared)).toThrow(AccountKeyBundleConflictError);
    expect(currentRecoveryId(SCOPE)).toBe(first.recoveryId);
    expect(recoverySecretFor(SCOPE, first.recoveryId)).toEqual(originalSecret);
    expect(currentAccountKey(SCOPE)!.key).not.toEqual(originalKey);
    expect(recoverySecretFor(SCOPE, staged.recoveryId)).toBeNull();
  });

  it('hashes mutable RPC payloads canonically before request binding', () => {
    expect(recoveryPayloadHash({ b: 2, a: 1 })).toBe(recoveryPayloadHash({ a: 1, b: 2 }));
    expect(recoveryPayloadHash({ a: 1 })).not.toBe(recoveryPayloadHash({ a: 2 }));
  });
});

const RECOVERY_PREFIX_LENGTH = 'anvil-recovery-'.length;
