import { getPreferenceValues, LocalStorage } from '@raycast/api';
import {
  connectMeshMachineHost,
  fetchMeshMachineHosts,
  meshMachineRouteCandidates,
  type MeshMachineSessionConnection,
} from '../../../src/main/services/mesh-host-client.service.js';
import type { MeshMachineHost } from '../../../cloud/contract/machine.js';

const SESSION_KEY = 'anvil.account.session';
const BACKEND_KEY = 'anvil.account.backend';

interface DeviceSession {
  accessToken: string;
  accessExpiresAt: string;
  refreshToken: string;
  credentialGeneration: number;
  enrollmentId: string;
  accountId: string;
  datasetEpoch: string;
  displayName?: string;
}

export interface AccountPreferences {
  accountApiUrl?: string;
  accountEnrollmentCode?: string;
}

export interface AccountMeshEvent {
  enrollmentId: string;
  epoch: string;
  sequence: number;
  workspaceId: string;
  jobId?: string;
  eventKind: string;
  payload: unknown;
}

export interface AccountMachineTarget {
  host: MeshMachineHost;
  connection: MeshMachineSessionConnection;
}

const activeConnections = new Map<string, MeshMachineSessionConnection>();
const pendingConnections = new Map<
  string,
  { endpointGeneration: string; promise: Promise<MeshMachineSessionConnection> }
>();
const latestEndpointGenerations = new Map<string, string>();
const eventListeners = new Set<(event: AccountMeshEvent) => void>();

export function accountConfigured(): boolean {
  const prefs = getPreferenceValues<AccountPreferences>();
  return Boolean(prefs.accountApiUrl?.trim() && prefs.accountEnrollmentCode?.trim());
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function secureApiUrl(value: string): URL {
  const url = new URL(value);
  if (
    url.protocol !== 'https:' ||
    url.username !== '' ||
    url.password !== '' ||
    url.search !== '' ||
    url.hash !== ''
  ) {
    throw new Error('Account sign-in requires an HTTPS Anvil API URL.');
  }
  if (!url.pathname.endsWith('/')) url.pathname += '/';
  return url;
}

function routeUrl(apiUrl: string, route: string): string {
  return new URL(route, secureApiUrl(apiUrl)).href;
}

async function fetchJson(
  url: string,
  init: { body?: unknown; accessToken?: string; method?: 'GET' | 'POST'; timeoutMs?: number },
): Promise<unknown> {
  const requestUrl = new URL(url);
  if (requestUrl.protocol !== 'https:' || requestUrl.username || requestUrl.password) {
    throw new Error('Account credentials can only be sent to an HTTPS Anvil API.');
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), init.timeoutMs ?? 12_000);
  try {
    const response = await fetch(url, {
      method: init.method ?? 'POST',
      headers: {
        Accept: 'application/json',
        ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(init.accessToken === undefined ? {} : { Authorization: `Bearer ${init.accessToken}` }),
      },
      redirect: 'error',
      signal: controller.signal,
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });
    const payload = (await response.json().catch(() => null)) as unknown;
    if (isRecord(payload) && isRecord(payload.error)) {
      const code = typeof payload.error.code === 'string' ? payload.error.code : 'unauthenticated';
      throw new Error(code);
    }
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return payload;
  } finally {
    clearTimeout(timeout);
  }
}

async function storedSession(): Promise<{ apiUrl: string; session: DeviceSession } | null> {
  const [apiUrl, raw] = await Promise.all([
    LocalStorage.getItem<string>(BACKEND_KEY),
    LocalStorage.getItem<string>(SESSION_KEY),
  ]);
  if (!apiUrl || !raw) return null;
  try {
    const session = JSON.parse(raw) as DeviceSession;
    if (
      typeof session.accessToken !== 'string' ||
      typeof session.refreshToken !== 'string' ||
      typeof session.enrollmentId !== 'string' ||
      typeof session.accountId !== 'string'
    ) {
      return null;
    }
    secureApiUrl(apiUrl);
    return { apiUrl, session };
  } catch {
    return null;
  }
}

async function storeSession(apiUrl: string, session: DeviceSession): Promise<void> {
  await LocalStorage.setItem(SESSION_KEY, JSON.stringify(session));
  await LocalStorage.setItem(BACKEND_KEY, secureApiUrl(apiUrl).href);
}

async function ensureSession(): Promise<{ apiUrl: string; session: DeviceSession }> {
  const existing = await storedSession();
  if (existing) return existing;

  const prefs = getPreferenceValues<AccountPreferences>();
  const rawApiUrl = prefs.accountApiUrl?.trim();
  const code = prefs.accountEnrollmentCode?.trim();
  if (!rawApiUrl || !code) {
    throw new Error('Set a companion token or an account API URL + enrollment code.');
  }
  const apiUrl = secureApiUrl(rawApiUrl).href;
  const session = (await fetchJson(routeUrl(apiUrl, 'enroll'), {
    body: {
      proof: { method: 'enrollment-code', code },
      installationId: `raycast-${crypto.randomUUID()}`,
      displayName: 'Raycast',
    },
  })) as DeviceSession;
  if (typeof session.accessToken !== 'string') {
    throw new Error('Enrollment returned a malformed session.');
  }
  await storeSession(apiUrl, session);
  return { apiUrl, session };
}

async function refreshSession(): Promise<{ apiUrl: string; session: DeviceSession } | null> {
  const existing = await storedSession();
  if (!existing) return null;
  try {
    const session = (await fetchJson(routeUrl(existing.apiUrl, 'session/refresh'), {
      body: {
        refreshToken: existing.session.refreshToken,
        enrollmentId: existing.session.enrollmentId,
      },
    })) as DeviceSession;
    await storeSession(existing.apiUrl, session);
    return { apiUrl: existing.apiUrl, session };
  } catch {
    return null;
  }
}

