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

/** Pill text for the tool Luna is using. Anything unknown, or no tool yet, reads as thinking. */
export function activityLabel(toolName: string | null | undefined): string {
  return (toolName ? ACTIVITY_LABELS.get(toolName) : undefined) ?? "Thinking…";
}

type ResponseArgs = {
  tips: readonly string[];
  sources: readonly unknown[];
  guideError: string | null;
  // The user closed the body for the result on screen. A new result clears it (store.ts).
  dismissed: boolean;
};

/** The body shows when the result has something to say and the user has not closed it. */
export function shouldShowResponse(args: ResponseArgs): boolean {
  if (args.dismissed) return false;
  return args.tips.length > 0 || args.sources.length > 0 || args.guideError !== null;
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
