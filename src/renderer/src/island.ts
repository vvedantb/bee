// Pure logic for the island: the pill while Luna works, and the response body under it. No React or window here.

// revising: a new line arrived while tips were on screen. They stay (dimmed) while the run updates them.
export type IslandPhase = "idle" | "thinking" | "revising" | "expanded";

/** The least time an answer that opened on its own stays open with no new result, scroll or pointer on the island. */
export const ISLAND_MIN_OPEN_MS = 30_000;
/** Reading speed for the time on top of ISLAND_MIN_OPEN_MS, in words a second (about 200 a minute). */
export const READ_WORDS_PER_SECOND = 3.3;

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

const MCP_REASON_CHARS = 60;

/** One muted line for connectors Luna could not use, e.g. "Eva unavailable: sign in again from Connectors". Null when none. */
export function mcpErrorNote(errors: ReadonlyArray<{ server: string; error: string }> | undefined): string | null {
  if (!errors || errors.length === 0) return null;
  const reason = (error: string) => {
    if (/sign(?:ed)?[\s-]?in/i.test(error)) return "sign in again from Connectors";
    const line = error.replace(/\s+/g, " ").trim();
    return line.length > MCP_REASON_CHARS ? `${line.slice(0, MCP_REASON_CHARS - 1).trimEnd()}…` : line || "failed to connect";
  };
  return errors.map(({ server, error }) => `${server} unavailable: ${reason(error)}`).join("; ");
}

type ResponseArgs = {
  tips: readonly string[];
  sources: readonly unknown[];
  guideError: string | null;
  // The user closed the body for the result on screen. A new result clears it (store.ts).
  dismissed: boolean;
  // Link chips on screen for this turn. They can open the body on their own, before any result.
  chipCount?: number;
  // Lines of the meeting card ("Last time with…") on screen. Like a chip, it can open the body before any result.
  cardLines?: number;
};

/** The body shows when the result (or a link chip) has something to say and the user has not closed it. */
export function shouldShowResponse(args: ResponseArgs): boolean {
  if (args.dismissed) return false;
  return args.tips.length > 0 || args.sources.length > 0 || args.guideError !== null || (args.chipCount ?? 0) > 0 || (args.cardLines ?? 0) > 0;
}

/**
 * Whether the island body is on screen. While Luna thinks, the tips already shown stay (the pill says "Thinking…", and streamed
 * tips replace them line by line), and so do link chips. A stale error or sources alone do not open the body while busy.
 */
export function islandShowsBody(args: ResponseArgs & { busy: boolean }): boolean {
  if (!args.busy) return shouldShowResponse(args);
  return !args.dismissed && (args.tips.length > 0 || (args.chipCount ?? 0) > 0 || (args.cardLines ?? 0) > 0);
}

/** Thinking wins over the pill's phase: a new run replaces the old answer. */
export function islandPhase(args: ResponseArgs & { busy: boolean; revising?: boolean }): IslandPhase {
  if (args.busy) return args.revising ? "revising" : "thinking";
  return shouldShowResponse(args) ? "expanded" : "idle";
}

/** How long the body stays open after the last activity: ISLAND_MIN_OPEN_MS plus time to read what it shows, in ms. */
export function islandOpenMs(text: string): number {
  const words = text.split(/\s+/).filter(Boolean).length;
  return ISLAND_MIN_OPEN_MS + Math.round((words / READ_WORDS_PER_SECOND) * 1000);
}

/**
 * True when the body should fold back to the one-line pill now. lastActivityAt: when the result arrived, or the pointer last left
 * or scrolled the body. Never while busy, while the pointer is on the island, while the user has the answer open in full (they
 * clicked the one-line answer; only they close it), or when no body is open. The answer itself stays in the pill until a new turn.
 */
export function shouldAutoCollapse(args: { phase: IslandPhase; hovered: boolean; fullText: boolean; lastActivityAt: number; now: number; openMs: number }): boolean {
  if (args.phase !== "expanded" || args.hovered || args.fullText) return false;
  return args.now - args.lastActivityAt >= args.openMs;
}

export type IslandClick = "full-text" | "open-panel" | "close-panel" | null;

/**
 * What a click on the pill does. The status text, when it shows an answer folded to one line, opens that answer in full in the
 * island itself, never the panel; otherwise it does nothing. Only the chevron opens or closes the panel.
 */
export function islandClick(target: "status" | "chevron", args: { panelOpen: boolean; bodyShown: boolean; hasResponse: boolean }): IslandClick {
  if (target === "chevron") return args.panelOpen ? "close-panel" : "open-panel";
  return !args.panelOpen && !args.bodyShown && args.hasResponse ? "full-text" : null;
}

export type PipelineTimings = { retrieve: number; rank: number; guide: number; mcp: number };

/** Wall time of a run in ms: retrieval, then Jev beside MCP and Luna. Jev and Luna overlap, so the sum would overstate it. */
export function timingsLabel(timings: PipelineTimings): string {
  return `${Math.round(timings.retrieve + Math.max(timings.rank, timings.mcp + timings.guide))} ms`;
}

/** Each stage in ms, so MCP is never hidden inside Luna's time. */
export function timingsTitle(timings: PipelineTimings): string {
  const ms = (value: number) => `${Math.round(value)} ms`;
  return `retrieve ${ms(timings.retrieve)} · Jev ${ms(timings.rank)} · MCP ${ms(timings.mcp)} · AI ${ms(timings.guide)} (Jev runs beside MCP and the AI)`;
}

/** How close to the end of the island body counts as "at the bottom", in CSS px. */
export const FOLLOW_SLACK_PX = 24;

export type ScrollMetrics = { scrollTop: number; scrollHeight: number; clientHeight: number };

export function nearBottom(metrics: ScrollMetrics): boolean {
  return metrics.scrollHeight - metrics.clientHeight - metrics.scrollTop <= FOLLOW_SLACK_PX;
}

/**
 * Whether the body keeps pinning its newest line after a scroll. Near the bottom it follows; moving up (the user) pauses it.
 * Moving down without reaching the bottom keeps the current choice, so Bee's own smooth scroll never pauses itself.
 */
export function keepFollowing(following: boolean, previousTop: number, metrics: ScrollMetrics): boolean {
  if (nearBottom(metrics)) return true;
  if (metrics.scrollTop < previousTop) return false;
  return following;
}
