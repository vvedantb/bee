import { defineConfig } from "vitest/config";

// The scenario lab (test/scenarios.lab.test.ts): one desktop, so one scenario at a time.
export default defineConfig({
  test: {
    include: ["test/**/*.lab.test.ts"],
    environment: "node",
    fileParallelism: false,
    testTimeout: 10 * 60_000,
  },
});
