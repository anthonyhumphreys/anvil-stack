import { env, runInDurableObject, SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import { isRpcError } from '../../contract/envelope';
import type {
  ShareCreateResult,
  ShareFinalizeResult,
  ShareListResult,
  ShareRevokeResult,
} from '../../contract/shares';
import { sha256Hex } from '../src/hash';
import { signHostedServiceRequest } from '../src/hosted/service-auth';
import type { SessionCoordinator } from '../src/session-coordinator';
import type { DeviceSession, EnrollmentCodeIssueResult } from '../../contract/auth';
import { expectSuccess, postRpc } from './helpers';

const SERVICE_KEY_ID = 'test';
const SERVICE_SECRET = 'a'.repeat(32);
const SERVICE_AUDIENCE = 'anvil-hosted';
const ADMIN_TOKEN = 'dev-admin-token';

/**
 * share.* requires a live device session — the session object verifies the
 * caller's enrollment row, so spike auth alone is not enough.
 */
async function fixture(label: string) {
  env.ENROLLMENT_ADMIN_TOKEN = ADMIN_TOKEN;
  const accountId = `acct-${label}-${crypto.randomUUID()}`;
  const issued = await SELF.fetch('https://spike.test/v1/enrollment-codes', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${ADMIN_TOKEN}`,
    },
    body: JSON.stringify({ accountId }),
  });
  const { code } = (await issued.json()) as EnrollmentCodeIssueResult;
  const enrolled = await SELF.fetch('https://spike.test/v1/enroll', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      proof: { method: 'enrollment-code', code },
      installationId: `install-${label}`,
      displayName: 'Share test device',
    }),
  });
  const session = (await enrolled.json()) as DeviceSession;
  return {
    accountId,
    enrollmentId: session.enrollmentId,
    auth: `Bearer ${session.accessToken}`,
  };
}

function sessionStub() {
  return env.SESSIONS.get(env.SESSIONS.idFromName('sessions'));
}

async function createShare(
  auth: string,
  params: Record<string, unknown> = {},
): Promise<ShareCreateResult> {
  return expectSuccess<ShareCreateResult>(
    await postRpc(
      'share.create',
      {
        title: 'Design notes',
        mediaType: 'text/markdown',
        byteLength: 4,
        sha256: '0'.repeat(64),
        ...params,
      },
      auth,
    ),
  );
}

async function putShare(path: string, auth: string, body: Uint8Array): Promise<Response> {
  return SELF.fetch(`https://spike.test${path}`, {
    method: 'PUT',
    headers: { Authorization: auth, 'content-type': 'application/octet-stream' },
    body,
  });
}

/** Signed website-channel fetch; returns the raw streamed response. */
async function hostedShareRead(shareId: string): Promise<Response> {
  const payload = new TextEncoder().encode(JSON.stringify({ shareId }));
  const url = 'https://spike.test/internal/hosted/shared-artifact';
  const headers = await signHostedServiceRequest(
    new Request(url, { method: 'POST' }),
    payload,
    { audience: SERVICE_AUDIENCE, keyId: SERVICE_KEY_ID, secret: SERVICE_SECRET },
    Date.now(),
  );
  return SELF.fetch(new Request(url, { method: 'POST', headers, body: payload }));
}

async function publishShare(auth: string, text: string): Promise<ShareFinalizeResult> {
  const body = new TextEncoder().encode(text);
  const sha = await sha256Hex(text);
  const reserved = await createShare(auth, {
    byteLength: body.byteLength,
    sha256: sha,
  });
  const put = await putShare(reserved.uploadPath, auth, body);
  expect(put.status).toBe(200);
  return expectSuccess<ShareFinalizeResult>(
    await postRpc(
      'share.finalize',
      { shareId: reserved.shareId, byteLength: body.byteLength, sha256: sha },
      auth,
    ),
  );
}

