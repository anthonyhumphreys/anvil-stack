import { isRecord, rpcErrorResponse } from '../rpc';
import { getOrCreateAdmittedBillingAccount } from './admission';
import { validateHostedIdentity } from './identity';

export async function betaCodeHash(code: string): Promise<string | null> {
  const normalized = code.trim().toLowerCase();
  if (!/^anvil_beta_[a-f0-9]{32}$/.test(normalized)) return null;
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(`anvil/beta-code/v1:${normalized}`),
  );
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function betaAccessUntil(
  db: D1Database,
  billingAccountId: string,
): Promise<number | null> {
  const row = await db
    .prepare(
      `SELECT MAX(access_until) AS access_until FROM hosted_beta_codes
     WHERE redeemed_by = ? AND revoked_at IS NULL`,
    )
    .bind(billingAccountId)
    .first<{ access_until: number | null }>();
  return row?.access_until ?? null;
}

export async function handleBetaRedeem(body: unknown, env: Env, db: D1Database): Promise<Response> {
  if (!isRecord(body) || !validateHostedIdentity(body) || typeof body['code'] !== 'string') {
    return rpcErrorResponse(undefined, 'malformed-request');
  }
  const hash = await betaCodeHash(body['code']);
  if (hash === null)
    return rpcErrorResponse(undefined, 'forbidden', { reason: 'beta-code-invalid' });
  const account = await getOrCreateAdmittedBillingAccount(env, db, {
    workosClientId: body['workosClientId'],
    workosUserId: body['workosUserId'],
  });
  if (account === null)
    return rpcErrorResponse(undefined, 'forbidden', { reason: 'waitlist-approval-required' });
  if (account.lifecycle !== 'active')
    return rpcErrorResponse(undefined, 'forbidden', { reason: 'account-deleted' });
  const now = Date.now();
  const row = await db
    .prepare(
      `UPDATE hosted_beta_codes SET redeemed_by = ?, redeemed_at = COALESCE(redeemed_at, ?)
     WHERE code_hash = ? AND revoked_at IS NULL AND access_until > ?
       AND (redeemed_by = ? OR (redeemed_by IS NULL AND redeem_until > ?))
       AND EXISTS (SELECT 1 FROM billing_accounts WHERE id = ? AND lifecycle = 'active')
     RETURNING access_until`,
    )
    .bind(account.id, now, hash, now, account.id, now, account.id)
    .first<{ access_until: number }>();
  if (row === null)
    return rpcErrorResponse(undefined, 'forbidden', { reason: 'beta-code-invalid' });
  return Response.json({ accessUntil: new Date(row.access_until).toISOString() });
}
