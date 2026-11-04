// Connector icons from MCP initialize (`serverInfo.icons`, spec 2025-11-25). No Node or SDK imports, so the renderer can use them too.

/** The largest icon src Bee stores in settings.json. A bigger data: URL is skipped. */
export const MCP_ICON_MAX_CHARS = 100_000;

export type McpIcon = { src: string; mimeType?: string; sizes?: string[]; theme?: "light" | "dark" };

/** The src when it is an https: URL or a data:image URL within the size cap, else null. Every other scheme is rejected. */
export function safeIconSrc(src: string | undefined | null): string | null {
  const value = src?.trim();
  if (!value || value.length > MCP_ICON_MAX_CHARS) return null;
  if (/^data:image\/[a-z0-9.+-]+[;,]/i.test(value)) return value;
  try {
    return new URL(value).protocol === "https:" ? value : null;
  } catch {
    return null;
  }
}

/** How far an icon's sizes are from 32px. "any" (SVG) counts as a fit; no sizes ranks after any listed size. */
function sizeDistance(sizes: readonly string[] | undefined): number {
  if (!sizes?.length) return 1000;
  let best = Number.POSITIVE_INFINITY;
  for (const size of sizes) {
    if (size.toLowerCase() === "any") return 0;
    const px = Number(/^(\d+)x\d+$/i.exec(size.trim())?.[1]);
    if (Number.isFinite(px)) best = Math.min(best, Math.abs(px - 32));
  }
  return Number.isFinite(best) ? best : 1000;
}

/**
 * The best icon src for Bee's dark UI: only https: and data:image srcs; dark-theme icons first, then unthemed, then light;
 * within a theme, sizes nearest 32px. null when none is usable. Reads loosely, so a malformed list never throws.
 */
export function pickServerIcon(icons: unknown): string | null {
  if (!Array.isArray(icons)) return null;
  const themeRank = (theme: unknown): number => (theme === "dark" ? 0 : theme === "light" ? 2 : 1);
  let best: { src: string; rank: number; distance: number } | null = null;
  for (const item of icons as Array<Partial<McpIcon> | null>) {
    const src = safeIconSrc(typeof item?.src === "string" ? item.src : null);
    if (!src) continue;
    const rank = themeRank(item?.theme);
    const distance = sizeDistance(Array.isArray(item?.sizes) ? item.sizes.filter((size): size is string => typeof size === "string") : undefined);
    if (!best || rank < best.rank || (rank === best.rank && distance < best.distance)) best = { src, rank, distance };
  }
  return best?.src ?? null;
}

/** The host to ask for a favicon, or null. Convex HTTP action hosts (*.convex.site) serve none, so they are skipped. */
export function faviconHostOf(url: string | undefined): string | null {
  try {
    const host = new URL(url ?? "").hostname.toLowerCase();
    if (!host || host === "convex.site" || host.endsWith(".convex.site")) return null;
    return host;
  } catch {
    return null;
  }
}
