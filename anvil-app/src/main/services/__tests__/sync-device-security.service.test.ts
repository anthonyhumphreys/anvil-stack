import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SCHEMA_SQL } from '../../db/schema';
import type { SyncScope } from '../../../shared/sync-mesh';
import type { SyncDeviceSecurityContext } from '../sync-device-security.service';

const db = new Database(':memory:');
db.exec(SCHEMA_SQL);
vi.mock('../../db/database.js', () => ({ getDb: () => db }));
vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(`enc:${value}`, 'utf8'),
    decryptString: (encrypted: Buffer) => {
      const text = encrypted.toString('utf8');
      if (!text.startsWith('enc:')) throw new Error('invalid wrapped value');
      return text.slice('enc:'.length);
    },
  },
}));
vi.mock('../sync-entity-domain.js', () => ({ applyRemoteEntityPayload: vi.fn() }));

import {
  currentAccountKey,
  currentRecoveryId,
  invalidateRecoverySecret,
  provisionAccountKey,
  rotateAccountKey,
} from '../sync-keyring.service';
import {
  createRecoverySetup,
  prepareRecoveryUnlock,
  refreshRecoveryEnvelope,
} from '../sync-recovery.service';
import {
  setNewDeviceTrustPolicy,
  refreshDeviceRecovery,
  replaceDeviceRecovery,
  setupDeviceRecovery,
  unlockDeviceRecovery,
} from '../sync-device-security.service';

const SCOPE: SyncScope = { backendId: 'backend-1', accountId: 'account-1', datasetEpoch: '1' };
const ENROLLMENT = 'enrollment-1';

function context(
  rpc: (operation: string, params: unknown) => Promise<unknown>,
): SyncDeviceSecurityContext {
  return {
    scope: SCOPE,
    enrollmentId: ENROLLMENT,
    rpc: rpc as <R>(operation: string, params: unknown) => Promise<R>,
    assertCurrent: () => undefined,
  };
}

beforeEach(() => {
  db.exec(
    `DELETE FROM sync_keyring;
     DELETE FROM sync_recovery_secrets;
     DELETE FROM sync_device_keys;`,
  );
});

