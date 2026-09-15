// BILL-04 website-facing device + data/deletion routes — the
// `/internal/hosted/*` signed service channel's account-management
// surface, dispatched from routes.ts after the HMAC signature check.
//
// Every handler shares one prelude: the verified WorkOS identity resolves
// to a billing row (`getBillingAccountByIdentity` — never creates), a
// non-active lifecycle denies with `account-deleted`, and routes that act
// on sync data require a linked `sync_account_id` (`unlinked` otherwise).
// Device and deletion work is then forwarded to the SessionCoordinator's
// `*-for-account`/`delete-account-by-id` internal routes, which trust the
// body-supplied accountId because this channel is signature-gated and
// worker-internal by construction.

import type { AccountDeletionState, DeviceListResult } from '../../../contract/auth';
import { isRecord, rpcErrorResponse } from '../rpc';
import { audit } from './billing';
import { validateHostedIdentity } from './identity';
import {
  getBillingAccountByIdentity,
  markBillingLifecycle,
  type BillingAccountRow,
} from './store';

/** Website-supplied rename bound — tighter than the DO's own 128-char cap. */
const MAX_HOSTED_DEVICE_NAME_CHARS = 80;
const MAX_ENROLLMENT_ID_CHARS = 128;

function sessionStub(env: Env): DurableObjectStub {
  return env.SESSIONS.get(env.SESSIONS.idFromName('sessions'));
}

type Resolved = { account: BillingAccountRow } | { error: Response };

/**
 * Shared prelude step one: validated identity → existing billing row.
 * Never creates accounts — the website only manages identities that have
 * already signed up through a billing-touching route.
 */
async function resolveBillingAccount(body: unknown, db: D1Database): Promise<Resolved> {
  if (!isRecord(body) || !validateHostedIdentity(body)) {
    return { error: rpcErrorResponse(undefined, 'malformed-request') };
  }
  const account = await getBillingAccountByIdentity(db, body);
  if (account === null) {
    return { error: rpcErrorResponse(undefined, 'not-found') };
  }
  return { account };
}

/**
 * Shared prelude for routes that act on the mapped sync account:
 * identity → billing row → active lifecycle → linked sync account.
 */
async function resolveLinkedAccount(
  body: unknown,
  db: D1Database,
): Promise<{ account: BillingAccountRow; syncAccountId: string } | { error: Response }> {
  const resolved = await resolveBillingAccount(body, db);
  if ('error' in resolved) return resolved;
  const { account } = resolved;
  if (account.lifecycle !== 'active') {
    return { error: rpcErrorResponse(undefined, 'forbidden', { reason: 'account-deleted' }) };
  }
  if (account.sync_account_id === null) {
    return { error: rpcErrorResponse(undefined, 'not-found', { reason: 'unlinked' }) };
  }
  return { account, syncAccountId: account.sync_account_id };
}

/**
 * Forwards a JSON body to a SessionCoordinator internal route and relays
 * the response. Session-object error codes the website can act on
 * (not-found, malformed-request) pass through; anything else — and any
 * transport failure — collapses to `unavailable`.
 */
