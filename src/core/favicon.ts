import { safeExternalUrl } from "./url-safety";

// Site icons for link chips, fetched in main (the renderer's CSP allows no remote images) and handed over as data URLs.
// Order: /favicon.ico, then the homepage's <link rel="icon">, then a favicon service. Any failure gives null (a globe in the UI).

export const FAVICON_TIMEOUT_MS = 1000;
export const FAVICON_MAX_BYTES = 100_000;
const HTML_MAX_BYTES = 200_000;
/** Disk entries older than this are fetched again. */
export const FAVICON_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_REDIRECTS = 3;

export type FaviconEntry = { dataUrl: string; savedAt: number };
export type FaviconStore = { read(host: string): Promise<FaviconEntry | null>; write(host: string, entry: FaviconEntry): Promise<void> };

type FetchLike = (url: string, init: { signal: AbortSignal; redirect: "manual"; headers: Record<string, string> }) => Promise<Response>;

/** A hostname that is safe to fetch and to use as a file name, or null. */
export function faviconHost(domain: string): string | null {
  const host = domain.trim().toLowerCase();
  if (!/^[a-z0-9.-]+$/.test(host) || !safeExternalUrl(`https://${host}/`)) return null;
  return host;
}

/** Reads at most max bytes. null when the body is larger. */
async function readLimited(res: Response, max: number): Promise<Uint8Array | null> {
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > max) return null;
  if (!res.body) {
    const all = new Uint8Array(await res.arrayBuffer());
    return all.byteLength > max ? null : all;
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/** href values of icon links in a page, apple-touch-icon after plain icons (those are larger than a chip needs). */
export function parseIconLinks(html: string, baseUrl: string): string[] {
  const icons: string[] = [];
  const touch: string[] = [];
  for (const tag of html.match(/<link\b[^>]*>/gi) ?? []) {
    const rel = /\brel\s*=\s*["']?([^"'>]+)/i.exec(tag)?.[1]?.toLowerCase() ?? "";
    const href = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(tag);
    const value = (href?.[1] ?? href?.[2] ?? href?.[3] ?? "").trim();
    if (!value || !/\bicon\b/.test(rel)) continue;
    try {
      (rel.includes("apple-touch-icon") ? touch : icons).push(new URL(value, baseUrl).href);
    } catch {
      // Unparseable href: skip it.
    }
  }
  return [...icons, ...touch];
}

/** Resolver with a memory cache and an injected disk store. Fetch is injected for tests. */
export function createFaviconResolver(args: { fetch: FetchLike; store?: FaviconStore; now?: () => number; timeoutMs?: number }) {
  const now = args.now ?? Date.now;
  const memory = new Map<string, string | null>();
  const pending = new Map<string, Promise<string | null>>();

  // Follows redirects by hand so every hop passes safeExternalUrl (no redirect to loopback).
  async function get(url: string): Promise<Response | null> {
    let current = safeExternalUrl(url);
    for (let hop = 0; current && hop <= MAX_REDIRECTS; hop++) {
      const res = await args.fetch(current, {
        signal: AbortSignal.timeout(args.timeoutMs ?? FAVICON_TIMEOUT_MS),
        redirect: "manual",
        headers: { "user-agent": "Bee", accept: "image/*,text/html;q=0.8" },
      });
      const location = res.headers.get("location");
      if (res.status >= 300 && res.status < 400 && location) {
        current = safeExternalUrl(new URL(location, current).href);
        continue;
      }
      return res.ok ? res : null;
    }
    return null;
  }

  async function image(url: string): Promise<string | null> {
    try {
      const res = await get(url);
      if (!res) return null;
      const mime = (res.headers.get("content-type") ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
      if (!/^image\/[a-z0-9.+-]+$/.test(mime)) return null;
      const bytes = await readLimited(res, FAVICON_MAX_BYTES);
      if (!bytes || bytes.byteLength === 0) return null;
      return `data:${mime};base64,${Buffer.from(bytes).toString("base64")}`;
    } catch {
      return null;
    }
  }

  async function pageIcons(host: string): Promise<string[]> {
    try {
      const res = await get(`https://${host}/`);
      if (!res) return [];
      const bytes = await readLimited(res, HTML_MAX_BYTES);
      return bytes ? parseIconLinks(new TextDecoder().decode(bytes), res.url || `https://${host}/`) : [];
    } catch {
      return [];
    }
  }

  async function fetchIcon(host: string): Promise<string | null> {
    const direct = await image(`https://${host}/favicon.ico`);
    if (direct) return direct;
    for (const link of (await pageIcons(host)).slice(0, 3)) {
      const found = await image(link);
      if (found) return found;
    }
    return image(`https://www.google.com/s2/favicons?domain=${encodeURIComponent(host)}&sz=32`);
  }

  async function resolve(host: string): Promise<string | null> {
    try {
      const saved = await args.store?.read(host);
      if (saved && now() - saved.savedAt < FAVICON_TTL_MS) return saved.dataUrl;
    } catch {
      // A bad disk entry is the same as none.
    }
    const dataUrl = await fetchIcon(host);
    if (dataUrl) await args.store?.write(host, { dataUrl, savedAt: now() }).catch(() => undefined);
    return dataUrl;
  }

  /** The domain's icon as a data URL, or null. Concurrent calls for one host share one fetch. Failures last for the session. */
  return async function favicon(domain: string): Promise<string | null> {
    const host = faviconHost(domain);
    if (!host) return null;
    if (memory.has(host)) return memory.get(host) ?? null;
    let run = pending.get(host);
    if (!run) {
      run = resolve(host)
        .catch(() => null)
        .then((value) => {
          memory.set(host, value);
          return value;
        })
        .finally(() => pending.delete(host));
      pending.set(host, run);
    }
    return run;
  };
}
