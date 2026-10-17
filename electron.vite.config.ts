import react from "@vitejs/plugin-react";
import { defineConfig } from "electron-vite";

export default defineConfig({
  main: {
    build: { outDir: "out/main" },
    // Main derives the Clerk issuer and CSP from the same publishable key as the renderer.
    envPrefix: ["MAIN_VITE_", "VITE_CLERK_"],
  },
  preload: {
    // Sandboxed preloads must be a single CommonJS file, so bundle zod in rather than externalising it.
    build: {
      outDir: "out/preload",
      externalizeDeps: false,
      rollupOptions: { output: { format: "cjs", entryFileNames: "[name].cjs" } },
    },
  },
  renderer: {
    build: { outDir: "out/renderer" },
    plugins: [react({ babel: { plugins: ["babel-plugin-react-compiler"] } })],
  },
});
