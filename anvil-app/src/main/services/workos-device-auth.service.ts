import type { DeviceSession } from '../../../cloud/contract/auth.js';

/** The fixed public WorkOS AuthKit authority used by headless sign-in. */
export const WORKOS_AUTHKIT_ISSUER = 'https://api.workos.com/user_management' as const;
export const WORKOS_DEVICE_AUTHORIZATION_URL = `${WORKOS_AUTHKIT_ISSUER}/authorize/device` as const;

/** OAuth device-code grant used by WorkOS's authenticate endpoint. */
export const WORKOS_DEVICE_GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:device_code' as const;

export const DEFAULT_WORKOS_DEVICE_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_WORKOS_DEVICE_TIMEOUT_MS = 15 * 60 * 1000;
const MAX_WORKOS_RESPONSE_BYTES = 64 * 1024;
const DEFAULT_POLL_INTERVAL_SECONDS = 5;
const MAX_POLL_INTERVAL_SECONDS = 5 * 60;

export type WorkOSDevicePollErrorCode =
  | 'authorization_pending'
  | 'slow_down'
  | 'access_denied'
  | 'expired_token'
  | 'invalid_request'
  | 'invalid_client'
  | 'invalid_grant'
  | 'unsupported_grant_type';

export type WorkOSDeviceAuthErrorCode =
  | WorkOSDevicePollErrorCode
  | 'cancelled'
  | 'timeout'
  | 'malformed-response'
  | 'http-error';

/** Proof sent to the Anvil backend. The device code never crosses the UI. */
export interface WorkOSDeviceProof {
  method: 'workos-device';
  issuer: typeof WORKOS_AUTHKIT_ISSUER;
  deviceCode: string;
}

export interface WorkOSDeviceEnrollParams {
  proof: WorkOSDeviceProof;
  installationId: string;
  displayName?: string;
}

/** Values safe to show in a terminal or renderer. No device code is exposed. */
export interface WorkOSDeviceChallenge {
  userCode: string;
  verificationUri: string;
  verificationUriComplete?: string;
  expiresAt: string;
  intervalSeconds: number;
}

export interface WorkOSDeviceAuthErrorOptions {
  code: WorkOSDeviceAuthErrorCode;
  message?: string;
  status?: number;
}

/** Stable, redacted errors for the headless flow. Device codes are omitted. */
export class WorkOSDeviceAuthError extends Error {
  readonly code: WorkOSDeviceAuthErrorCode;
  readonly status?: number;

  constructor(options: WorkOSDeviceAuthErrorOptions) {
    super(options.message ?? `WorkOS device authorization failed: ${options.code}`);
    this.name = 'WorkOSDeviceAuthError';
    this.code = options.code;
    this.status = options.status;
  }
}

export type WorkOSDeviceEnrollFn = (
  params: WorkOSDeviceEnrollParams,
  signal: AbortSignal,
) => Promise<DeviceSession>;

export type WorkOSDeviceSleepFn = (milliseconds: number, signal: AbortSignal) => Promise<void>;

