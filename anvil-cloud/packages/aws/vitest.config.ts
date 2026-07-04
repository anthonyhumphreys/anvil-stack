import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // The AWS preview example test runs a full Cell build, which exceeds
    // Vitest's default 5s limit on CI runners.
    testTimeout: 15_000,
  },
});
