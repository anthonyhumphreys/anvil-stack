import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.jsonc' },
      // The deployable config fails closed on spike auth; the dev flag exists
      // only inside the test pool's worker options.
      miniflare: { bindings: { ANVIL_DEV_SPIKE: 'true' } },
    }),
  ],
  test: {
    globals: false,
  },
});
