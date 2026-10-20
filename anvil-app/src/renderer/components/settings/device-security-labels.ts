import type {
  SyncDeviceSecurityStatus,
  SyncDeviceTrustSource,
  SyncDeviceTrustState,
} from '../../../shared/sync-device-security';

export function deviceTrustSourceLabel(source: SyncDeviceTrustSource): string {
  switch (source) {
    case 'automatic-auth':
      return 'Trusted automatically';
    case 'manual-approval':
      return 'Approved by another trusted device';
    case 'recovery-code':
    case 'recovery':
      return 'Unlocked with recovery code';
    case 'first-device':
      return 'First device';
    case 'local-device':
      return 'This device';
    case 'pairing':
      return 'Paired with another trusted device';
    default:
      return 'Trust source unavailable';
  }
}

export function deviceTrustStateLabel(state: SyncDeviceTrustState): string {
  switch (state) {
    case 'trusted':
      return 'Trusted';
    case 'pending':
      return 'Waiting for approval';
    case 'revoked':
      return 'Revoked';
    default:
      return 'Unknown';
  }
}

export function securityEventLabel(
  kind: SyncDeviceSecurityStatus['recentEvents'][number]['kind'],
  outcome?: string,
): string {
  switch (kind) {
    case 'setPolicy':
    case 'policy-changed':
      if (outcome === 'accepted:auto-trust-authenticated') {
        return 'Policy changed: new devices trusted automatically';
      }
      if (outcome === 'accepted:require-approval') {
        return 'Policy changed: new devices require approval';
      }
      return 'Policy changed';
    case 'configure':
    case 'policy-configured':
      return 'Security configured';
    case 'recover':
    case 'recovery-unlocked':
      return 'Recovery used';
    case 'updateRecovery':
    case 'recovery-replaced':
      return 'Recovery code replaced';
    case 'device-approved':
      return 'Device trusted';
    case 'device-auto-trusted':
      return 'Trusted automatically';
    case 'device-revoked':
      return 'Device revoked';
    case 'reset':
    case 'encrypted-data-reset':
      return 'Encrypted data reset';
    default:
      return 'Security activity';
  }
}
