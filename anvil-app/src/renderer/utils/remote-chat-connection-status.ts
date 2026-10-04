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

  switch (input.hostState) {
    case 'live':
      return { label: `Connected · ${input.targetName}`, detail: null, tone: 'muted' };
    case 'connecting':
      return {
        label: `Connecting to ${input.targetName}`,
        detail:
          'Anvil is connecting automatically. This chat will continue when the machine is ready.',
        tone: 'muted',
      };
    case 'offline':
      return {
        label: `${input.targetName} is offline`,
        detail:
          'Wake the machine or restore its network connection. Anvil will reconnect automatically.',
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
