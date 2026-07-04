import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // CLI tests run full Cell builds (typecheck + bundle) per command, often
    // several per test, which exceeds Vitest's default 5s limit on CI runners.
    testTimeout: 60_000,
  },
});
