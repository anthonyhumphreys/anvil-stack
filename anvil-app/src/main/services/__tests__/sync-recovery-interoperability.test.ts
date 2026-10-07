import { createPrivateKey, createPublicKey, randomBytes, randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { RecoveryRequestBinding } from '../../../../cloud/contract/device-security';
// Load the Worker module at runtime: its compiler project uses Cloudflare's
// WebCrypto types, while this integration test runs the actual desktop crypto.
const workerVerifierPath = '../../../../cloud/backend/src/device-security.ts';
const { parseSecurityProof, verifySecurityProof } = await import(workerVerifierPath);

vi.mock('../sync-keyring.service.js', () => ({}));
import {
  deriveRecoverySigningSeed,
  recoveryPayloadHash,
  signRecoveryRequest,
} from '../sync-recovery.service';

describe('desktop recovery proof / Worker interoperability', () => {
  it('verifies the client-derived signature with the Worker verifier and binds every field', async () => {
    const secret = randomBytes(32);
    const recoveryId = randomUUID();
    const privateKey = createPrivateKey({
      key: Buffer.concat([
        Buffer.from('302e020100300506032b657004220420', 'hex'),
        deriveRecoverySigningSeed(secret, recoveryId),
      ]),
      format: 'der',
      type: 'pkcs8',
    });
    const publicKey = createPublicKey(privateKey)
      .export({ format: 'der', type: 'spki' })
      .subarray(-32)
      .toString('base64url');
    const binding: RecoveryRequestBinding = {
      action: 'setPolicy',
      accountId: 'account-interoperability',
      backendId: 'backend-interoperability',
      enrollmentId: 'enrollment-interoperability',
      identityPub: randomBytes(32).toString('base64'),
      recoveryId,
      revision: 7,
      challenge: randomBytes(32).toString('base64url'),
      payloadHash: recoveryPayloadHash({ policy: 'require-approval', revision: 7 }),
    };
    const row = {
      challenge_id: randomUUID(),
      account_id: binding.accountId,
      enrollment_id: binding.enrollmentId,
      action: 'setPolicy',
      account_revision: binding.revision,
      recovery_revision: 3,
      challenge: binding.challenge,
      expected_public_key: publicKey,
      recovery_id: recoveryId,
      backend_id: binding.backendId,
      identity_pub: binding.identityPub,
      payload_hash: binding.payloadHash,
      expires_at: Date.now() + 60_000,
      used_at: null,
      created_at: Date.now(),
    };
    const proof = {
      challengeId: row.challenge_id,
      signature: signRecoveryRequest(binding, secret),
      identityPub: binding.identityPub,
      payloadHash: binding.payloadHash,
    };
    expect(parseSecurityProof(proof)).toEqual(proof);
    expect(parseSecurityProof({ ...proof, publicKey })).toBeNull();
    expect(await verifySecurityProof(row, parseSecurityProof(proof))).toBe(true);
    for (const field of [
      'account_id',
      'enrollment_id',
      'action',
      'account_revision',
      'challenge',
      'recovery_id',
      'backend_id',
      'identity_pub',
      'payload_hash',
    ] as const) {
      const altered = { ...row, [field]: field === 'account_revision' ? 8 : 'changed' };
      expect(await verifySecurityProof(altered, proof), field).toBe(false);
    }
    expect(await verifySecurityProof({ ...row, used_at: Date.now() }, proof)).toBe(false);
    expect(await verifySecurityProof({ ...row, expires_at: Date.now() - 1 }, proof)).toBe(false);
    expect(await verifySecurityProof(row, { ...proof, challengeId: randomUUID() })).toBe(false);
    expect(
      await verifySecurityProof(row, {
        ...proof,
        signature: signRecoveryRequest(binding, randomBytes(32)),
      }),
    ).toBe(false);
  });

  it('hashes the canonical mutation, including policy and envelope changes', () => {
    expect(recoveryPayloadHash({ revision: 2, policy: 'require-approval' })).toBe(
      recoveryPayloadHash({ policy: 'require-approval', revision: 2 }),
    );
    expect(recoveryPayloadHash({ policy: 'require-approval' })).not.toBe(
      recoveryPayloadHash({ policy: 'auto-trust-authenticated' }),
    );
    expect(recoveryPayloadHash({ recovery: { ct: 'one' } })).not.toBe(
      recoveryPayloadHash({ recovery: { ct: 'two' } }),
    );
  });
});
