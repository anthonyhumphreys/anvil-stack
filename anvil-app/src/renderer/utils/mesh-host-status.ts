import type { MeshMachineHostStatus } from '../../../cloud/contract/machine.js';

export interface MeshHostStatusSummary {
  value: string;
  detail: string;
  tone: string;
}

export function summarizeLocalMeshHostStatus({
  host,
  loading,
  signedIn,
  syncEnabled,
  backendReady,
}: {
  host: MeshMachineHostStatus | null | undefined;
  loading: boolean;
  signedIn: boolean;
  syncEnabled: boolean;
  backendReady: boolean;
}): MeshHostStatusSummary {
  if (loading) {
    return {
      value: 'Checking…',
      detail: 'Checking whether approved devices can connect to this device.',
      tone: 'text-text-primary',
    };
  }

  if (host !== undefined && host !== null && (!host.enabled || host.state === 'disabled')) {
    return {
      value: 'Direct connections unavailable',
      detail: 'Direct access is not configured for this service. Sync remains available.',
      tone: 'text-text-primary',
    };
  }

  if (!signedIn) {
    return {
      value: 'Not available',
      detail: backendReady
        ? 'Sign in, then enable Sync to let approved devices connect.'
        : 'Choose a Sync service and sign in to connect approved devices.',
      tone: 'text-text-primary',
    };
  }

  if (!syncEnabled) {
    return {
      value: 'Not available',
      detail: 'Enable Sync to let approved devices connect to this device.',
      tone: 'text-text-primary',
    };
  }

  if (host === undefined || host === null) {
    return {
      value: 'Checking…',
      detail: 'Anvil has not reported this device’s connection status yet.',
      tone: 'text-text-primary',
    };
  }

  switch (host.state) {
    case 'disabled':
      return {
        value: 'Direct connections unavailable',
        detail: 'Direct access is not configured for this service. Sync remains available.',
        tone: 'text-text-primary',
      };
    case 'starting':
      return {
        value: 'Starting',
        detail: 'Anvil is preparing this device for approved connections.',
        tone: 'text-warning',
      };
    case 'bind-error':
      return {
        value: 'Needs attention',
        detail: 'Connection service could not start. Restart Anvil.',
        tone: 'text-error',
      };
    case 'offline':
      return {
        value: 'Offline',
        detail:
          host.managedOrigin !== null
            ? 'Keep Anvil open and online so approved devices can connect.'
            : 'Keep Anvil open on a network the other device can reach.',
        tone: 'text-warning',
      };
    case 'listening': {
      if (host.activeSessions > 0) {
        const count = host.activeSessions;
        return {
          value: 'Connected',
          detail: `${count} active connection${count === 1 ? '' : 's'} · keep Anvil open and online.`,
          tone: 'text-success',
        };
      }

      return host.managedOrigin !== null
        ? {
            value: 'Available',
            detail: 'Keep Anvil open and online so approved devices can connect.',
            tone: 'text-success',
          }
        : {
            value: 'Available on your network',
            detail: 'Keep Anvil open. Other devices must be able to reach this network.',
            tone: 'text-success',
          };
    }
    default: {
      const exhaustive: never = host.state;
      return exhaustive;
    }
  }
}
