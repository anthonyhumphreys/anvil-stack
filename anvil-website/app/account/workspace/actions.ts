"use server";

import { hostedIdentity } from "@/lib/auth";
import {
  getDashboardCommandStatus,
  getDashboardStatus,
  hostedConfigured,
  HostedApiError,
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
  browserPub: string;
  challenge: string;
  workspaceIds: string[];
  repositoryIds?: string[];
  scopes?: DashboardScope[];
  expiresAt: string;
  origin?: string;
  userAgent?: string;
}

/** Creates or resumes a browser authorization request with readonly defaults. */
export async function requestBrowserWorkspaceAccessAction(
  input: BrowserWorkspaceAccessRequest
): Promise<BrowserWorkspaceActionResult<HostedDashboardRequestResult>> {
  const identity = await requireIdentity();
  if (!identity) return NOT_CONFIGURED;
  if (!isRecord(input) || !Array.isArray(input.workspaceIds)) {
    return { ok: false, code: "malformed-request", message: "Choose a valid workspace." };
  }
  if (!REQUEST_ID_PATTERN.test(input.requestId) || !KEY_PATTERN.test(input.browserPub)) {
    return { ok: false, code: "malformed-request", message: "Malformed browser key request." };
  }
  if (!isBase64(input.challenge) || decodedBase64Bytes(input.challenge) !== 32) {
    return { ok: false, code: "malformed-request", message: "Malformed browser challenge." };
  }
  if (
    input.workspaceIds.length === 0 ||
    input.workspaceIds.length > 32 ||
    !input.workspaceIds.every((id) => SCOPE_ID_PATTERN.test(id))
  ) {
    return { ok: false, code: "malformed-request", message: "Choose a valid workspace." };
  }
  if (input.repositoryIds !== undefined && !Array.isArray(input.repositoryIds)) {
    return { ok: false, code: "malformed-request", message: "Repository scope is invalid." };
  }
  const repositoryIds = input.repositoryIds ?? [];
  if (
    repositoryIds.length === 0 ||
    repositoryIds.length > 256 ||
    !repositoryIds.every((id) => SCOPE_ID_PATTERN.test(id))
  ) {
    return { ok: false, code: "malformed-request", message: "Repository scope is invalid." };
  }
  const workspaceBindings: BrowserWorkspaceBinding[] = input.workspaceIds.map((workspaceId) => ({
    workspaceId,
    repositoryIds: [...repositoryIds]
  }));
  if (input.scopes !== undefined && !Array.isArray(input.scopes)) {
    return { ok: false, code: "malformed-request", message: "Workspace permission is invalid." };
  }
  const scopes = [...new Set(input.scopes ?? ["read-dashboard", "workspace-read"])] as DashboardScope[];
  if (scopes.length === 0 || scopes.some((scope) => !WORKSPACE_SCOPES.includes(scope))) {
    return { ok: false, code: "malformed-request", message: "Workspace permission is invalid." };
  }
  if (typeof input.expiresAt !== "string") {
    return { ok: false, code: "malformed-request", message: "Expiry out of bounds." };
  }
  const expiresAtMs = Date.parse(input.expiresAt);
  if (!Number.isFinite(expiresAtMs) || expiresAtMs - Date.now() < 60_000 || expiresAtMs - Date.now() > 24 * 60 * 60_000) {
    return { ok: false, code: "malformed-request", message: "Expiry out of bounds." };
  }
  try {
    const data = await submitDashboardRequest(identity, {
      requestId: input.requestId,
      browserPub: input.browserPub,
      challenge: input.challenge,
      scopes,
      workspaceBindings,
      expiresAt: new Date(expiresAtMs).toISOString(),
      ...(typeof input.origin === "string" ? { origin: input.origin.slice(0, 200) } : {}),
      ...(typeof input.userAgent === "string" ? { userAgent: input.userAgent.slice(0, 300) } : {})
    });
    return { ok: true, data };
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
