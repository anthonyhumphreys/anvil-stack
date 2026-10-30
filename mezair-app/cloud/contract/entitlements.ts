export type HostedAccessState = 'preview' | 'active' | 'grace' | 'restricted' | 'unknown';
export type HostedAccessSource =
  | 'preview'
  | 'subscription'
  | 'renewal-grace'
  | 'outage-grace'
  | 'none';

export interface HostedLimits {
  devices: number;
  /** `null` means there is no published aggregate storage quota. */
  artifactBytes: number | null;
  /** `null` means there is no published aggregate history quota. */
  historyBytes: number | null;
}

export type HostedFundingSource = 'personal' | 'team' | 'preview' | 'none';

export interface HostedEntitlement {
  state: HostedAccessState;
  source: HostedAccessSource;
  planKey: 'sync_personal' | 'sync_team' | null;
  /** Which payer currently grants this user's hosted access. */
  fundedBy: HostedFundingSource;
  /** Present only while access is funded by an organisation seat. */
  organizationId: string | null;
  capabilities: { syncWrite: boolean; meshSubmit: boolean };
  limits: HostedLimits;
  previewEndsAt: string;
  accessUntil: string | null;
  graceUntil: string | null;
  checkedAt: string;
  revision: number;
  reason:
    | 'free'
    | 'preview'
    | 'paid'
    | 'renewal-failed'
    | 'billing-outage'
    | 'preview-ended'
    | 'subscription-required'
    | 'account-deleted'
    | 'billing-unavailable'
    | 'device-limit-exceeded';
}
