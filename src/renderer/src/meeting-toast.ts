// Turns a meeting notice into a Sonner toast. Shared by main.tsx and the screenshot page, so both show the same words and buttons.
import { toast } from "@vvedantb/ui";
import { MEETING_START_BUTTON, MEETING_STOP_BUTTON, MEETING_TOAST_ID, type MeetingNotice } from "./meeting-notices";

export function showMeetingNotice(notice: MeetingNotice, on: { accept: () => void; stop: () => void }): void {
  if (notice.kind === "clear") toast.dismiss(MEETING_TOAST_ID);
  else if (notice.kind === "info") toast(notice.message);
  // Auto-confirm off: one persistent toast with a button. The same id means Start becomes Stop in place.
  else if (notice.kind === "prompt-start") toast(notice.message, { id: MEETING_TOAST_ID, duration: Infinity, action: { label: MEETING_START_BUTTON, onClick: on.accept } });
  else toast(notice.message, { id: MEETING_TOAST_ID, duration: Infinity, action: { label: MEETING_STOP_BUTTON, onClick: on.stop } });
}
