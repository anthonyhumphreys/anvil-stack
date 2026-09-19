"use server";

import { hostedIdentity } from "@/lib/auth";
import {
  getDashboardSnapshot,
  getDashboardStatus,
  hostedConfigured,
  submitDashboardRequest,
  HostedApiError
} from "@/lib/hosted";
import type {
  HostedDashboardRequestResult,
  HostedDashboardSnapshotResult,
  HostedDashboardStatus
} from "@/lib/hosted/types";
import { workosConfigured } from "@/lib/workos-env";

export type DashboardActionResult<T> =
  | { ok: true; data: T }
  | { ok: false; code: string; message: string };

const NOT_CONFIGURED: DashboardActionResult<never> = {
  ok: false,
  code: "unconfigured",
  message: "The hosted account service is not configured on this deployment."
};

function fail(error: unknown): DashboardActionResult<never> {
  if (error instanceof HostedApiError) {
    const reason =
      error.details && typeof error.details["reason"] === "string"
        ? (error.details["reason"] as string)
        : null;
    if (reason === "account-deleted") {
      return { ok: false, code: error.code, message: "This hosted account has been deleted." };
    }
    if (reason === "no-sync-account") {
      return {
        ok: false,
        code: error.code,
        message: "No sync account is linked yet — use the pairing card below to connect a device."
      };
    }
    return {
      ok: false,
      code: error.code,
      message: `The dashboard service returned ${error.code}.`
    };
  }
  return { ok: false, code: "unavailable", message: "Something went wrong. Try again." };
}

async function requireIdentity() {
  if (!workosConfigured() || !hostedConfigured()) return null;
  return hostedIdentity();
}

const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{8,80}$/;
const REQUEST_SCOPES = [
  "read-dashboard",
  "submit-task",
  "approve-action",
  "request-handoff"
] as const;
const EXPIRY_MIN_MS = 60_000;
const EXPIRY_MAX_MS = 24 * 60 * 60_000;

export interface DashboardRequestSubmission {
  requestId: string;
  browserPub: string;
  challenge: string;
  scopes: string[];
  expiresAt: string;
  origin?: string;
  userAgent?: string;
}

/**
 * Posts the browser's ephemeral-key authorization request. Validation is
 * deliberately tight: the coordinator independently enforces scope/expiry
 * bounds, so bad input fails closed here rather than as a pending row.
 */
export async function requestDashboardAccessAction(
  input: DashboardRequestSubmission
): Promise<DashboardActionResult<HostedDashboardRequestResult>> {
  const identity = await requireIdentity();
  if (!identity) return NOT_CONFIGURED;
  if (!REQUEST_ID_PATTERN.test(input.requestId)) {
    return { ok: false, code: "malformed-request", message: "Malformed request." };
  }
  const scopes = input.scopes.filter((s): s is (typeof REQUEST_SCOPES)[number] =>
    (REQUEST_SCOPES as readonly string[]).includes(s)
  );
  if (scopes.length !== input.scopes.length || scopes.length === 0) {
    return { ok: false, code: "malformed-request", message: "Unknown dashboard scope." };
  }
  const expiresAtMs = Date.parse(input.expiresAt);
  if (
    !Number.isFinite(expiresAtMs) ||
    expiresAtMs - Date.now() < EXPIRY_MIN_MS ||
    expiresAtMs - Date.now() > EXPIRY_MAX_MS
  ) {
    return { ok: false, code: "malformed-request", message: "Expiry out of bounds." };
  }
  try {
    const data = await submitDashboardRequest(identity, {
      requestId: input.requestId,
      browserPub: input.browserPub,
      challenge: input.challenge,
      scopes,
      expiresAt: new Date(expiresAtMs).toISOString(),
      ...(input.origin === undefined ? {} : { origin: input.origin.slice(0, 200) }),
      ...(input.userAgent === undefined ? {} : { userAgent: input.userAgent.slice(0, 300) })
    });
    return { ok: true, data };
  } catch (error) {
    return fail(error);
  }
}

/** Polls request state — returns the sealed grant once a device approves. */
export async function dashboardStatusAction(
  requestId: string
): Promise<DashboardActionResult<HostedDashboardStatus>> {
  const identity = await requireIdentity();
  if (!identity) return NOT_CONFIGURED;
  if (!REQUEST_ID_PATTERN.test(requestId)) {
    return { ok: false, code: "malformed-request", message: "Malformed request." };
  }
  try {
    return { ok: true, data: await getDashboardStatus(identity, requestId) };
  } catch (error) {
    return fail(error);
  }
}

/** Fetches the latest sealed snapshot for an approved request. */
export async function dashboardSnapshotAction(
  requestId: string
): Promise<DashboardActionResult<HostedDashboardSnapshotResult>> {
  const identity = await requireIdentity();
  if (!identity) return NOT_CONFIGURED;
  if (!REQUEST_ID_PATTERN.test(requestId)) {
    return { ok: false, code: "malformed-request", message: "Malformed request." };
  }
  try {
    return { ok: true, data: await getDashboardSnapshot(identity, requestId) };
  } catch (error) {
    return fail(error);
  }
}
