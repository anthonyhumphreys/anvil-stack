import "server-only";

import { deploymentVariable } from "@/lib/deployment-env.js";
import { normalizePathWithQuery, signRequest } from "./signing";
import type {
  HostedAccount,
  HostedBillingOverview,
  HostedDashboardRequestInput,
  HostedDashboardRequestResult,
  HostedDashboardTrustRevokeInput,
  HostedDashboardTrustRevokeResult,
  HostedDashboardGrantRevokeResult,
  HostedDashboardCommandStatusResult,
  HostedDashboardCommandSubmitResult,
  BrowserWorkspaceCommandEnvelope,
  HostedDashboardSnapshotResult,
  HostedDashboardStatus,
  HostedDataStatusResult,
  HostedDeleteAccountResult,
  HostedDeviceListResult,
  HostedWorkspaceMachine,
  HostedEntitlement,
  HostedIdentity,
  HostedOrganizationAcceptResult,
  HostedOrganizationCreateResult,
  HostedOrganizationInviteResult,
  HostedOrganizationListResult,
  HostedOrganizationRole,
  HostedLinkCodeResult,
  HostedPairDeviceResult,
  HostedPortalResult,
  HostedReconcileResult
} from "./types";
import {
  MESH_MACHINE_CAPABILITIES,
  MESH_MACHINE_OPERATIONS,
  type MeshMachineHost,
  type MeshMachineHostsResponse,
  type MeshMachineRoute,
  type MeshMachineAdmissionIssueRequest,
  type MeshMachineAdmissionIssueResponse
} from "../../../anvil-app/cloud/contract/machine.js";

const encoder = new TextEncoder();
const REQUEST_TIMEOUT_MS = 10_000;

function backendOrigin(): string | null {
  const origin = deploymentVariable("BACKEND_ORIGIN", "ANVIL_BACKEND_ORIGIN");
  if (typeof origin !== "string" || origin.length === 0) return null;
  try {
    const url = new URL(origin);
    return url.origin;
  } catch {
    return null;
  }
}

function signingKey(): { keyId: string; secret: string } | null {
  const keyId = deploymentVariable("HOSTED_KEY_ID", "ANVIL_HOSTED_KEY_ID");
  const secret = deploymentVariable("HOSTED_SERVICE_SECRET", "ANVIL_HOSTED_SERVICE_SECRET");
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
 * `unavailable`, …); `details` may carry a backend-specific reason.
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

function isMeshMachineRoute(value: unknown, machineId: string, endpointGeneration: string): value is MeshMachineRoute {
  if (!isRecord(value)) return false;
  if (
    (value.kind !== "private" && value.kind !== "https" && value.kind !== "managed") ||
    typeof value.url !== "string" || value.machineId !== machineId ||
    value.endpointGeneration !== endpointGeneration || typeof value.reachableUntil !== "string" ||
    !Number.isFinite(Date.parse(value.reachableUntil))
  ) return false;
  try {
    const url = new URL(value.url);
    return (url.protocol === "http:" || url.protocol === "https:") && !url.username && !url.password && !url.search && !url.hash;
  } catch {
    return false;
  }
}

