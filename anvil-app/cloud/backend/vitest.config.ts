import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.jsonc' },
      // The deployable config fails closed on spike auth; the dev flag exists
      // only inside the test pool's worker options. HOSTED_DB + a test service
      // key stand up the BILL-01 hosted surface in tests.
      miniflare: {
        d1Databases: { HOSTED_DB: 'hosted-test' },
        bindings: {
          ANVIL_DEV_SPIKE: 'true',
          HOSTED_SERVICE_KEYS: JSON.stringify({ test: 'a'.repeat(32) }),
        },
      },
    }),
  ],
  test: {
    globals: false,
  },
});
