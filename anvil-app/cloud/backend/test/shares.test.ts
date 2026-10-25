import { env, runInDurableObject, SELF } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';

import { isRpcError } from '../../contract/envelope';
import type {
  ShareAudience,
  ShareAudiencesResult,
  ShareCreateResult,
  ShareFinalizeResult,
  ShareListResult,
  ShareRevokeResult,
  ShareUpdateResult,
} from '../../contract/shares';
import { sha256Hex } from '../src/hash';
import { PREVIEW_END_MS } from '../src/hosted/policy';
import { signHostedServiceRequest } from '../src/hosted/service-auth';
import { SessionCoordinator } from '../src/session-coordinator';
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
  const issued = await withSelfHostedBackend(() =>
    SELF.fetch('https://spike.test/v1/enrollment-codes', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${ADMIN_TOKEN}`,
      },
      body: JSON.stringify({ accountId }),
    }),
  );
  const { code } = (await issued.json()) as EnrollmentCodeIssueResult;
  const enrolled = await withSelfHostedBackend(() =>
    SELF.fetch('https://spike.test/v1/enroll', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        proof: { method: 'enrollment-code', code },
        installationId: `install-${label}`,
        displayName: 'Share test device',
      }),
    }),
  );
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
async function hostedShareRead(
  shareId: string,
  identity?: { workosClientId: string; workosUserId: string },
): Promise<Response> {
  const payload = new TextEncoder().encode(JSON.stringify({ shareId, identity }));
  const url = 'https://spike.test/internal/hosted/shared-artifact';
  const headers = await signHostedServiceRequest(
    new Request(url, { method: 'POST' }),
    payload,
    { audience: SERVICE_AUDIENCE, keyId: SERVICE_KEY_ID, secret: SERVICE_SECRET },
    Date.now(),
  );
  return SELF.fetch(new Request(url, { method: 'POST', headers, body: payload }));
}

async function publishShare(
  auth: string,
  text: string,
  audience?: ShareAudience,
): Promise<ShareFinalizeResult> {
  const body = new TextEncoder().encode(text);
  const sha = await sha256Hex(text);
  const reserved = await createShare(auth, {
    byteLength: body.byteLength,
    sha256: sha,
    ...(audience === undefined ? {} : { audience }),
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
        await postRpc(
          'share.finalize',
          { shareId, byteLength: body.byteLength, sha256: sha },
          f.auth,
        ),
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

// Organization access uses local membership, with no subscription or paid seat.
async function organizationFixture() {
  const db = env.HOSTED_DB!;
  const author = await fixture('org-author');
  const member = await fixture('org-member');
  const outsider = await fixture('org-outsider');
  const pending = await fixture('org-pending');
  const clientId = 'client_hosted_test';
  const organizationId = `anvil_org_${crypto.randomUUID()}`;
  const now = Date.now();
  const identities = new Map<string, { workosClientId: string; workosUserId: string }>();
  const billingIds = new Map<string, string>();
  for (const user of [author, member, outsider, pending]) {
    const userId = `user_${crypto.randomUUID()}`;
    const billingId = `bill_${crypto.randomUUID()}`;
    identities.set(user.accountId, { workosClientId: clientId, workosUserId: userId });
    billingIds.set(user.accountId, billingId);
    await db
      .prepare(
        `INSERT INTO billing_accounts (id, workos_client_id, workos_user_id, sync_account_id,
       generation, lifecycle, created_at, updated_at) VALUES (?, ?, ?, ?, 1, 'active', ?, ?)`,
      )
      .bind(billingId, clientId, userId, user.accountId, now, now)
      .run();
  }
  await db
    .prepare(
      `INSERT INTO hosted_organizations (id, idempotency_key, workos_organization_id, name,
     status, created_by_workos_user_id, created_at, updated_at)
     VALUES (?, ?, ?, 'Share team', 'active', ?, ?, ?)`,
    )
    .bind(
      organizationId,
      crypto.randomUUID(),
      `org_${crypto.randomUUID()}`,
      identities.get(author.accountId)!.workosUserId,
      now,
      now,
    )
    .run();
  for (const user of [author, member]) {
    await db
      .prepare(
        `INSERT INTO hosted_organization_memberships (organization_id, billing_account_id,
       workos_client_id, workos_user_id, email, role, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'member', 'active', ?, ?)`,
      )
      .bind(
        organizationId,
        billingIds.get(user.accountId),
        clientId,
        identities.get(user.accountId)!.workosUserId,
        'member@example.test',
        now,
        now,
      )
      .run();
  }
  await db
    .prepare(
      `INSERT INTO hosted_organization_invitations (id, organization_id, target_billing_account_id,
     target_workos_user_id, email, invited_by_workos_user_id, state, expires_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'pending@example.test', ?, 'pending', ?, ?, ?)`,
    )
    .bind(
      `inv_${crypto.randomUUID()}`,
      organizationId,
      billingIds.get(pending.accountId),
      identities.get(pending.accountId)!.workosUserId,
      identities.get(author.accountId)!.workosUserId,
      now + 86_400_000,
      now,
      now,
    )
    .run();
  const audience: ShareAudience = { kind: 'organization', organizationId };
  return {
    db,
    author,
    member,
    outsider,
    pending,
    organizationId,
    audience,
    identity: (user: { accountId: string }) => identities.get(user.accountId)!,
    remove: async (user: { accountId: string }) =>
      db
        .prepare(
          `UPDATE hosted_organization_memberships SET status = 'inactive', workos_sync_status = 'pending'
       WHERE organization_id = ? AND billing_account_id = ?`,
        )
        .bind(organizationId, billingIds.get(user.accountId))
        .run(),
    disable: async (user: { accountId: string }) =>
      db
        .prepare(`UPDATE billing_accounts SET lifecycle = 'deleting' WHERE id = ?`)
        .bind(billingIds.get(user.accountId))
        .run(),
  };
}

async function expectPrivateDenial(response: Response, status: number, code: string) {
  expect(response.status).toBe(status);
  expect(response.headers.get('cache-control')).toBe('private, no-store');
  for (const header of [
    'x-anvil-share-title',
    'x-anvil-share-id',
    'x-anvil-share-state',
    'x-anvil-share-audience',
    'x-anvil-share-sha256',
  ]) {
    expect(response.headers.has(header)).toBe(false);
  }
  const body = (await response.json()) as { error: { code: string; details?: unknown } };
  expect(body.error.code).toBe(code);
  expect(body.error.details).toBeUndefined();
}

describe('organization share audiences', () => {
  it('migrates pre-audience share rows to link access without changing their bytes or lifecycle', async () => {
    const f = await fixture('audience-migration');
    const published = await publishShare(f.auth, 'Existing public snapshot');
    await runInDurableObject(sessionStub(), (_instance: SessionCoordinator, state) => {
      state.storage.sql.exec('ALTER TABLE shared_artifacts DROP COLUMN audience_kind');
      state.storage.sql.exec('ALTER TABLE shared_artifacts DROP COLUMN organization_id');
      // Reconstruct against the persisted pre-audience schema, as on deployment.
      new SessionCoordinator(state, env);
      const row = state.storage.sql
        .exec(
          'SELECT audience_kind, organization_id, state FROM shared_artifacts WHERE share_id = ?',
          published.share.shareId,
        )
        .toArray()[0];
      expect(row).toMatchObject({
        audience_kind: 'link',
        organization_id: null,
        state: 'published',
      });
    });
    expect(await (await hostedShareRead(published.share.shareId)).text()).toBe(
      'Existing public snapshot',
    );
  });

  it('lists only the verified device account active organizations and returns frozen audience', async () => {
    const f = await organizationFixture();
    const listed = expectSuccess<ShareAudiencesResult>(
      await postRpc(
        'share.audiences',
        {
          identity: f.identity(f.outsider),
          accountId: f.outsider.accountId,
        },
        f.author.auth,
      ),
    );
    expect(listed.organizations).toEqual([{ id: f.organizationId, name: 'Share team' }]);
    expect(
      expectSuccess<ShareAudiencesResult>(
        await postRpc(
          'share.audiences',
          {
            identity: f.identity(f.author),
          },
          f.outsider.auth,
        ),
      ).organizations,
    ).toEqual([]);
    const reserved = await createShare(f.author.auth, { audience: f.audience });
    expect(reserved.audience).toEqual(f.audience);
    const owned = expectSuccess<ShareListResult>(await postRpc('share.list', {}, f.author.auth));
    expect(owned.shares.find((s) => s.shareId === reserved.shareId)?.audience).toEqual(f.audience);
    const unauthenticated = await SELF.fetch('https://spike.test/v1/rpc', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        protocol: 'anvil-backend/1',
        requestId: crypto.randomUUID(),
        operation: 'share.audiences',
        params: {},
      }),
    });
    expect(unauthenticated.status).toBe(401);
  });

  it('serves current members without paid seats and denies anonymous, outsider, pending and removed readers without metadata', async () => {
    const f = await organizationFixture();
    const shared = await publishShare(f.author.auth, 'Private organization body', f.audience);
    expect(shared.share.audience).toEqual(f.audience);
    const shareId = shared.share.shareId;
    await expectPrivateDenial(await hostedShareRead(shareId), 401, 'unauthenticated');
    for (const user of [f.outsider, f.pending]) {
      await expectPrivateDenial(await hostedShareRead(shareId, f.identity(user)), 403, 'forbidden');
    }
    const allowed = await hostedShareRead(shareId, f.identity(f.member));
    expect(allowed.status).toBe(200);
    expect(allowed.headers.get('x-anvil-share-audience')).toBe(JSON.stringify(f.audience));
    expect(allowed.headers.get('cache-control')).toBe('private, no-store');
    expect(await allowed.text()).toBe('Private organization body');
    await f.remove(f.member);
    await expectPrivateDenial(
      await hostedShareRead(shareId, f.identity(f.member)),
      403,
      'forbidden',
    );
  });

  it('rejects forged identities, inactive accounts and closed organizations at final read', async () => {
    const f = await organizationFixture();
    const shared = await publishShare(f.author.auth, 'Restricted', f.audience);
    const shareId = shared.share.shareId;
    await expectPrivateDenial(
      await hostedShareRead(shareId, {
        ...f.identity(f.member),
        workosClientId: 'client_fake',
      }),
      403,
      'forbidden',
    );
    await expectPrivateDenial(
      await hostedShareRead(shareId, {
        ...f.identity(f.member),
        workosUserId: 'user_fake',
      }),
      403,
      'forbidden',
    );
    await f.disable(f.member);
    await expectPrivateDenial(
      await hostedShareRead(shareId, f.identity(f.member)),
      403,
      'forbidden',
    );
    await f.db
      .prepare("UPDATE hosted_organizations SET status = 'closed' WHERE id = ?")
      .bind(f.organizationId)
      .run();
    await expectPrivateDenial(
      await hostedShareRead(shareId, f.identity(f.author)),
      403,
      'forbidden',
    );
  });

  it('derives creator identity from verified account and rejects unknown or inactive organization scope', async () => {
    const f = await organizationFixture();
    for (const audience of [
      f.audience,
      { kind: 'organization', organizationId: 'anvil_org_fake' },
    ]) {
      const result = await postRpc(
        'share.create',
        {
          title: 'Forged',
          mediaType: 'text/plain',
          byteLength: 4,
          sha256: '0'.repeat(64),
          audience,
          identity: f.identity(f.author),
          accountId: f.author.accountId,
        },
        f.outsider.auth,
      );
      expect(isRpcError(result.body)).toBe(true);
      if (isRpcError(result.body)) expect(result.body.error.code).toBe('forbidden');
    }
    await f.remove(f.author);
    expect(
      isRpcError(
        (
          await postRpc(
            'share.create',
            {
              title: 'Former member',
              mediaType: 'text/plain',
              byteLength: 4,
              sha256: '0'.repeat(64),
              audience: f.audience,
            },
            f.author.auth,
          )
        ).body,
      ),
    ).toBe(true);
    expect(
      expectSuccess<ShareAudiencesResult>(await postRpc('share.audiences', {}, f.author.auth))
        .organizations,
    ).toEqual([]);
  });

  it('freezes audience through updates and finalize and preserves default link access', async () => {
    const f = await organizationFixture();
    const shared = await publishShare(f.author.auth, 'Frozen policy', f.audience);
    const shareId = shared.share.shareId;
    for (const operation of ['share.update', 'share.finalize']) {
      const result = await postRpc(
        operation,
        {
          shareId,
          byteLength: 4,
          sha256: '0'.repeat(64),
          audience: { kind: 'link' },
        },
        f.author.auth,
      );
      expect(isRpcError(result.body)).toBe(true);
      if (isRpcError(result.body))
        expect(result.body.error.details?.reason).toBe('audience-immutable');
    }
    const legacy = await publishShare(f.author.auth, 'Link access');
    expect(legacy.share.audience).toEqual({ kind: 'link' });
    expect((await hostedShareRead(legacy.share.shareId)).status).toBe(200);
  });

  it('denies upload, finalize and update after author departure but leaves published content for current members and author revoke/list', async () => {
    const f = await organizationFixture();
    const published = await publishShare(f.author.auth, 'Already published', f.audience);
    const bytes = new TextEncoder().encode('Unpublished');
    const sha256 = await sha256Hex('Unpublished');
    const staged = await createShare(f.author.auth, {
      audience: f.audience,
      byteLength: bytes.byteLength,
      sha256,
    });
    expect((await putShare(staged.uploadPath, f.author.auth, bytes)).status).toBe(200);
    const unuploaded = await createShare(f.author.auth, {
      audience: f.audience,
      byteLength: bytes.byteLength,
      sha256,
    });
    await f.remove(f.author);
    expect((await putShare(unuploaded.uploadPath, f.author.auth, bytes)).status).toBe(403);
    for (const [operation, shareId] of [
      ['share.finalize', staged.shareId],
      ['share.update', published.share.shareId],
    ]) {
      const denied = await postRpc(
        operation,
        { shareId, byteLength: bytes.byteLength, sha256 },
        f.author.auth,
      );
      expect(isRpcError(denied.body)).toBe(true);
      if (isRpcError(denied.body)) expect(denied.body.error.code).toBe('forbidden');
    }
    const allowed = await hostedShareRead(published.share.shareId, f.identity(f.member));
    expect(await allowed.text()).toBe('Already published');
    await expectPrivateDenial(
      await hostedShareRead(published.share.shareId, f.identity(f.author)),
      403,
      'forbidden',
    );
    expect(
      expectSuccess<ShareListResult>(await postRpc('share.list', {}, f.author.auth)).shares.length,
    ).toBe(3);
    expect(
      expectSuccess<ShareRevokeResult>(
        await postRpc('share.revoke', { shareId: published.share.shareId }, f.author.auth),
      ).share.state,
    ).toBe('revoked');
  });

  it('denies pending replacement finalize after author removal and retains the original bytes', async () => {
    const f = await organizationFixture();
    const published = await publishShare(f.author.auth, 'Original snapshot', f.audience);
    const bytes = new TextEncoder().encode('Replacement');
    const sha256 = await sha256Hex('Replacement');
    const update = expectSuccess<ShareUpdateResult>(
      await postRpc(
        'share.update',
        {
          shareId: published.share.shareId,
          byteLength: bytes.byteLength,
          sha256,
        },
        f.author.auth,
      ),
    );
    expect((await putShare(update.uploadPath, f.author.auth, bytes)).status).toBe(200);
    await f.remove(f.author);
    const denied = await postRpc(
      'share.finalize',
      { shareId: published.share.shareId, byteLength: bytes.byteLength, sha256 },
      f.author.auth,
    );
    expect(isRpcError(denied.body)).toBe(true);
    if (isRpcError(denied.body)) expect(denied.body.error.code).toBe('forbidden');
    expect(
      await (await hostedShareRead(published.share.shareId, f.identity(f.member))).text(),
    ).toBe('Original snapshot');
  });

  it('gates raw reads and lifecycle metadata, distinguishing expired and revoked only for authorized members', async () => {
    const f = await organizationFixture();
    const expired = await publishShare(f.author.auth, 'Expires', f.audience);
    const revoked = await publishShare(f.author.auth, 'Revokes', f.audience);
    const raw = await SELF.fetch(`https://spike.test/v1/shared/${expired.share.shareId}`);
    expect(raw.status).not.toBe(200);
    expect(raw.headers.has('x-anvil-share-title')).toBe(false);
    const unsigned = await SELF.fetch('https://spike.test/internal/hosted/shared-artifact', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ shareId: expired.share.shareId, identity: f.identity(f.member) }),
    });
    expect(unsigned.status).toBe(401);
    await runInDurableObject(sessionStub(), (_instance: SessionCoordinator, state) => {
      state.storage.sql.exec(
        'UPDATE shared_artifacts SET expires_at = 1 WHERE share_id = ?',
        expired.share.shareId,
      );
    });
    expectSuccess<ShareRevokeResult>(
      await postRpc('share.revoke', { shareId: revoked.share.shareId }, f.author.auth),
    );
    for (const [shareId, reason] of [
      [expired.share.shareId, 'share-expired'],
      [revoked.share.shareId, 'share-revoked'],
    ]) {
      await expectPrivateDenial(await hostedShareRead(shareId), 401, 'unauthenticated');
      await expectPrivateDenial(
        await hostedShareRead(shareId, f.identity(f.outsider)),
        403,
        'forbidden',
      );
      const response = await hostedShareRead(shareId, f.identity(f.member));
      expect(response.status).toBe(404);
      const body = (await response.json()) as { error: { details?: { reason?: string } } };
      expect(body.error.details?.reason).toBe(reason);
      expect(response.headers.has('x-anvil-share-title')).toBe(false);
    }
  });
});

