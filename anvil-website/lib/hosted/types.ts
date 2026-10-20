// Response shapes for the backend's `/internal/hosted/*` service channel.
// These mirror the contract types in anvil-app/cloud/contract (auth.ts,
// entitlements.ts) and the route responses in src/hosted/routes.ts and
// src/hosted/billing-routes.ts. Keep them aligned with the backend — the
// signer is byte-checked, the payloads are convention-checked.

import type { MeshMachineHost } from "../../../anvil-app/cloud/contract/machine";

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

export type HostedFundingSource = "personal" | "team" | "preview" | "none";

export interface HostedLimits {
  devices: number;
  artifactBytes: number | null;
  historyBytes: number | null;
}

export interface HostedEntitlement {
  state: HostedAccessState;
  source: HostedAccessSource;
  planKey: "sync_personal" | "sync_team" | null;
  fundedBy: HostedFundingSource;
  organizationId: string | null;
  capabilities: { syncWrite: boolean; meshSubmit: boolean };
  limits: HostedLimits;
  previewEndsAt: string;
  accessUntil: string | null;
  graceUntil: string | null;
  checkedAt: string;
  revision: number;
  reason:
    | "free"
    | "preview"
    | "paid"
    | "renewal-failed"
    | "billing-outage"
    | "preview-ended"
    | "subscription-required"
    | "account-deleted"
    | "billing-unavailable"
    | "device-limit-exceeded";
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
  /** Backend-authoritative environment gate for personal checkout. */
  checkoutAvailable: boolean;
  subscription: HostedSubscription | null;
  personalSubscription?: HostedSubscription | null;
  teamSponsorship: HostedTeamSponsorship | null;
  pendingCheckout: HostedPendingCheckout | null;
  lastReconcileAt: number | null;
  lastWebhookAt: number | null;
}

export interface HostedTeamSponsorship {
  organizationId: string;
  organizationName: string;
  planKey: "sync_team";
  interval: HostedBillingInterval;
  status: string;
  currentPeriodEnd: number;
  cancelAtPeriodEnd: boolean;
  seatCapacity: number;
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

export type HostedOrganizationRole = "owner" | "member";

export interface HostedOrganizationMember {
  workosUserId: string;
  email: string;
  role: HostedOrganizationRole;
  fundedBy: "team" | "none";
  seatAssigned: boolean;
}

export interface HostedOrganizationInvitation {
  id: string;
  email: string;
  state: string;
  expiresAt: string | number;
}

export interface HostedOrganizationBillingSummary {
  source: "preview" | "team" | "none";
  checkoutAvailable: boolean;
  seatCapacity: number;
  planKey: "sync_team" | null;
  interval: HostedBillingInterval | null;
  status: string | null;
  currentPeriodEnd: number | null;
  cancelAtPeriodEnd: boolean;
  scheduledSeatCapacity: number | null;
  scheduledEffectiveAt: number | null;
}

export interface HostedOrganization {
  id: string;
  name: string;
  status?: "active" | "closed";
  billingRecoveryOnly?: boolean;
  membership: { role: HostedOrganizationRole; seatAssigned: boolean; fundedBy?: "team" | "none" };
  seats: { assigned: number; reserved: number; available: number };
  members: HostedOrganizationMember[];
  invitations: HostedOrganizationInvitation[];
  billing: HostedOrganizationBillingSummary;
}

export interface HostedOrganizationListResult {
  organizations: HostedOrganization[];
}

export interface HostedOrganizationCreateResult {
  organization: HostedOrganization;
}

export interface HostedOrganizationInviteResult {
  invitation: HostedOrganizationInvitation & { acceptInvitationUrl?: string };
  seat: { assignedSeats?: number; reservedSeats: number; availableSeats: number };
}

export interface HostedOrganizationAcceptResult {
  accepted: boolean;
  reason?: "not-anvil-organization-invitation";
  organizationId?: string;
  role?: HostedOrganizationRole;
  entitlement?: HostedEntitlement;
}

export interface HostedOrganizationSeatChangeResult {
  seatCapacity: number;
  scheduledSeatCapacity: number | null;
  effectiveAt: number | null;
}

export interface HostedSeatIncreaseQuote {
  quoteId: string;
  seatCapacity: number;
  requestedSeats: number;
  /** Stripe invoice-preview total in minor units, including applicable tax. */
  amountDue: number;
  currency: "gbp";
  /** Tax portion in minor units, already included in amountDue. */
  taxAmount: number;
  /** Stripe Unix timestamp in seconds. */
  prorationDate: number;
  /** Unix timestamp in milliseconds. */
  expiresAt: number;
}

export interface HostedOrganizationMemberSeatResult {
  assigned: boolean;
}

export interface HostedOrganizationCloseResult {
  closed: boolean;
  organizationId: string;
  providerSyncPending?: boolean;
}

/** POST /internal/hosted/reconcile */
export interface HostedReconcileResult {
  reconciled: boolean;
  subscriptions: number;
}

/** Account-scoped hosted device and deletion shapes. No session tokens are returned. */
export interface HostedDeviceSummary {
  enrollmentId: string;
  displayName?: string;
  installationId: string;
  credentialGeneration: number;
  revoked: boolean;
  createdAt: string;
  self: boolean;
  enrollmentClass?: "device" | "ephemeral";
  trustState?: "pending" | "trusted" | "revoked";
}

export interface HostedDeviceListResult {
  devices: HostedDeviceSummary[];
}

/** Browser-selectable, account-owned Desktop machine. Live status is not reported by the API. */
export interface HostedWorkspaceMachine {
  enrollmentId: string;
  name: string;
  status: "unknown";
  /** Live direct-route metadata; no session or connector credentials. */
  meshHost?: MeshMachineHost;
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
  targetEnrollmentId?: string;
  trustId?: string;
  renewalProof?: string;
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

export interface HostedDashboardTrustRevokeInput {
  trustId: string;
  origin: string;
}

export interface HostedDashboardTrustRevokeResult {
  revoked: boolean;
}

export interface HostedDashboardGrantRevokeResult {
  revoked: boolean;
}

export interface DashboardRenewalProofInput {
  accountId: string;
  requestId: string;
  trustId: string;
  browserPub: string;
  origin: string;
  targetEnrollmentId: string;
  challenge: string;
  expiresAt: string;
  workspaceBindings: BrowserWorkspaceBinding[];
  scopes: DashboardScope[];
}

/** Must match dashboardRenewalProofMessage in the Desktop cloud contract. */
export function dashboardRenewalProofMessage(input: DashboardRenewalProofInput): string {
  const workspaceBindings = input.workspaceBindings
    .map((binding) => ({
      workspaceId: binding.workspaceId,
      repositoryIds: [...binding.repositoryIds].sort()
    }))
    .sort((left, right) => left.workspaceId.localeCompare(right.workspaceId));
  return JSON.stringify([
    "anvil/dashboard-renewal-proof/v1",
    input.accountId,
    input.requestId,
    input.trustId,
    input.browserPub,
    input.origin,
    input.targetEnrollmentId,
    input.challenge,
    input.expiresAt,
    workspaceBindings,
    [...input.scopes].sort()
  ]);
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
  "chat.execution.options",
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
  "chat.execution.options": "workspace-read",
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