function createRaycastSocket(url: string, protocols: string[]) {
  const socket = new WebSocket(url, protocols);
  return {
    on(event: string, listener: (...args: unknown[]) => void) {
      socket.addEventListener(event as 'message' | 'error' | 'close', (value) => {
        if (event === 'message') listener((value as MessageEvent).data);
        else if (event === 'error') listener(new Error('machine-socket-error'));
        else listener();
      });
    },
    send(data: string) {
      socket.send(data);
    },
    close(code?: number, reason?: string) {
      socket.close(code, reason);
    },
  };
}

function publishMeshEvent(event: AccountMeshEvent): void {
  for (const listener of eventListeners) listener(event);
}

async function openHostSession(
  host: MeshMachineHost,
  account: { apiUrl: string; session: DeviceSession },
): Promise<MeshMachineSessionConnection> {
  latestEndpointGenerations.set(host.enrollmentId, host.endpointGeneration);
  const existing = activeConnections.get(host.enrollmentId);
  if (
    existing &&
    existing.machineId === host.machineId &&
    existing.endpointGeneration === host.endpointGeneration
  ) {
    return existing;
  }
  existing?.close();
  activeConnections.delete(host.enrollmentId);
  const pending = pendingConnections.get(host.enrollmentId);
  if (pending?.endpointGeneration === host.endpointGeneration) return pending.promise;
  let openedConnection: MeshMachineSessionConnection | null = null;
  const opening = connectMeshMachineHost(host, {
    apiUrl: account.apiUrl,
    accessToken: account.session.accessToken,
    accountId: account.session.accountId,
    enrollmentId: account.session.enrollmentId,
    socketFactory: createRaycastSocket,
    onEvent: publishMeshEvent,
    onClosed(enrollmentId) {
      if (activeConnections.get(enrollmentId) === openedConnection) {
        activeConnections.delete(enrollmentId);
      }
    },
    onResnapshotRequired(event) {
      publishMeshEvent({
        ...event,
        epoch: '',
        sequence: 0,
        workspaceId: '',
        eventKind: 'resnapshot-required',
        payload: null,
      });
    },
  });
  const pendingEntry = { endpointGeneration: host.endpointGeneration, promise: opening };
  pendingConnections.set(host.enrollmentId, pendingEntry);
  try {
    const connection = await opening;
    openedConnection = connection;
    if (latestEndpointGenerations.get(host.enrollmentId) !== host.endpointGeneration) {
      connection.close();
      throw new Error('route-unavailable');
    }
    activeConnections.set(host.enrollmentId, connection);
    return connection;
  } finally {
    if (pendingConnections.get(host.enrollmentId) === pendingEntry) {
      pendingConnections.delete(host.enrollmentId);
    }
  }
}

/** Discovers through HTTPS, then establishes an encrypted host-local session. */
export async function resolveAccountMachine(): Promise<AccountMachineTarget> {
  let account = await ensureSession();
  let hosts: MeshMachineHost[];
  try {
    hosts = await fetchMeshMachineHosts({
      apiUrl: account.apiUrl,
      accessToken: account.session.accessToken,
    });
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes('unauthenticated')) throw error;
    const refreshed = await refreshSession();
    if (!refreshed) throw error;
    account = refreshed;
    hosts = await fetchMeshMachineHosts({
      apiUrl: account.apiUrl,
      accessToken: account.session.accessToken,
    });
  }
  const onlineHosts = hosts.filter(
    (host) => host.online && host.enrollmentId !== account.session.enrollmentId,
  );
  const currentProtocolHosts = onlineHosts.filter(
    (host) =>
      host.capabilities.includes('machine.session/1') &&
      host.capabilities.includes('machine.stream/1') &&
      host.operations.includes('read.snapshot'),
  );
  const candidates = currentProtocolHosts.filter(
    (host) => meshMachineRouteCandidates(host).length > 0,
  );
  if (candidates.length === 0) {
    if (onlineHosts.length > 0 && currentProtocolHosts.length === 0) {
      throw new Error('The current Mesh session protocol is unavailable on online hosts.');
    }
    throw new Error(
      'Host connection unavailable. Check that a host is online and Mesh is enabled.',
    );
  }

  let latestError: unknown;
  for (const host of candidates) {
    try {
      return { host, connection: await openHostSession(host, account) };
    } catch (error) {
      latestError = error;
      if (
        error instanceof Error &&
        (error.message === 'approval-required' || error.message === 'device-denied')
      ) {
        break;
      }
    }
  }
  if (latestError instanceof Error && latestError.message === 'approval-required') {
    throw new Error(
      'A host needs approval. On that host, open Settings → Devices → Account device access and approve Raycast.',
    );
  }
  if (latestError instanceof Error && latestError.message === 'device-denied') {
    throw new Error(
      'A host denied Raycast under its local trust policy. Review host trust settings.',
    );
  }
  if (latestError instanceof Error && latestError.message === 'protocol-mismatch') {
    throw new Error('The current Mesh session protocol is unavailable on the reachable host.');
  }
  throw new Error('Host connection unavailable. Check the host and its current Mesh listener.');
}

export function subscribeToAccountMeshEvents(
  listener: (event: AccountMeshEvent) => void,
): () => void {
  eventListeners.add(listener);
  return () => eventListeners.delete(listener);
}

/** Drops live sessions; the next account request rediscovers a current route. */
export async function forgetDialedHost(): Promise<void> {
  for (const connection of activeConnections.values()) connection.close();
  activeConnections.clear();
}