export interface RunWorkOSDeviceFlowOptions {
  /** Public WorkOS application client ID from the reviewed backend descriptor. */
  clientId: string;
  /** Device-local installation identifier sent to the Anvil backend. */
  installationId: string;
  /** Called once after strict validation of the public authorization response. */
  onChallenge?: (challenge: WorkOSDeviceChallenge) => void | Promise<void>;
  /** Exchanges the private WorkOS device code at Anvil's /enroll boundary. */
  enrollFn: WorkOSDeviceEnrollFn;
  /** Injected for tests; defaults to global fetch. */
  fetchFn?: typeof fetch;
  /** Injected for tests; defaults to an abort-aware timer. */
  sleep?: WorkOSDeviceSleepFn;
  /** Injected for tests; must return epoch milliseconds. */
  now?: () => number;
  /** Overall flow budget; clamped to a bounded five-to-fifteen minute window. */
  timeoutMs?: number;
  /** Caller cancellation (sign-out and daemon Ctrl-C use this). */
  signal?: AbortSignal;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function safeHttpsUrl(value: unknown, field: string): string {
  if (!isNonEmptyString(value) || value.length > 2048) {
    throw new WorkOSDeviceAuthError({
      code: 'malformed-response',
      message: `WorkOS device authorization returned an invalid ${field}.`,
    });
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new WorkOSDeviceAuthError({
      code: 'malformed-response',
      message: `WorkOS device authorization returned an invalid ${field}.`,
    });
  }
  if (
    parsed.protocol !== 'https:' ||
    parsed.username.length > 0 ||
    parsed.password.length > 0 ||
    parsed.hash.length > 0 ||
    parsed.hostname.length === 0
  ) {
    throw new WorkOSDeviceAuthError({
      code: 'malformed-response',
      message: `WorkOS device authorization returned an unsafe ${field}.`,
    });
  }
  for (const key of parsed.searchParams.keys()) {
    const normalized = key.toLowerCase().replace(/-/g, '_');
    if (
      normalized !== 'user_code' &&
      (normalized === 'code' ||
        normalized.includes('device_code') ||
        normalized.includes('access_token') ||
        normalized.includes('refresh_token') ||
        normalized.includes('client_secret') ||
        normalized.includes('authorization_code') ||
        normalized.includes('token') ||
        normalized.includes('secret'))
    ) {
      throw new WorkOSDeviceAuthError({
        code: 'malformed-response',
        message: `WorkOS device authorization returned an unsafe ${field}.`,
      });
    }
  }
  return parsed.href;
}

function abortError(): WorkOSDeviceAuthError {
  return new WorkOSDeviceAuthError({
    code: 'cancelled',
    message: 'WorkOS device authorization was cancelled.',
  });
}

function timeoutError(): WorkOSDeviceAuthError {
  return new WorkOSDeviceAuthError({
    code: 'timeout',
    message: 'WorkOS device authorization timed out.',
  });
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortError();
}

function createLinkedAbortSignal(
  parent: AbortSignal | undefined,
  timeoutMs: number,
): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController();
  const onParentAbort = () => controller.abort();
  if (parent?.aborted) {
    controller.abort();
  } else {
    parent?.addEventListener('abort', onParentAbort, { once: true });
  }
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timer);
      parent?.removeEventListener('abort', onParentAbort);
    },
  };
}

function defaultSleep(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(abortError());
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, milliseconds);
    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      reject(abortError());
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

async function readJson(response: Response): Promise<unknown> {
  let body: string;
  try {
    if (response.body === null) {
      body = await response.text();
    } else {
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let total = 0;
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        total += next.value.byteLength;
        if (total > MAX_WORKOS_RESPONSE_BYTES) {
          await reader.cancel().catch(() => undefined);
          throw new WorkOSDeviceAuthError({
            code: 'malformed-response',
            message: 'WorkOS returned an oversized device authorization response.',
          });
        }
        chunks.push(next.value);
      }
      body = new TextDecoder().decode(
        chunks.reduce((result, chunk) => {
          const merged = new Uint8Array(result.length + chunk.length);
          merged.set(result);
          merged.set(chunk, result.length);
          return merged;
        }, new Uint8Array()),
      );
    }
  } catch (error) {
    if (error instanceof WorkOSDeviceAuthError) throw error;
    throw new WorkOSDeviceAuthError({
      code: 'malformed-response',
      message: 'WorkOS returned an unreadable device authorization response.',
    });
  }
  if (new TextEncoder().encode(body).byteLength > MAX_WORKOS_RESPONSE_BYTES) {
    throw new WorkOSDeviceAuthError({
      code: 'malformed-response',
      message: 'WorkOS returned an oversized device authorization response.',
    });
  }
  try {
    return JSON.parse(body) as unknown;
  } catch {
    throw new WorkOSDeviceAuthError({
      code: 'malformed-response',
      message: 'WorkOS returned invalid JSON for device authorization.',
    });
  }
}