describe('shared artifacts', () => {
  it('round-trips create → upload → finalize → hosted read → list', async () => {
    const f = await fixture('share-happy');
    const text = 'shared artifact body ✓';
    const finalized = await publishShare(f.auth, text);

    expect(finalized.share.state).toBe('published');
    expect(finalized.share.title).toBe('Design notes');
    expect(finalized.share.expiresAt).not.toBeNull();

    const read = await hostedShareRead(finalized.share.shareId);
    expect(read.status).toBe(200);
    expect(read.headers.get('content-type')).toBe('text/markdown');
    expect(read.headers.get('x-anvil-share-id')).toBe(finalized.share.shareId);
    expect(decodeURIComponent(read.headers.get('x-anvil-share-title') ?? '')).toBe('Design notes');
    expect(await read.text()).toBe(text);

    const listed = expectSuccess<ShareListResult>(await postRpc('share.list', {}, f.auth));
    const found = listed.shares.find((s) => s.shareId === finalized.share.shareId);
    expect(found?.state).toBe('published');
  });

  it('rejects finalize before upload and size-mismatched uploads', async () => {
    const f = await fixture('share-verify');
    const text = 'verify me';
    const body = new TextEncoder().encode(text);
    const sha = await sha256Hex(text);
    const reserved = await createShare(f.auth, {
      byteLength: body.byteLength,
      sha256: sha,
    });

    const early = await postRpc(
      'share.finalize',
      { shareId: reserved.shareId, byteLength: body.byteLength, sha256: sha },
      f.auth,
    );
    expect(isRpcError(early.body)).toBe(true);
    if (isRpcError(early.body)) {
      expect(early.body.error.details?.['reason']).toBe('share-not-uploaded');
    }

    const short = await putShare(reserved.uploadPath, f.auth, body.slice(0, -1));
    expect(short.status).not.toBe(200);

    const put = await putShare(reserved.uploadPath, f.auth, body);
    expect(put.status).toBe(200);

    const wrong = await postRpc(
      'share.finalize',
      { shareId: reserved.shareId, byteLength: body.byteLength, sha256: '1'.repeat(64) },
      f.auth,
    );
    expect(isRpcError(wrong.body)).toBe(true);
  });

  it('keeps shares account-scoped: other accounts cannot finalize, revoke, or list them', async () => {
    const f = await fixture('share-owner');
    const other = await fixture('share-stranger');
    const finalized = await publishShare(f.auth, 'owner content');

    const foreignFinalize = await postRpc(
      'share.finalize',
      { shareId: finalized.share.shareId, byteLength: 1, sha256: '0'.repeat(64) },
      other.auth,
    );
    expect(isRpcError(foreignFinalize.body)).toBe(true);

    const foreignRevoke = await postRpc(
      'share.revoke',
      { shareId: finalized.share.shareId },
      other.auth,
    );
    expect(isRpcError(foreignRevoke.body)).toBe(true);

    const listed = expectSuccess<ShareListResult>(await postRpc('share.list', {}, other.auth));
    expect(listed.shares.some((s) => s.shareId === finalized.share.shareId)).toBe(false);
  });

  it('revocation immediately breaks the hosted URL', async () => {
    const f = await fixture('share-revoke');
    const finalized = await publishShare(f.auth, 'revocable');

    const before = await hostedShareRead(finalized.share.shareId);
    expect(before.status).toBe(200);
    await before.arrayBuffer();

    const revoked = expectSuccess<ShareRevokeResult>(
      await postRpc('share.revoke', { shareId: finalized.share.shareId }, f.auth),
    );
    expect(revoked.share.state).toBe('revoked');

    const after = await hostedShareRead(finalized.share.shareId);
    expect(after.status).toBe(404);
  });

  it('rejects malformed reservations and oversized byteLength', async () => {
    const f = await fixture('share-malformed');
    const tooBig = await postRpc(
      'share.create',
      {
        title: 'too big',
        mediaType: 'text/plain',
        byteLength: 16 * 1024 * 1024 + 1,
        sha256: '0'.repeat(64),
      },
      f.auth,
    );
    expect(isRpcError(tooBig.body)).toBe(true);

    const badHash = await postRpc(
      'share.create',
      {
        title: 'bad hash',
        mediaType: 'text/plain',
        byteLength: 10,
        sha256: 'not-a-sha',
      },
      f.auth,
    );
    expect(isRpcError(badHash.body)).toBe(true);
  });

  it('persists and serves sealed-share metadata end to end', async () => {
    const f = await fixture('share-sealed');
    // Ciphertext is opaque to the backend; use arbitrary bytes + their hash.
    const ciphertext = new TextEncoder().encode('sealed-blob-not-readable');
    const sha = await sha256Hex('sealed-blob-not-readable');
    const reserved = await createShare(f.auth, {
      byteLength: ciphertext.byteLength,
      sha256: sha,
      sealed: true,
      plaintextBytes: 42,
    });
    const put = await putShare(reserved.uploadPath, f.auth, ciphertext);
    expect(put.status).toBe(200);
    const finalized = expectSuccess<ShareFinalizeResult>(
      await postRpc(
        'share.finalize',
        {
          shareId: reserved.shareId,
          byteLength: ciphertext.byteLength,
          sha256: sha,
          sealed: true,
        },
        f.auth,
      ),
    );
    expect(finalized.share.sealed).toBe(true);
    expect(finalized.share.plaintextBytes).toBe(42);
    expect(finalized.share.byteLength).toBe(ciphertext.byteLength);

    const listed = expectSuccess<ShareListResult>(await postRpc('share.list', {}, f.auth));
    const found = listed.shares.find((s) => s.shareId === finalized.share.shareId);
    expect(found?.sealed).toBe(true);
    expect(found?.plaintextBytes).toBe(42);

    // The website channel gets ciphertext plus the seal manifest headers —
    // the decryption key is never part of this exchange.
    const read = await hostedShareRead(finalized.share.shareId);
    expect(read.status).toBe(200);
    expect(read.headers.get('x-anvil-share-sealed')).toBe('1');
    expect(read.headers.get('x-anvil-share-sha256')).toBe(sha);
    expect(read.headers.get('x-anvil-share-plaintext-bytes')).toBe('42');
    expect(await read.text()).toBe('sealed-blob-not-readable');
  });

  it('rejects a finalize whose seal manifest disagrees with the reservation', async () => {
    const f = await fixture('share-sealed-mismatch');
    const ciphertext = new TextEncoder().encode('blob');
    const sha = await sha256Hex('blob');
    const reserved = await createShare(f.auth, {
      byteLength: ciphertext.byteLength,
      sha256: sha,
      sealed: true,
      plaintextBytes: 10,
    });
    const put = await putShare(reserved.uploadPath, f.auth, ciphertext);
    expect(put.status).toBe(200);
    const mismatch = await postRpc(
      'share.finalize',
      {
        shareId: reserved.shareId,
        byteLength: ciphertext.byteLength,
        sha256: sha,
        sealed: false,
      },
      f.auth,
    );
    expect(isRpcError(mismatch.body)).toBe(true);
    if (isRpcError(mismatch.body)) {
      expect(mismatch.body.error.details?.['reason']).toBe('manifest-mismatch');
    }
  });

  it('rejects malformed seal metadata on create', async () => {
    const f = await fixture('share-sealed-malformed');
    const bad = await postRpc(
      'share.create',
      {
        title: 'bad seal',
        mediaType: 'text/plain',
        byteLength: 4,
        sha256: '0'.repeat(64),
        sealed: 'yes',
      },
      f.auth,
    );
    expect(bad.status).toBe(400);
  });

  it('expires overdue upload reservations during the sweep', async () => {
    const f = await fixture('share-sweep');
    const reserved = await createShare(f.auth, { byteLength: 8 });

    // Backdate the reservation deadline, then drive the sweep directly on
    // the session object — the same path the alarm takes.
    await runInDurableObject(sessionStub(), async (instance: SessionCoordinator, state) => {
      state.storage.sql.exec(
        'UPDATE shared_artifacts SET upload_expires_at = 1 WHERE share_id = ?',
        reserved.shareId,
      );
      await instance.fetch(
        new Request('https://internal.anvil/internal/sweep', { method: 'POST' }),
      );
      const row = state.storage.sql
        .exec('SELECT state FROM shared_artifacts WHERE share_id = ?', reserved.shareId)
        .toArray()[0] as { state: string } | undefined;
      expect(row?.state).toBe('expired');
    });
  });
});
