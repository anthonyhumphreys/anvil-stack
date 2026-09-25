// BILL-02 Stripe REST client — fetch + WebCrypto only, no SDK. Stripe
// speaks application/x-www-form-urlencoded including nested parameter
// syntax (`metadata[billing_account_id]`), so POST bodies are form
// encoded rather than JSON. Every failure is a StripeApiError: missing
// configuration, network errors and non-2xx answers all surface as one
// "provider unavailable" condition the routes map to 503.

import { isRecord } from '../rpc';

const DEFAULT_API_BASE = 'https://api.stripe.com';
const SIGNATURE_TOLERANCE_MS = 300_000;

const encoder = new TextEncoder();
const hexOf = (bytes: ArrayBuffer): string =>
  [...new Uint8Array(bytes)].map((v) => v.toString(16).padStart(2, '0')).join('');

export class StripeApiError extends Error {
  /** HTTP status, or 0 for configuration/network failures. */
  readonly status: number;

  constructor(status: number, detail: string) {
    super(`stripe ${status === 0 ? 'error' : status}: ${detail}`);
    this.name = 'StripeApiError';
    this.status = status;
  }
}

export interface StripeRequestInit {
  method?: 'GET' | 'POST';
  params?: Record<string, string | number | boolean | null | undefined>;
  idempotencyKey?: string;
}

function formEncode(params: Record<string, string | number | boolean | null | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    search.append(key, String(value));
  }
  return search.toString();
}

/** Authenticated Stripe API call; returns the parsed JSON body on 2xx. */
export async function stripeRequest<T>(
  env: Env,
  path: string,
  init: StripeRequestInit = {},
): Promise<T> {
  const secret = env.STRIPE_SECRET_KEY;
  if (typeof secret !== 'string' || secret.length === 0) {
    throw new StripeApiError(0, 'STRIPE_SECRET_KEY is not configured');
  }
  const base = env.STRIPE_API_BASE ?? DEFAULT_API_BASE;
  const method = init.method ?? 'GET';
  const url = `${base}${path}`;
  const headers: Record<string, string> = { Authorization: `Bearer ${secret}` };
  if (init.idempotencyKey !== undefined) {
    headers['Idempotency-Key'] = init.idempotencyKey;
  }
  let response: Response;
  try {
    response = await fetch(
      method === 'GET' && init.params !== undefined
        ? `${url}?${formEncode(init.params)}`
        : url,
      {
        method,
        headers:
          method === 'POST'
            ? { ...headers, 'content-type': 'application/x-www-form-urlencoded' }
            : headers,
        ...(method === 'POST' ? { body: formEncode(init.params ?? {}) } : {}),
      },
    );
  } catch (error) {
    throw new StripeApiError(0, error instanceof Error ? error.message : 'network failure');
  }
  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch {
    parsed = null;
  }
  if (!response.ok) {
    const detail =
      isRecord(parsed) && isRecord(parsed['error']) && typeof parsed['error']['message'] === 'string'
        ? parsed['error']['message']
        : `HTTP ${response.status}`;
    throw new StripeApiError(response.status, detail);
  }
  return parsed as T;
}

/** Constant-time hex compare: differing lengths never match. */
function hexEquals(a: string, b: string): boolean {
  if (!/^[a-f0-9]+$/.test(a) || !/^[a-f0-9]+$/.test(b) || a.length !== b.length) {
    return false;
  }
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/**
 * Verifies a `Stripe-Signature` header against the raw request body. The
 * header carries `t=<unix seconds>,v1=<hmac>` pairs (v1 repeats during
 * secret rotation); the signed payload is `${t}.${rawBody}` under
 * HMAC-SHA256 with the endpoint secret. Missing/overshot timestamps and
 * missing v1 values reject.
 */
export async function verifyStripeWebhookSignature(
  rawBody: string,
  header: string,
  secret: string,
  now: number,
  toleranceMs: number = SIGNATURE_TOLERANCE_MS,
): Promise<boolean> {
  let timestamp: string | null = null;
  const signatures: string[] = [];
  for (const part of header.split(',')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (key === 't') timestamp = value;
    if (key === 'v1') signatures.push(value);
  }
  if (timestamp === null || !/^\d{1,16}$/.test(timestamp) || signatures.length === 0) {
    return false;
  }
  const time = Number(timestamp) * 1000;
  if (!Number.isSafeInteger(time) || Math.abs(now - time) > toleranceMs) {
    return false;
  }
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const expected = hexOf(
    await crypto.subtle.sign('HMAC', key, encoder.encode(`${timestamp}.${rawBody}`)),
  );
  return signatures.some((signature) => hexEquals(expected, signature));
}

// Minimal provider shapes — only the fields this service consumes are
// modeled; everything else passes through untouched.

export interface StripeCheckoutSession {
  id: string;
  url: string | null;
  status: string | null;
  customer: string | null;
  subscription: string | null;
  client_reference_id: string | null;
}

export interface StripeSubscription {
  id: string;
  status: string;
  customer: string;
  current_period_end: number;
  cancel_at_period_end: boolean;
  items: {
    data: Array<{ price: { id: string; recurring: { interval: string } | null } }>;
  };
}

export interface StripeInvoice {
  id: string;
  subscription: string | null;
  billing_reason: string | null;
  status: string | null;
}

export interface StripePortalSession {
  id: string;
  url: string;
}

export interface StripeList<T> {
  object: 'list';
  data: T[];
  has_more: boolean;
}

export function parseStripeCheckoutSession(value: unknown): StripeCheckoutSession | null {
  if (!isRecord(value) || typeof value['id'] !== 'string') return null;
  const opt = (key: string): string | null =>
    typeof value[key] === 'string' ? (value[key] as string) : null;
  return {
    id: value['id'],
    url: opt('url'),
    status: opt('status'),
    customer: opt('customer'),
    subscription: opt('subscription'),
    client_reference_id: opt('client_reference_id'),
  };
}

export function parseStripeSubscription(value: unknown): StripeSubscription | null {
  if (
    !isRecord(value) ||
    typeof value['id'] !== 'string' ||
    typeof value['status'] !== 'string' ||
    typeof value['customer'] !== 'string' ||
    !Number.isSafeInteger(value['current_period_end']) ||
    typeof value['cancel_at_period_end'] !== 'boolean'
  ) {
    return null;
  }
  const items = isRecord(value['items']) && Array.isArray(value['items']['data'])
    ? value['items']['data']
    : [];
  const first = isRecord(items[0]) && isRecord(items[0]['price']) ? items[0]['price'] : null;
  const recurring = first !== null && isRecord(first['recurring']) ? first['recurring'] : null;
  return {
    id: value['id'],
    status: value['status'],
    customer: value['customer'],
    current_period_end: value['current_period_end'] as number,
    cancel_at_period_end: value['cancel_at_period_end'],
    items: {
      data: [
        {
          price: {
            id: first !== null && typeof first['id'] === 'string' ? first['id'] : '',
            recurring:
              recurring !== null && typeof recurring['interval'] === 'string'
                ? { interval: recurring['interval'] }
                : null,
          },
        },
      ],
    },
  };
}

export function parseStripeInvoice(value: unknown): StripeInvoice | null {
  if (!isRecord(value) || typeof value['id'] !== 'string') return null;
  const opt = (key: string): string | null =>
    typeof value[key] === 'string' ? (value[key] as string) : null;
  return {
    id: value['id'],
    subscription: opt('subscription'),
    billing_reason: opt('billing_reason'),
    status: opt('status'),
  };
}
