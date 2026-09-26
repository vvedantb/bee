import { defineConfig } from "vitest/config";

// Electron E2E with a fake mic and live Vercel AI Gateway calls. Needs BEE_AI_GATEWAY_API_KEY.
export default defineConfig({
  test: {
    include: ["test/**/*.e2e.test.ts"],
    environment: "node",
    testTimeout: 120_000,
  },
});
