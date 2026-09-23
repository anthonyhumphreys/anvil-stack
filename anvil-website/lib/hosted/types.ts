// Response shapes for the backend's `/internal/hosted/*` service channel.
// These mirror the contract types in anvil-app/cloud/contract (auth.ts,
// entitlements.ts) and the route responses in src/hosted/routes.ts and
// src/hosted/billing-routes.ts. Keep them aligned with the backend — the
// signer is byte-checked, the payloads are convention-checked.

/** Identity the website asserts for a signed-in WorkOS user. */
export interface HostedIdentity {
  workosClientId: string;
  workosUserId: string;
}

export type HostedLifecycle = "active" | "deleting" | "deleted";

export type HostedAccessState = "preview" | "active" | "grace" | "restricted" | "unknown";
export type HostedAccessSource =
  | "preview"
  | "subscription"
  | "renewal-grace"
  | "outage-grace"
  | "none";

export interface HostedLimits {
  devices: number;
  artifactBytes: number;
  historyBytes: number;
}

export interface HostedEntitlement {
  state: HostedAccessState;
  source: HostedAccessSource;
  planKey: "sync_personal" | null;
  capabilities: { syncWrite: boolean; meshSubmit: boolean };
  limits: HostedLimits;
  previewEndsAt: string;
  accessUntil: string | null;
  graceUntil: string | null;
  checkedAt: string;
  revision: number;
  reason:
    | "preview"
    | "paid"
    | "renewal-failed"
    | "billing-outage"
    | "preview-ended"
    | "subscription-required"
    | "account-deleted"
    | "billing-unavailable";
}

/** POST /internal/hosted/account */
export interface HostedAccount {
  billingAccountId: string;
  syncAccountId: string | null;
  generation: number;
  lifecycle: HostedLifecycle;
}

export interface HostedSubscription {
  planKey: string;
  interval: string;
  status: string;
  currentPeriodEnd: number;
  cancelAtPeriodEnd: boolean;
}

export interface HostedPendingCheckout {
  sessionId: string;
  createdAt: number;
}

/** POST /internal/hosted/billing */
export interface HostedBillingOverview {
  billingAccountId: string;
  lifecycle: HostedLifecycle;
  entitlement: HostedEntitlement;
  subscription: HostedSubscription | null;
  pendingCheckout: HostedPendingCheckout | null;
  lastReconcileAt: number | null;
  lastWebhookAt: number | null;
}

/** POST /internal/hosted/pair-device */
export interface HostedPairDeviceResult {
  code: string;
  expiresAt: string;
  accountId: string;
}

/** POST /internal/hosted/link-code */
export interface HostedLinkCodeResult {
  linkCode: string;
  expiresAt: string;
}

export type HostedBillingInterval = "month" | "year";

/** POST /internal/hosted/checkout */
export interface HostedCheckoutResult {
  checkoutUrl: string;
  sessionId: string;
}

/** POST /internal/hosted/portal */
export interface HostedPortalResult {
  portalUrl: string;
}

/** POST /internal/hosted/reconcile */
export interface HostedReconcileResult {
  reconciled: boolean;
  subscriptions: number;
}

/**
 * Device/deletion shapes below mirror the device-authenticated RPC contract
 * (contract/auth.ts). The `/internal/hosted/*` routes for them are not
 * deployed yet — callers must tolerate a `not-found` HostedApiError.
 */
export interface HostedDeviceSummary {
  enrollmentId: string;
  displayName?: string;
  installationId: string;
  credentialGeneration: number;
  revoked: boolean;
  createdAt: string;
  self: boolean;
}

export interface HostedDeviceListResult {
  devices: HostedDeviceSummary[];
}

export type HostedDeletionState = "none" | "deleting" | "deleted";

export interface HostedDataStatusResult {
  state: HostedDeletionState;
  deletionGeneration?: number;
  startedAt?: string;
  deletedAt?: string;
  purgedRows?: number;
}

export interface HostedDeleteAccountResult {
  state: Exclude<HostedDeletionState, "none">;
  deletionGeneration: number;
  startedAt: string;
}

// ---- Dashboard authorization -------------------------------------------------
// These mirror anvil-app/cloud/contract/dashboard.ts and sealed.ts. The
// browser posts an ephemeral X25519 request, polls status for the sealed
// DSK grant, then pulls sealed snapshots — every envelope is opaque to the
// coordinator and this channel.

export type DashboardScope =
  | "read-dashboard"
  | "submit-task"
  | "approve-action"
  | "request-handoff"
  | "workspace-read"
  | "workspace-write"
  | "terminal"
  | "preview";

export type DashboardRequestState =
  | "pending"
  | "approved"
  | "denied"
  | "expired"
  | "revoked";

/** A workspace binding is intentionally repository-scoped; it is not a workspace wildcard. */
export interface BrowserWorkspaceBinding {
  workspaceId: string;
  repositoryIds: string[];
}

/** Browser → POST /internal/hosted/dashboard-request */
export interface HostedDashboardRequestInput {
  requestId: string;
  browserPub: string;
  challenge: string;
  scopes: DashboardScope[];
  workspaceBindings?: BrowserWorkspaceBinding[];
  /** @deprecated use workspaceBindings; retained for legacy dashboard callers. */
  workspaceIds?: string[];
  /** @deprecated use workspaceBindings; retained for legacy dashboard callers. */
  repositoryIds?: string[];
  expiresAt: string;
  origin?: string;
  userAgent?: string;
}

export interface HostedDashboardRequestResult {
  request: {
    requestId: string;
    state: DashboardRequestState;
    expiresAt: string;
  };
}

