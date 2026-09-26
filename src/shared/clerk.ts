// Bee signs in against the vedantb.com Clerk production instance. VITE_CLERK_PUBLISHABLE_KEY overrides it.
const FALLBACK_PUBLISHABLE_KEY = "pk_live_Y2xlcmsudmVkYW50Yi5jb20k";

export const CLERK_PUBLISHABLE_KEY = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY || FALLBACK_PUBLISHABLE_KEY;

// The renderer is served from bee://renderer/ so Clerk sees a stable origin (see main/renderer-protocol.ts).
export const RENDERER_SCHEME = "bee";
export const RENDERER_HOST = "renderer";
export const RENDERER_URL = `${RENDERER_SCHEME}://${RENDERER_HOST}/`;

/** A publishable key is `pk_(live|test)_` + base64("<frontend api host>$"). */
export function frontendApiHost(publishableKey: string): string {
  const encoded = publishableKey.split("_")[2] ?? "";
  return atob(encoded).replace(/\$$/, "");
}
