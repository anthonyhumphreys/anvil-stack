import type { SyncRuntimeStatus } from '../../shared/sync-runtime';

type MeshHostState = SyncRuntimeStatus['meshHosts'][number]['state'];

export interface RemoteChatConnectionNotice {
  label: string;
  detail: string | null;
  tone: 'muted' | 'warning';
}

export function remoteChatConnectionNotice(input: {
  approvalRequired: boolean;
  approvalActionsAvailable: boolean;
  hostState: MeshHostState | undefined;
  hostError?: SyncRuntimeStatus['meshHosts'][number]['lastError'];
  hostPath?: SyncRuntimeStatus['meshHosts'][number]['path'];
  targetName: string;
  fallbackLabel: string;
}): RemoteChatConnectionNotice {
  if (input.approvalRequired) {
    return {
      label: 'Approval required',
      detail: input.approvalActionsAvailable
        ? 'Approve or deny the request below to continue.'
        : 'This machine is waiting for an approval.',
      tone: 'warning',
    };
  }

  if (input.hostError === 'approval-required' || input.hostError === 'device-denied') {
    return {
      label:
        input.hostError === 'approval-required' ? 'Host access required' : 'Host access denied',
      detail:
        'On the target machine, open Settings → Devices → Account device access to review this device. Live updates will connect when access is allowed.',
      tone: 'warning',
    };
  }

  if (input.hostError === 'authorization-unavailable') {
    return {
      label: 'Checking host access',
      detail:
        'Mezair cannot verify device access right now. Check sign-in and the network connection.',
      tone: 'warning',
    };
  }

  switch (input.hostState) {
    case 'live':
      return {
        label: `Connected · ${input.targetName}`,
        detail:
          input.hostPath === 'direct'
            ? 'Direct · Host LAN address'
            : input.hostPath === 'private-network'
              ? 'Private Network'
              : input.hostPath === 'https'
                ? 'Direct HTTPS'
                : input.hostPath === 'managed'
                  ? 'Managed Tunnel'
                  : null,
        tone: 'muted',
      };
    case 'connecting':
      return {
        label: `Connecting to ${input.targetName}`,
        detail:
          'Mezair is connecting automatically. This chat will continue when the machine is ready.',
        tone: 'muted',
      };
    case 'offline':
      return {
        label: `${input.targetName} is offline`,
        detail:
          'Wake the machine or restore its network connection. Mezair will reconnect automatically.',
        tone: 'warning',
      };
    case 'degraded':
      return {
        label: `Connected · ${input.targetName}`,
        detail: 'Connected, but live updates may be delayed.',
        tone: 'muted',
      };
    default:
      return { label: input.fallbackLabel, detail: null, tone: 'muted' };
  }
}
