// BILL-01 hosted API surface — mounted only when env.HOSTED_DB is bound;
// self-host workers answer every hosted path with not-found.
//
// `/internal/hosted/*` is the website service channel: every request must
// carry a valid HMAC signature (service-auth.ts, audience 'anvil-hosted')
// with D1-backed nonce replay protection. Device credentials never pass.

import { BROWSER_WORKSPACE_MAX_RPC_BODY_BYTES } from '../../../contract/browser-workspace';
import { isRecord, rpcErrorResponse } from '../rpc';
import {
  handleBillingOverview,
  handleCheckout,
  handleEntitlement,
  handleOrganizationSeatChange,
  handleOrganizationSeatQuote,
  handleOrganizationSeatConfirm,
  handlePortal,
  handleReconcile,
  handleStripeWebhook,
} from './billing-routes';
import {
  handleDashboardCommandStatus,
  handleDashboardCommandSubmit,
  handleDashboardRevoke,
  handleDashboardRequest,
  handleDashboardSnapshot,
  handleDashboardStatus,
  handleDashboardTrustRevoke,
} from './dashboard-routes';
import {
  handleHostedDataStatus,
  handleHostedDeleteAccount,
  handleHostedDeviceRename,
  handleHostedDeviceRevoke,
  handleHostedDevices,
} from './device-routes';
import { validateHostedIdentity, type HostedIdentity } from './identity';
import { emitMetric } from './metrics';
import { handleFairUseOperatorRequest } from './fair-use-admin';
import { issueHostedMachineAdmission, listHostedMachineHosts } from './machine-api';
import { handleHostedOrganizationRequest } from './organizations';
import { handleHostedOrganizationWebhook } from './organization-webhooks';
import { verifyHostedServiceRequest } from './service-auth';
import { consumeServiceNonce, getBillingAccountByIdentity } from './store';

// browser-workspace/1 envelopes carry bounded file/history/diff/preview
// ciphertext; service-auth still signs the exact raw body before parsing.
const HOSTED_BODY_MAX_BYTES = BROWSER_WORKSPACE_MAX_RPC_BODY_BYTES;
const HOSTED_SERVICE_AUDIENCE = 'anvil-hosted';
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

async function handleHostedMeshHosts(body: unknown, env: Env, db: D1Database): Promise<Response> {
  if (!isRecord(body) || !validateHostedIdentity(body)) {
    return rpcErrorResponse(undefined, 'malformed-request');
  }
  const account = await getBillingAccountByIdentity(db, body);
  if (account === null) return rpcErrorResponse(undefined, 'not-found');
  if (account.lifecycle !== 'active') {
    return rpcErrorResponse(undefined, 'forbidden', { reason: 'account-deleted' });
  }
  if (account.sync_account_id === null) {
    return rpcErrorResponse(undefined, 'not-found', { reason: 'unlinked' });
  }
  const result = await listHostedMachineHosts(env, account.sync_account_id);
  return result === null ? rpcErrorResponse(undefined, 'unavailable') : Response.json(result, {
    headers: { 'cache-control': 'no-store' },
  });
}