/** Sealed DSK wrap minted by the approving device (contract DashboardGrantPayload). */
export interface DashboardGrantPayload {
  v: 1;
  enc: "x25519-aes-256-gcm";
  requestId: string;
  browserPub: string;
  expiresAt: string;
  ephPub: string;
  nonce: string;
  ct: string;
}

/** AES-256-GCM snapshot under the DSK (contract SealedDashboardSnapshot). */
export interface SealedDashboardSnapshot {
  enc: "aes-256-gcm";
  seq: number;
  nonce: string;
  ct: string;
}

/** POST /internal/hosted/dashboard-status */
export interface HostedDashboardStatus {
  requestId: string;
  state: DashboardRequestState;
  accountId?: string;
  backendId?: string;
  grant?: DashboardGrantPayload;
  snapshotSeq?: number;
  expiresAt?: string;
}

/** POST /internal/hosted/dashboard-snapshot */
export interface HostedDashboardSnapshotResult {
  requestId: string;
  snapshot?: SealedDashboardSnapshot;
}

// ---- Browser workspace command relay ---------------------------------------
// These fields intentionally mirror the shared browser-workspace/1 contract.
// `ct` is opaque to the hosted service. Only routing metadata is validated or
// indexed by the coordinator.

export const BROWSER_WORKSPACE_OPERATIONS = [
  "workspace.get",
  "repo.list",
  "file.list",
  "file.read",
  "file.write",
  "chat.thread.list",
  "chat.create",
  "chat.history.read",
  "chat.session.start",
  "chat.send",
  "chat.status",
  "chat.cancel",
  "chat.approvals.list",
  "chat.approve",
  "chat.input",
  "git.status",
  "git.diff",
  "workflow.list",
  "workflow.get",
  "workflow.start",
  "workflow.cancel",
  "terminal.create",
  "terminal.read",
  "terminal.write",
  "terminal.resize",
  "terminal.close",
  "preview.screenshot"
] as const;

export type BrowserWorkspaceOperation = (typeof BROWSER_WORKSPACE_OPERATIONS)[number];

export type BrowserWorkspaceScope =
  | "workspace-read"
  | "workspace-write"
  | "submit-task"
  | "approve-action"
  | "terminal"
  | "preview";

export const BROWSER_WORKSPACE_OPERATION_SCOPE: Record<
  BrowserWorkspaceOperation,
  BrowserWorkspaceScope
> = {
  "workspace.get": "workspace-read",
  "repo.list": "workspace-read",
  "file.list": "workspace-read",
  "file.read": "workspace-read",
  "file.write": "workspace-write",
  "chat.thread.list": "workspace-read",
  "chat.create": "submit-task",
  "chat.history.read": "workspace-read",
  "chat.session.start": "submit-task",
  "chat.send": "submit-task",
  "chat.status": "workspace-read",
  "chat.cancel": "submit-task",
  "chat.approvals.list": "workspace-read",
  "chat.approve": "approve-action",
  "chat.input": "approve-action",
  "git.status": "workspace-read",
  "git.diff": "workspace-read",
  "workflow.list": "workspace-read",
  "workflow.get": "workspace-read",
  "workflow.start": "submit-task",
  "workflow.cancel": "submit-task",
  "terminal.create": "terminal",
  "terminal.read": "terminal",
  "terminal.write": "terminal",
  "terminal.resize": "terminal",
  "terminal.close": "terminal",
  "preview.screenshot": "preview"
};

export interface BrowserWorkspaceCommandEnvelope {
  v: 1;
  enc: "aes-256-gcm";
  requestId: string;
  commandId: string;
  operation: BrowserWorkspaceOperation;
  workspaceId: string;
  repositoryId?: string;
  expiresAt: string;
  nonce: string;
  ct: string;
}

/** Shared transport and decrypted-payload ceilings mirrored from browser-workspace/1. */
export const BROWSER_WORKSPACE_MAX_RPC_BODY_BYTES = 512 * 1024;
export const BROWSER_WORKSPACE_MAX_ENVELOPE_BYTES = 384 * 1024;
export const BROWSER_WORKSPACE_MAX_RESULT_PLAINTEXT_BYTES = 256 * 1024;
export const BROWSER_WORKSPACE_MAX_FILE_CONTENT_BYTES = 64 * 1024;
export const BROWSER_WORKSPACE_MAX_FILE_READ_BYTES = 512 * 1024;
export const BROWSER_WORKSPACE_MAX_HISTORY_BYTES = 512 * 1024;
export const BROWSER_WORKSPACE_MAX_DIFF_BYTES = 512 * 1024;
export const BROWSER_WORKSPACE_MAX_TERMINAL_READ_BYTES = 128 * 1024;
export const BROWSER_WORKSPACE_MAX_PREVIEW_PNG_BYTES = 180 * 1024;
export const BROWSER_WORKSPACE_MAX_CHAT_MESSAGE_CHARS = 32_000;

export interface BrowserWorkspaceResultEnvelope {
  v: 1;
  enc: "aes-256-gcm";
  requestId: string;
  commandId: string;
  operation: BrowserWorkspaceOperation;
  workspaceId: string;
  repositoryId?: string;
  expiresAt: string;
  nonce: string;
  ct: string;
}

export type DashboardCommandState =
  | "queued"
  | "claimed"
  | "completed"
  | "failed"
  | "expired"
  | "revoked"
  | "unknown-outcome";

export interface HostedDashboardCommandSubmitResult {
  requestId: string;
  commandId: string;
  state: DashboardCommandState;
  deduplicated: boolean;
  expiresAt: string;
}

export interface HostedDashboardCommandStatusResult {
  requestId: string;
  commandId: string;
  operation: BrowserWorkspaceOperation;
  state: DashboardCommandState;
  expiresAt: string;
  result?: BrowserWorkspaceResultEnvelope;
}
