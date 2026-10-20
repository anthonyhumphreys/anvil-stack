import * as SecureStore from 'expo-secure-store';
import { PROTOCOL } from '../../cloud/contract/version';
import type { DeviceListResult, DeviceSession, EnrollResult } from '../../cloud/contract/auth';
import type { DevicePresenceResult } from '../../cloud/contract/companion';
import {
  MESH_MACHINE_CAPABILITIES,
  MESH_MACHINE_OPERATIONS,
  MESH_MACHINE_PROTOCOL_VERSION,
  type MeshMachineHost,
} from '../../cloud/contract/machine';

// MOB-01 Phase 1: account-connected companion mode. The phone enrolls on
// the user's sync account with a single-use enrollment code (minted from
// the website "Connect a device" card or another enrolled device), keeps
// the device session in SecureStore, and talks to the account coordinator
// for the device roster and presence — the directory the dial-order
// selection in Phase 2 is built on.
//
// This module mirrors the wire contract in
// src/main/services/sync-backend-client.service.ts: plain-JSON auth routes
// plus the versioned RPC envelope. It stays self-contained because the
// desktop client uses Node APIs that do not exist in Hermes.

const SESSION_KEY = 'anvil.account.session.v1';
const BACKEND_KEY = 'anvil.account.backend.v1';
const INSTALLATION_KEY = 'anvil.account.installation.v1';
const ACCOUNT_REQUEST_TIMEOUT_MS = 12_000;

export interface AccountConnection {
  apiUrl: string;
  session: DeviceSession;
}

