"use server";

import { headers } from "next/headers";
import { hostedIdentity } from "@/lib/auth";
import {
  getDashboardCommandStatus,
  getDashboardStatus,
  hostedConfigured,
  HostedApiError,
  revokeDashboardTrust,
  revokeDashboardGrant,
  submitDashboardCommand,
  submitDashboardRequest
} from "@/lib/hosted";
import {
  BROWSER_WORKSPACE_MAX_ENVELOPE_BYTES,
  BROWSER_WORKSPACE_OPERATIONS
} from "@/lib/hosted/types";
import type {
  BrowserWorkspaceCommandEnvelope,
  BrowserWorkspaceOperation,
  DashboardScope,
  HostedDashboardCommandStatusResult,
  HostedDashboardCommandSubmitResult,
  BrowserWorkspaceBinding,
  HostedDashboardTrustRevokeResult,
  HostedDashboardGrantRevokeResult,
  HostedDashboardRequestResult,
  HostedDashboardStatus
} from "@/lib/hosted/types";
import { workosConfigured } from "@/lib/workos-env";

export type BrowserWorkspaceActionResult<T> =
  | { ok: true; data: T }
  | { ok: false; code: string; message: string };

const NOT_CONFIGURED: BrowserWorkspaceActionResult<never> = {
  ok: false,
  code: "unconfigured",
  message: "The hosted workspace service is not configured on this deployment."
};

const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{8,80}$/;
const KEY_PATTERN = /^[A-Za-z0-9+/]{43}=$/;
const SCOPE_ID_PATTERN = /^[A-Za-z0-9_-]{1,200}$/;
const COMMAND_ID_PATTERN = /^[A-Za-z0-9_-]{8,100}$/;
const COMMAND_TTL_MIN_MS = 1_000;
const COMMAND_TTL_MAX_MS = 10 * 60_000;
const WORKSPACE_SCOPES: readonly DashboardScope[] = [
  "read-dashboard",
  "workspace-read",
  "workspace-write",
  "submit-task",
  "approve-action",
  "request-handoff",
  "terminal",
  "preview"
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isOperation(value: unknown): value is BrowserWorkspaceOperation {
  return (
    typeof value === "string" &&
    (BROWSER_WORKSPACE_OPERATIONS as readonly string[]).includes(value)
  );
}

function isBase64(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9+/]*={0,2}$/.test(value) && value.length % 4 === 0;
}

function decodedBase64Bytes(value: string): number {
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  return (value.length / 4) * 3 - padding;
}

function validOpaqueEnvelope(value: unknown): value is BrowserWorkspaceCommandEnvelope {
  if (!isRecord(value)) return false;
  if (value.v !== 1 || value.enc !== "aes-256-gcm") return false;
  if (typeof value.requestId !== "string" || !REQUEST_ID_PATTERN.test(value.requestId)) return false;
  if (typeof value.commandId !== "string" || !COMMAND_ID_PATTERN.test(value.commandId)) return false;
  if (!isOperation(value.operation)) return false;
  if (typeof value.workspaceId !== "string" || !SCOPE_ID_PATTERN.test(value.workspaceId)) return false;
  if (
    value.repositoryId !== undefined &&
    (typeof value.repositoryId !== "string" || !SCOPE_ID_PATTERN.test(value.repositoryId))
  ) {
    return false;
  }
  if (typeof value.expiresAt !== "string") return false;
  const expiry = Date.parse(value.expiresAt);
  if (!Number.isFinite(expiry)) return false;
  const remaining = expiry - Date.now();
  if (remaining < COMMAND_TTL_MIN_MS || remaining > COMMAND_TTL_MAX_MS) return false;
  if (!isBase64(value.nonce) || decodedBase64Bytes(value.nonce) !== 12) return false;
  if (!isBase64(value.ct) || decodedBase64Bytes(value.ct) < 16) return false;
  return (
    new TextEncoder().encode(JSON.stringify(value)).byteLength <=
    BROWSER_WORKSPACE_MAX_ENVELOPE_BYTES
  );
}

