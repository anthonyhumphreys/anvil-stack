// BILL-01 hosted API surface — mounted only when env.HOSTED_DB is bound;
// self-host workers answer every hosted path with not-found.
//
// `POST /v1/hosted/link` is the one public route: a device holding a live
// session redeems a single-use `anvil-lc-…` link code (minted for a WorkOS
// identity by the website via /internal/hosted/link-code) to bind its
// existing sync account to that identity's billing account.
//
// `/internal/hosted/*` is the website service channel: every request must
// carry a valid HMAC signature (service-auth.ts, audience 'anvil-hosted')
// with D1-backed nonce replay protection. Device credentials never pass.

import type { EnrollmentCodeIssueResult } from '../../../contract/auth';
import { parseDeviceBearer } from '../auth';
import { isRecord, rpcErrorResponse } from '../rpc';
import {
  handleBillingOverview,
  handleCheckout,
  handleEntitlement,
  handlePortal,
  handleReconcile,
  handleStripeWebhook,
} from './billing-routes';
import {
  handleHostedDataStatus,
  handleHostedDeleteAccount,
  handleHostedDeviceRename,
  handleHostedDeviceRevoke,
  handleHostedDevices,
} from './device-routes';
import {
  initialHostedSyncAccountId,
  validateHostedIdentity,
  type HostedIdentity,
} from './identity';
import { verifyHostedServiceRequest } from './service-auth';
import {
  HostedConflictError,
  bumpGeneration,
  consumeHostedLinkCode,
  consumeServiceNonce,
  findActiveBillingBySyncAccount,
  getBillingAccountById,
  getBillingAccountByIdentity,
  getOrCreateBillingAccount,
  issueHostedLinkCode,
  setSyncAccountLink,
} from './store';

const HOSTED_BODY_MAX_BYTES = 8 * 1024;
const HOSTED_SERVICE_AUDIENCE = 'anvil-hosted';
/** Cap on the tombstone-walk when deriving a clean sync account mapping. */
const MAX_GENERATION_BUMPS = 10;

function trimTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 47) end -= 1;
  return value.slice(0, end);
}

function sessionStub(env: Env): DurableObjectStub {
  return env.SESSIONS.get(env.SESSIONS.idFromName('sessions'));
}

/** Bounded raw-body read: the HMAC signature covers these exact bytes. */
async function readHostedBody(request: Request): Promise<Uint8Array | null> {
  const declared = Number(request.headers.get('content-length') ?? '0');
  if (Number.isFinite(declared) && declared > HOSTED_BODY_MAX_BYTES) {
    return null;
  }
  let buffer: ArrayBuffer;
  try {
    buffer = await request.arrayBuffer();
  } catch {
    return null;
  }
  return buffer.byteLength > HOSTED_BODY_MAX_BYTES ? null : new Uint8Array(buffer);
}

function parseJsonBody(body: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder().decode(body)) as unknown;
  } catch {
    return null;
  }
}

/**
 * HOSTED_SERVICE_KEYS is a JSON `{"keyId":"secret",…}` map. Any malformed
 * input — bad JSON, a non-string secret, an unusable key id — denies every
 * request rather than partially trusting the configured key set.
 */
function parseServiceKeys(raw: string | undefined): Record<string, string> | null {
  if (typeof raw !== 'string' || raw.length === 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || Object.keys(parsed).length === 0) return null;
  const keys: Record<string, string> = {};
  for (const [keyId, secret] of Object.entries(parsed)) {
    if (typeof secret !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(keyId)) {
      return null;
    }
    keys[keyId] = secret;
  }
  return keys;
}

/** Device bearer → verified {accountId, enrollmentId} via the session object. */
async function resolveDevice(
  request: Request,
  env: Env,
): Promise<{ accountId: string; enrollmentId: string } | null> {
  const bearer = parseDeviceBearer(request.headers.get('Authorization'));
  if (bearer === null) return null;
  const response = await sessionStub(env).fetch(
    'https://internal.anvil/internal/resolve-device',
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${bearer}` },
    },
  );
  if (!response.ok) return null;
  const identity = (await response.json()) as {
    accountId?: unknown;
    enrollmentId?: unknown;
  };
  if (typeof identity.accountId !== 'string' || typeof identity.enrollmentId !== 'string') {
    return null;
  }
  return { accountId: identity.accountId, enrollmentId: identity.enrollmentId };
}

/** Deletion-tombstone probe on the session object; fails closed via throw. */
async function isTombstoned(env: Env, accountId: string): Promise<boolean> {
  const response = await sessionStub(env).fetch(
    `https://internal.anvil/internal/deletion-state?accountId=${encodeURIComponent(accountId)}`,
  );
  if (!response.ok) throw new Error('deletion-state lookup failed');
  const body = (await response.json()) as { tombstoned?: unknown };
  return body.tombstoned === true;
}

