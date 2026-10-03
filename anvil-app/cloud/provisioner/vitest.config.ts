import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: {
    alias: {
      '@cloudflare/sandbox': fileURLToPath(new URL('./test/sandbox-mock.ts', import.meta.url)),
    },
  },
  test: { include: ['test/**/*.test.ts'] },
});
