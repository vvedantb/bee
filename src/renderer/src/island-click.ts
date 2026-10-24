// What a click on the pill's status text opens. No React or window here, so tests can call it.
import { islandClick } from "./island";
import type { NotchStatusKind } from "./notch";
import type { Tab } from "./store";

/**
 * full-text: the answer in full in the island. panel: the panel on its current tab. gateway-key: Settings with the AI Gateway key
 * field focused. A tab: the panel on that tab.
 */
export type StatusClick = "full-text" | "panel" | "gateway-key" | Tab | null;

/** The id of the AI Gateway key input in Settings, so the gateway-key click can find it. */
export const GATEWAY_KEY_FIELD_ID = "gateway-api-key";

/**
 * Scrolls the key field into view and puts the cursor in it. Only focuses: the field keeps its mask, and its eye and copy buttons
 * still decide what is shown. Returns false if the field is not on screen.
 */
export function focusKeyField(field: Pick<HTMLElement, "scrollIntoView" | "focus"> | null): boolean {
  if (!field) return false;
  field.scrollIntoView({ block: "nearest" });
  field.focus({ preventScroll: true });
  return true;
}

/** How many frames (~0.5 s at 60 Hz) the gateway-key click waits for the panel to open and Settings to render. */
export const KEY_FIELD_FRAMES = 30;

/**
 * Focuses the key field as soon as it exists: tries now, then once per frame for up to `frames` frames, since the panel may still
 * be opening or settings still loading. find and nextFrame are injected (document lookup and requestAnimationFrame in the app).
 * Resolves true once focused, false if the field never showed up.
 */
export function focusKeyFieldWhenReady(args: {
  find: () => Pick<HTMLElement, "scrollIntoView" | "focus"> | null;
  nextFrame: (run: () => void) => void;
  frames?: number;
}): Promise<boolean> {
  const frames = args.frames ?? KEY_FIELD_FRAMES;
  return new Promise((resolve) => {
    const attempt = (left: number): void => {
      if (focusKeyField(args.find())) return resolve(true);
      if (left <= 0) return resolve(false);
      args.nextFrame(() => attempt(left - 1));
    };
    attempt(frames);
  });
}

/**
 * An answer folded to one line opens in full in the island itself (island.ts islandClick); an answer already open does nothing.
 * Status that asks the user to act opens where they can: Settings with the AI Gateway key field focused, or the Live tab, which
 * shows the mic error. Any other status opens the panel while it is closed, like the chevron.
 */
export function statusClick(args: { kind: NotchStatusKind; panelOpen: boolean; bodyShown: boolean; answerFolded: boolean }): StatusClick {
  if (args.kind === "answer") {
    const click = islandClick("status", { panelOpen: args.panelOpen, bodyShown: args.bodyShown, hasResponse: args.answerFolded });
    return click === "full-text" ? click : null;
  }
  if (args.kind === "gateway-key") return "gateway-key";
  if (args.kind === "mic-error") return "live";
  if (args.kind === "loading" || args.panelOpen) return null;
  return "panel";
}