/**
 * `POST /v1/hosted/link` — device-session plus link-code redemption. The
 * code is consumed atomically before any ownership check, so a rejected
 * link attempt still burns the code (never a reusable oracle).
 */
async function handleHostedLink(
  request: Request,
  env: Env,
  db: D1Database,
): Promise<Response> {
  const bodyBytes = await readHostedBody(request);
  if (bodyBytes === null) {
    return rpcErrorResponse(undefined, 'payload-too-large');
  }
  const body = parseJsonBody(bodyBytes);
  if (!isRecord(body) || typeof body['linkCode'] !== 'string' || body['linkCode'].length === 0) {
    return rpcErrorResponse(undefined, 'malformed-request');
  }
  const device = await resolveDevice(request, env);
  if (device === null) {
    return rpcErrorResponse(undefined, 'unauthenticated');
  }
  const billingAccountId = await consumeHostedLinkCode(db, body['linkCode']);
  if (billingAccountId === null) {
    return rpcErrorResponse(undefined, 'unauthenticated');
  }
  const billing = await getBillingAccountById(db, billingAccountId);
  if (billing === null) {
    // The link code's foreign key guarantees the row — this is a store bug.
    return rpcErrorResponse(undefined, 'unavailable');
  }
  if (billing.lifecycle !== 'active') {
    return rpcErrorResponse(undefined, 'forbidden', { reason: 'account-deleted' });
  }
  if (billing.sync_account_id !== null && billing.sync_account_id !== device.accountId) {
    return rpcErrorResponse(undefined, 'conflict', { reason: 'already-linked' });
  }
  const claimed = await findActiveBillingBySyncAccount(db, device.accountId);
  if (claimed !== null && claimed.id !== billing.id) {
    return rpcErrorResponse(undefined, 'conflict', { reason: 'sync-account-claimed' });
  }
  try {
    await setSyncAccountLink(db, billing.id, device.accountId);
  } catch (error) {
    if (error instanceof HostedConflictError) {
      return rpcErrorResponse(undefined, 'conflict', { reason: 'already-linked' });
    }
    throw error;
  }
  return Response.json({ linked: true, billingAccountId: billing.id });
}

/**
 * `POST /internal/hosted/pair-device` — the "Connect a device" fallback
 * flow: resolve the billing account's sync mapping (deriving and rolling
 * generations past tombstones as needed), then mint a single-use
 * enrollment code the user types into the desktop.
 */
async function handlePairDevice(body: unknown, env: Env, db: D1Database): Promise<Response> {
  if (!isRecord(body) || !validateHostedIdentity(body)) {
    return rpcErrorResponse(undefined, 'malformed-request');
  }
  const identity: HostedIdentity = {
    workosClientId: body.workosClientId,
    workosUserId: body.workosUserId,
  };
  const displayName = typeof body['displayName'] === 'string' ? body['displayName'] : null;
  const account = await getOrCreateBillingAccount(db, identity);
  if (account.lifecycle !== 'active') {
    return rpcErrorResponse(undefined, 'forbidden', { reason: 'account-deleted' });
  }
  const base = await initialHostedSyncAccountId(identity);
  let syncAccountId = account.sync_account_id ?? base;
  let linked = account.sync_account_id !== null;
  try {
    // A mapped (or freshly derived) account may already carry a deletion
    // tombstone: roll the billing generation forward until the mapping
    // lands on a live account — the same `base~N` walk the OIDC enroll
    // path performs.
    for (let bumps = 0; await isTombstoned(env, syncAccountId); bumps += 1) {
      if (bumps >= MAX_GENERATION_BUMPS) {
        return rpcErrorResponse(undefined, 'unavailable');
      }
      const bumped = await bumpGeneration(db, account.id);
      syncAccountId = bumped.syncAccountId;
      linked = true;
    }
    if (!linked) {
      await setSyncAccountLink(db, account.id, syncAccountId);
    }
  } catch (error) {
    if (error instanceof HostedConflictError) {
      return rpcErrorResponse(undefined, 'conflict');
    }
    throw error;
  }
  const issued = await sessionStub(env).fetch(
    'https://internal.anvil/internal/issue-enrollment-code',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        accountId: syncAccountId,
        ...(displayName === null ? {} : { displayName }),
        issuedBy: 'hosted-pairing',
      }),
    },
  );
  if (!issued.ok) {
    const payload = (await issued.json().catch(() => null)) as {
      error?: { code?: string };
    } | null;
    const code = payload?.error?.code;
    if (code === 'throttled') return rpcErrorResponse(undefined, 'throttled');
    if (code === 'forbidden') {
      // Lost a tombstone race between the check above and code issuance.
      return rpcErrorResponse(undefined, 'forbidden', { reason: 'account-deleted' });
    }
    return rpcErrorResponse(undefined, 'unavailable');
  }
  const result = (await issued.json()) as EnrollmentCodeIssueResult;
  return Response.json({
    code: result.code,
    expiresAt: result.expiresAt,
    accountId: syncAccountId,
  });
}

