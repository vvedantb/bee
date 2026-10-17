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

/**
 * The cleaned href when raw is an http(s) URL that is safe to hand to the browser, else null.
 * Rejects other schemes, credentials in the URL, and hosts without a dot (localhost, bare words).
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
  stripTrackingParams(parsed);
  return parsed.href.length > MAX_URL_LENGTH ? null : parsed.href;
}
