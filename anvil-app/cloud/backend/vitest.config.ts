import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

// BILL-02: `cloudflare:test` does not export fetchMock in this plugin
// version, so outbound Stripe calls are intercepted by a miniflare
// outbound service instead. Tests queue responses via
// POST https://api.stripe.com/__stripe-stub/enqueue and the stub answers
// FIFO on method + pathname; an unstubbed call fails loudly, and no test
// traffic can reach the real api.stripe.com.
const stripeStubQueue: { method: string; path: string; status: number; body: unknown }[] = [];

async function stripeStubOutbound(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  if (url.hostname !== 'api.stripe.com') {
    return json({ error: `stripe-stub: refusing non-Stripe outbound fetch to ${url.hostname}` }, 500);
  }
  if (url.pathname === '/__stripe-stub/enqueue' && request.method === 'POST') {
    const rule = (await request.json()) as {
      method: string;
      path: string;
      status?: number;
      body?: unknown;
    };
    stripeStubQueue.push({
      method: rule.method,
      path: rule.path,
      status: rule.status ?? 200,
      body: rule.body ?? {},
    });
    return json({ pending: stripeStubQueue.length });
  }
  if (url.pathname === '/__stripe-stub/reset' && request.method === 'POST') {
    stripeStubQueue.length = 0;
    return json({ pending: 0 });
  }
  if (url.pathname === '/__stripe-stub/pending' && request.method === 'GET') {
    return json({ pending: stripeStubQueue });
  }
  if (request.headers.get('authorization') !== 'Bearer sk_test_fake') {
    return json({ error: { message: 'stripe-stub: missing or wrong bearer' } }, 401);
  }
  const key = `${request.method} ${url.pathname}`;
  const index = stripeStubQueue.findIndex((rule) => `${rule.method} ${rule.path}` === key);
  if (index === -1) {
    return json({ error: { message: `stripe-stub: no queued response for ${key}` } }, 500);
  }
  const [rule] = stripeStubQueue.splice(index, 1);
  return json(rule.body, rule.status);
}

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.jsonc' },
      // The deployable config fails closed on spike auth; the dev flag exists
      // only inside the test pool's worker options. HOSTED_DB + a test service
      // key stand up the BILL-01 hosted surface; the STRIPE_*/HOSTED_* values
      // are fake BILL-02 fixtures — never real credentials.
      miniflare: {
        d1Databases: { HOSTED_DB: 'hosted-test' },
        bindings: {
          ANVIL_DEV_SPIKE: 'true',
          // BILL-03: enforcement is on for the whole suite — every
          // pre-existing test account is unlinked and therefore
          // preview-entitled, proving enforcement doesn't disturb them.
          HOSTED_BILLING_ENFORCEMENT: 'true',
          HOSTED_SERVICE_KEYS: JSON.stringify({ test: 'a'.repeat(32) }),
          STRIPE_SECRET_KEY: 'sk_test_fake',
          STRIPE_WEBHOOK_SECRET: 'whsec_testfake0123456789',
          HOSTED_CHECKOUT_ENABLED: 'true',
          STRIPE_PRICE_SYNC_MONTHLY: 'price_test_monthly',
          STRIPE_PRICE_SYNC_ANNUAL: 'price_test_annual',
          HOSTED_CHECKOUT_SUCCESS_URL: 'https://example.test/checkout/success',
          HOSTED_CHECKOUT_CANCEL_URL: 'https://example.test/checkout/cancel',
          HOSTED_PORTAL_RETURN_URL: 'https://example.test/account',
        },
        outboundService: stripeStubOutbound,
      },
    }),
  ],
  test: {
    globals: false,
    // D1 is fresh per test file; hosted migrations must exist before any
    // module-level fixtures run, so they land in a setup file rather than
    // per-suite beforeEach.
    setupFiles: ['./test/hosted-migrations.setup.ts'],
  },
});