/**
 * `POST /internal/hosted/link-code` — mints the single-use code a signed-in
 * website user carries to a device running an existing sync account.
 */
async function handleLinkCode(body: unknown, db: D1Database): Promise<Response> {
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
  const issued = await issueHostedLinkCode(db, account.id);
  if (issued === null) {
    return rpcErrorResponse(undefined, 'throttled');
  }
  return Response.json({ linkCode: issued.code, expiresAt: issued.expiresAt });
}

/** `POST /internal/hosted/account` — the website's billing-account lookup. */
async function handleHostedAccount(body: unknown, db: D1Database): Promise<Response> {
  if (!isRecord(body) || !validateHostedIdentity(body)) {
    return rpcErrorResponse(undefined, 'malformed-request');
  }
  const account = await getBillingAccountByIdentity(db, body);
  if (account === null) {
    return rpcErrorResponse(undefined, 'not-found');
  }
  return Response.json({
    billingAccountId: account.id,
    syncAccountId: account.sync_account_id,
    generation: account.generation,
    lifecycle: account.lifecycle,
  });
}

/**
 * Hosted route entry point called from index.ts. Every hosted path 404s on
 * deployments without HOSTED_DB; internal routes additionally require the
 * service signature before dispatch, so an unsigned probe learns nothing.
 */
export async function handleHostedRequest(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const path = trimTrailingSlashes(url.pathname) || '/';
  const db = env.HOSTED_DB;
  if (db === undefined) {
    return rpcErrorResponse(undefined, 'not-found');
  }
  try {
    if (path === '/v1/hosted/link') {
      if (request.method !== 'POST') {
        return rpcErrorResponse(undefined, 'malformed-request');
      }
      return await handleHostedLink(request, env, db);
    }
    // BILL-02: the one unauthenticated-but-signed public route — Stripe
    // calls it directly, so the webhook secret doubles as the gate.
    if (path === '/v1/hosted/stripe-webhook') {
      if (request.method !== 'POST') {
        return rpcErrorResponse(undefined, 'malformed-request');
      }
      return await handleStripeWebhook(request, env, db);
    }
    if (path.startsWith('/internal/hosted/')) {
      if (request.method !== 'POST') {
        return rpcErrorResponse(undefined, 'malformed-request');
      }
      const body = await readHostedBody(request);
      if (body === null) {
        return rpcErrorResponse(undefined, 'payload-too-large');
      }
      const keys = parseServiceKeys(env.HOSTED_SERVICE_KEYS);
      if (keys === null) {
        return rpcErrorResponse(undefined, 'unauthenticated');
      }
      const verified = await verifyHostedServiceRequest(
        request,
        body,
        {
          audience: HOSTED_SERVICE_AUDIENCE,
          keys,
          consumeNonce: (keyId, requestId, expiresAt) =>
            consumeServiceNonce(db, keyId, requestId, expiresAt),
        },
        Date.now(),
      );
      if (!verified) {
        return rpcErrorResponse(undefined, 'unauthenticated');
      }
      const json = parseJsonBody(body);
      switch (path) {
        case '/internal/hosted/pair-device':
          return await handlePairDevice(json, env, db);
        case '/internal/hosted/link-code':
          return await handleLinkCode(json, db);
        case '/internal/hosted/account':
          return await handleHostedAccount(json, db);
        case '/internal/hosted/checkout':
          return await handleCheckout(json, env, db);
        case '/internal/hosted/portal':
          return await handlePortal(json, env, db);
        case '/internal/hosted/billing':
          return await handleBillingOverview(json, env, db);
        case '/internal/hosted/entitlement':
          return await handleEntitlement(json, env, db);
        case '/internal/hosted/reconcile':
          return await handleReconcile(json, env, db);
        // BILL-04: website-facing device management + data/deletion state.
        case '/internal/hosted/devices':
          return await handleHostedDevices(json, env, db);
        case '/internal/hosted/device-rename':
          return await handleHostedDeviceRename(json, env, db);
        case '/internal/hosted/device-revoke':
          return await handleHostedDeviceRevoke(json, env, db);
        case '/internal/hosted/data-status':
          return await handleHostedDataStatus(json, env, db);
        case '/internal/hosted/delete-account':
          return await handleHostedDeleteAccount(json, env, db);
        default:
          return rpcErrorResponse(undefined, 'not-found');
      }
    }
    return rpcErrorResponse(undefined, 'not-found');
  } catch {
    return rpcErrorResponse(undefined, 'unavailable');
  }
}
