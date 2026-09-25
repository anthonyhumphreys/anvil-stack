import { getPreferenceValues, LocalStorage } from '@raycast/api';

// MOB-01 Phase 3: account-connected mode for Raycast. When the extension
// has no manual baseUrl/token, it can instead redeem a single-use
// enrollment code (minted from the account website or an enrolled device)
// once, keep the device session in LocalStorage, discover enrolled hosts
// through the account coordinator, and dial their advertised endpoints in
// preference order (tailscale -> lan -> loopback) presenting the account
// access token — the host attests it like any other enrollment.

const PROTOCOL = 'anvil-backend/1' as const;
const SESSION_KEY = 'anvil.account.session';
const BACKEND_KEY = 'anvil.account.backend';
const HOST_KEY = 'anvil.account.host';
const DIAL_TIMEOUT_MS = 4_000;

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

interface DevicePresenceEntry {
  enrollmentId: string;
  online: boolean;
  lastSeenAt: string;
  endpoints?: { kind: 'tailscale' | 'lan' | 'loopback'; host: string; port: number }[];
  capabilities?: string[];
  protocol?: number;
  self: boolean;
}

interface DialedHost {
  baseUrl: string;
  enrollmentId: string;
  dialedAt: number;
}

export interface AccountPreferences {
  accountApiUrl?: string;
  accountEnrollmentCode?: string;
}

export function accountConfigured(): boolean {
  const prefs = getPreferenceValues<AccountPreferences>();
  return Boolean(prefs.accountApiUrl?.trim() && prefs.accountEnrollmentCode?.trim());
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function routeUrl(apiUrl: string, route: string): string {
  const base = apiUrl.endsWith('/') ? apiUrl : `${apiUrl}/`;
  return new URL(route, base).href;
}

async function fetchJson(
  url: string,
  init: { body: unknown; accessToken?: string; timeoutMs?: number },
): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), init.timeoutMs ?? 12_000);
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        ...(init.accessToken === undefined
          ? {}
          : { Authorization: `Bearer ${init.accessToken}` }),
      },
      signal: controller.signal,
      body: JSON.stringify(init.body),
    });
    const payload = (await response.json().catch(() => null)) as unknown;
    if (isRecord(payload) && isRecord(payload['error'])) {
      const code =
        typeof payload['error']['code'] === 'string' ? payload['error']['code'] : 'unauthenticated';
      throw new Error(code);
    }
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    return payload;
  } finally {
    clearTimeout(timeout);
  }
}

async function rpc<R>(apiUrl: string, accessToken: string, operation: string, params: unknown): Promise<R> {
  const payload = (await fetchJson(routeUrl(apiUrl, 'rpc'), {
    accessToken,
    body: { protocol: PROTOCOL, requestId: crypto.randomUUID(), operation, params },
  })) as Record<string, unknown>;
  if (!isRecord(payload) || !('result' in payload)) {
    throw new Error(`malformed envelope for ${operation}`);
  }
  return payload['result'] as R;
}

async function storedSession(): Promise<{ apiUrl: string; session: DeviceSession } | null> {
  const [apiUrl, raw] = await Promise.all([
    LocalStorage.getItem<string>(BACKEND_KEY),
    LocalStorage.getItem<string>(SESSION_KEY),
  ]);
  if (!apiUrl || !raw) return null;
  try {
    return { apiUrl, session: JSON.parse(raw) as DeviceSession };
  } catch {
    return null;
  }
}

async function storeSession(apiUrl: string, session: DeviceSession): Promise<void> {
  await LocalStorage.setItem(SESSION_KEY, JSON.stringify(session));
  await LocalStorage.setItem(BACKEND_KEY, apiUrl);
}

async function ensureSession(): Promise<{ apiUrl: string; session: DeviceSession }> {
  const existing = await storedSession();
  if (existing) return existing;

  const prefs = getPreferenceValues<AccountPreferences>();
  const apiUrl = prefs.accountApiUrl?.trim().replace(/\/+$/, '');
  const code = prefs.accountEnrollmentCode?.trim();
  if (!apiUrl || !code) {
    throw new Error('Set a companion token or an account API URL + enrollment code.');
  }
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

async function probe(baseUrl: string, accessToken: string): Promise<'ready' | 'blocked' | 'down'> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DIAL_TIMEOUT_MS);
  try {
    const response = await fetch(`${baseUrl}/api/chat/threads`, {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
      signal: controller.signal,
    });
    if (response.status === 200) return 'ready';
    return response.status === 403 ? 'blocked' : 'down';
  } catch {
    return 'down';
  } finally {
    clearTimeout(timeout);
  }
}

async function dial(apiUrl: string, accessToken: string, ownEnrollmentId: string): Promise<DialedHost | null> {
  const presence = await rpc<{ devices: DevicePresenceEntry[] }>(
    apiUrl,
    accessToken,
    'device.presence',
    {},
  );
  for (const entry of presence.devices) {
    if (entry.self || entry.enrollmentId === ownEnrollmentId) continue;
    if (!entry.online) continue;
    for (const endpoint of entry.endpoints ?? []) {
      const baseUrl = `http://${endpoint.host}:${endpoint.port}`;
      const result = await probe(baseUrl, accessToken);
      if (result === 'ready') {
        return { baseUrl, enrollmentId: entry.enrollmentId, dialedAt: Date.now() };
      }
      if (result === 'blocked') {
        throw new Error(
          'This device is waiting for approval on the host — approve it in desktop Settings.',
        );
      }
    }
  }
  return null;
}

/**
 * The companion endpoint to talk to: the dialed account host if one is
 * remembered and still answers, otherwise a fresh presence dial. The
 * bearer is the account access token, rotated transparently on failure.
 */
export async function resolveAccountTarget(): Promise<{ baseUrl: string; token: string }> {
  let active = await ensureSession();

  const cachedRaw = await LocalStorage.getItem<string>(HOST_KEY);
  if (cachedRaw) {
    try {
      const cached = JSON.parse(cachedRaw) as DialedHost;
      if ((await probe(cached.baseUrl, active.session.accessToken)) === 'ready') {
        return { baseUrl: cached.baseUrl, token: active.session.accessToken };
      }
    } catch {
      // Fall through to a fresh dial.
    }
  }

  let host: DialedHost | null;
  try {
    host = await dial(active.apiUrl, active.session.accessToken, active.session.enrollmentId);
  } catch (error) {
    if (!String(error).includes('unauthenticated')) throw error;
    const refreshed = await refreshSession();
    if (!refreshed) throw error;
    active = refreshed;
    host = await dial(active.apiUrl, active.session.accessToken, active.session.enrollmentId);
  }

  if (host === null) {
    // Every endpoint refused — the access token may simply be stale.
    const refreshed = await refreshSession();
    if (refreshed) {
      active = refreshed;
      host = await dial(active.apiUrl, active.session.accessToken, active.session.enrollmentId);
    }
  }
  if (host === null) {
    throw new Error('No enrolled hosts are reachable right now.');
  }

  await LocalStorage.setItem(HOST_KEY, JSON.stringify(host));
  return { baseUrl: host.baseUrl, token: active.session.accessToken };
}

/** Drops the remembered dialed host so the next call redials. */
export async function forgetDialedHost(): Promise<void> {
  await LocalStorage.removeItem(HOST_KEY);
}