describe('share publication deadline boundaries', () => {
  it('rejects finalizing an expired uploaded reservation without waiting for sweep', async () => {
    const f = await fixture('share-finalize-expired-reservation');
    const bytes = new TextEncoder().encode('staged');
    const sha256 = await sha256Hex('staged');
    const reserved = await createShare(f.auth, { byteLength: bytes.byteLength, sha256 });
    expect((await putShare(reserved.uploadPath, f.auth, bytes)).status).toBe(200);
    await runInDurableObject(sessionStub(), (_instance: SessionCoordinator, state) => {
      state.storage.sql.exec(
        'UPDATE shared_artifacts SET upload_expires_at = 1 WHERE share_id = ?',
        reserved.shareId,
      );
    });
    const result = await postRpc(
      'share.finalize',
      { shareId: reserved.shareId, byteLength: bytes.byteLength, sha256 },
      f.auth,
    );
    expect(isRpcError(result.body)).toBe(true);
    if (isRpcError(result.body))
      expect(result.body.error.details?.reason).toBe('reservation-expired');
    expect((await hostedShareRead(reserved.shareId)).status).toBe(404);
  });

  it('rejects expired pending replacement finalization and preserves the original publication', async () => {
    const f = await fixture('share-finalize-expired-replacement');
    const published = await publishShare(f.auth, 'original');
    const bytes = new TextEncoder().encode('replacement');
    const sha256 = await sha256Hex('replacement');
    const reserved = expectSuccess<ShareUpdateResult>(
      await postRpc(
        'share.update',
        {
          shareId: published.share.shareId,
          byteLength: bytes.byteLength,
          sha256,
        },
        f.auth,
      ),
    );
    expect(reserved.audience).toEqual({ kind: 'link' });
    expect((await putShare(reserved.uploadPath, f.auth, bytes)).status).toBe(200);
    await runInDurableObject(sessionStub(), (_instance: SessionCoordinator, state) => {
      state.storage.sql.exec(
        'UPDATE shared_artifacts SET pending_upload_expires_at = 1 WHERE share_id = ?',
        published.share.shareId,
      );
    });
    const result = await postRpc(
      'share.finalize',
      { shareId: published.share.shareId, byteLength: bytes.byteLength, sha256 },
      f.auth,
    );
    expect(isRpcError(result.body)).toBe(true);
    if (isRpcError(result.body))
      expect(result.body.error.details?.reason).toBe('reservation-expired');
    expect(await (await hostedShareRead(published.share.shareId)).text()).toBe('original');
  });
});

