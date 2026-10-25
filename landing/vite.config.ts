import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// Custom domain on Pages (bee.vedantb.com), so assets load from the root.
// The build lands in ../docs so branch-based Pages ("Deploy from branch / docs") keeps working.
// docs/design is kept: the design notes live in public/design and are copied into the output.
export default defineConfig({
  base: "/",
  plugins: [react(), tailwindcss()],
  build: {
    outDir: "../docs",
    emptyOutDir: true,
  },
});
