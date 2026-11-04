// Server naming helpers with no Node or SDK imports, so the renderer can use them too.
const MAX_SLUG = 24;

/** Server name as a tool-name prefix: [a-zA-Z0-9_-]+, no "__" (that separates server and tool). */
export function mcpSlug(name: string): string {
  const slug = name
    .replace(/[^a-zA-Z0-9_-]+/g, "_")
    .replace(/_{2,}/g, "_")
    .replace(/^[_-]+|[_-]+$/g, "")
    .slice(0, MAX_SLUG);
  return slug || "mcp";
}

/**
 * True for a vmem connector: the name the server reported in MCP initialize (`serverInfo.name`, stored as serverInfoName)
 * is vmem, ignoring case. Never keyed off the URL or the display name. Callers check `enabled`.
 */
export function isVmemConnector(server: { serverInfoName?: string }): boolean {
  return Boolean(server.serverInfoName) && mcpSlug(server.serverInfoName ?? "").toLowerCase() === "vmem";
}