function requestError(error: unknown, signal: AbortSignal): WorkOSDeviceAuthError {
  if (signal.aborted) return timeoutError();
  if (error instanceof WorkOSDeviceAuthError) return error;
  return new WorkOSDeviceAuthError({
    code: 'http-error',
    message: 'Unable to contact WorkOS for device authorization.',
  });
}

function parseChallenge(
  payload: unknown,
  now: number,
): {
  challenge: WorkOSDeviceChallenge;
  deviceCode: string;
  expiresAtMs: number;
} {
  if (!isRecord(payload)) {
    throw new WorkOSDeviceAuthError({
      code: 'malformed-response',
      message: 'WorkOS device authorization response was not an object.',
    });
  }
  const deviceCode = payload['device_code'];
  const userCode = payload['user_code'];
  const verificationUriValue = payload['verification_uri'];
  const completeValue = payload['verification_uri_complete'];
  const expiresIn = payload['expires_in'];
  const interval =
    payload['interval'] === undefined ? DEFAULT_POLL_INTERVAL_SECONDS : payload['interval'];
  if (
    !isNonEmptyString(deviceCode) ||
    deviceCode.length > 4096 ||
    !/^[\x21-\x7e]+$/.test(deviceCode) ||
    !isNonEmptyString(userCode) ||
    userCode.length > 128 ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(userCode) ||
    !isPositiveInteger(expiresIn)
  ) {
    throw new WorkOSDeviceAuthError({
      code: 'malformed-response',
      message: 'WorkOS device authorization response omitted required fields.',
    });
  }
  if (
    expiresIn > 24 * 60 * 60 ||
    !isPositiveInteger(interval) ||
    interval > MAX_POLL_INTERVAL_SECONDS
  ) {
    throw new WorkOSDeviceAuthError({
      code: 'malformed-response',
      message: 'WorkOS device authorization response contained invalid timing.',
    });
  }
  const verificationUri = safeHttpsUrl(verificationUriValue, 'verification URI');
  let verificationUriComplete: string | undefined;
  if (completeValue !== undefined) {
    verificationUriComplete = safeHttpsUrl(completeValue, 'complete verification URI');
    if (new URL(verificationUriComplete).origin !== new URL(verificationUri).origin) {
      throw new WorkOSDeviceAuthError({
        code: 'malformed-response',
        message: 'WorkOS verification URIs have different origins.',
      });
    }
  }
  const encodedDeviceCode = encodeURIComponent(deviceCode);
  const containsDeviceCode = (uri: string): boolean => {
    if (uri.includes(deviceCode) || uri.includes(encodedDeviceCode)) return true;
    try {
      return decodeURIComponent(uri).includes(deviceCode);
    } catch {
      return true;
    }
  };
  if (
    containsDeviceCode(verificationUri) ||
    (verificationUriComplete !== undefined && containsDeviceCode(verificationUriComplete))
  ) {
    throw new WorkOSDeviceAuthError({
      code: 'malformed-response',
      message: 'WorkOS returned a verification URI containing the private device code.',
    });
  }
  const expiresAtMs = now + expiresIn * 1000;
  const challenge: WorkOSDeviceChallenge = {
    userCode,
    verificationUri,
    ...(verificationUriComplete === undefined ? {} : { verificationUriComplete }),
    expiresAt: new Date(expiresAtMs).toISOString(),
    intervalSeconds: interval,
  };
  return { challenge, deviceCode, expiresAtMs };
}

