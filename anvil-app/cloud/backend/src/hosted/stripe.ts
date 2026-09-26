// BILL-02 Stripe REST client — fetch + WebCrypto only, no SDK. Stripe
// speaks application/x-www-form-urlencoded including nested parameter
// syntax (`metadata[billing_account_id]`), so POST bodies are form
// encoded rather than JSON. Every failure is a StripeApiError: missing
// configuration, network errors and non-2xx answers all surface as one
// "provider unavailable" condition the routes map to 503.

import { isRecord } from '../rpc';

const DEFAULT_API_BASE = 'https://api.stripe.com';
const SIGNATURE_TOLERANCE_MS = 300_000;
const STRIPE_REQUEST_TIMEOUT_MS = 10_000;
/** Webhook endpoints for each Stripe account must use this same API version. */
export const STRIPE_API_VERSION = '2026-08-26.dahlia';

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
  const headers: Record<string, string> = {
    Authorization: `Bearer ${secret}`,
    'Stripe-Version': STRIPE_API_VERSION,
  };
  if (init.idempotencyKey !== undefined) {
    headers['Idempotency-Key'] = init.idempotencyKey;
  }
  let response: Response;
  try {
    response = await fetch(
      method === 'GET' && init.params !== undefined ? `${url}?${formEncode(init.params)}` : url,
      {
        method,
        headers:
          method === 'POST'
            ? { ...headers, 'content-type': 'application/x-www-form-urlencoded' }
            : headers,
        ...(method === 'POST' ? { body: formEncode(init.params ?? {}) } : {}),
        signal: AbortSignal.timeout(STRIPE_REQUEST_TIMEOUT_MS),
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
      isRecord(parsed) &&
      isRecord(parsed['error']) &&
      typeof parsed['error']['message'] === 'string'
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
  metadata: Record<string, string>;
}

export interface StripeSubscription {
  id: string;
  status: string;
  customer: string;
  current_period_start: number;
  current_period_end: number;
  cancel_at_period_end: boolean;
  items: {
    data: Array<{
      id: string | null;
      quantity: number | null;
      current_period_start: number | null;
      current_period_end: number | null;
      price: { id: string; recurring: { interval: string } | null };
    }>;
  };
}

export interface StripeInvoice {
  id: string;
  subscription: string | null;
  billing_reason: string | null;
  status: string | null;
  customer: string | null;
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

export interface StripePrice {
  id: string;
  active: boolean;
  livemode: boolean;
  currency: string;
  unit_amount: number | null;
  recurring: { interval: string; interval_count: number } | null;
}

export function parseStripePrice(value: unknown): StripePrice | null {
  if (
    !isRecord(value) ||
    typeof value['id'] !== 'string' ||
    typeof value['active'] !== 'boolean' ||
    typeof value['livemode'] !== 'boolean' ||
    typeof value['currency'] !== 'string' ||
    (value['unit_amount'] !== null && !Number.isSafeInteger(value['unit_amount']))
  ) {
    return null;
  }
  const recurring = isRecord(value['recurring']) ? value['recurring'] : null;
  return {
    id: value['id'],
    active: value['active'],
    livemode: value['livemode'],
    currency: value['currency'],
    unit_amount: typeof value['unit_amount'] === 'number' ? value['unit_amount'] : null,
    recurring:
      recurring !== null &&
      typeof recurring['interval'] === 'string' &&
      Number.isSafeInteger(recurring['interval_count'])
        ? { interval: recurring['interval'], interval_count: recurring['interval_count'] as number }
        : null,
  };
}

export function parseStripeCheckoutSession(value: unknown): StripeCheckoutSession | null {
  if (!isRecord(value) || typeof value['id'] !== 'string') return null;
  const opt = (key: string): string | null =>
    typeof value[key] === 'string' ? (value[key] as string) : null;
  const metadata: Record<string, string> = {};
  if (isRecord(value['metadata'])) {
    for (const [key, item] of Object.entries(value['metadata'])) {
      if (typeof item === 'string') metadata[key] = item;
    }
  }
  return {
    id: value['id'],
    url: opt('url'),
    status: opt('status'),
    customer: opt('customer'),
    subscription: opt('subscription'),
    client_reference_id: opt('client_reference_id'),
    metadata,
  };
}

export function parseStripeSubscription(value: unknown): StripeSubscription | null {
  if (
    !isRecord(value) ||
    typeof value['id'] !== 'string' ||
    typeof value['status'] !== 'string' ||
    typeof value['customer'] !== 'string' ||
    typeof value['cancel_at_period_end'] !== 'boolean'
  ) {
    return null;
  }
  const itemList = isRecord(value['items']) ? value['items'] : null;
  const items = itemList !== null && Array.isArray(itemList['data']) ? itemList['data'] : null;
  // Hosted plans intentionally support one recurring line item. Truncated or
  // multi-item objects must fail closed instead of assigning the first item.
  if (items === null || items.length !== 1 || itemList?.['has_more'] === true) return null;
  const firstItem = isRecord(items[0]) ? items[0] : null;
  const first = firstItem !== null && isRecord(firstItem['price']) ? firstItem['price'] : null;
  const recurring = first !== null && isRecord(first['recurring']) ? first['recurring'] : null;
  const itemPeriodEnd = firstItem?.['current_period_end'];
  const itemPeriodStart = firstItem?.['current_period_start'];
  const itemQuantity = firstItem?.['quantity'];
  const currentPeriodEnd =
    typeof itemPeriodEnd === 'number' && Number.isSafeInteger(itemPeriodEnd) ? itemPeriodEnd : null;
  const currentPeriodStart =
    typeof itemPeriodStart === 'number' && Number.isSafeInteger(itemPeriodStart)
      ? itemPeriodStart
      : null;
  if (
    currentPeriodEnd === null ||
    currentPeriodStart === null ||
    firstItem === null ||
    first === null ||
    typeof first['id'] !== 'string' ||
    !Number.isSafeInteger(itemQuantity) ||
    (itemQuantity as number) < 1 ||
    recurring === null ||
    typeof recurring['interval'] !== 'string'
  )
    return null;
  return {
    id: value['id'],
    status: value['status'],
    customer: value['customer'],
    current_period_start: currentPeriodStart,
    current_period_end: currentPeriodEnd,
    cancel_at_period_end: value['cancel_at_period_end'],
    items: {
      data: [
        {
          id: typeof firstItem['id'] === 'string' ? firstItem['id'] : null,
          quantity: itemQuantity as number,
          current_period_start: currentPeriodStart,
          current_period_end:
            typeof itemPeriodEnd === 'number' && Number.isSafeInteger(itemPeriodEnd)
              ? itemPeriodEnd
              : null,
          price: {
            id: first['id'],
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
  const parent = isRecord(value['parent']) ? value['parent'] : null;
  const subscriptionDetails =
    parent !== null && isRecord(parent['subscription_details'])
      ? parent['subscription_details']
      : null;
  const modernSubscription =
    subscriptionDetails !== null && typeof subscriptionDetails['subscription'] === 'string'
      ? subscriptionDetails['subscription']
      : null;
  return {
    id: value['id'],
    subscription: modernSubscription ?? opt('subscription'),
    billing_reason: opt('billing_reason'),
    status: opt('status'),
    customer: opt('customer'),
  };
}
