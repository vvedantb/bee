// Pure logic for the island: the pill while Luna works, and the response body under it. No React or window here.

export type IslandPhase = "idle" | "thinking" | "expanded";

/** Time with no new result, no busy run and no pointer on the island before the body closes. */
export const ISLAND_IDLE_MS = 10_000;

const ACTIVITY_LABELS = new Map([
  ["web_search", "Searching the web"],
  ["read_file", "Reading notes"],
  ["list_dir", "Reading notes"],
  ["search_files", "Reading notes"],
  ["append_note", "Writing a note"],
]);

/** Pill text for the tool Luna is using. MCP tools are named server__tool. Anything unknown reads as thinking. */
export function activityLabel(toolName: string | null | undefined): string {
  if (!toolName) return "Thinking…";
  const known = ACTIVITY_LABELS.get(toolName);
  if (known) return known;
  const split = toolName.indexOf("__");
  return split > 0 && split + 2 < toolName.length ? `Using ${toolName.slice(0, split)}…` : "Thinking…";
}

type ResponseArgs = {
  tips: readonly string[];
  sources: readonly unknown[];
  guideError: string | null;
  // The user closed the body for the result on screen. A new result clears it (store.ts).
  dismissed: boolean;
  // Link chips on screen for this turn. They can open the body on their own, before any result.
  chipCount?: number;
};

/** The body shows when the result (or a link chip) has something to say and the user has not closed it. */
export function shouldShowResponse(args: ResponseArgs): boolean {
  if (args.dismissed) return false;
  return args.tips.length > 0 || args.sources.length > 0 || args.guideError !== null || (args.chipCount ?? 0) > 0;
}

/** Thinking wins over the body: a new run replaces the old answer. */
export function islandPhase(args: ResponseArgs & { busy: boolean }): IslandPhase {
  if (args.busy) return "thinking";
  return shouldShowResponse(args) ? "expanded" : "idle";
}

/**
 * True when the body should close now. lastActivityAt: when the result arrived or the pointer last left.
 * Never while busy, while the pointer is on the island, or when no body is open.
 */
export function shouldAutoCollapse(args: { phase: IslandPhase; hovered: boolean; lastActivityAt: number; now: number }): boolean {
  if (args.phase !== "expanded" || args.hovered) return false;
  return args.now - args.lastActivityAt >= ISLAND_IDLE_MS;
}