function isMeshMachineHost(value: unknown): value is MeshMachineHost {
  if (!isRecord(value) || !Array.isArray(value.capabilities) || !Array.isArray(value.operations) || !Array.isArray(value.routes)) return false;
  if (
    typeof value.enrollmentId !== "string" || !/^[A-Za-z0-9_-]{1,200}$/.test(value.enrollmentId) ||
    typeof value.machineId !== "string" || !/^[A-Za-z0-9_-]{1,200}$/.test(value.machineId) ||
    typeof value.endpointGeneration !== "string" || !/^[A-Za-z0-9_-]{1,200}$/.test(value.endpointGeneration) ||
    value.protocolVersion !== 1 ||
    typeof value.online !== "boolean" || typeof value.lastSeenAt !== "string" ||
    typeof value.reachableUntil !== "string" || !Number.isFinite(Date.parse(value.reachableUntil)) ||
    !["disabled", "unallocated", "allocating", "ready", "retiring", "failed"].includes(String(value.allocationState)) ||
    !value.capabilities.every((item) => typeof item === "string" && (MESH_MACHINE_CAPABILITIES as readonly string[]).includes(item)) ||
    !value.operations.every((item) => typeof item === "string" && (MESH_MACHINE_OPERATIONS as readonly string[]).includes(item)) ||
    !value.routes.every((route) => isMeshMachineRoute(route, value.machineId as string, value.endpointGeneration as string))
  ) return false;
  return true;
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

/**
 * Signed POST like {@link hostedCall} but returns the raw Response — for
 * routes that stream artifact bytes with `x-anvil-*` metadata headers
 * instead of a JSON payload.
 */
export async function hostedCallRaw(path: string, body: unknown): Promise<Response> {
  const origin = backendOrigin();
  const key = signingKey();
  if (origin === null || key === null) {
    throw new HostedApiError(0, "unconfigured");
  }
  const bodyBytes = encoder.encode(JSON.stringify(body ?? {}));
  const pathWithQuery = normalizePathWithQuery(path);
  const signature = await signRequest(pathWithQuery, "POST", bodyBytes);
  try {
    return await fetch(`${origin}${pathWithQuery}`, {
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
}

/**
 * POST /internal/hosted/shared-artifact — resolves a published share to
 * its bytes plus `x-anvil-share-*` metadata headers. Non-2xx means the
 * share is revoked, expired, or never existed.
 */
export function fetchSharedArtifact(shareId: string): Promise<Response> {
  return hostedCallRaw("/internal/hosted/shared-artifact", { shareId });
}

/** POST /internal/hosted/account — billing-account lookup for the identity. */
export function getAccount(identity: HostedIdentity): Promise<HostedAccount> {
  return hostedCall<HostedAccount>("/internal/hosted/account", identity);
}

/** POST /internal/hosted/billing — access state and legacy payment records. */
export function getBilling(identity: HostedIdentity): Promise<HostedBillingOverview> {
  return hostedCall<HostedBillingOverview>("/internal/hosted/billing", identity);
}

/** POST /internal/hosted/entitlement — stored entitlement snapshot. */
export function getEntitlement(identity: HostedIdentity): Promise<HostedEntitlement> {
  return hostedCall<HostedEntitlement>("/internal/hosted/entitlement", identity);
}

/** POST /internal/hosted/portal — Stripe Customer Portal session. */
export function createPortal(identity: HostedIdentity): Promise<HostedPortalResult> {
  return hostedCall<HostedPortalResult>("/internal/hosted/portal", identity);
}

/** Organization billing is scoped to the organization customer in Stripe. */
export function createOrganizationPortal(
  identity: HostedIdentity,
  organizationId: string
): Promise<HostedPortalResult> {
  return hostedCall<HostedPortalResult>("/internal/hosted/portal", {
    ...identity,
    organizationId
  });
}

export function listOrganizations(identity: HostedIdentity): Promise<HostedOrganizationListResult> {
  return hostedCall<HostedOrganizationListResult>("/internal/hosted/organizations", { identity });
}

/** Creates a free organisation with its owner counted within the five-member limit. */
export function createOrganization(
  identity: HostedIdentity,
  name: string,
  idempotencyKey: string
): Promise<HostedOrganizationCreateResult> {
  return hostedCall<HostedOrganizationCreateResult>("/internal/hosted/organization-create", {
    identity,
    name,
    idempotencyKey,
    ownerSeatAssigned: true
  });
}

export function inviteOrganizationMember(
  identity: HostedIdentity,
  organizationId: string,
  email: string
): Promise<HostedOrganizationInviteResult> {
  return hostedCall<HostedOrganizationInviteResult>("/internal/hosted/organization-invite", {
    identity,
    organizationId,
    email
  });
}

export function acceptOrganizationInvitation(
  identity: HostedIdentity,
  invitationToken: string
): Promise<HostedOrganizationAcceptResult> {
  return hostedCall<HostedOrganizationAcceptResult>(
    "/internal/hosted/organization-invitation-accept",
    { identity, invitationToken }
  );
}

export function removeOrganizationMember(
  identity: HostedIdentity,
  organizationId: string,
  workosUserId: string
): Promise<{ removed: boolean }> {
  return hostedCall("/internal/hosted/organization-member-remove", {
    identity,
    organizationId,
    workosUserId
  });
}

export function leaveOrganization(
  identity: HostedIdentity,
  organizationId: string
): Promise<{ left: boolean }> {
  return hostedCall("/internal/hosted/organization-leave", { identity, organizationId });
}

export function updateOrganizationRole(
  identity: HostedIdentity,
  organizationId: string,
  workosUserId: string,
  role: HostedOrganizationRole
): Promise<{ updated: boolean }> {
  return hostedCall("/internal/hosted/organization-role", {
    identity,
    organizationId,
    workosUserId,
    role
  });
}

export function revokeOrganizationInvitation(
  identity: HostedIdentity,
  organizationId: string,
  invitationId: string
): Promise<{ revoked: boolean }> {
  return hostedCall("/internal/hosted/organization-invitation-revoke", {
    identity,
    organizationId,
    invitationId
  });
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

/** POST /internal/hosted/devices — account-scoped enrolled device list. */
export function listDevices(identity: HostedIdentity): Promise<HostedDeviceListResult> {
  return hostedCall<HostedDeviceListResult>("/internal/hosted/devices", identity);
}

/** Signed, WorkOS-scoped discovery for browser clients that hold no device bearer. */
export async function listMeshHosts(identity: HostedIdentity): Promise<MeshMachineHost[]> {
  const result = await hostedCall<MeshMachineHostsResponse>("/internal/hosted/mesh-hosts", identity);
  if (!isRecord(result) || result.v !== 1 || !Array.isArray(result.hosts)) return [];
  return result.hosts.filter(isMeshMachineHost);
}

/** Issues a one-use admission ticket through the signed WorkOS identity channel. */
export function issueMeshMachineAdmissionTicket(
  identity: HostedIdentity,
  machineId: string,
  request: Extract<MeshMachineAdmissionIssueRequest, { kind: "dashboard" }>,
): Promise<MeshMachineAdmissionIssueResponse> {
  return hostedCall<MeshMachineAdmissionIssueResponse>("/internal/hosted/mesh-machine-admission", {
    ...identity,
    machineId,
    ...request,
  });
}

/** Active person-owned machines that a browser may target for Desktop approval. */
export async function listWorkspaceMachines(
  identity: HostedIdentity,
): Promise<HostedWorkspaceMachine[]> {
  const [{ devices }, meshHosts] = await Promise.all([
    listDevices(identity),
    listMeshHosts(identity).catch(() => []),
  ]);
  const meshHostByEnrollment = new Map(meshHosts.map((host) => [host.enrollmentId, host]));
  return devices
    .filter(
      (device) =>
        !device.revoked &&
        device.enrollmentClass === "device" &&
        device.trustState === "trusted",
    )
    .map((device) => ({
      enrollmentId: device.enrollmentId,
      name: device.displayName?.trim() || `Anvil Desktop · ${device.enrollmentId.slice(-6)}`,
      status: "unknown",
      ...(meshHostByEnrollment.has(device.enrollmentId)
        ? { meshHost: meshHostByEnrollment.get(device.enrollmentId) }
        : {}),
    }));
}

/** POST /internal/hosted/device-rename. */
export function renameDevice(
  identity: HostedIdentity,
  enrollmentId: string,
  displayName: string
): Promise<{ renamed: boolean; enrollmentId: string }> {
  return hostedCall("/internal/hosted/device-rename", { ...identity, enrollmentId, displayName });
}

/** POST /internal/hosted/device-revoke. */
export function revokeDevice(
  identity: HostedIdentity,
  enrollmentId: string
): Promise<{ revoked: boolean; enrollmentId: string }> {
  return hostedCall("/internal/hosted/device-revoke", { ...identity, enrollmentId });
}

/** POST /internal/hosted/data-status — hosted deletion status. */
export function getDataStatus(identity: HostedIdentity): Promise<HostedDataStatusResult> {
  return hostedCall<HostedDataStatusResult>("/internal/hosted/data-status", identity);
}

/** POST /internal/hosted/delete-account — schedule hosted data purge. */
export function deleteAccount(identity: HostedIdentity): Promise<HostedDeleteAccountResult> {
  return hostedCall<HostedDeleteAccountResult>("/internal/hosted/delete-account", identity);
}

/** POST /internal/hosted/reconcile — re-pull subscription truth from Stripe. */
export function reconcile(identity: HostedIdentity): Promise<HostedReconcileResult> {
  return hostedCall<HostedReconcileResult>("/internal/hosted/reconcile", identity);
}

/**
 * POST /internal/hosted/dashboard-request — upsert the browser's
 * authorization request. Identity fields ride the same body; the backend
 * stamps the resolved sync account so a request can never name another.
 */
export function submitDashboardRequest(
  identity: HostedIdentity,
  request: HostedDashboardRequestInput
): Promise<HostedDashboardRequestResult> {
  return hostedCall<HostedDashboardRequestResult>("/internal/hosted/dashboard-request", {
    ...identity,
    request
  });
}

/** POST /internal/hosted/dashboard-trust-revoke — revoke one remembered browser. */
export function revokeDashboardTrust(
  identity: HostedIdentity,
  request: HostedDashboardTrustRevokeInput,
): Promise<HostedDashboardTrustRevokeResult> {
  return hostedCall<HostedDashboardTrustRevokeResult>("/internal/hosted/dashboard-trust-revoke", {
    ...identity,
    request,
  });
}

/** POST /internal/hosted/dashboard-revoke — revoke one browser session grant. */
export function revokeDashboardGrant(
  identity: HostedIdentity,
  requestId: string,
): Promise<HostedDashboardGrantRevokeResult> {
  return hostedCall<HostedDashboardGrantRevokeResult>("/internal/hosted/dashboard-revoke", {
    ...identity,
    requestId,
  });
}

/**
 * POST /internal/hosted/dashboard-status — lifecycle state, the sealed
 * DSK grant once approved, and the latest snapshot seq.
 */
export function getDashboardStatus(
  identity: HostedIdentity,
  requestId: string
): Promise<HostedDashboardStatus> {
  return hostedCall<HostedDashboardStatus>("/internal/hosted/dashboard-status", {
    ...identity,
    requestId
  });
}

/** POST /internal/hosted/dashboard-snapshot — the latest sealed snapshot. */
export function getDashboardSnapshot(
  identity: HostedIdentity,
  requestId: string
): Promise<HostedDashboardSnapshotResult> {
  return hostedCall<HostedDashboardSnapshotResult>("/internal/hosted/dashboard-snapshot", {
    ...identity,
    requestId
  });
}

/**
 * POST /internal/hosted/dashboard-command-submit — deposits one opaque
 * browser-workspace/1 command. The website never receives or forwards the
 * decrypted command parameters.
 */
export function submitDashboardCommand(
  identity: HostedIdentity,
  requestId: string,
  command: BrowserWorkspaceCommandEnvelope
): Promise<HostedDashboardCommandSubmitResult> {
  return hostedCall<HostedDashboardCommandSubmitResult>(
    "/internal/hosted/dashboard-command-submit",
    { ...identity, requestId, command }
  );
}

/** Polls one command by its stable id. Results remain opaque until the browser opens them. */
export function getDashboardCommandStatus(
  identity: HostedIdentity,
  requestId: string,
  commandId: string
): Promise<HostedDashboardCommandStatusResult> {
  return hostedCall<HostedDashboardCommandStatusResult>(
    "/internal/hosted/dashboard-command-status",
    { ...identity, requestId, commandId }
  );
}
