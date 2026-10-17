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

const VMEM_HOSTS = ["vmem.vedantb.com", "vmem.projectv.uk"];

/** True for the user's vmem connector: a server named vmem, or one whose URL host is a vmem host. Callers check `enabled`. */
export function isVmemConnector(server: { name: string; url?: string }): boolean {
  if (mcpSlug(server.name).toLowerCase() === "vmem") return true;
  try {
    const host = new URL(server.url ?? "").hostname.toLowerCase();
    return VMEM_HOSTS.some((vmem) => host === vmem || host.endsWith(`.${vmem}`));
  } catch {
    return false;
  }
}
