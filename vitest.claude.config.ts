import { defineConfig } from "vitest/config";

// Live "Bee, …" requests on the Claude Agent SDK (core/claude-agent.ts). Needs BEE_CLAUDE_CODE_OAUTH_TOKEN (`claude setup-token`).
export default defineConfig({
  test: {
    include: ["test/**/*.claude.test.ts"],
    environment: "node",
    testTimeout: 180_000,
  },
});