async function forwardToSessions(env: Env, path: string, payload: unknown): Promise<Response> {
  const response = await sessionStub(env).fetch(`https://internal.anvil${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const body = (await response.json().catch(() => null)) as {
    error?: { code?: string };
  } | null;
  if (!response.ok || body === null) {
    const code = body?.error?.code;
    return rpcErrorResponse(
      undefined,
      code === 'not-found' || code === 'malformed-request' ? code : 'unavailable',
    );
  }
  return Response.json(body);
}

/** `POST /internal/hosted/devices` — the website's device list. */
export async function handleHostedDevices(
  body: unknown,
  env: Env,
  db: D1Database,
): Promise<Response> {
  const resolved = await resolveLinkedAccount(body, db);
  if ('error' in resolved) return resolved.error;
  // No caller enrollment exists on this channel: the session object's
  // for-account route returns every row with `self: false`.
  return forwardToSessions(env, '/internal/device-list-for-account', {
    accountId: resolved.syncAccountId,
  });
}

/**
 * `POST /internal/hosted/device-rename` — renames any device on the
 * mapped account (the website user is the account owner). An empty
 * displayName clears the name, matching `device.rename` semantics.
 */
export async function handleHostedDeviceRename(
  body: unknown,
  env: Env,
  db: D1Database,
): Promise<Response> {
  if (
    !isRecord(body) ||
    typeof body['enrollmentId'] !== 'string' ||
    body['enrollmentId'].length === 0 ||
    body['enrollmentId'].length > MAX_ENROLLMENT_ID_CHARS ||
    typeof body['displayName'] !== 'string' ||
    body['displayName'].length > MAX_HOSTED_DEVICE_NAME_CHARS
  ) {
    return rpcErrorResponse(undefined, 'malformed-request');
  }
  const resolved = await resolveLinkedAccount(body, db);
  if ('error' in resolved) return resolved.error;
  return forwardToSessions(env, '/internal/device-rename-for-account', {
    accountId: resolved.syncAccountId,
    enrollmentId: body['enrollmentId'],
    displayName: body['displayName'],
  });
}

/**
 * `POST /internal/hosted/device-revoke` — revokes any device on the
 * mapped account. The website holds no session of its own, so there is
 * no self-device to protect from revocation.
 */
export async function handleHostedDeviceRevoke(
  body: unknown,
  env: Env,
  db: D1Database,
): Promise<Response> {
  if (
    !isRecord(body) ||
    typeof body['enrollmentId'] !== 'string' ||
    body['enrollmentId'].length === 0 ||
    body['enrollmentId'].length > MAX_ENROLLMENT_ID_CHARS
  ) {
    return rpcErrorResponse(undefined, 'malformed-request');
  }
  const resolved = await resolveLinkedAccount(body, db);
  if ('error' in resolved) return resolved.error;
  return forwardToSessions(env, '/internal/device-revoke-for-account', {
    accountId: resolved.syncAccountId,
    enrollmentId: body['enrollmentId'],
  });
}

/**
 * Read-only deletion probe on the account object. Returns null when the
 * object is unreachable or answers with an unexpected shape — the session
 * object's tombstone remains authoritative, exactly like the session
 * coordinator's own `readAccountDeletionStatus`.
 */
async function probeAccountDeletion(
  env: Env,
  accountId: string,
): Promise<{ state: AccountDeletionState; purgedRows?: number } | null> {
  try {
    const stub = env.ACCOUNT.get(env.ACCOUNT.idFromName(accountId));
    const response = await stub.fetch('https://internal.anvil/internal/deletion-status', {
      method: 'POST',
    });
    const body = (await response.json().catch(() => null)) as {
      state?: unknown;
      purgedRows?: unknown;
    } | null;
    if (
      !response.ok ||
      body === null ||
      (body.state !== 'none' && body.state !== 'deleting' && body.state !== 'deleted')
    ) {
      return null;
    }
    return {
      state: body.state,
      ...(typeof body.purgedRows === 'number' ? { purgedRows: body.purgedRows } : {}),
    };
  } catch {
    return null;
  }
}

/**
 * `POST /internal/hosted/data-status` — combines the session object's
 * deletion tombstone with the account object's purge state for the mapped
 * sync account. Unlinked accounts report the empty shape instead of
 * `unlinked`: there is no sync data to describe.
 */
export async function handleHostedDataStatus(
  body: unknown,
  env: Env,
  db: D1Database,
): Promise<Response> {
  const resolved = await resolveBillingAccount(body, db);
  if ('error' in resolved) return resolved.error;
  const { account } = resolved;
  if (account.lifecycle !== 'active') {
    return rpcErrorResponse(undefined, 'forbidden', { reason: 'account-deleted' });
  }
  if (account.sync_account_id === null) {
    return Response.json({
      syncAccountId: null,
      tombstoned: false,
      deletion: { state: 'none' },
    });
  }
  const syncAccountId = account.sync_account_id;
  const tombstone = await sessionStub(env).fetch(
    `https://internal.anvil/internal/deletion-state?accountId=${encodeURIComponent(syncAccountId)}`,
  );
  if (!tombstone.ok) throw new Error('deletion-state lookup failed');
  const tombstoneBody = (await tombstone.json()) as { tombstoned?: unknown };
  const tombstoned = tombstoneBody.tombstoned === true;
  const deletion =
    (await probeAccountDeletion(env, syncAccountId)) ??
    ({ state: tombstoned ? 'deleting' : 'none' } as const);
  return Response.json({ syncAccountId, tombstoned, deletion });
}

/**
 * `POST /internal/hosted/delete-account` — starts deletion of the mapped
 * sync account (tombstone + session revocation + retryable purge, all
 * inside the session object) and marks the billing row `deleting`.
 * Idempotent: a repeat while `deleting` re-drives the same flow and
 * reports current state; only a fully `deleted` row is denied.
 */
export async function handleHostedDeleteAccount(
  body: unknown,
  env: Env,
  db: D1Database,
): Promise<Response> {
  const resolved = await resolveBillingAccount(body, db);
  if ('error' in resolved) return resolved.error;
  const { account } = resolved;
  if (account.lifecycle === 'deleted') {
    return rpcErrorResponse(undefined, 'forbidden', { reason: 'account-deleted' });
  }
  if (account.sync_account_id === null) {
    return rpcErrorResponse(undefined, 'not-found', { reason: 'unlinked' });
  }
  const response = await sessionStub(env).fetch(
    'https://internal.anvil/internal/delete-account-by-id',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ accountId: account.sync_account_id }),
    },
  );
  const payload = (await response.json().catch(() => null)) as {
    state?: unknown;
  } | null;
  if (!response.ok || (payload?.state !== 'deleting' && payload?.state !== 'deleted')) {
    return rpcErrorResponse(undefined, 'unavailable');
  }
  // First request transitions the billing row and leaves the audit mark;
  // repeats land zero rows on the lifecycle guard and stay silent.
  if (
    account.lifecycle === 'active' &&
    (await markBillingLifecycle(db, account.id, 'deleting'))
  ) {
    await audit(db, account.id, 'account.delete-requested', {
      syncAccountId: account.sync_account_id,
    });
  }
  return Response.json({ state: payload.state });
}
