export type HostedAccessState = 'preview' | 'active' | 'grace' | 'restricted' | 'unknown';
export type HostedAccessSource = 'preview' | 'subscription' | 'renewal-grace' | 'outage-grace' | 'none';

export interface HostedLimits {
  devices: number;
  artifactBytes: number;
  historyBytes: number;
}

export interface HostedEntitlement {
  state: HostedAccessState;
  source: HostedAccessSource;
  planKey: 'sync_personal' | null;
  capabilities: { syncWrite: boolean; meshSubmit: boolean };
  limits: HostedLimits;
  previewEndsAt: string;
  accessUntil: string | null;
  graceUntil: string | null;
  checkedAt: string;
  revision: number;
  reason: 'preview' | 'paid' | 'renewal-failed' | 'billing-outage' | 'preview-ended' | 'subscription-required' | 'account-deleted' | 'billing-unavailable';
}
