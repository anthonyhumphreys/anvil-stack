/** Minimal WorkOS REST client for the Worker runtime. Never logs credentials or tokens. */

const WORKOS_API_BASE = 'https://api.workos.com';
const WORKOS_REQUEST_TIMEOUT_MS = 10_000;

export class WorkOSRequestError extends Error {
  constructor(
    readonly status: number,
    readonly retryable: boolean,
  ) {
    super('WorkOS request failed');
    this.name = 'WorkOSRequestError';
  }
}

function workosApiKey(env: Env): string {
  const apiKey = env.WORKOS_API_KEY;
  if (typeof apiKey !== 'string' || apiKey.length === 0) {
    throw new WorkOSRequestError(503, false);
  }
  return apiKey;
}

/**
 * Makes one bounded server-to-server WorkOS request. The URL is always
 * constructed from the fixed API origin and internal endpoint constants.
 */
export async function workosRequest<T>(
  env: Env,
  path: string,
  options: { method?: 'GET' | 'POST' | 'PUT' | 'DELETE'; body?: unknown } = {},
): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), WORKOS_REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(`${WORKOS_API_BASE}${path}`, {
      method: options.method ?? 'GET',
      headers: {
        Authorization: `Bearer ${workosApiKey(env)}`,
        ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      signal: controller.signal,
    });
    const payload: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      throw new WorkOSRequestError(
        response.status,
        response.status === 429 || response.status >= 500,
      );
    }
    if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
      throw new WorkOSRequestError(502, true);
    }
    return payload as T;
  } catch (error) {
    if (error instanceof WorkOSRequestError) throw error;
    throw new WorkOSRequestError(503, true);
  } finally {
    clearTimeout(timeout);
  }
}
