// Vite env vars read by shared code. The main build exposes VITE_CLERK_* too (electron.vite.config.ts).
interface ImportMetaEnv {
  readonly VITE_CLERK_PUBLISHABLE_KEY?: string;
  // Main only: relay URL baked in at build time; BEE_RELAY_URL overrides it at run time.
  readonly MAIN_VITE_BEE_RELAY_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
