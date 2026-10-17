// URL checks shared by Luna's sources (core/tools.ts) and the link chips' opener (main/open-url.ts). No Electron here.

export const MAX_URL_LENGTH = 2000;

const TRACKING_PARAMS = new Set(["fbclid", "gclid", "ref", "ref_src"]);

/** Remove tracking query params in place: utm_*, fbclid, gclid, ref, ref_src and source=post_page-…. */
export function stripTrackingParams(url: URL): void {
  for (const [key, value] of [...url.searchParams.entries()]) {
    const name = key.toLowerCase();
    if (name.startsWith("utm_") || TRACKING_PARAMS.has(name) || (name === "source" && value.toLowerCase().startsWith("post_page"))) {
      url.searchParams.delete(key);
    }
  }
}

/** IPv4 loopback (127.0.0.0/8) and the unspecified range (0.x.x.x, so 0.0.0.0). The URL parser already writes IPv4 as dotted decimal. */
function isLocalIpv4(host: string): boolean {
  const match = /^(\d{1,3})\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.exec(host);
  return match !== null && (match[1] === "127" || match[1] === "0");
}

/** Loopback or unspecified hosts: localhost, 127.0.0.0/8, 0.0.0.0, [::1], [::] and IPv4-mapped forms of those. */
export function isLocalHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (isLocalIpv4(host)) return true;
  if (!host.startsWith("[")) return false;
  const v6 = host.slice(1, -1);
  if (v6 === "::1" || v6 === "::") return true;
  // The parser turns ::ffff:127.0.0.1 into ::ffff:7f00:1.
  const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(v6);
  if (!mapped) return false;
  const high = parseInt(mapped[1] ?? "", 16);
  return isLocalIpv4(`${high >> 8}.${high & 255}.0.0`);
}

/**
 * The cleaned href when raw is an http(s) URL that is safe to hand to the browser, else null.
 * Rejects other schemes, credentials in the URL, hosts without a dot (localhost, bare words) and loopback addresses.
 */
export function safeExternalUrl(raw: string): string | null {
  const text = raw.trim();
  if (!text || text.length > MAX_URL_LENGTH) return null;
  let parsed: URL;
  try {
    parsed = new URL(text);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  if (parsed.username || parsed.password) return null;
  if (!parsed.hostname.includes(".") && !parsed.hostname.startsWith("[")) return null;
  if (isLocalHost(parsed.hostname)) return null;
  stripTrackingParams(parsed);
  return parsed.href.length > MAX_URL_LENGTH ? null : parsed.href;
}
