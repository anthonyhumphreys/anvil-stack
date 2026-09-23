// Browser dashboard authorization: scoped, encrypted projections of
// account state for web clients — NOT enrollment, NOT an account key.
//
// Model: the browser generates a non-exportable ephemeral X25519 keypair
// and submits a bounded authorization request (challenge, scopes, expiry,
// origin) through the signed hosted channel. A trusted device polls
// `dashboard.requests`, shows the user the exact browser identity and
// scope, and on approval seals a dashboard session key (DSK) to the
// browser pubkey plus a first snapshot sealed under the DSK. The
// coordinator stores and relays both envelopes but can never open them.
//
// Three permissions stay independent: WorkOS session = authentication;
// the approved grant's scopes = authorization to act; the wrapped DSK =
// authorization to decrypt. Authentication alone never implies either.
//
// The browser is v1-scoped: it receives a bounded snapshot (devices,
// environments, jobs, approvals, handoffs, activity), may mint task
// content keys for jobs it submits, and acts only through the hosted
// channel gated by its grant scopes. It never receives the ADK.

import type { DashboardGrantPayload, SealedDashboardSnapshot } from './sealed.js';
import type { BrowserWorkspaceBinding } from './browser-workspace.js';

/**
 * Scopes a dashboard grant may carry. `read-dashboard` is the baseline;
 * the action scopes are independent — a grant may read without being
 * able to submit, approve, or hand off.
 */
export type DashboardScope =
  | 'read-dashboard'
  | 'submit-task'
  | 'approve-action'
  | 'request-handoff'
  // browser-workspace/1 action scopes. Legacy grants omit workspace/repo
  // bindings and therefore cannot authorize these operations.
  | 'workspace-read'
  | 'workspace-write'
  | 'terminal'
  | 'preview';

export const DASHBOARD_SCOPES: readonly DashboardScope[] = [
  'read-dashboard',
  'submit-task',
  'approve-action',
  'request-handoff',
  'workspace-read',
  'workspace-write',
  'terminal',
  'preview',
];

export function isDashboardScope(value: unknown): value is DashboardScope {
  return typeof value === 'string' && (DASHBOARD_SCOPES as readonly string[]).includes(value);
}

/** Request lifecycle. `expired`/`revoked`/`denied` are terminal. */
export type DashboardRequestState =
  | 'pending'
  | 'approved'
  | 'denied'
  | 'expired'
  | 'revoked';

/**
 * A browser authorization request — the coordinator-visible metadata of
 * a pending/approved grant. The DSK itself never appears here; it lives
 * exclusively inside `grant.ct`.
 */
export interface DashboardRequest {
  requestId: string;
  /** base64 raw X25519 public key the browser generated for this request. */
  browserPub: string;
  /** Random challenge the browser must keep proving (binds this request). */
  challenge: string;
  /** Scopes the browser asked for; the grant may carry a subset. */
  scopes: DashboardScope[];
  /** Workspace/repository bindings requested by browser-workspace/1. */
  workspaceBindings?: BrowserWorkspaceBinding[];
  /** @deprecated use workspaceBindings; accepted only for one-to-one legacy callers. */
  workspaceIds?: string[];
  /** @deprecated use workspaceBindings; accepted only for one-to-one legacy callers. */
  repositoryIds?: string[];
  /** Explicitly approved scopes; absent on legacy grants. */
  grantedScopes?: DashboardScope[];
  /** Claimed page origin — a hint and a binding, not proof of identity. */
  origin?: string;
  /** User-agent hint — contextual only, never cryptographic proof. */
  userAgent?: string;
  /** ISO-8601 request/grant expiry requested by the browser. */
  expiresAt: string;
  state: DashboardRequestState;
  createdAt: string;
  /** Enrollment that decided (approved/denied/revoked), once decided. */
  decidedBy?: string;
  decidedAt?: string;
}