function pollCodeFrom(error: unknown): WorkOSDevicePollErrorCode | null {
  if (error instanceof WorkOSDeviceAuthError && isPollCode(error.code)) return error.code;
  if (!isRecord(error)) return null;
  const details = isRecord(error['details']) ? error['details'] : null;
  const candidates = [
    error['code'],
    error['error'],
    details?.['code'],
    details?.['reason'],
    details?.['workosCode'],
  ];
  for (const candidate of candidates) {
    if (typeof candidate !== 'string') continue;
    const normalized = candidate.trim().toLowerCase().replace(/-/g, '_');
    const exact: Record<string, WorkOSDevicePollErrorCode> = {
      authorization_pending: 'authorization_pending',
      slow_down: 'slow_down',
      access_denied: 'access_denied',
      expired_token: 'expired_token',
      invalid_request: 'invalid_request',
      invalid_client: 'invalid_client',
      invalid_grant: 'invalid_grant',
      unsupported_grant_type: 'unsupported_grant_type',
      device_authorization_pending: 'authorization_pending',
      device_authorization_slow_down: 'slow_down',
      device_authorization_denied: 'access_denied',
      device_authorization_expired: 'expired_token',
      workos_device_authorization_pending: 'authorization_pending',
      workos_device_authorization_slow_down: 'slow_down',
      workos_device_authorization_denied: 'access_denied',
      workos_device_authorization_expired: 'expired_token',
    };
    const mapped = exact[normalized];
    if (mapped !== undefined) return mapped;
  }
  return null;
}

function isPollCode(value: string): value is WorkOSDevicePollErrorCode {
  return (
    value === 'authorization_pending' ||
    value === 'slow_down' ||
    value === 'access_denied' ||
    value === 'expired_token' ||
    value === 'invalid_request' ||
    value === 'invalid_client' ||
    value === 'invalid_grant' ||
    value === 'unsupported_grant_type'
  );
}

function validateDeviceSession(value: unknown): DeviceSession {
  if (!isRecord(value)) throw malformedSession();
  const requiredStrings = [
    'accessToken',
    'accessExpiresAt',
    'refreshToken',
    'enrollmentId',
    'accountId',
    'datasetEpoch',
  ] as const;
  if (
    !requiredStrings.every((key) => isNonEmptyString(value[key])) ||
    !isPositiveInteger(value['credentialGeneration']) ||
    !Number.isFinite(Date.parse(value['accessExpiresAt'] as string))
  ) {
    throw malformedSession();
  }
  const session: DeviceSession = {
    accessToken: value['accessToken'] as string,
    accessExpiresAt: value['accessExpiresAt'] as string,
    refreshToken: value['refreshToken'] as string,
    credentialGeneration: value['credentialGeneration'] as number,
    enrollmentId: value['enrollmentId'] as string,
    accountId: value['accountId'] as string,
    datasetEpoch: value['datasetEpoch'] as string,
  };
  for (const key of ['displayName', 'enrollmentExpiresAt', 'environmentId'] as const) {
    if (value[key] !== undefined) {
      if (!isNonEmptyString(value[key])) throw malformedSession();
      session[key] = value[key] as never;
    }
  }
  if (value['enrollmentClass'] !== undefined) {
    if (value['enrollmentClass'] !== 'device' && value['enrollmentClass'] !== 'ephemeral') {
      throw malformedSession();
    }
    session.enrollmentClass = value['enrollmentClass'];
  }
  return session;
}

function malformedSession(): WorkOSDeviceAuthError {
  return new WorkOSDeviceAuthError({
    code: 'malformed-response',
    message: 'The backend returned an invalid Anvil device session.',
  });
}

/**
 * Runs WorkOS Device Authorization through the Anvil enrollment boundary.
 * WorkOS is contacted directly only for the public device authorization
 * request. Polls submit the private device code to Anvil; Anvil exchanges it
 * with WorkOS and returns an Anvil DeviceSession. The code is never returned,
 * logged, or persisted by this client.
 */
