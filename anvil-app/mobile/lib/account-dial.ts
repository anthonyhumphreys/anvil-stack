import {
  getAccountConnection,
  listMeshMachineHosts,
} from './anvil-account';
import { saveAccountConnection } from './anvil-api';
import {
  getMeshMachineSession,
  meshMachineRouteCandidates,
  MeshMachineRequestError,
} from './mesh-session';

export type DialOutcome =
  | 'ready'
  | 'approval-required'
  | 'denied'
  | 'protocol-mismatch'
  | 'route-unavailable'
  | 'authorization-unavailable';

export interface DialedHost {
  enrollmentId: string;
  displayName: string;
  outcome: DialOutcome;
  detail?: string;
}

/**
 * Discovers hosts through the HTTPS broker, then verifies a ticket-bound direct
 * session. It deliberately never probes a companion REST endpoint with the
 * account bearer; account credentials are used only for broker discovery and
 * admission-ticket issuance.
 */
export async function dialAccountHosts(): Promise<DialedHost[]> {
  const account = await getAccountConnection();
  if (!account) return [];

  const hosts = await listMeshMachineHosts();
  const results: DialedHost[] = [];
  for (const host of hosts) {
    if (host.enrollmentId === account.session.enrollmentId || !host.online) continue;
    const displayName = `Anvil host ${host.machineId.slice(0, 8)}`;
    if (
      host.protocolVersion !== 1 ||
      !host.capabilities.includes('machine.session/1') ||
      !host.capabilities.includes('machine.stream/1') ||
      !host.operations.includes('read.snapshot')
    ) {
      results.push({
        enrollmentId: host.enrollmentId,
        displayName,
        outcome: 'protocol-mismatch',
        detail: 'The host does not expose the current encrypted Mesh session protocol.',
      });
      continue;
    }
    if (meshMachineRouteCandidates(host).length === 0) {
      results.push({ enrollmentId: host.enrollmentId, displayName, outcome: 'route-unavailable' });
      continue;
    }
    try {
      const session = await getMeshMachineSession(host.enrollmentId);
      const routeUrl = session.route.url;
      await saveAccountConnection({
        id: `acct:${host.enrollmentId}`,
        baseUrl: routeUrl,
        deviceName: displayName,
        enrollmentId: host.enrollmentId,
        requiresHostApproval: false,
      });
      results.push({ enrollmentId: host.enrollmentId, displayName, outcome: 'ready' });
    } catch (error) {
      const code = error instanceof MeshMachineRequestError ? error.code : 'machine-route-unavailable';
      const outcome: DialOutcome =
        code === 'approval-required'
          ? 'approval-required'
          : code === 'device-denied'
            ? 'denied'
            : code === 'machine-protocol-upgrade-required' || code === 'machine-protocol-mismatch'
              ? 'protocol-mismatch'
              : code === 'machine-route-unavailable'
                ? 'route-unavailable'
                : 'authorization-unavailable';
      results.push({
        enrollmentId: host.enrollmentId,
        displayName,
        outcome,
        detail:
          outcome === 'approval-required'
            ? 'Waiting for this device to be approved on the host.'
            : outcome === 'denied'
              ? 'The host denied this device in its local trust policy.'
              : outcome === 'protocol-mismatch'
                ? 'The host does not expose the current encrypted Mesh session protocol.'
                : outcome === 'route-unavailable'
                  ? 'The host is online but its advertised Mesh route could not be reached.'
                  : 'The host could not authorize a Mesh session. Check account trust and enrollment settings.',
      });
    }
  }
  return results;
}
