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
    return json({ error: { message: `stripe-stub: no queued response for ${key}` }, status: 500 });
  }
  const [rule] = stripeStubQueue.splice(index, 1);
  return json(rule.body, rule.status);
}

// ENV-09: the managed provisioner service binding. Tests queue responses
// through the binding itself (POST /__provisioner-stub/enqueue) exactly like
// the Stripe stub — FIFO on method + pathname, unstubbed calls fail loudly.
// /v1/* routes require the configured bearer; the stub also answers
// {providerRef: 'sb-<environmentId>'} when no rule is queued for a create.
const provisionerStubQueue: { method: string; path: string; status: number; body: unknown }[] = [];

async function provisionerStubBinding(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  if (url.pathname === '/__provisioner-stub/enqueue' && request.method === 'POST') {
    const rule = (await request.json()) as {
      method: string;
      path: string;
      status?: number;
      body?: unknown;
    };
    provisionerStubQueue.push({
      method: rule.method,
      path: rule.path,
      status: rule.status ?? 200,
      body: rule.body ?? {},
    });
    return json({ pending: provisionerStubQueue.length });
  }
  if (url.pathname === '/__provisioner-stub/reset' && request.method === 'POST') {
    provisionerStubQueue.length = 0;
    provisionerStubLast = null;
    return json({ pending: 0 });
  }
  if (url.pathname === '/__provisioner-stub/last' && request.method === 'GET') {
    return json(provisionerStubLast);
  }
  if (request.headers.get('authorization') !== 'Bearer test-managed-token') {
    return json({ error: 'provisioner-stub: missing or wrong bearer' }, 401);
  }
  const key = `${request.method} ${url.pathname}`;
  const index = provisionerStubQueue.findIndex((rule) => `${rule.method} ${rule.path}` === key);
  if (index !== -1) {
    const [rule] = provisionerStubQueue.splice(index, 1);
    return json(rule.body, rule.status);
  }
  if (request.method === 'POST' && url.pathname === '/v1/environments') {
    const body = (await request.json()) as { environmentId?: string };
    provisionerStubLast = { method: request.method, path: url.pathname, body };
    return json({ providerRef: `sb-${body.environmentId ?? 'unknown'}` }, 201);
  }
  if (request.method === 'DELETE') {
    provisionerStubLast = { method: request.method, path: url.pathname, body: null };
    return json({ ok: true });
  }
  return json({ error: `provisioner-stub: no queued response for ${key}` }, 500);
}

let provisionerStubLast: { method: string; path: string; body: unknown } | null = null;

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
          // ENV-09: managed provisioning surface. Tests drive the claimer
          // through env.MANAGED_PROVISIONER.fetch (stub control routes under
          // /__provisioner-stub/*); ANVIL_PUBLIC_API_URL is what the claimer
          // injects as the environment's backendUrl.
          MANAGED_PROVISIONER_TOKEN: 'test-managed-token',
          ANVIL_PUBLIC_API_URL: 'https://api.anvil.test',
        },
        serviceBindings: {
          MANAGED_PROVISIONER: provisionerStubBinding,
        },
        outboundService: stripeStubOutbound,
      },
    }),
  ],
  test: {
    globals: false,
    // The Stripe and managed-provisioner test services are module-scoped FIFO
    // queues. Running files concurrently lets another file consume a queued
    // response, making provider tests order-dependent and leaving stale rules
    // behind for the next test. Keep the Worker files serial while retaining
    // normal intra-file test execution.
    fileParallelism: false,
    // D1 is fresh per test file; hosted migrations must exist before any
    // module-level fixtures run, so they land in a setup file rather than
    // per-suite beforeEach.
    setupFiles: ['./test/hosted-migrations.setup.ts'],
  },
});