export async function runWorkOSDeviceFlow(
  options: RunWorkOSDeviceFlowOptions,
): Promise<DeviceSession> {
  if (!isNonEmptyString(options.clientId) || !isNonEmptyString(options.installationId)) {
    throw new WorkOSDeviceAuthError({
      code: 'malformed-response',
      message: 'WorkOS device authorization requires a client and installation id.',
    });
  }
  const now = options.now ?? Date.now;
  const requestedTimeout = options.timeoutMs ?? DEFAULT_WORKOS_DEVICE_TIMEOUT_MS;
  const timeoutMs = Math.min(
    MAX_WORKOS_DEVICE_TIMEOUT_MS,
    Math.max(
      1_000,
      Number.isFinite(requestedTimeout) ? requestedTimeout : DEFAULT_WORKOS_DEVICE_TIMEOUT_MS,
    ),
  );
  const linked = createLinkedAbortSignal(options.signal, timeoutMs);
  const fetchFn = options.fetchFn ?? fetch;
  const sleep = options.sleep ?? defaultSleep;
  try {
    throwIfAborted(linked.signal);
    let response: Response;
    try {
      response = await fetchFn(WORKOS_DEVICE_AUTHORIZATION_URL, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({ client_id: options.clientId }).toString(),
        redirect: 'error',
        signal: linked.signal,
      });
    } catch (error) {
      if (linked.signal.aborted) {
        if (options.signal?.aborted) throw abortError();
        throw timeoutError();
      }
      throw requestError(error, linked.signal);
    }
    const payload = await readJson(response);
    if (!response.ok) {
      throw new WorkOSDeviceAuthError({
        code: 'http-error',
        status: response.status,
        message: 'WorkOS rejected the device authorization request.',
      });
    }
    const parsed = parseChallenge(payload, now());
    await options.onChallenge?.(parsed.challenge);
    throwIfAborted(linked.signal);

    let intervalSeconds = parsed.challenge.intervalSeconds;
    const deadline = Math.min(parsed.expiresAtMs, now() + timeoutMs);
    const initialWaitMs = deadline - now();
    if (initialWaitMs <= 0) throw timeoutError();
    await sleep(Math.min(intervalSeconds * 1000, initialWaitMs), linked.signal);
    for (;;) {
      throwIfAborted(linked.signal);
      if (now() >= deadline) throw timeoutError();
      try {
        const session = await options.enrollFn(
          {
            proof: {
              method: 'workos-device',
              issuer: WORKOS_AUTHKIT_ISSUER,
              deviceCode: parsed.deviceCode,
            },
            installationId: options.installationId,
          },
          linked.signal,
        );
        throwIfAborted(linked.signal);
        return validateDeviceSession(session);
      } catch (error) {
        if (linked.signal.aborted) {
          if (options.signal?.aborted) throw abortError();
          throw timeoutError();
        }
        const code = pollCodeFrom(error);
        if (code === null) {
          if (error instanceof WorkOSDeviceAuthError) throw error;
          throw new WorkOSDeviceAuthError({
            code: 'http-error',
            message: 'The Anvil enrollment request failed.',
          });
        }
        if (code === 'access_denied') {
          throw new WorkOSDeviceAuthError({
            code,
            message: 'WorkOS device authorization was denied.',
          });
        }
        if (code === 'expired_token') {
          throw new WorkOSDeviceAuthError({
            code,
            message: 'The WorkOS device authorization expired.',
          });
        }
        if (
          code === 'invalid_request' ||
          code === 'invalid_client' ||
          code === 'invalid_grant' ||
          code === 'unsupported_grant_type'
        ) {
          throw new WorkOSDeviceAuthError({
            code,
            message: 'WorkOS rejected the device authorization request.',
          });
        }
        if (code === 'slow_down') {
          intervalSeconds = Math.min(MAX_POLL_INTERVAL_SECONDS, intervalSeconds + 5);
        }
      }
      const remainingMs = deadline - now();
      if (remainingMs <= 0) throw timeoutError();
      await sleep(Math.min(intervalSeconds * 1000, remainingMs), linked.signal);
    }
  } finally {
    linked.dispose();
  }
}