describe('atomic share title replacements', () => {
  it('publishes the redacted title together with its bytes only for the matching reservation token', async () => {
    const f = await fixture('share-title');
    const published = await publishShare(f.auth, 'original');
    const shareId = published.share.shareId;
    const body = new TextEncoder().encode('replacement');
    const sha256 = await sha256Hex('replacement');
    const reserve = async (title: string) =>
      expectSuccess<ShareUpdateResult>(
        await postRpc(
          'share.update',
          {
            shareId,
            title,
            byteLength: body.byteLength,
            sha256,
          },
          f.auth,
        ),
      );
    const stale = await reserve('First title');
    const current = await reserve('[redacted]');
    expect(current.updateToken).not.toBe(stale.updateToken);
    expect((await putShare(current.uploadPath, f.auth, body)).status).toBe(200);
    const before = await hostedShareRead(shareId);
    expect(decodeURIComponent(before.headers.get('x-anvil-share-title') ?? '')).toBe(
      'Design notes',
    );
    expect(await before.text()).toBe('original');
    for (const updateToken of [undefined, stale.updateToken]) {
      const denied = await postRpc(
        'share.finalize',
        { shareId, byteLength: body.byteLength, sha256, updateToken },
        f.auth,
      );
      expect(isRpcError(denied.body)).toBe(true);
      if (isRpcError(denied.body))
        expect(denied.body.error.details?.reason).toBe('update-reservation-mismatch');
    }
    const finalized = expectSuccess<ShareFinalizeResult>(
      await postRpc(
        'share.finalize',
        {
          shareId,
          byteLength: body.byteLength,
          sha256,
          updateToken: current.updateToken,
        },
        f.auth,
      ),
    );
    expect(finalized.share.title).toBe('[redacted]');
    const after = await hostedShareRead(shareId);
    expect(decodeURIComponent(after.headers.get('x-anvil-share-title') ?? '')).toBe('[redacted]');
    expect(await after.text()).toBe('replacement');
  });

  it('preserves original title and bytes when the replacement expires', async () => {
    const f = await fixture('share-title-expired');
    const published = await publishShare(f.auth, 'original');
    const shareId = published.share.shareId;
    const body = new TextEncoder().encode('replacement');
    const sha256 = await sha256Hex('replacement');
    const reserved = expectSuccess<ShareUpdateResult>(
      await postRpc(
        'share.update',
        {
          shareId,
          title: '[redacted]',
          byteLength: body.byteLength,
          sha256,
        },
        f.auth,
      ),
    );
    expect((await putShare(reserved.uploadPath, f.auth, body)).status).toBe(200);
    await runInDurableObject(sessionStub(), (_instance: SessionCoordinator, state) => {
      state.storage.sql.exec(
        'UPDATE shared_artifacts SET pending_upload_expires_at = 1 WHERE share_id = ?',
        shareId,
      );
    });
    const denied = await postRpc(
      'share.finalize',
      {
        shareId,
        byteLength: body.byteLength,
        sha256,
        updateToken: reserved.updateToken,
      },
      f.auth,
    );
    expect(isRpcError(denied.body)).toBe(true);
    if (isRpcError(denied.body))
      expect(denied.body.error.details?.reason).toBe('reservation-expired');
    const read = await hostedShareRead(shareId);
    expect(decodeURIComponent(read.headers.get('x-anvil-share-title') ?? '')).toBe('Design notes');
    expect(await read.text()).toBe('original');
  });

  it('applies the same title size validation to replacement reservations as creation', async () => {
    const f = await fixture('share-title-bounds');
    const published = await publishShare(f.auth, 'original');
    for (const title of ['', 'a'.repeat(1025), 123]) {
      const denied = await postRpc(
        'share.update',
        {
          shareId: published.share.shareId,
          title,
          byteLength: 4,
          sha256: '0'.repeat(64),
        },
        f.auth,
      );
      expect(isRpcError(denied.body)).toBe(true);
      if (isRpcError(denied.body)) expect(denied.body.error.code).toBe('malformed-request');
    }
  });
});
