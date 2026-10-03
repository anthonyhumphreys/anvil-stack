import type { CompanionEndpoint, DevicePresenceEntry } from '../../cloud/contract/companion';
import {
  getAccountConnection,
  getAccountPresence,
  listAccountDevices,
  refreshAccountSession,
} from './anvil-account';
import { saveAccountConnection } from './anvil-api';

// MOB-01 Phase 2: direct-transport selection. The account coordinator is
// the directory — it reports which enrollments are online and the
// endpoints each host advertised. The phone dials each host's endpoints
// in contract preference order (tailscale -> lan -> loopback) and keeps
// the first address whose companion API accepts the account access token.
// A 403 means the credential verified but the host's policy is pending or
// denied — that stops the dial (the host was reached), not a fallback.

export type DialOutcome = 'ready' | 'pending' | 'denied' | 'unreachable';

export interface DialedHost {
  enrollmentId: string;
  displayName: string;
  outcome: DialOutcome;
  baseUrl?: string;
}

const DIAL_TIMEOUT_MS = 4_000;
const PROBE_PATH = '/api/chat/threads';

function endpointBaseUrl(endpoint: CompanionEndpoint): string {
  return `http://${endpoint.host}:${endpoint.port}`;
}

function isSelf(entry: DevicePresenceEntry, ownEnrollmentId: string): boolean {
  return entry.self || entry.enrollmentId === ownEnrollmentId;
}

async function probe(
  baseUrl: string,
  accessToken: string,
): Promise<'ready' | 'pending' | 'denied' | 'unreachable'> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DIAL_TIMEOUT_MS);
  try {
    const response = await fetch(`${baseUrl}${PROBE_PATH}`, {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
      signal: controller.signal,
    });
    if (response.status === 200) return 'ready';
    if (response.status === 403) {
      const body = (await response.json().catch(() => null)) as { error?: string } | null;
      return body?.error?.toLowerCase().includes('denied') ? 'denied' : 'pending';
    }
    return 'unreachable';
  } catch {
    return 'unreachable';
  } finally {
    clearTimeout(timeout);
  }
}

async function dialHost(
  entry: DevicePresenceEntry,
  accessToken: string,
): Promise<{ outcome: DialOutcome; baseUrl?: string }> {
  let pendingBaseUrl: string | undefined;
  let denied = false;
  for (const endpoint of entry.endpoints ?? []) {
    const baseUrl = endpointBaseUrl(endpoint);
    const result = await probe(baseUrl, accessToken);
    if (result === 'ready') return { outcome: 'ready', baseUrl };
    if (result === 'pending') pendingBaseUrl = baseUrl;
    if (result === 'denied') denied = true;
  }
  if (pendingBaseUrl !== undefined) {
    return { outcome: 'pending', baseUrl: pendingBaseUrl };
  }
  return { outcome: denied ? 'denied' : 'unreachable' };
}

/**
 * Rediscovers every online account host, dials its endpoints in
 * preference order, and upserts account-mode connections for whatever
 * answered. Hosts whose policy is still pending are kept too — they
 * surface as "waiting for approval" and start working the moment the
 * host approves, no re-dial needed.
 */
export async function dialAccountHosts(): Promise<DialedHost[]> {
  const account = await getAccountConnection();
  if (!account) return [];
  let accessToken = account.session.accessToken;

  const [presence, devices] = await Promise.all([
    getAccountPresence(),
    listAccountDevices().catch(() => ({ devices: [] })),
  ]);
  const names = new Map(
    devices.devices.map((device) => [device.enrollmentId, device.displayName ?? '']),
  );

  const results: DialedHost[] = [];
  for (const entry of presence.devices) {
    if (isSelf(entry, account.session.enrollmentId)) continue;
    if (!entry.online || (entry.endpoints ?? []).length === 0) continue;

    const displayName = names.get(entry.enrollmentId) || entry.enrollmentId;
    let dialed = await dialHost(entry, accessToken);
    if (dialed.outcome === 'unreachable') {
      // An expired access token looks like an unreachable host; rotate the
      // session once and retry this host before moving on.
      const refreshed = await refreshAccountSession().catch(() => null);
      if (refreshed) {
        accessToken = refreshed.session.accessToken;
        dialed = await dialHost(entry, accessToken);
      }
    }

    const connectionId = `acct:${entry.enrollmentId}`;
    if (dialed.outcome === 'ready' || dialed.outcome === 'pending') {
      await saveAccountConnection({
        id: connectionId,
        baseUrl: dialed.baseUrl as string,
        deviceName: displayName,
        enrollmentId: entry.enrollmentId,
        requiresHostApproval: dialed.outcome === 'pending',
      });
    }
    results.push({
      enrollmentId: entry.enrollmentId,
      displayName,
      outcome: dialed.outcome,
      baseUrl: dialed.baseUrl,
    });
  }
  return results;
}
