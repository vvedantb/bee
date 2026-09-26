import { defineConfig } from "vitest/config";

// Live calls to Vercel AI Gateway. Needs BEE_AI_GATEWAY_API_KEY.
export default defineConfig({
  test: {
    include: ["test/**/*.gateway.test.ts"],
    environment: "node",
    testTimeout: 120_000,
  },
});
