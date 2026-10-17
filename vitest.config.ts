import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "test/latency.test.ts", "relay/**/*.test.ts", "scripts/**/*.test.mjs"],
    environment: "node",
  },
});