export class AccountRpcError extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(code: string, retryable: boolean, message: string) {
    super(message);
    this.name = 'AccountRpcError';
    this.code = code;
    this.retryable = retryable;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function randomId(): string {
  const cryptoApi = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (typeof cryptoApi?.randomUUID === 'function') {
    return cryptoApi.randomUUID();
  }
  return `req-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

async function fetchJson(
  url: string,
  init: { body?: unknown; accessToken?: string; method?: 'GET' | 'POST' },
): Promise<unknown> {
  const requestUrl = new URL(url);
  if (
    requestUrl.protocol !== 'https:' ||
    requestUrl.username !== '' ||
    requestUrl.password !== '' ||
    requestUrl.search !== '' ||
    requestUrl.hash !== ''
  ) {
    throw new AccountRpcError(
      'secure-transport-required',
      false,
      'Account credentials can only be sent to an HTTPS Anvil API with normal certificate verification.',
    );
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), ACCOUNT_REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: init.method ?? 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        ...(init.accessToken === undefined
          ? {}
          : { Authorization: `Bearer ${init.accessToken}` }),
      },
      redirect: 'error',
      signal: controller.signal,
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });
    const payload = (await response.json().catch(() => null)) as unknown;
    if (isRecord(payload) && isRecord(payload['error'])) {
      const errorBody = payload['error'];
      throw new AccountRpcError(
        typeof errorBody['code'] === 'string' ? errorBody['code'] : 'unauthenticated',
        errorBody['retryable'] === true,
        `backend request rejected: ${typeof errorBody['code'] === 'string' ? errorBody['code'] : response.status}`,
      );
    }
    if (!response.ok) {
      throw new AccountRpcError('unavailable', true, `backend request failed: HTTP ${response.status}`);
    }
    return payload;
  } finally {
    clearTimeout(timeout);
  }
}

function routeUrl(apiUrl: string, route: string): string {
  const parsed = new URL(apiUrl);
  if (parsed.protocol !== 'https:') {
    throw new AccountRpcError(
      'secure-transport-required',
      false,
      'Account sign-in requires an HTTPS Anvil API URL.',
    );
  }
  const base = parsed.href.endsWith('/') ? parsed.href : `${parsed.href}/`;
  return new URL(route, base).href;
}

async function installationId(): Promise<string> {
  const existing = await SecureStore.getItemAsync(INSTALLATION_KEY);
  if (existing) return existing;
  const created = randomId();
  await SecureStore.setItemAsync(INSTALLATION_KEY, created);
  return created;
}

async function storeConnection(connection: AccountConnection): Promise<void> {
  await SecureStore.setItemAsync(SESSION_KEY, JSON.stringify(connection.session));
  await SecureStore.setItemAsync(BACKEND_KEY, connection.apiUrl);
}

/** The stored account connection, or null when not enrolled. */
export async function getAccountConnection(): Promise<AccountConnection | null> {
  const [apiUrl, raw] = await Promise.all([
    SecureStore.getItemAsync(BACKEND_KEY),
    SecureStore.getItemAsync(SESSION_KEY),
  ]);
  if (!apiUrl || !raw) return null;
  try {
    const session = JSON.parse(raw) as DeviceSession;
    if (typeof session.accessToken !== 'string' || typeof session.enrollmentId !== 'string') {
      return null;
    }
    return { apiUrl, session };
  } catch {
    return null;
  }
}

/** Redeems a single-use enrollment code and persists the device session. */
export async function enrollWithCode(
  apiUrl: string,
  code: string,
  displayName: string,
): Promise<AccountConnection> {
  const trimmedApi = apiUrl.trim().replace(/\/+$/, '');
  const parsedApi = new URL(trimmedApi);
  if (parsedApi.protocol !== 'https:' || parsedApi.username || parsedApi.password) {
    throw new AccountRpcError(
      'secure-transport-required',
      false,
      'Account sign-in requires an HTTPS Anvil API URL.',
    );
  }
  const normalizedApi = trimmedApi;
  if (!normalizedApi) throw new Error('Backend URL is required.');
  const trimmedCode = code.trim();
  if (!trimmedCode) throw new Error('Enrollment code is required.');

  const session = (await fetchJson(routeUrl(normalizedApi, 'enroll'), {
    body: {
      proof: { method: 'enrollment-code', code: trimmedCode },
      installationId: await installationId(),
      displayName: displayName.trim() || 'Anvil Mobile',
    },
  })) as EnrollResult;
  if (typeof session.accessToken !== 'string') {
    throw new Error('Enrollment returned a malformed session.');
  }

  const connection = { apiUrl: normalizedApi, session };
  await storeConnection(connection);
  return connection;
}

/**
 * Rotates the device session through `session/refresh`. The presented
 * refresh token is single-use — the rotated pair replaces it in storage.
 */
export async function refreshAccountSession(): Promise<AccountConnection | null> {
  const connection = await getAccountConnection();
  if (!connection) return null;
  const session = (await fetchJson(routeUrl(connection.apiUrl, 'session/refresh'), {
    body: {
      refreshToken: connection.session.refreshToken,
      enrollmentId: connection.session.enrollmentId,
    },
  })) as DeviceSession;
  const next = { apiUrl: connection.apiUrl, session };
  await storeConnection(next);
  return next;
}

async function rpcOnce<R>(connection: AccountConnection, operation: string, params: unknown): Promise<R> {
  const requestId = randomId();
  const payload = (await fetchJson(routeUrl(connection.apiUrl, 'rpc'), {
    accessToken: connection.session.accessToken,
    body: { protocol: PROTOCOL, requestId, operation, params },
  })) as Record<string, unknown>;
  if (!isRecord(payload) || !('result' in payload)) {
    throw new AccountRpcError('unavailable', true, `backend RPC ${operation} returned a malformed envelope`);
  }
  if (typeof payload['requestId'] === 'string' && payload['requestId'] !== requestId) {
    throw new AccountRpcError('unavailable', true, `backend RPC ${operation} returned a mismatched requestId`);
  }
  return payload['result'] as R;
}

/**
 * Envelope-RPC call under the stored device session. On `unauthenticated`
 * the access token is refreshed once and the call retried; a second
 * failure means the session is dead and the caller should sign in again.
 */
export async function accountRpc<R>(operation: string, params: unknown): Promise<R> {
  const connection = await getAccountConnection();
  if (!connection) {
    throw new AccountRpcError('unauthenticated', false, 'Sign in to your Anvil account first.');
  }
  try {
    return await rpcOnce<R>(connection, operation, params);
  } catch (error) {
    if (!(error instanceof AccountRpcError) || error.code !== 'unauthenticated') {
      throw error;
    }
  }
  const refreshed = await refreshAccountSession();
  if (!refreshed) {
    throw new AccountRpcError('unauthenticated', false, 'Sign in to your Anvil account first.');
  }
  return rpcOnce<R>(refreshed, operation, params);
}

/** Every enrollment on the account — revoked rows included for audit. */
export async function listAccountDevices(): Promise<DeviceListResult> {
  return accountRpc<DeviceListResult>('device.list', {});
}

/** Presence roster: who's online plus advertised dialable endpoints. */
export async function getAccountPresence(): Promise<DevicePresenceResult> {
  return accountRpc<DevicePresenceResult>('device.presence', {});
}

/** Account bearer stays on the verified HTTPS broker; it is never sent to an advertised host. */
export async function listMeshMachineHosts(): Promise<MeshMachineHost[]> {
  const connection = await getAccountConnection();
  if (!connection) {
    throw new AccountRpcError('unauthenticated', false, 'Sign in to your Anvil account first.');
  }
  const request = async (current: AccountConnection): Promise<MeshMachineHost[]> => {
    const result = await fetchJson(routeUrl(current.apiUrl, 'mesh/hosts'), {
      method: 'GET',
      accessToken: current.session.accessToken,
    });
    if (!isRecord(result) || result.v !== MESH_MACHINE_PROTOCOL_VERSION || !Array.isArray(result.hosts)) {
      throw new AccountRpcError('unavailable', true, 'The Mesh host list was malformed.');
    }
    return result.hosts.filter(isMeshMachineHost);
  };
  try {
    return await request(connection);
  } catch (error) {
    if (!(error instanceof AccountRpcError) || error.code !== 'unauthenticated') throw error;
  }
  const refreshed = await refreshAccountSession();
  if (!refreshed) {
    throw new AccountRpcError('unauthenticated', false, 'Sign in to your Anvil account first.');
  }
  return request(refreshed);
}

function isMeshMachineHost(value: unknown): value is MeshMachineHost {
  if (!isRecord(value)) return false;
  const allocationStates = [
    'disabled',
    'unallocated',
    'allocating',
    'ready',
    'retiring',
    'failed',
  ];
  if (
    typeof value.enrollmentId !== 'string' ||
    value.enrollmentId.length === 0 ||
    typeof value.machineId !== 'string' ||
    value.machineId.length === 0 ||
    typeof value.endpointGeneration !== 'string' ||
    value.endpointGeneration.length === 0 ||
    value.protocolVersion !== MESH_MACHINE_PROTOCOL_VERSION ||
    typeof value.online !== 'boolean' ||
    !isTimestamp(value.lastSeenAt) ||
    !isTimestamp(value.reachableUntil) ||
    !Array.isArray(value.capabilities) ||
    !value.capabilities.every(
      (capability) =>
        typeof capability === 'string' &&
        (MESH_MACHINE_CAPABILITIES as readonly string[]).includes(capability),
    ) ||
    !Array.isArray(value.operations) ||
    !value.operations.every(
      (operation) =>
        typeof operation === 'string' &&
        (MESH_MACHINE_OPERATIONS as readonly string[]).includes(operation),
    ) ||
    !allocationStates.includes(String(value.allocationState)) ||
    !Array.isArray(value.routes)
  ) {
    return false;
  }
  return value.routes.every((route) => {
    if (!isRecord(route)) return false;
    return (
      (route.kind === 'private' || route.kind === 'https' || route.kind === 'managed') &&
      typeof route.url === 'string' &&
      route.machineId === value.machineId &&
      route.endpointGeneration === value.endpointGeneration &&
      isTimestamp(route.reachableUntil) &&
      (route.allocationGeneration === undefined || typeof route.allocationGeneration === 'string')
    );
  });
}

function isTimestamp(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

/** Revokes this device's session server-side and clears local storage. */
export async function signOutAccount(): Promise<void> {
  const connection = await getAccountConnection();
  if (connection) {
    await fetchJson(routeUrl(connection.apiUrl, 'session/revoke'), {
      accessToken: connection.session.accessToken,
      body: {
        enrollmentId: connection.session.enrollmentId,
        refreshToken: connection.session.refreshToken,
      },
    }).catch(() => undefined);
  }
  await SecureStore.deleteItemAsync(SESSION_KEY);
  await SecureStore.deleteItemAsync(BACKEND_KEY);
}
