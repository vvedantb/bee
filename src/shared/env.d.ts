// Vite env vars read by shared code. The main build exposes VITE_CLERK_* too (electron.vite.config.ts).
interface ImportMetaEnv {
  readonly VITE_CLERK_PUBLISHABLE_KEY?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
