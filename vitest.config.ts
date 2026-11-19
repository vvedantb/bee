import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "test/latency.test.ts", "test/replay-fixtures.test.ts", "relay/**/*.test.ts", "convex/**/*.test.ts", "scripts/**/*.test.mjs"],
    environment: "node",
    // Test files share a worker (and its module cache) instead of starting one worker per file: 159 workers at ~0.6 s each.
    isolate: false,
  },
});
