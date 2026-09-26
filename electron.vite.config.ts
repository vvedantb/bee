import react from "@vitejs/plugin-react";
import { defineConfig } from "electron-vite";

export default defineConfig({
  main: {
    build: { outDir: "out/main" },
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
