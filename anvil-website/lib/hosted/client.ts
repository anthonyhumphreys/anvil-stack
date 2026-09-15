import "server-only";

import { normalizePathWithQuery, signRequest } from "./signing";
import type {
  HostedAccount,
  HostedBillingInterval,
  HostedBillingOverview,
  HostedCheckoutResult,
  HostedDataStatusResult,
  HostedDeleteAccountResult,
  HostedDeviceListResult,
  HostedEntitlement,
  HostedIdentity,
  HostedLinkCodeResult,
  HostedPairDeviceResult,
  HostedPortalResult,
  HostedReconcileResult
} from "./types";

const encoder = new TextEncoder();
const REQUEST_TIMEOUT_MS = 10_000;

/** Hosted sync is free through 31 Oct 2026; paid enforcement starts here. */
export const HOSTED_PAID_ENFORCEMENT_AT = "2026-11-01T00:00:00Z";

function backendOrigin(): string | null {
  const origin = process.env.ANVIL_BACKEND_ORIGIN;
  if (typeof origin !== "string" || origin.length === 0) return null;
  try {
    const url = new URL(origin);
    return url.origin;
  } catch {
    return null;
  }
}

function signingKey(): { keyId: string; secret: string } | null {
  const keyId = process.env.ANVIL_HOSTED_KEY_ID;
  const secret = process.env.ANVIL_HOSTED_SERVICE_SECRET;
  if (
    typeof keyId !== "string" ||
    !/^[A-Za-z0-9_-]{1,64}$/.test(keyId) ||
    typeof secret !== "string" ||
    encoder.encode(secret).byteLength < 32
  ) {
    return null;
  }
  return { keyId, secret };
}

/** True when all three backend-channel env vars are present and well-formed. */
export function hostedConfigured(): boolean {
  return backendOrigin() !== null && signingKey() !== null;
}

/**
 * Error raised for a non-2xx response from `/internal/hosted/*`. `code` is
 * the backend's RPC error code (`unauthenticated`, `forbidden`, `not-found`,
 * `unavailable`, …); `details` carries e.g. `reason: 'checkout-disabled'`.
 */
export class HostedApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: Record<string, unknown> | undefined;

  constructor(status: number, code: string, details?: Record<string, unknown>) {
    super(`Hosted API ${status}: ${code}`);
    this.name = "HostedApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * POSTs a JSON body to `${ANVIL_BACKEND_ORIGIN}${path}` with the HMAC
 * service-signature headers. The signature covers the exact body bytes and
 * the `pathname + search`, so `path` may carry a query string.
 */
export async function hostedCall<T>(path: string, body: unknown): Promise<T> {
  const origin = backendOrigin();
  const key = signingKey();
  if (origin === null || key === null) {
    throw new HostedApiError(0, "unconfigured");
  }
  const bodyBytes = encoder.encode(JSON.stringify(body ?? {}));
  const pathWithQuery = normalizePathWithQuery(path);
  const signature = await signRequest(pathWithQuery, "POST", bodyBytes);
  let response: Response;
  try {
    response = await fetch(`${origin}${pathWithQuery}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...signature
      },
      body: bodyBytes,
      cache: "no-store",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    });
  } catch (error) {
    throw new HostedApiError(
      0,
      error instanceof Error && error.name === "TimeoutError" ? "timeout" : "unavailable"
    );
  }
  const payload = (await response.json().catch(() => null)) as unknown;
  if (!response.ok) {
    const error = isRecord(payload) && isRecord(payload["error"]) ? payload["error"] : null;
    const code = typeof error?.["code"] === "string" ? error["code"] : "unavailable";
    const details = isRecord(error?.["details"])
      ? (error["details"] as Record<string, unknown>)
      : undefined;
    throw new HostedApiError(response.status, code, details);
  }
  return payload as T;
}

/** POST /internal/hosted/account — billing-account lookup for the identity. */
export function getAccount(identity: HostedIdentity): Promise<HostedAccount> {
  return hostedCall<HostedAccount>("/internal/hosted/account", identity);
}

/** POST /internal/hosted/billing — entitlement + subscription + checkout state. */
export function getBilling(identity: HostedIdentity): Promise<HostedBillingOverview> {
  return hostedCall<HostedBillingOverview>("/internal/hosted/billing", identity);
}

/** POST /internal/hosted/entitlement — stored entitlement snapshot. */
export function getEntitlement(identity: HostedIdentity): Promise<HostedEntitlement> {
  return hostedCall<HostedEntitlement>("/internal/hosted/entitlement", identity);
}

/** POST /internal/hosted/checkout — Stripe Checkout session for an interval. */
export function createCheckout(
  identity: HostedIdentity,
  interval: HostedBillingInterval
): Promise<HostedCheckoutResult> {
  return hostedCall<HostedCheckoutResult>("/internal/hosted/checkout", { ...identity, interval });
}

/** POST /internal/hosted/portal — Stripe Customer Portal session. */
export function createPortal(identity: HostedIdentity): Promise<HostedPortalResult> {
  return hostedCall<HostedPortalResult>("/internal/hosted/portal", identity);
}

/** POST /internal/hosted/pair-device — one-time enrollment code for a new device. */
export function pairDevice(
  identity: HostedIdentity,
  displayName?: string
): Promise<HostedPairDeviceResult> {
  return hostedCall<HostedPairDeviceResult>("/internal/hosted/pair-device", {
    ...identity,
    ...(displayName ? { displayName } : {})
  });
}

/** POST /internal/hosted/link-code — code to bind an existing sync account. */
export function createLinkCode(identity: HostedIdentity): Promise<HostedLinkCodeResult> {
  return hostedCall<HostedLinkCodeResult>("/internal/hosted/link-code", identity);
}

/** POST /internal/hosted/devices — account device list (route not deployed yet). */
export function listDevices(identity: HostedIdentity): Promise<HostedDeviceListResult> {
  return hostedCall<HostedDeviceListResult>("/internal/hosted/devices", identity);
}

/** POST /internal/hosted/device-rename (route not deployed yet). */
export function renameDevice(
  identity: HostedIdentity,
  enrollmentId: string,
  displayName: string
): Promise<{ renamed: boolean; enrollmentId: string }> {
  return hostedCall("/internal/hosted/device-rename", { ...identity, enrollmentId, displayName });
}

/** POST /internal/hosted/device-revoke (route not deployed yet). */
export function revokeDevice(
  identity: HostedIdentity,
  enrollmentId: string
): Promise<{ revoked: boolean; enrollmentId: string }> {
  return hostedCall("/internal/hosted/device-revoke", { ...identity, enrollmentId });
}

/** POST /internal/hosted/data-status — hosted deletion status (route not deployed yet). */
export function getDataStatus(identity: HostedIdentity): Promise<HostedDataStatusResult> {
  return hostedCall<HostedDataStatusResult>("/internal/hosted/data-status", identity);
}

/** POST /internal/hosted/delete-account — schedule hosted data purge (route not deployed yet). */
export function deleteAccount(identity: HostedIdentity): Promise<HostedDeleteAccountResult> {
  return hostedCall<HostedDeleteAccountResult>("/internal/hosted/delete-account", identity);
}

/** POST /internal/hosted/reconcile — re-pull subscription truth from Stripe. */
export function reconcile(identity: HostedIdentity): Promise<HostedReconcileResult> {
  return hostedCall<HostedReconcileResult>("/internal/hosted/reconcile", identity);
}