/**
 * `dashboard.requests` (user role): pending requests awaiting a trusted
 * device's decision. Bounded list, newest first.
 */
export interface DashboardRequestsParams {
  /**
   * Optional issuer-bound lookup. Omitting this field (or sending `{}`)
   * preserves the bounded pending-request list behavior.
   */
  requestId?: string;
}

export interface DashboardRequestsResult {
  requests: DashboardRequest[];
  /** Issuer-bound live lookup used by browser-workspace command revalidation. */
  request?: DashboardRequest;
}

/**
 * `dashboard.decide` (user role): the approving device deposits the
 * sealed grant + first sealed snapshot, or records a denial/revocation.
 * `decision:'approved'` requires `grant` and `snapshot`.
 */
export interface DashboardDecideParams {
  requestId: string;
  decision: 'approved' | 'denied';
  /** Sealed DSK wrap — required on approval. */
  grant?: DashboardGrantPayload;
  /** First sealed snapshot under the DSK — required on approval. */
  snapshot?: SealedDashboardSnapshot;
  /** Optional browser-workspace/1 approval bindings. */
  workspaceBindings?: BrowserWorkspaceBinding[];
  /** @deprecated use workspaceBindings. */
  workspaceIds?: string[];
  /** @deprecated use workspaceBindings. */
  repositoryIds?: string[];
  grantedScopes?: DashboardScope[];
}

export interface DashboardDecideResult {
  request: DashboardRequest;
}

/**
 * `dashboard.publish` (user role): replace the sealed snapshot at a
 * strictly increasing `seq`. Only the approving device (or another
 * trusted device holding the DSK) may publish; stale seqs are conflicts.
 */
export interface DashboardPublishParams {
  requestId: string;
  snapshot: SealedDashboardSnapshot;
}

export interface DashboardPublishResult {
  published: boolean;
  seq: number;
}

/** `dashboard.revoke` (user role): kill a grant; the snapshot is dropped. */
export interface DashboardRevokeParams {
  requestId: string;
}

export interface DashboardRevokeResult {
  request: DashboardRequest;
}

// ---- Hosted-channel shapes ---------------------------------------------------
// These ride the website → backend internal routes (HMAC service auth),
// never the device-RPC channel — browsers hold no device session.

/** Browser → hosted `dashboard-request` upsert. */
export interface HostedDashboardRequestInput {
  requestId: string;
  browserPub: string;
  challenge: string;
  scopes: DashboardScope[];
  workspaceBindings?: BrowserWorkspaceBinding[];
  /** @deprecated use workspaceBindings. */
  workspaceIds?: string[];
  /** @deprecated use workspaceBindings. */
  repositoryIds?: string[];
  expiresAt: string;
  origin?: string;
  userAgent?: string;
}

/** Hosted `dashboard-status` result: state + the sealed grant if approved. */
export interface HostedDashboardStatus {
  requestId: string;
  state: DashboardRequestState;
  /**
   * The account the request was stamped to, and the deployment id the
   * approving device binds into the grant/snapshot AAD — both public
   * routing metadata the browser needs to reconstruct associated data.
   */
  accountId?: string;
  backendId?: string;
  /** Sealed DSK wrap — present only when approved. */
  grant?: DashboardGrantPayload;
  /** Latest sealed snapshot sequence, when a snapshot exists. */
  snapshotSeq?: number;
  expiresAt?: string;
}

/** Hosted `dashboard-snapshot` result: the current sealed snapshot. */
export interface HostedDashboardSnapshotResult {
  requestId: string;
  snapshot?: SealedDashboardSnapshot;
}

/**
 * `keyring.report` (user role): a trusted device reports a completed
 * post-revocation rotation so the dashboard can distinguish "access
 * revoked" from "rotation pending".
 */
export interface KeyringReportParams {
  rotationId: string;
  revokedEnrollmentIds: string[];
  toVersion: number;
}

export interface KeyringReportResult {
  recorded: boolean;
}
