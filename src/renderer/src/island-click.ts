// What a click on the pill's status text opens. No React or window here, so tests can call it.
import { islandClick } from "./island";
import type { NotchStatusKind } from "./notch";
import type { Tab } from "./store";

/** full-text: the answer in full in the island. panel: the panel on its current tab. A tab: the panel on that tab. */
export type StatusClick = "full-text" | "panel" | Tab | null;

/**
 * An answer folded to one line opens in full in the island itself (island.ts islandClick); an answer already open does nothing.
 * Status that asks the user to act opens where they can: the AI Gateway key field at the top of Settings, or the Live tab, which
 * shows the mic error. Any other status opens the panel while it is closed, like the chevron.
 */
export function statusClick(args: { kind: NotchStatusKind; panelOpen: boolean; bodyShown: boolean; answerFolded: boolean }): StatusClick {
  if (args.kind === "answer") {
    const click = islandClick("status", { panelOpen: args.panelOpen, bodyShown: args.bodyShown, hasResponse: args.answerFolded });
    return click === "full-text" ? click : null;
  }
  if (args.kind === "gateway-key") return "settings";
  if (args.kind === "mic-error") return "live";
  if (args.kind === "loading" || args.panelOpen) return null;
  return "panel";
}
