// Hosted dashboard channel — the browser's only path into the mesh.
//
// Every route rides the HMAC-signed /internal/hosted/* surface: the website
// (holding the WorkOS session) resolves the caller's billing account, maps
// it to the sync account, and forwards to that account's coordinator object.
// The browser never holds a device session and never sees an account key;
// it exchanges an ephemeral X25519 request for a sealed DSK grant + sealed
// snapshots that only it can open.

import { isRecord, rpcErrorResponse } from '../rpc';
import { validateHostedIdentity } from './identity';
import { getBillingAccountByIdentity } from './store';

/** Resolves the signed-in identity to its active sync account id. */
async function resolveSyncAccount(
  body: unknown,
  db: D1Database,
): Promise<{ syncAccountId: string } | Response> {
  if (!isRecord(body) || !validateHostedIdentity(body)) {
    return rpcErrorResponse(undefined, 'malformed-request');
  }
  const account = await getBillingAccountByIdentity(db, body);
  if (account === null) {
    return rpcErrorResponse(undefined, 'not-found');
  }
  if (account.lifecycle !== 'active') {
    return rpcErrorResponse(undefined, 'forbidden', { reason: 'account-deleted' });
  }
  if (account.sync_account_id === null) {
    return rpcErrorResponse(undefined, 'conflict', { reason: 'no-sync-account' });
  }
  return { syncAccountId: account.sync_account_id };
}

/**
 * The account coordinator speaks the versioned RPC envelope, while the
 * signed hosted service channel exposes the plain hosted contract used by
 * the website. Unwrap successful coordinator responses at this boundary;
 * forwarding the envelope makes the browser see an object with no `state`
 * (and consequently poll forever).
 */
async function forwardToAccount(
  env: Env,
  accountId: string,
  path: string,
  body: unknown,
): Promise<Response> {
  const stub = env.ACCOUNT.get(env.ACCOUNT.idFromName(accountId));
  const response = await stub.fetch(
    new Request(`https://internal.anvil${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
  const payload = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  if (!response.ok || payload === null) {
    return Response.json(payload ?? { error: { code: 'unavailable' } }, {
      status: response.status,
    });
  }
  const result = payload['result'];
  return Response.json(result === undefined ? payload : result, { status: response.status });
}

/**
 * `POST /internal/hosted/dashboard-request` — upsert a browser's
 * authorization request `{identity, request: HostedDashboardRequestInput}`.
 * The resolved sync account id is stamped on by the backend so the browser
 * cannot name a different account's object.
 */
export async function handleDashboardRequest(
  body: unknown,
  env: Env,
  db: D1Database,
): Promise<Response> {
  const resolved = await resolveSyncAccount(body, db);
  if (resolved instanceof Response) {
    return resolved;
  }
  if (!isRecord(body) || !isRecord(body['request'])) {
    return rpcErrorResponse(undefined, 'malformed-request');
  }
  return forwardToAccount(env, resolved.syncAccountId, '/internal/dashboard-request', {
    ...body['request'],
    accountId: resolved.syncAccountId,
  });
}

/**
 * `POST /internal/hosted/dashboard-status` — `{identity, requestId}` → the
 * request's lifecycle state, the sealed DSK grant once approved, and the
 * latest snapshot seq.
 */
export async function handleDashboardStatus(
  body: unknown,
  env: Env,
  db: D1Database,
): Promise<Response> {
  const resolved = await resolveSyncAccount(body, db);
  if (resolved instanceof Response) {
    return resolved;
  }
  if (!isRecord(body) || typeof body['requestId'] !== 'string') {
    return rpcErrorResponse(undefined, 'malformed-request');
  }
  return forwardToAccount(env, resolved.syncAccountId, '/internal/dashboard-status', {
    requestId: body['requestId'],
  });
}

/**
 * `POST /internal/hosted/dashboard-snapshot` — `{identity, requestId}` →
 * the latest sealed snapshot for an approved request. Opaque to every hop.
 */
export async function handleDashboardSnapshot(
  body: unknown,
  env: Env,
  db: D1Database,
): Promise<Response> {
  const resolved = await resolveSyncAccount(body, db);
  if (resolved instanceof Response) {
    return resolved;
  }
  if (!isRecord(body) || typeof body['requestId'] !== 'string') {
    return rpcErrorResponse(undefined, 'malformed-request');
  }
  return forwardToAccount(env, resolved.syncAccountId, '/internal/dashboard-snapshot', {
    requestId: body['requestId'],
  });
}
