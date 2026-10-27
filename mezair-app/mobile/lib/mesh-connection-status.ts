import type { MobileMeshStatus } from './mesh-session-manager';

export function meshPathLabel(status: MobileMeshStatus): string {
  if (status.state === 'authorization-unavailable') return 'Authorization unavailable';
  if (status.state !== 'live')
    return status.state === 'idle' ? 'Available on demand' : 'Connecting';
  switch (status.path) {
    case 'direct':
      return status.lanAddress ? 'Direct · host LAN address' : 'Direct';
    case 'private-network':
      return 'Private Network';
    case 'https':
      return 'Direct HTTPS';
    case 'managed':
      return 'Managed Tunnel';
    default:
      return 'Connected';
  }
}
