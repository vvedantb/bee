import { net, protocol } from "electron";
import { resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { CLERK_PUBLISHABLE_KEY, RENDERER_SCHEME, frontendApiHost } from "../shared/clerk";

// Clerk's UI is hot-loaded from the Frontend API host, so the CSP must allow it (see @clerk/electron README).
function contentSecurityPolicy(devUrl: string | undefined): string {
  const fapi = `https://${frontendApiHost(CLERK_PUBLISHABLE_KEY)}`;
  const dev = devUrl ? new URL(devUrl) : null;
  // Vite dev needs eval and its HMR socket.
  const devScript = dev ? " 'unsafe-eval'" : "";
  const devConnect = dev ? ` ${dev.origin} ws://${dev.host}` : "";
  return [
    "default-src 'self'",
    `script-src 'self' 'unsafe-inline'${devScript} ${fapi} https://challenges.cloudflare.com`,
    `connect-src 'self' ${fapi}${devConnect}`,
    "img-src 'self' https://img.clerk.com data:",
    "style-src 'self' 'unsafe-inline'",
    "worker-src 'self' blob:",
    "frame-src 'self' https://challenges.cloudflare.com",
    "form-action 'self'",
  ].join("; ");
}

/** Serves bee://renderer/* from the built renderer, or proxies to the Vite dev server in development. */
export function handleRendererProtocol(rendererDir: string, devUrl: string | undefined): void {
  const csp = contentSecurityPolicy(devUrl);

  async function fetchAsset(url: URL): Promise<Response> {
    if (devUrl) return net.fetch(new URL(url.pathname + url.search, devUrl).toString());
    const file = resolve(rendererDir, `.${decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname)}`);
    if (!file.startsWith(rendererDir + sep)) return new Response("Not found", { status: 404 });
    return net.fetch(pathToFileURL(file).toString());
  }

  protocol.handle(RENDERER_SCHEME, async (request) => {
    const response = await fetchAsset(new URL(request.url));
    const headers = new Headers(response.headers);
    headers.set("Content-Security-Policy", csp);
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  });
}
