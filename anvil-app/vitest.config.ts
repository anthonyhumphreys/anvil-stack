import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
    exclude: ['node_modules/**', 'out/**', 'dist/**', 'video/**', 'landing/**', 'mobile/**'],
  },
});
