import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Full Cell builds (typecheck + bundle) exceed 5s on CI runners.
    testTimeout: 15_000,
  },
});
