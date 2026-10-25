import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { REACT_DEDUPE, defineWebViteConfig, srcAlias } from "@vvedantb/config";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Custom domain on Pages (bee.vedantb.com), so assets load from the root.
// The build lands in ../docs so branch-based Pages ("Deploy from branch / docs") keeps working.
// docs/design is kept: the design notes live in public/design and are copied into the output.
export default defineConfig({
  ...defineWebViteConfig({
    tailwindcss,
    react: { plugin: react },
    alias: srcAlias(__dirname),
    dedupe: REACT_DEDUPE,
  }),
  base: "/",
  build: {
    outDir: "../docs",
    emptyOutDir: true,
  },
});