function fail(error: unknown): BrowserWorkspaceActionResult<never> {
  if (error instanceof HostedApiError) {
    const reason =
      error.details && typeof error.details["reason"] === "string"
        ? (error.details["reason"] as string)
        : null;
    if (reason === "account-deleted") {
      return { ok: false, code: error.code, message: "This hosted account has been deleted." };
    }
    if (reason === "no-sync-account") {
      return { ok: false, code: error.code, message: "Connect a trusted Desktop before opening a workspace." };
    }
    if (reason === "request-revoked" || reason === "grant-revoked") {
      return { ok: false, code: "revoked", message: "This browser workspace grant was revoked." };
    }
    if (error.code === "not-found") {
      return {
        ok: false,
        code: "backend-upgrade-required",
        message: "This backend needs an update for browser workspaces."
      };
    }
    return { ok: false, code: error.code, message: `The workspace service returned ${error.code}.` };
  }
  return { ok: false, code: "unavailable", message: "Something went wrong. Try again." };
}

async function requireIdentity() {
  if (!workosConfigured() || !hostedConfigured()) return null;
  return hostedIdentity();
}

export interface BrowserWorkspaceAccessRequest {
  requestId: string;
  targetEnrollmentId: string;
  browserPub: string;
  challenge: string;
  trustId?: string;
  renewalProof?: string;
  scopes: DashboardScope[];
  workspaceBindings?: BrowserWorkspaceBinding[];
  expiresAt: string;
}

