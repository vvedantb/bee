import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "relay/**/*.test.ts", "scripts/**/*.test.mjs"],
    environment: "node",
    // Same reason as electron.vite.config.ts: let Vite resolve the SDK's extensionless imports.
    server: { deps: { inline: ["@vmem/sdk"] } },
  },
});
