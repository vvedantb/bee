import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "test/latency.test.ts", "test/replay-fixtures.test.ts", "relay/**/*.test.ts", "convex/**/*.test.ts", "scripts/**/*.test.mjs"],
    environment: "node",
    // CI runs typecheck and lint beside the tests on 4 vCPUs: cap workers to avoid oversubscription.
    maxWorkers: 2,
  },
});