async function requestOrigin(): Promise<{ origin: string; userAgent: string | undefined } | null> {
  const incoming = await headers();
  const raw = incoming.get("origin");
  if (!raw || raw.length > 300) return null;
  try {
    const parsed = new URL(raw);
    if (parsed.origin !== raw || parsed.username || parsed.password) return null;
    const local = parsed.protocol === "http:" &&
      (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1" || parsed.hostname === "[::1]");
    if (parsed.protocol !== "https:" && !local) return null;
    return { origin: parsed.origin, userAgent: incoming.get("user-agent")?.slice(0, 300) };
  } catch {
    return null;
  }
}

/** Creates or resumes a browser authorization request with readonly defaults. */
export async function requestBrowserWorkspaceAccessAction(
  input: BrowserWorkspaceAccessRequest
): Promise<BrowserWorkspaceActionResult<HostedDashboardRequestResult>> {
  const identity = await requireIdentity();
  if (!identity) return NOT_CONFIGURED;
  if (!isRecord(input)) {
    return { ok: false, code: "malformed-request", message: "Choose a valid workspace." };
  }
  if (!REQUEST_ID_PATTERN.test(input.requestId) || !KEY_PATTERN.test(input.browserPub)) {
    return { ok: false, code: "malformed-request", message: "Malformed browser key request." };
  }
  if (!isBase64(input.challenge) || decodedBase64Bytes(input.challenge) !== 32) {
    return { ok: false, code: "malformed-request", message: "Malformed browser challenge." };
  }
  if (typeof input.targetEnrollmentId !== "string" || !SCOPE_ID_PATTERN.test(input.targetEnrollmentId)) {
    return { ok: false, code: "malformed-request", message: "Choose a trusted Desktop machine." };
  }
  if (input.workspaceBindings !== undefined && (!Array.isArray(input.workspaceBindings) || input.workspaceBindings.length !== 0)) {
    return { ok: false, code: "malformed-request", message: "Desktop selects workspace access during approval." };
  }
  if (input.scopes !== undefined && !Array.isArray(input.scopes)) {
    return { ok: false, code: "malformed-request", message: "Workspace permission is invalid." };
  }
  const scopes = [...new Set(input.scopes ?? [])] as DashboardScope[];
  if (scopes.length !== 0 || scopes.some((scope) => !WORKSPACE_SCOPES.includes(scope))) {
    return { ok: false, code: "malformed-request", message: "Workspace permission is invalid." };
  }
  const isRenewal = input.trustId !== undefined || input.renewalProof !== undefined;
  if (
    isRenewal &&
    (typeof input.trustId !== "string" || !REQUEST_ID_PATTERN.test(input.trustId) ||
      typeof input.renewalProof !== "string" || !isBase64(input.renewalProof) ||
      decodedBase64Bytes(input.renewalProof) !== 32 || scopes.length !== 0)
  ) {
    return { ok: false, code: "malformed-request", message: "The remembered browser proof is invalid." };
  }
  if (typeof input.expiresAt !== "string") {
    return { ok: false, code: "malformed-request", message: "Expiry out of bounds." };
  }
  const expiresAtMs = Date.parse(input.expiresAt);
  if (!Number.isFinite(expiresAtMs) || expiresAtMs - Date.now() < 60_000 || expiresAtMs - Date.now() > 60 * 60_000) {
    return { ok: false, code: "malformed-request", message: "Expiry out of bounds." };
  }
  const requestIdentity = await requestOrigin();
  if (requestIdentity === null) {
    return { ok: false, code: "origin-required", message: "Open the workspace from its secure website address and try again." };
  }
  try {
    const data = await submitDashboardRequest(identity, {
      requestId: input.requestId,
      targetEnrollmentId: input.targetEnrollmentId,
      ...(isRenewal ? { trustId: input.trustId as string, renewalProof: input.renewalProof as string } : {}),
      browserPub: input.browserPub,
      challenge: input.challenge,
      scopes,
      workspaceBindings: [],
      expiresAt: new Date(expiresAtMs).toISOString(),
      origin: requestIdentity.origin,
      ...(requestIdentity.userAgent === undefined ? {} : { userAgent: requestIdentity.userAgent })
    });
    return { ok: true, data };
  } catch (error) {
    return fail(error);
  }
}

/** Revokes a remembered browser and all of its renewed sessions. */
export async function revokeBrowserWorkspaceTrustAction(
  trustId: string,
): Promise<BrowserWorkspaceActionResult<HostedDashboardTrustRevokeResult>> {
  const identity = await requireIdentity();
  if (!identity) return NOT_CONFIGURED;
  if (typeof trustId !== "string" || !REQUEST_ID_PATTERN.test(trustId)) {
    return { ok: false, code: "malformed-request", message: "Malformed browser trust id." };
  }
  const requestIdentity = await requestOrigin();
  if (requestIdentity === null) {
    return { ok: false, code: "origin-required", message: "Open the workspace from its secure website address and try again." };
  }
  try {
    return {
      ok: true,
      data: await revokeDashboardTrust(identity, { trustId, origin: requestIdentity.origin })
    };
  } catch (error) {
    return fail(error);
  }
}

/** Revokes one temporary browser grant when no remembered trust exists. */
export async function revokeBrowserWorkspaceGrantAction(
  requestId: string,
): Promise<BrowserWorkspaceActionResult<HostedDashboardGrantRevokeResult>> {
  const identity = await requireIdentity();
  if (!identity) return NOT_CONFIGURED;
  if (typeof requestId !== "string" || !REQUEST_ID_PATTERN.test(requestId)) {
    return { ok: false, code: "malformed-request", message: "Malformed browser grant id." };
  }
  try {
    return { ok: true, data: await revokeDashboardGrant(identity, requestId) };
  } catch (error) {
    return fail(error);
  }
}

/** Returns grant routing metadata and the sealed grant, if Desktop approved it. */
export async function browserWorkspaceStatusAction(
  requestId: string
): Promise<BrowserWorkspaceActionResult<HostedDashboardStatus>> {
  const identity = await requireIdentity();
  if (!identity) return NOT_CONFIGURED;
  if (!REQUEST_ID_PATTERN.test(requestId)) {
    return { ok: false, code: "malformed-request", message: "Malformed workspace request." };
  }
  try {
    return { ok: true, data: await getDashboardStatus(identity, requestId) };
  } catch (error) {
    return fail(error);
  }
}

/** Deposits one encrypted command. Retrying the same command id is safe; changing its envelope is not. */
export async function submitBrowserWorkspaceCommandAction(
  requestId: string,
  command: BrowserWorkspaceCommandEnvelope
): Promise<BrowserWorkspaceActionResult<HostedDashboardCommandSubmitResult>> {
  const identity = await requireIdentity();
  if (!identity) return NOT_CONFIGURED;
  if (!validOpaqueEnvelope(command) || command.requestId !== requestId) {
    return { ok: false, code: "malformed-request", message: "Malformed workspace command." };
  }
  try {
    return { ok: true, data: await submitDashboardCommand(identity, requestId, command) };
  } catch (error) {
    return fail(error);
  }
}

/** Polls one command by stable id. It never retries a mutation implicitly. */
export async function browserWorkspaceCommandStatusAction(
  requestId: string,
  commandId: string
): Promise<BrowserWorkspaceActionResult<HostedDashboardCommandStatusResult>> {
  const identity = await requireIdentity();
  if (!identity) return NOT_CONFIGURED;
  if (!REQUEST_ID_PATTERN.test(requestId) || !COMMAND_ID_PATTERN.test(commandId)) {
    return { ok: false, code: "malformed-request", message: "Malformed workspace command." };
  }
  try {
    return { ok: true, data: await getDashboardCommandStatus(identity, requestId, commandId) };
  } catch (error) {
    return fail(error);
  }
}
