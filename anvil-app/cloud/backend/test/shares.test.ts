import { env, runInDurableObject, SELF } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';

import { isRpcError } from '../../contract/envelope';
import type {
  ShareCreateResult,
  ShareFinalizeResult,
  ShareListResult,
  ShareRevokeResult,
  ShareUpdateResult,
} from '../../contract/shares';
import { sha256Hex } from '../src/hash';
import { PREVIEW_END_MS } from '../src/hosted/policy';
import { signHostedServiceRequest } from '../src/hosted/service-auth';
import type { SessionCoordinator } from '../src/session-coordinator';
import type { DeviceSession, EnrollmentCodeIssueResult } from '../../contract/auth';
import { expectSuccess, postRpc, withSelfHostedBackend } from './helpers';

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
  const issued = await withSelfHostedBackend(() => SELF.fetch('https://spike.test/v1/enrollment-codes', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${ADMIN_TOKEN}`,
    },
    body: JSON.stringify({ accountId }),
  }));
  const { code } = (await issued.json()) as EnrollmentCodeIssueResult;
  const enrolled = await withSelfHostedBackend(() => SELF.fetch('https://spike.test/v1/enroll', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      proof: { method: 'enrollment-code', code },
      installationId: `install-${label}`,
      displayName: 'Share test device',
    }),
  }));
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
  it('allows share creation after preview expiry without a subscription', async () => {
    const dateNow = vi.spyOn(Date, 'now').mockReturnValue(PREVIEW_END_MS + 1);
    try {
      const f = await fixture('share-free-after-preview');
      const reserved = await createShare(f.auth);
      expect(reserved.shareId).toMatch(/^shr_[0-9a-f-]{36}$/i);
      expect(reserved.uploadPath).toMatch(/^\/v1\/shared\//);
    } finally {
      dateNow.mockRestore();
    }
  });

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
  describe('share.update (stable links)', () => {
    async function updateShare(
      auth: string,
      shareId: string,
      text: string,
      extra: Record<string, unknown> = {},
    ) {
      const body = new TextEncoder().encode(text);
      const sha = await sha256Hex(text);
      const response = await postRpc(
        'share.update',
        { shareId, byteLength: body.byteLength, sha256: sha, ...extra },
        auth,
      );
      return { response, body, sha };
    }

    it('swaps bytes under the same share id only after finalize verifies them', async () => {
      const f = await fixture('share-update-happy');
      const published = await publishShare(f.auth, 'version one');
      const shareId = published.share.shareId;
      expect(published.share.version).toBe(1);
      expect(published.share.updatedAt).toBeNull();

      const { response, body, sha } = await updateShare(f.auth, shareId, 'version two, longer');
      const reserved = expectSuccess<ShareUpdateResult>(response);
      expect(reserved.uploadPath).toBe(`/v1/shared/${shareId}`);
      expect(Date.parse(reserved.expiresAt)).toBeGreaterThan(Date.now());

      // Reserved but not uploaded: readers still get the published bytes.
      const beforeUpload = await hostedShareRead(shareId);
      expect(await beforeUpload.text()).toBe('version one');

      const put = await putShare(reserved.uploadPath, f.auth, body);
      expect(put.status).toBe(200);

      // Uploaded but not finalized: still the published bytes.
      const beforeFinalize = await hostedShareRead(shareId);
      expect(beforeFinalize.headers.get('x-anvil-share-version')).toBe('1');
      expect(await beforeFinalize.text()).toBe('version one');

      const finalized = expectSuccess<ShareFinalizeResult>(
        await postRpc('share.finalize', { shareId, byteLength: body.byteLength, sha256: sha }, f.auth),
      );
      expect(finalized.share.shareId).toBe(shareId);
      expect(finalized.share.state).toBe('published');
      expect(finalized.share.version).toBe(2);
      expect(finalized.share.updatedAt).not.toBeNull();
      expect(finalized.share.sha256).toBe(sha);
      expect(finalized.share.byteLength).toBe(body.byteLength);
      expect(finalized.share.expiresAt).toBe(published.share.expiresAt);

      const after = await hostedShareRead(shareId);
      expect(after.status).toBe(200);
      expect(after.headers.get('x-anvil-share-version')).toBe('2');
      expect(after.headers.get('x-anvil-share-updated-at')).toBe(finalized.share.updatedAt);
      expect(await after.text()).toBe('version two, longer');

      const listed = expectSuccess<ShareListResult>(await postRpc('share.list', {}, f.auth));
      expect(listed.shares.find((s) => s.shareId === shareId)?.version).toBe(2);
    });

    it('keeps the published bytes when the replacement fails verification', async () => {
      const f = await fixture('share-update-checksum');
      const published = await publishShare(f.auth, 'original');
      const shareId = published.share.shareId;
      const declared = await updateShare(f.auth, shareId, 'replaced');
      const reserved = expectSuccess<ShareUpdateResult>(declared.response);
      // Same length, different bytes: the stored digest will not match.
      const put = await putShare(reserved.uploadPath, f.auth, new TextEncoder().encode('tampered'));
      expect(put.status).toBe(200);
      const finalize = await postRpc(
        'share.finalize',
        { shareId, byteLength: declared.body.byteLength, sha256: declared.sha },
        f.auth,
      );
      expect(isRpcError(finalize.body)).toBe(true);
      if (isRpcError(finalize.body)) {
        expect(finalize.body.error.details?.['reason']).toBe('checksum-mismatch');
      }
      const read = await hostedShareRead(shareId);
      expect(read.status).toBe(200);
      expect(read.headers.get('x-anvil-share-version')).toBe('1');
      expect(await read.text()).toBe('original');

      // The failed attempt left nothing pending; a fresh update still works.
      const retry = await updateShare(f.auth, shareId, 'replaced');
      expectSuccess<ShareUpdateResult>(retry.response);
    });

    it('rejects finalize manifests that disagree with the update reservation', async () => {
      const f = await fixture('share-update-manifest');
      const published = await publishShare(f.auth, 'first');
      const shareId = published.share.shareId;
      const declared = await updateShare(f.auth, shareId, 'second!');
      const reserved = expectSuccess<ShareUpdateResult>(declared.response);
      expect((await putShare(reserved.uploadPath, f.auth, declared.body)).status).toBe(200);
      const wrong = await postRpc(
        'share.finalize',
        { shareId, byteLength: declared.body.byteLength, sha256: '1'.repeat(64) },
        f.auth,
      );
      expect(isRpcError(wrong.body)).toBe(true);
      if (isRpcError(wrong.body)) {
        expect(wrong.body.error.details?.['reason']).toBe('manifest-mismatch');
      }
      const short = await putShare(reserved.uploadPath, f.auth, declared.body.slice(0, -1));
      expect(short.status).not.toBe(200);
    });

    it('only updates published shares owned by the caller', async () => {
      const f = await fixture('share-update-state');
      const other = await fixture('share-update-stranger');

      const reservedOnly = await createShare(f.auth, { byteLength: 4 });
      const notPublished = await updateShare(f.auth, reservedOnly.shareId, 'next');
      expect(isRpcError(notPublished.response.body)).toBe(true);
      if (isRpcError(notPublished.response.body)) {
        expect(notPublished.response.body.error.code).toBe('conflict');
        expect(notPublished.response.body.error.details?.['reason']).toBe('share-state');
      }

      const published = await publishShare(f.auth, 'owned');
      const foreign = await updateShare(other.auth, published.share.shareId, 'hijack');
      expect(isRpcError(foreign.response.body)).toBe(true);
      if (isRpcError(foreign.response.body)) {
        expect(foreign.response.body.error.code).toBe('not-found');
      }

      expectSuccess<ShareRevokeResult>(
        await postRpc('share.revoke', { shareId: published.share.shareId }, f.auth),
      );
      const revoked = await updateShare(f.auth, published.share.shareId, 'too late');
      expect(isRpcError(revoked.response.body)).toBe(true);
      if (isRpcError(revoked.response.body)) {
        expect(revoked.response.body.error.details?.['reason']).toBe('share-state');
      }
    });

    it('cannot change the protection class and rejects malformed params', async () => {
      const f = await fixture('share-update-sealed');
      const published = await publishShare(f.auth, 'plain share');
      const flip = await updateShare(f.auth, published.share.shareId, 'sealed now', {
        sealed: true,
      });
      expect(isRpcError(flip.response.body)).toBe(true);
      if (isRpcError(flip.response.body)) {
        expect(flip.response.body.error.details?.['reason']).toBe('manifest-mismatch');
      }
      const malformed = await postRpc(
        'share.update',
        { shareId: published.share.shareId, byteLength: 0, sha256: 'nope' },
        f.auth,
      );
      expect(isRpcError(malformed.body)).toBe(true);
    });

    it('revoking a share with a pending update drops the staged bytes', async () => {
      const f = await fixture('share-update-revoke');
      const published = await publishShare(f.auth, 'live');
      const shareId = published.share.shareId;
      const declared = await updateShare(f.auth, shareId, 'staged');
      const reserved = expectSuccess<ShareUpdateResult>(declared.response);
      expect((await putShare(reserved.uploadPath, f.auth, declared.body)).status).toBe(200);
      expectSuccess<ShareRevokeResult>(await postRpc('share.revoke', { shareId }, f.auth));
      const read = await hostedShareRead(shareId);
      expect(read.status).toBe(404);
      await runInDurableObject(sessionStub(), async (_instance: SessionCoordinator, state) => {
        const row = state.storage.sql
          .exec('SELECT pending_r2_key FROM shared_artifacts WHERE share_id = ?', shareId)
          .toArray()[0] as { pending_r2_key: string | null } | undefined;
        expect(row?.pending_r2_key).toBeNull();
      });
    });
  });
});