async function handleHostedMachineAdmission(body: unknown, env: Env, db: D1Database): Promise<Response> {
  if (
    !isRecord(body) ||
    !validateHostedIdentity(body) ||
    typeof body['machineId'] !== 'string' ||
    typeof body['endpointGeneration'] !== 'string' ||
    typeof body['clientPublicKey'] !== 'string' ||
    typeof body['bootstrapChallenge'] !== 'string' ||
    typeof body['grantId'] !== 'string' ||
    typeof body['origin'] !== 'string' ||
    typeof body['requestId'] !== 'string'
  ) return rpcErrorResponse(undefined, 'malformed-request');
  const account = await getBillingAccountByIdentity(db, body);
  if (account === null) return rpcErrorResponse(undefined, 'not-found');
  if (account.lifecycle !== 'active') {
    return rpcErrorResponse(undefined, 'forbidden', { reason: 'account-deleted' });
  }
  if (account.sync_account_id === null) {
    return rpcErrorResponse(undefined, 'not-found', { reason: 'unlinked' });
  }
  return issueHostedMachineAdmission(env, account.sync_account_id, {
    machineId: body['machineId'],
    endpointGeneration: body['endpointGeneration'],
    clientPublicKey: body['clientPublicKey'],
    bootstrapChallenge: body['bootstrapChallenge'],
    grantId: body['grantId'],
    origin: body['origin'],
    requestId: body['requestId'],
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
    if (path === '/internal/hosted/operator/fair-use') {
      return await handleFairUseOperatorRequest(request, env);
    }
    // BILL-02: the one unauthenticated-but-signed public route — Stripe
    // calls it directly, so the webhook secret doubles as the gate.
    if (path === '/v1/hosted/stripe-webhook') {
      if (request.method !== 'POST') {
        return rpcErrorResponse(undefined, 'malformed-request');
      }
      return await handleStripeWebhook(request, env, db);
    }
    if (path === '/v1/hosted/workos-webhook') {
      return await handleHostedOrganizationWebhook(request, env, db);
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
        emitMetric('service_auth.failure', { path });
        return rpcErrorResponse(undefined, 'unauthenticated');
      }
      const json = parseJsonBody(body);
      const organizationResponse = await handleHostedOrganizationRequest(path, json, env, db);
      if (organizationResponse !== null) return organizationResponse;
      switch (path) {
        case '/internal/hosted/account':
          return await handleHostedAccount(json, db);
        case '/internal/hosted/mesh-hosts':
          return await handleHostedMeshHosts(json, env, db);
        case '/internal/hosted/mesh-machine-admission':
          return await handleHostedMachineAdmission(json, env, db);
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
        case '/internal/hosted/seats':
          return await handleOrganizationSeatChange(json, env, db);
        case '/internal/hosted/seats/quote':
          return await handleOrganizationSeatQuote(json, env, db);
        case '/internal/hosted/seats/confirm':
          return await handleOrganizationSeatConfirm(json, env, db);
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
        // Browser dashboard channel: the website's only mesh access — a
        // scoped authorization request + sealed grant/snapshot relay.
        case '/internal/hosted/dashboard-request':
          return await handleDashboardRequest(json, env, db);
        case '/internal/hosted/dashboard-revoke':
          return await handleDashboardRevoke(json, env, db);
        case '/internal/hosted/dashboard-trust-revoke':
          return await handleDashboardTrustRevoke(json, env, db);
        case '/internal/hosted/dashboard-status':
          return await handleDashboardStatus(json, env, db);
        case '/internal/hosted/dashboard-snapshot':
          return await handleDashboardSnapshot(json, env, db);
        case '/internal/hosted/dashboard-command-submit':
          return await handleDashboardCommandSubmit(json, env, db);
        case '/internal/hosted/dashboard-command-status':
          return await handleDashboardCommandStatus(json, env, db);
        // Hosted artifact sharing: the website's /artifacts/{shareId}
        // page resolves published shares through this signed channel.
        // The session object streams R2 bytes with metadata headers, so
        // the response passes through untouched (no JSON envelope).
        case '/internal/hosted/shared-artifact': {
          if (!isRecord(json) || typeof json['shareId'] !== 'string') {
            return rpcErrorResponse(undefined, 'malformed-request');
          }
          return await sessionStub(env).fetch(
            new Request('https://internal.anvil/internal/shared-artifact', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ shareId: json['shareId'] }),
            }),
          );
        }
        default:
          return rpcErrorResponse(undefined, 'not-found');
      }
    }
    return rpcErrorResponse(undefined, 'not-found');
  } catch {
    emitMetric('hosted.route_error', { path });
    return rpcErrorResponse(undefined, 'unavailable');
  }
}
