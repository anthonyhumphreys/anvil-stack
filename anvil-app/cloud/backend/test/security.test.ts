import { env, SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import type { DeviceSession, EnrollmentCodeIssueResult } from '../../contract/auth';
import { canonicalizeJson } from '../../contract/sync';
import { recoveryRequestBindingBytes } from '../../contract/device-security';
import { isRpcError, type RpcResponse } from '../../contract/envelope';
import { encodeBase64Url } from '../src/device-security';
import { expectSuccess, postRpc } from './helpers';

const ADMIN_TOKEN = 'security-test-admin';

async function issueCode(accountId: string, options: Record<string, unknown> = {}) {
  env.ENROLLMENT_ADMIN_TOKEN = ADMIN_TOKEN;
  const response = await SELF.fetch('https://spike.test/v1/enrollment-codes', {
    method: 'POST',
    headers: { Authorization: `Bearer ${ADMIN_TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({ accountId, ...options }),
  });
  expect(response.status).toBe(200);
  return (await response.json()) as EnrollmentCodeIssueResult;
}

async function enroll(code: string, installationId: string): Promise<DeviceSession> {
  const response = await SELF.fetch('https://spike.test/v1/enroll', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      proof: { method: 'enrollment-code', code },
      installationId,
    }),
  });
  expect(response.status).toBe(200);
  return (await response.json()) as DeviceSession;
}

function bearer(session: DeviceSession): string {
  return `Bearer ${session.accessToken}`;
}

function standardBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

async function ed25519Material(): Promise<{
  publicKey: string;
  sign: (message: Uint8Array) => Promise<string>;
}> {
  const pair = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, [
    'sign',
    'verify',
  ])) as CryptoKeyPair;
  const publicRaw = (await crypto.subtle.exportKey('raw', pair.publicKey)) as ArrayBuffer;
  const publicKey = encodeBase64Url(new Uint8Array(publicRaw));
  return {
    publicKey,
    sign: async (message) =>
      encodeBase64Url(new Uint8Array(await crypto.subtle.sign({ name: 'Ed25519' }, pair.privateKey, message))),
  };
}

function recoveryEnvelope(publicKey: string) {
  return {
    v: 1,
    algorithm: 'aes-256-gcm',
    recoveryId: crypto.randomUUID(),
    publicKey,
    nonce: standardBase64(crypto.getRandomValues(new Uint8Array(12))),
    ct: standardBase64(crypto.getRandomValues(new Uint8Array(32))),
  } as const;
}

async function payloadHash(payload: unknown): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(canonicalizeJson(payload)),
  );
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function signedProof(
  session: DeviceSession,
  action: string,
  material: Awaited<ReturnType<typeof ed25519Material>>,
  binding: { payloadHash: string; backendId: string; identityPub: string },
): Promise<{ challengeId: string; identityPub: string; payloadHash: string; signature: string }> {
  const challengeResponse = await postRpc(
    'security.challenge',
    { action, payloadHash: binding.payloadHash, backendId: binding.backendId, identityPub: binding.identityPub },
    bearer(session),
  );
  const challenge = expectSuccess<{
    challengeId: string;
    challenge: string;
    accountId: string;
    enrollmentId: string;
    action: string;
    accountRevision: number;
    recoveryRevision: number;
    recoveryId: string;
    backendId: string;
    identityPub: string;
    payloadHash: string;
  }>(challengeResponse);
  const message = recoveryRequestBindingBytes({
    action: challenge.action,
    accountId: challenge.accountId,
    backendId: challenge.backendId,
    enrollmentId: challenge.enrollmentId,
    identityPub: challenge.identityPub,
    recoveryId: challenge.recoveryId,
    revision: challenge.accountRevision,
    challenge: challenge.challenge,
    payloadHash: challenge.payloadHash,
  });
  return {
    challengeId: challenge.challengeId,
    identityPub: challenge.identityPub,
    payloadHash: challenge.payloadHash,
    signature: await material.sign(message),
  };
}

describe('account security policy and recovery', () => {
  it('defaults to approval, bootstraps once, and keeps code enrollments pending', async () => {
    const accountId = `acct-security-${crypto.randomUUID()}`;
    const first = await enroll((await issueCode(accountId)).code, 'security-first');
    const initial = expectSuccess<Record<string, unknown>>(
      await postRpc('security.get', {}, bearer(first)),
    );
    expect(initial.policy).toBe('require-approval');
    expect(initial.recoveryConfigured).toBe(false);

    const recovery = await ed25519Material();
    const envelope = recoveryEnvelope(recovery.publicKey);
    const backendId = `backend-${crypto.randomUUID()}`;
    const configured = expectSuccess<Record<string, unknown>>(
      await postRpc(
        'security.configure',
        {
          backendId,
          envelope,
        },
        bearer(first),
      ),
    );
    expect(configured.recoveryConfigured).toBe(true);
    expect(JSON.stringify(configured)).not.toContain('recovery-secret');

    const second = await enroll((await issueCode(accountId)).code, 'security-second');
    const after = expectSuccess<{ enrollments: Array<{ enrollmentId: string; trustState: string }> }>(
      await postRpc('security.get', {}, bearer(first)),
    );
    expect(after.enrollments.find((row) => row.enrollmentId === second.enrollmentId)?.trustState).toBe(
      'pending',
    );
  });

  it('uses a one-use, revision-bound Ed25519 proof for policy changes', async () => {
    const accountId = `acct-security-${crypto.randomUUID()}`;
    const first = await enroll((await issueCode(accountId)).code, 'security-policy');
    const material = await ed25519Material();
    const envelope = recoveryEnvelope(material.publicKey);
    const backendId = `backend-${crypto.randomUUID()}`;
    expectSuccess<Record<string, unknown>>(
      await postRpc(
        'security.configure',
        {
          backendId,
          envelope,
        },
        bearer(first),
      ),
    );
    const requestedPolicy = 'auto-trust-authenticated';
    const revision = 2;
    const mutationHash = await payloadHash({ policy: requestedPolicy, revision });
    const proof = await signedProof(first, 'setPolicy', material, {
      payloadHash: mutationHash,
      backendId,
      identityPub: encodeBase64Url(crypto.getRandomValues(new Uint8Array(32))),
    });
    const changed = expectSuccess<Record<string, unknown>>(
      await postRpc(
        'security.setPolicy',
        { policy: requestedPolicy, revision, payloadHash: mutationHash, proof },
        bearer(first),
      ),
    );
    expect(changed.policy).toBe('auto-trust-authenticated');
    expect(
      (changed['recentEvents'] as Array<Record<string, unknown>>).find(
        (event) => event.kind === 'policy-changed',
      ),
    ).toMatchObject({
      source: 'recovery',
      outcome: 'accepted:auto-trust-authenticated',
    });
    const replay = await postRpc(
      'security.setPolicy',
      { policy: 'require-approval', revision: 3, payloadHash: mutationHash, proof },
      bearer(first),
    );
    expect(replay.status).toBe(401);
  });

  it('keeps revoked trust revoked and reset fences the account', async () => {
    const accountId = `acct-security-${crypto.randomUUID()}`;
    const first = await enroll((await issueCode(accountId)).code, 'security-revoke');
    const second = await enroll((await issueCode(accountId)).code, 'security-revoked');
    const revoked = await postRpc(
      'device.revoke',
      { enrollmentId: second.enrollmentId },
      bearer(first),
    );
    expect(revoked.status).toBe(200);
    const roster = expectSuccess<{ enrollments: Array<{ enrollmentId: string; trustState: string }> }>(
      await postRpc('security.get', {}, bearer(first)),
    );
    expect(roster.enrollments.find((row) => row.enrollmentId === second.enrollmentId)?.trustState).toBe(
      'revoked',
    );
    const reset = await postRpc(
      'security.reset',
      { confirmation: 'RESET ENCRYPTED DATA' },
      bearer(first),
    );
    expect(reset.status).toBe(200);
    expect((reset.body as { result?: { reauthRequired?: boolean } }).result?.reauthRequired).toBe(true);
    const stale = await postRpc('security.get', {}, bearer(first));
    expect(stale.status).toBe(401);
  });

  it('records explicit manual approval without treating code issuance as pairing', async () => {
    const accountId = `acct-security-${crypto.randomUUID()}`;
    const first = await enroll((await issueCode(accountId)).code, 'security-approval-first');
    const second = await enroll((await issueCode(accountId)).code, 'security-approval-second');
    const pending = expectSuccess<{
      enrollments: Array<{ enrollmentId: string; trustState: string; trustSource: string }>;
    }>(await postRpc('security.get', {}, bearer(first)));
    expect(pending.enrollments.find((entry) => entry.enrollmentId === second.enrollmentId)).toMatchObject({
      trustState: 'pending',
      trustSource: 'unknown',
    });
    const approved = expectSuccess<{
      enrollments: Array<{ enrollmentId: string; trustState: string; trustSource: string }>;
    }>(
      await postRpc(
        'security.approve',
        { enrollmentId: second.enrollmentId, source: 'manual-approval' },
        bearer(first),
      ),
    );
    expect(approved.enrollments.find((entry) => entry.enrollmentId === second.enrollmentId)).toMatchObject({
      trustState: 'trusted',
      trustSource: 'manual-approval',
    });
    expect(
      ((approved as unknown as { recentEvents: Array<Record<string, unknown>> }).recentEvents).find(
        (event) => event.kind === 'device-approved',
      ),
    ).toMatchObject({ source: 'manual-approval', outcome: 'accepted' });
  });

  it('verifies the shared recovery binding and returns only the opaque envelope', async () => {
    const accountId = `acct-security-${crypto.randomUUID()}`;
    const first = await enroll((await issueCode(accountId)).code, 'security-binding');
    const material = await ed25519Material();
    const backendId = `backend-${crypto.randomUUID()}`;
    const envelope = recoveryEnvelope(material.publicKey);
    const configured = expectSuccess<Record<string, unknown>>(
      await postRpc('security.configure', { policy: 'require-approval', backendId, envelope }, bearer(first)),
    );
    expect(configured.recoveryEnvelope).toEqual(envelope);
    const second = await enroll((await issueCode(accountId)).code, 'security-binding-pending');
    const identityPub = encodeBase64Url(crypto.getRandomValues(new Uint8Array(32)));
    const challenge = expectSuccess<{
      challengeId: string;
      challenge: string;
      accountId: string;
      enrollmentId: string;
      accountRevision: number;
      recoveryId: string;
      backendId: string;
      identityPub: string;
      payloadHash: string;
    }>(
      await postRpc(
        'security.challenge',
        { action: 'recover', backendId, identityPub, payloadHash: await payloadHash({}) },
        bearer(second),
      ),
    );
    const signature = await material.sign(
      recoveryRequestBindingBytes({
        action: 'recover',
        accountId: challenge.accountId,
        backendId: challenge.backendId,
        enrollmentId: challenge.enrollmentId,
        identityPub: challenge.identityPub,
        recoveryId: challenge.recoveryId,
        revision: challenge.accountRevision,
        challenge: challenge.challenge,
        payloadHash: challenge.payloadHash,
      }),
    );
    const recovered = expectSuccess<{ recovered: boolean }>(
      await postRpc(
        'security.recover',
        { payloadHash: challenge.payloadHash, proof: { challengeId: challenge.challengeId, identityPub, payloadHash: challenge.payloadHash, signature } },
        bearer(second),
      ),
    );
    expect(recovered.recovered).toBe(true);
  });

  it('invalidates recovery for any trusted-device revocation and permits fresh setup', async () => {
    const accountId = `acct-security-${crypto.randomUUID()}`;
    const first = await enroll((await issueCode(accountId)).code, 'security-invalidation-first');
    const material = await ed25519Material();
    const backendId = `backend-${crypto.randomUUID()}`;
    const envelope = recoveryEnvelope(material.publicKey);
    expectSuccess<Record<string, unknown>>(
      await postRpc('security.configure', { backendId, envelope }, bearer(first)),
    );
    const second = await enroll((await issueCode(accountId)).code, 'security-invalidation-second');
    const identityPub = encodeBase64Url(crypto.getRandomValues(new Uint8Array(32)));
    const recoveryHash = await payloadHash({});
    const proof = await signedProof(second, 'recover', material, {
      payloadHash: recoveryHash,
      backendId,
      identityPub,
    });
    expectSuccess<{ recovered: boolean }>(
      await postRpc(
        'security.recover',
        { payloadHash: recoveryHash, proof },
        bearer(second),
      ),
    );
    expect(
      (await postRpc('device.revoke', { enrollmentId: second.enrollmentId }, bearer(first))).status,
    ).toBe(200);
    const afterRevoke = expectSuccess<Record<string, unknown>>(
      await postRpc('security.get', {}, bearer(first)),
    );
    expect(afterRevoke.recoveryConfigured).toBe(true);
    expect(afterRevoke.recoveryInvalidated).toBe(true);
    const pending = await enroll((await issueCode(accountId)).code, 'security-invalidation-pending');
    const staleRecovery = await postRpc(
      'security.challenge',
      {
        action: 'recover',
        backendId,
        identityPub: encodeBase64Url(crypto.getRandomValues(new Uint8Array(32))),
        payloadHash: await payloadHash({}),
      },
      bearer(pending),
    );
    expect(staleRecovery.status).toBe(409);
    const fresh = await ed25519Material();
    const freshEnvelope = recoveryEnvelope(fresh.publicKey);
    const replacementRevision = Number(afterRevoke.revision);
    const replacementBody = { backendId, envelope: freshEnvelope, revision: replacementRevision };
    const replacementHash = await payloadHash(replacementBody);
    const replacementProof = await signedProof(first, 'updateRecovery', material, {
      payloadHash: replacementHash,
      backendId,
      identityPub: encodeBase64Url(crypto.getRandomValues(new Uint8Array(32))),
    });
    const replaced = expectSuccess<Record<string, unknown>>(
      await postRpc(
        'security.updateRecovery',
        { ...replacementBody, payloadHash: replacementHash, proof: replacementProof },
        bearer(first),
      ),
    );
    expect(replaced.recoveryConfigured).toBe(true);
    expect(replaced.recoveryEnvelope).toEqual(freshEnvelope);
  });
});