describe('sync device security orchestration', () => {
  it('does not retain a recovery code until the opaque envelope is accepted', async () => {
    provisionAccountKey(SCOPE);
    const calls: Array<{ operation: string; params: unknown }> = [];
    const rpc = vi.fn(async (operation: string, params: unknown) => {
      calls.push({ operation, params });
      if (operation === 'security.get') {
        return {
          accountId: SCOPE.accountId,
          canConfigure: true,
          policy: 'require-approval',
          trustState: 'trusted',
          trustSource: 'first-device',
          revision: 1,
        };
      }
      throw new Error('configuration rejected');
    });

    await expect(setupDeviceRecovery(context(rpc), 'auto-trust-authenticated')).rejects.toThrow(
      'configuration rejected',
    );
    expect(calls.map(({ operation }) => operation)).toEqual(['security.get', 'security.configure']);
    expect(db.prepare('SELECT COUNT(*) AS n FROM sync_recovery_secrets').get()).toEqual({ n: 0 });
  });

  it('requires the recovery code before committing key custody on a new device', async () => {
    provisionAccountKey(SCOPE);
    const setup = createRecoverySetup(SCOPE);
    db.prepare('DELETE FROM sync_keyring').run();
    db.prepare('DELETE FROM sync_recovery_secrets').run();

    const payloads: Array<{ operation: string; params: unknown }> = [];
    const rpc = vi.fn(async (operation: string, params: unknown) => {
      payloads.push({ operation, params });
      if (operation === 'security.get') {
        return {
          accountId: SCOPE.accountId,
          configured: true,
          policy: 'auto-trust-authenticated',
          revision: 2,
          trustState: 'trusted',
          trustSource: 'automatic-auth',
          recovery: {
            envelope: setup.envelope,
            recoveryId: setup.recoveryId,
            verifierPublicKey: setup.publicKey,
          },
          requiresRecovery: true,
        };
      }
      if (operation === 'security.challenge') {
        const request = params as Record<string, unknown>;
        return {
          challengeId: 'sch_test_12345678',
          challenge: 'challenge-value',
          accountId: SCOPE.accountId,
          enrollmentId: ENROLLMENT,
          action: request.action,
          accountRevision: 2,
          recoveryRevision: 1,
          recoveryId: setup.recoveryId,
          backendId: SCOPE.backendId,
          identityPub: request.identityPub,
          payloadHash: request.payloadHash,
        };
      }
      if (operation === 'security.recover') return { recovered: true };
      throw new Error(`unexpected operation ${operation}`);
    });

    await expect(unlockDeviceRecovery(context(rpc), 'anvil-recovery-invalid')).rejects.toThrow();
    expect(currentAccountKey(SCOPE)).toBeNull();
    expect(payloads.map(({ operation }) => operation)).toEqual(['security.get']);

    const status = await unlockDeviceRecovery(context(rpc), setup.code);
    expect(status.hasAccountKey).toBe(true);
    expect(status.hasRecoverySecret).toBe(true);
    expect(payloads.map(({ operation }) => operation)).toEqual([
      'security.get',
      'security.get',
      'security.challenge',
      'security.recover',
      'security.get',
    ]);
    const proof = payloads.find(({ operation }) => operation === 'security.recover')?.params as {
      proof: { signature: string; payloadHash: string };
    };
    expect(proof.proof.signature).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(proof.proof.payloadHash).toMatch(/^[0-9a-f]{64}$/);
    const backendSecurityModulePath = '../../../../cloud/backend/src/device-security';
    const backendSecurity = await import(backendSecurityModulePath);
    expect(backendSecurity.parseSecurityProof(proof.proof)).toEqual(proof.proof);
    expect(
      backendSecurity.parseSecurityProof({ ...proof.proof, publicKey: setup.publicKey }),
    ).toBeNull();
  });

  it('leaves key custody unchanged when the backend rejects recovery', async () => {
    provisionAccountKey(SCOPE);
    const setup = createRecoverySetup(SCOPE);
    db.prepare('DELETE FROM sync_keyring').run();
    db.prepare('DELETE FROM sync_recovery_secrets').run();
    const rpc = vi.fn(async (operation: string, params: unknown) => {
      if (operation === 'security.get') {
        return {
          accountId: SCOPE.accountId,
          configured: true,
          policy: 'auto-trust-authenticated',
          revision: 2,
          trustState: 'pending',
          recovery: {
            envelope: setup.envelope,
            recoveryId: setup.recoveryId,
            verifierPublicKey: setup.publicKey,
          },
          requiresRecovery: true,
        };
      }
      if (operation === 'security.challenge') {
        const request = params as Record<string, unknown>;
        return {
          challengeId: 'sch_reject_12345678',
          challenge: 'challenge-reject',
          accountId: SCOPE.accountId,
          enrollmentId: ENROLLMENT,
          action: 'recover',
          accountRevision: 2,
          recoveryRevision: 1,
          recoveryId: setup.recoveryId,
          backendId: SCOPE.backendId,
          identityPub: request.identityPub,
          payloadHash: request.payloadHash,
        };
      }
      throw new Error('recovery rejected');
    });
    await expect(unlockDeviceRecovery(context(rpc), setup.code)).rejects.toThrow(
      'recovery rejected',
    );
    expect(currentAccountKey(SCOPE)).toBeNull();
    expect(db.prepare('SELECT COUNT(*) AS n FROM sync_recovery_secrets').get()).toEqual({ n: 0 });
  });

  it('merges remote-only key versions before deciding whether refresh is needed', async () => {
    provisionAccountKey(SCOPE);
    const setup = createRecoverySetup(SCOPE);
    rotateAccountKey(SCOPE, []);
    const remoteEnvelope = refreshRecoveryEnvelope(SCOPE);
    db.prepare('DELETE FROM sync_keyring WHERE key_version = 2').run();
    expect(currentAccountKey(SCOPE)?.version).toBe(1);
    const calls: string[] = [];
    const rpc = vi.fn(async (operation: string) => {
      calls.push(operation);
      if (operation === 'security.get') {
        return {
          accountId: SCOPE.accountId,
          configured: true,
          policy: 'require-approval',
          revision: 3,
          trustState: 'trusted',
          recovery: {
            envelope: remoteEnvelope,
            recoveryId: setup.recoveryId,
            verifierPublicKey: setup.publicKey,
            revision: 2,
          },
        };
      }
      throw new Error(`unexpected RPC ${operation}`);
    });
    await refreshDeviceRecovery(context(rpc));
    expect(calls).toEqual(['security.get']);
    expect(currentAccountKey(SCOPE)?.version).toBe(2);
  });

  it('does not refresh a locally invalidated recovery root even if the server reports it valid', async () => {
    provisionAccountKey(SCOPE);
    const setup = createRecoverySetup(SCOPE);
    invalidateRecoverySecret(SCOPE);
    const rpc = vi.fn(async (operation: string) => {
      expect(operation).toBe('security.get');
      return {
        accountId: SCOPE.accountId,
        configured: true,
        policy: 'require-approval',
        revision: 2,
        trustState: 'trusted',
        recoveryValid: true,
        recovery: {
          envelope: setup.envelope,
          recoveryId: setup.recoveryId,
          verifierPublicKey: setup.publicKey,
        },
      };
    });
    await expect(refreshDeviceRecovery(context(rpc))).rejects.toThrow(
      'replaced after device revocation',
    );
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it('refuses recovery unlock while the retained root is invalidated', async () => {
    provisionAccountKey(SCOPE);
    const setup = createRecoverySetup(SCOPE);
    invalidateRecoverySecret(SCOPE);
    db.prepare('DELETE FROM sync_keyring').run();
    const rpc = vi.fn(async (operation: string) => {
      expect(operation).toBe('security.get');
      return {
        accountId: SCOPE.accountId,
        configured: true,
        policy: 'auto-trust-authenticated',
        revision: 2,
        trustState: 'pending',
        recoveryInvalidated: true,
        recovery: {
          envelope: setup.envelope,
          recoveryId: setup.recoveryId,
          verifierPublicKey: setup.publicKey,
        },
      };
    });
    await expect(unlockDeviceRecovery(context(rpc), setup.code)).rejects.toThrow(
      'replaced after device revocation',
    );
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(currentAccountKey(SCOPE)).toBeNull();
  });

  it('builds a replacement from merged remote history and clears invalidation only for the new root', async () => {
    provisionAccountKey(SCOPE);
    const oldSetup = createRecoverySetup(SCOPE);
    rotateAccountKey(SCOPE, []);
    const remoteEnvelope = refreshRecoveryEnvelope(SCOPE);
    db.prepare('DELETE FROM sync_keyring WHERE key_version = 2').run();
    invalidateRecoverySecret(SCOPE);
    let acceptedEnvelope: typeof remoteEnvelope | null = null;
    const rpc = vi.fn(async (operation: string, params: unknown) => {
      if (operation === 'security.get') {
        return {
          accountId: SCOPE.accountId,
          configured: true,
          policy: 'require-approval',
          revision: 5,
          trustState: 'trusted',
          recoveryInvalidated: true,
          recovery: {
            envelope: remoteEnvelope,
            recoveryId: oldSetup.recoveryId,
            verifierPublicKey: oldSetup.publicKey,
            revision: 2,
          },
        };
      }
      if (operation === 'security.challenge') {
        const request = params as Record<string, unknown>;
        return {
          challengeId: 'sch_replace_merge_12345678',
          challenge: 'challenge-replace-merge',
          accountId: SCOPE.accountId,
          enrollmentId: ENROLLMENT,
          action: 'updateRecovery',
          accountRevision: 5,
          recoveryRevision: 2,
          recoveryId: oldSetup.recoveryId,
          backendId: SCOPE.backendId,
          identityPub: request.identityPub,
          payloadHash: request.payloadHash,
        };
      }
      if (operation === 'security.updateRecovery') {
        const request = params as { recovery: { envelope: typeof remoteEnvelope } };
        acceptedEnvelope = request.recovery.envelope;
        return {
          accountId: SCOPE.accountId,
          configured: true,
          policy: 'require-approval',
          revision: 6,
          trustState: 'trusted',
          recoveryInvalidated: false,
          recovery: {
            envelope: acceptedEnvelope,
            recoveryId: acceptedEnvelope.recoveryId,
            verifierPublicKey: acceptedEnvelope.publicKey,
            revision: 3,
          },
        };
      }
      throw new Error(`unexpected RPC ${operation}`);
    });

    const result = await replaceDeviceRecovery(context(rpc));
    expect(currentAccountKey(SCOPE)?.version).toBe(2);
    expect(currentRecoveryId(SCOPE)).not.toBe(oldSetup.recoveryId);
    expect(
      (
        db.prepare('SELECT invalidated_at FROM sync_recovery_secrets').get() as {
          invalidated_at: string | null;
        }
      ).invalidated_at,
    ).toBeNull();
    expect(acceptedEnvelope).not.toBeNull();
    const unlocked = prepareRecoveryUnlock(SCOPE, result.recoveryCode, acceptedEnvelope!);
    expect(unlocked.bundle.keys.map((entry) => entry.keyVersion)).toEqual([1, 2]);
  });

  it('preserves the previous recovery root when replacement is rejected', async () => {
    provisionAccountKey(SCOPE);
    const setup = createRecoverySetup(SCOPE);
    const rpc = vi.fn(async (operation: string, params: unknown) => {
      if (operation === 'security.get') {
        return {
          accountId: SCOPE.accountId,
          configured: true,
          policy: 'require-approval',
          revision: 5,
          trustState: 'trusted',
          recovery: {
            envelope: setup.envelope,
            recoveryId: setup.recoveryId,
            verifierPublicKey: setup.publicKey,
          },
        };
      }
      if (operation === 'security.challenge') {
        const request = params as Record<string, unknown>;
        return {
          challengeId: 'sch_replace_12345678',
          challenge: 'challenge-replace',
          accountId: SCOPE.accountId,
          enrollmentId: ENROLLMENT,
          action: 'updateRecovery',
          accountRevision: 5,
          recoveryRevision: 1,
          recoveryId: setup.recoveryId,
          backendId: SCOPE.backendId,
          identityPub: request.identityPub,
          payloadHash: request.payloadHash,
        };
      }
      throw new Error('replacement rejected');
    });
    await expect(replaceDeviceRecovery(context(rpc))).rejects.toThrow('replacement rejected');
    expect(db.prepare('SELECT recovery_id FROM sync_recovery_secrets').get()).toEqual({
      recovery_id: setup.recoveryId,
    });
  });

  it('does not commit a recovered bundle after the session generation changes', async () => {
    provisionAccountKey(SCOPE);
    const setup = createRecoverySetup(SCOPE);
    db.prepare('DELETE FROM sync_keyring').run();
    db.prepare('DELETE FROM sync_recovery_secrets').run();
    let current = true;
    const rpc = vi.fn(async (operation: string, params: unknown) => {
      if (operation === 'security.get') {
        return {
          accountId: SCOPE.accountId,
          configured: true,
          policy: 'auto-trust-authenticated',
          revision: 2,
          trustState: 'pending',
          recovery: {
            envelope: setup.envelope,
            recoveryId: setup.recoveryId,
            verifierPublicKey: setup.publicKey,
          },
        };
      }
      if (operation === 'security.challenge') {
        const request = params as Record<string, unknown>;
        current = false;
        return {
          challengeId: 'sch_stale_12345678',
          challenge: 'challenge-stale',
          accountId: SCOPE.accountId,
          enrollmentId: ENROLLMENT,
          action: 'recover',
          accountRevision: 2,
          recoveryRevision: 1,
          recoveryId: setup.recoveryId,
          backendId: SCOPE.backendId,
          identityPub: request.identityPub,
          payloadHash: request.payloadHash,
        };
      }
      throw new Error(`unexpected RPC ${operation}`);
    });
    const fenced = context(rpc);
    fenced.assertCurrent = () => {
      if (!current) throw new Error('session generation changed');
    };
    await expect(unlockDeviceRecovery(fenced, setup.code)).rejects.toThrow(
      'session generation changed',
    );
    expect(currentAccountKey(SCOPE)).toBeNull();
    expect(db.prepare('SELECT COUNT(*) AS n FROM sync_recovery_secrets').get()).toEqual({ n: 0 });
  });

  it('binds policy changes to the exact mutable request body', async () => {
    provisionAccountKey(SCOPE);
    const setup = createRecoverySetup(SCOPE);
    const calls: Array<{ operation: string; params: unknown }> = [];
    const rpc = vi.fn(async (operation: string, params: unknown) => {
      calls.push({ operation, params });
      if (operation === 'security.get') {
        return {
          accountId: SCOPE.accountId,
          configured: true,
          policy: 'require-approval',
          revision: 4,
          trustState: 'trusted',
          trustSource: 'first-device',
          recovery: { envelope: setup.envelope, verifierPublicKey: setup.publicKey },
        };
      }
      if (operation === 'security.challenge') {
        const request = params as Record<string, unknown>;
        return {
          challengeId: 'sch_policy_12345678',
          challenge: 'challenge-policy',
          accountId: SCOPE.accountId,
          enrollmentId: ENROLLMENT,
          action: 'setPolicy',
          accountRevision: 4,
          recoveryRevision: 1,
          recoveryId: setup.recoveryId,
          backendId: SCOPE.backendId,
          identityPub: request.identityPub,
          payloadHash: request.payloadHash,
        };
      }
      return {};
    });

    await setNewDeviceTrustPolicy(context(rpc), 'auto-trust-authenticated');
    const challenge = calls.find(({ operation }) => operation === 'security.challenge')?.params as {
      payloadHash: string;
    };
    const mutation = calls.find(({ operation }) => operation === 'security.setPolicy')?.params as {
      policy: string;
      revision: number;
      payloadHash: string;
      proof: { payloadHash: string };
    };
    expect(mutation.policy).toBe('auto-trust-authenticated');
    expect(mutation.revision).toBe(4);
    expect(mutation.payloadHash).toBe(challenge.payloadHash);
    expect(mutation.proof.payloadHash).toBe(challenge.payloadHash);
  });
});
