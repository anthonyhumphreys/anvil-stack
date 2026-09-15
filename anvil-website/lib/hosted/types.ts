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
